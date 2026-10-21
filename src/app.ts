import type { Card, Deck } from "./types";
import { DECKS, cardsByDeck } from "./cards";
import { applyOps, emptyProgress, nextLocalSeq } from "./progress";
import type { Progress, ProgressOp } from "./progress";
import { loadDevice, reconcileDevice, saveDevice } from "./device";
import type { Device } from "./device";
import { LocalStore } from "./storage";
import { CloudSync } from "./cloud";
import type { SyncState } from "./cloud";
import { loadConfig } from "./config";
import type { RuntimeConfig } from "./config";
import { completeLogin, getSession, isExpired, signOut, startLogin } from "./auth";
import { buildQuiz, scoreQuiz, isCorrect } from "./quiz";
import type { QuizQuestion } from "./quiz";
import { play } from "./audio";
import { loadHistory, recordQuiz } from "./quizHistory";

type Screen = "decks" | "study" | "quiz" | "quiz-result" | "signin" | "history";

const store = new LocalStore();
let progress: Progress = store.load();

const state = {
  screen: "decks" as Screen,
  deck: null as Deck | null,
  cards: [] as Card[],
  index: 0,
  flipped: false,
  quiz: [] as QuizQuestion[],
  quizIndex: 0,
  quizChosen: null as string | null,
  quizAnswers: [] as { question: QuizQuestion; chosen: string }[],
};

const root = () => document.getElementById("app")!;

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** Cloud mode is active only when a real runtime config exists AND the user signed in. */
let cfg: RuntimeConfig | null = null;
let sync: CloudSync | null = null;
let syncState: SyncState | "idle" = "idle";

/** Cloud identity of this browser; null in device-only mode (those ops use the fixed "local" id). */
let device: Device | null = null;
let syncNote = "";

type NewOp = { kind: "status"; cardId: string; status: "learning" | "known" } | { kind: "quiz"; cardId: string; correct: boolean };

/** Build the op with this device's next sequence number and the card revision the user is looking at. */
function makeOp(o: NewOp): ProgressOp {
  const deviceId = device ? device.id : "local";
  const seq = device ? device.nextSeq : nextLocalSeq(progress, "local");
  if (device) { device = { ...device, nextSeq: seq + 1 }; saveDevice(device); }
  return o.kind === "status"
    ? { kind: "status", deviceId, seq, cardId: o.cardId, status: o.status, baseRev: progress.cards[o.cardId]?.rev ?? 0 }
    : { kind: "quiz", deviceId, seq, cardId: o.cardId, correct: o.correct };
}

function record(o: NewOp): void {
  const op = makeOp(o);
  progress = applyOps(progress, [op]).state;   // optimistic local result
  store.save(progress);                        // always keep a local copy
  if (sync) { sync.enqueue(op); void flush(); }
}

async function flush(): Promise<void> {
  if (!sync) return;
  const r = await sync.push();
  syncState = r.state;
  syncNote = r.dropped ? `${r.dropped} change${r.dropped > 1 ? "s were" : " was"} replaced by a newer decision from another device.` : "";
  if (r.expired) { device = reconcileDevice(device, []); saveDevice(device!); }   // server forgot us: start a fresh identity
  if (r.state === "synced") { progress = r.progress; store.save(progress); }
  render();
}

function setStatus(card: Card, status: "learning" | "known"): void {
  record({ kind: "status", cardId: card.id, status });
}

function learnedCount(deck: Deck): number {
  return cardsByDeck(deck).filter((c) => progress.cards[c.id]?.status === "known").length;
}

async function onAudio(path: string, btn: HTMLButtonElement): Promise<void> {
  const result = await play(path);
  if (result === "unavailable") {
    btn.dataset.state = "unavailable";
    btn.querySelector(".pending")!.textContent = "· unavailable";
  }
}

// ---------- renderers ----------

function renderDecks(): string {
  return `
  <section aria-labelledby="h-decks">
    <h2 class="sec-title" id="h-decks">Choose a deck</h2>
    <div class="decks">
      ${DECKS.map((d, i) => {
        const total = cardsByDeck(d.id).length;
        const learned = learnedCount(d.id);
        const pct = Math.round((learned / total) * 100);
        return `
        <button class="deck d${i + 1}" data-deck="${d.id}">
          <span class="stripe" aria-hidden="true"></span>
          <h3>${esc(d.title)}</h3>
          <p>${esc(d.blurb)}</p>
          <div class="meta">
            <span>${total} cards</span>
            <span class="bar"><span style="width:${pct}%"></span></span>
            <span>${learned} / ${total} learned</span>
          </div>
        </button>`;
      }).join("")}
    </div>
    ${renderAccount()}
    <button class="link hist-link" data-nav="history">View quiz history</button>
  </section>`;
}

const SYNC_TEXT: Record<SyncState | "idle", string> = {
  idle: "Signed in. Waiting for your first change.",
  synced: "All changes saved to your account.",
  offline: "Offline. Changes are kept on this device and will retry.",
  "signed-out": "Your session ended. Sign in again to sync.",
  conflict: "Could not merge changes yet. They are kept and will retry.",
  deleted: "This account was deleted. Progress is no longer saved.",
};

/** Says exactly what is true: device-only, or signed in with a real sync state.
 *  The sign-in / sign-out control itself now lives in the header (see renderHeaderAuth);
 *  this panel only explains the current storage/sync state. */
function renderAccount(): string {
  if (!cfg) {
    return `<p class="mode-note" data-mode="device">Progress is saved <strong>on this device only</strong>. Account sync is not available in this build.</p>`;
  }
  const sess = getSession();
  if (!sess || isExpired(sess.expiresAt, Date.now())) {
    return `<div class="mode-note" data-mode="signed-out">
      <p>Progress is saved on this device. Sign in to keep it on every device.</p></div>`;
  }
  return `<div class="mode-note" data-mode="cloud">
    <p role="status" data-sync="${syncState}">${SYNC_TEXT[syncState]}${syncNote ? " " + esc(syncNote) : ""}</p></div>`;
}

/** The header auth control: compact Sign in / Sign out, or nothing in device-only mode.
 *  "Sign in" opens the branded in-app sign-in screen, which then hands off to the
 *  Cognito hosted UI for the actual authentication (secure Auth Code + PKCE flow). */
function renderHeaderAuth(): string {
  if (!cfg) return "";
  const sess = getSession();
  const signedIn = !!sess && !isExpired(sess.expiresAt, Date.now());
  return signedIn
    ? `<button class="btn ghost compact" data-act="signout">Sign out</button>`
    : `<button class="btn primary compact" data-nav="signin">Sign in</button>`;
}

/** Quiz history screen: past completed quizzes, latest to oldest (device-local). */
function renderHistory(): string {
  const entries = loadHistory();
  const fmtDate = (ms: number): string => {
    const d = new Date(ms);
    return d.toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  };
  const deckTitle = (id: Deck): string => DECKS.find((d) => d.id === id)?.title ?? id;

  const rows = entries.map((e) => {
    const pct = e.total > 0 ? Math.round((e.correct / e.total) * 100) : 0;
    const tone = pct === 100 ? "ok" : pct >= 60 ? "" : "bad";
    return `
      <li class="hist-row">
        <div class="hist-main">
          <span class="hist-deck">${esc(deckTitle(e.deck))}</span>
          <span class="hist-when">${esc(fmtDate(e.at))}</span>
        </div>
        <span class="hist-score ${tone}">${e.correct} / ${e.total}<span class="hist-pct">${pct}%</span></span>
      </li>`;
  }).join("");

  return `
  <section aria-labelledby="h-history">
    <div class="topbar">
      <button class="link" data-nav="decks" aria-label="Back to decks">← Decks</button>
    </div>
    <h2 class="sec-title" id="h-history">Quiz history</h2>
    ${entries.length
      ? `<ul class="hist-list">${rows}</ul>`
      : `<p class="mode-note" data-mode="device">No quizzes yet. Finish a quiz and it will show up here, newest first. History is kept on this device.</p>`}
  </section>`;
}

/** Branded sign-in screen (matches mockups/login.html). The primary button hands off to the
 *  Cognito hosted UI via startLogin — this screen never collects a password itself. */
function renderSignin(): string {
  return `
  <section class="login" aria-labelledby="h-signin">
    <div class="topbar">
      <button class="link" data-nav="decks" aria-label="Back to decks">← Back</button>
    </div>
    <div class="login-card">
      <div class="lanyard" aria-hidden="true"></div>
      <h1 id="h-signin" class="login-title">Sign in</h1>
      <p class="login-sub">Sign in to sync your study progress across devices.</p>
      <button class="btn primary block" data-act="signin">Continue to sign in</button>
      <div class="divider">invite only</div>
      <p class="mode-note" data-mode="signed-out">
        Accounts are created by invitation. There is no public sign-up. Without an account you can
        keep studying and your progress stays saved on this device.
      </p>
    </div>
  </section>`;
}

function renderStudy(): string {
  const card = state.cards[state.index]!;
  const deckTitle = DECKS.find((d) => d.id === card.deck)!.title;
  const status = progress.cards[card.id]?.status;
  const back = state.flipped;
  return `
  <section aria-labelledby="h-study">
    <div class="topbar">
      <button class="link" data-nav="decks" aria-label="Back to decks">← Decks</button>
      <span class="counter">${state.index + 1} / ${state.cards.length}</span>
    </div>
    <h2 class="sec-title" id="h-study">${esc(deckTitle)}</h2>
    <div class="stage">
      <div class="card ${back ? "flipped" : ""}" id="studyCard">
        <div class="face front">
          <div class="lanyard" aria-hidden="true"></div>
          <div class="kind">${esc(card.kind)}${status ? ` · ${status === "known" ? "got it" : "still learning"}` : ""}</div>
          <div class="term" lang="en">${esc(card.term)}</div>
          <div class="pron">${audioBtn(card.audioTerm, "Play term")}</div>
        </div>
        <div class="face back">
          <div class="lanyard amber" aria-hidden="true"></div>
          <div class="meaning" lang="ja">${esc(card.ja)}</div>
          <p class="ex" lang="en">${esc(card.example)}</p>
          <p class="ex-ja" lang="ja">${esc(card.exampleJa)}</p>
          <div class="pron">
            ${audioBtn(card.audioTerm, "Term")}
            ${audioBtn(card.audioExample, "Example")}
          </div>
          <p class="voice-note">Voice: ${card.voice} (Polly Standard)</p>
        </div>
      </div>
    </div>
    <button class="btn primary block" data-act="flip" aria-pressed="${back}">
      ${back ? "Show term" : "Show meaning"}
    </button>
    <div class="controls">
      <button class="btn still" data-act="still">Still learning</button>
      <button class="btn got" data-act="got">Got it</button>
    </div>
    <div class="nav">
      <button class="btn ghost" data-act="prev" ${state.index === 0 ? "disabled" : ""}>Previous</button>
      <button class="btn ghost" data-act="next" ${state.index === state.cards.length - 1 ? "disabled" : ""}>Next</button>
    </div>
    <button class="btn block quizstart" data-act="quiz">Start quiz (${state.cards.length} cards)</button>
  </section>`;
}

function audioBtn(path: string, label: string): string {
  return `<button class="audio" data-audio="${esc(path)}" data-state="idle">
    <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5z"/><line x1="16" y1="9" x2="21" y2="14"/><line x1="21" y1="9" x2="16" y2="14"/></svg>
    ${esc(label)} <span class="pending">· tap to play</span>
  </button>`;
}

function renderQuiz(): string {
  const q = state.quiz[state.quizIndex]!;
  const answered = state.quizChosen !== null;
  const kindLabel =
    q.kind === "meaning" ? "Choose the Japanese meaning"
    : q.kind === "reverse" ? "Choose the English"
    : "Listening — choose the English";
  return `
  <section class="quiz" aria-labelledby="h-quiz">
    <div class="topbar">
      <button class="link" data-nav="study" aria-label="Back to study">← Study</button>
      <span class="counter">Q ${state.quizIndex + 1} / ${state.quiz.length}</span>
    </div>
    <div class="q">
      <h4>${kindLabel}</h4>
      ${q.prompt ? `<p class="prompt" lang="${q.kind === "reverse" ? "ja" : "en"}">${esc(q.prompt)}</p>` : ""}
      ${q.kind === "listening" ? audioBtn(q.card.audioTerm, "Play audio") : ""}
      <div role="group" aria-label="Answer choices">
      ${q.options.map((opt, i) => {
        let cls = "opt";
        let tag = String.fromCharCode(65 + i);
        if (answered) {
          if (opt === q.answer) { cls += " correct"; tag = "✓"; }
          else if (opt === state.quizChosen) { cls += " wrong"; tag = "✕"; }
        }
        const lang = q.kind === "meaning" ? "ja" : "en";
        return `<button class="${cls}" data-opt="${esc(opt)}" ${answered ? "disabled" : ""}>
          <span class="tag" aria-hidden="true">${tag}</span><span lang="${lang}">${esc(opt)}</span>
        </button>`;
      }).join("")}
      </div>
      ${answered ? renderFeedback(q) : ""}
      ${answered ? `<button class="btn primary block" data-act="qnext">${state.quizIndex === state.quiz.length - 1 ? "See results" : "Next question"}</button>` : ""}
    </div>
  </section>`;
}

function renderFeedback(q: QuizQuestion): string {
  const correct = isCorrect(q, state.quizChosen!);
  return `
  <div class="feedback ${correct ? "ok" : "bad"}" role="status">
    <span class="h">${correct ? "Correct" : `Not quite — the answer is ${esc(q.answer)}`}</span>
    <div class="ex"><span lang="en">${esc(q.card.example)}</span><br><span lang="ja">${esc(q.card.exampleJa)}</span></div>
  </div>`;
}

function renderResult(): string {
  const result = scoreQuiz(state.quizAnswers);
  const missed = state.cards.filter((c) => result.missedCardIds.includes(c.id));
  return `
  <section aria-labelledby="h-res">
    <h2 class="sec-title" id="h-res">Quiz result</h2>
    <div class="result">
      <div class="score">${result.correct} / ${result.total}</div>
      <p>${result.correct === result.total ? "Perfect round." : `${missed.length} to review.`}</p>
    </div>
    ${missed.length ? `<button class="btn primary block" data-act="retry">Retry missed (${missed.length})</button>` : ""}
    <button class="btn block ghost" data-nav="study">Back to study</button>
    <button class="btn block ghost" data-nav="decks">Choose another deck</button>
    <button class="btn block ghost" data-nav="history">View quiz history</button>
  </section>`;
}

// ---------- render + events ----------

function render(): void {
  const html =
    state.screen === "decks" ? renderDecks()
    : state.screen === "study" ? renderStudy()
    : state.screen === "quiz" ? renderQuiz()
    : state.screen === "signin" ? renderSignin()
    : state.screen === "history" ? renderHistory()
    : renderResult();
  root().innerHTML = html;
  const slot = document.getElementById("authSlot");
  if (slot) slot.innerHTML = renderHeaderAuth();
}

function startQuiz(cards: Card[]): void {
  state.quiz = buildQuiz(cards, Math.min(10, cards.length), Date.now());
  state.quizIndex = 0;
  state.quizChosen = null;
  state.quizAnswers = [];
  state.screen = "quiz";
}

// Delegated on document so both the in-app content and the header auth control are handled.
document.addEventListener("click", (e) => {
  const el = e.target as HTMLElement;
  const btn = el.closest("button");
  if (!btn) return;

  if (btn.dataset.audio) { void onAudio(btn.dataset.audio, btn as HTMLButtonElement); return; }

  const nav = btn.dataset.nav;
  if (nav === "decks") { state.screen = "decks"; render(); return; }
  if (nav === "study") { state.screen = "study"; state.flipped = false; render(); return; }
  if (nav === "signin") { state.screen = "signin"; render(); return; }
  if (nav === "history") { state.screen = "history"; render(); return; }

  const deck = btn.dataset.deck as Deck | undefined;
  if (deck) {
    state.deck = deck; state.cards = cardsByDeck(deck);
    state.index = 0; state.flipped = false; state.screen = "study"; render(); return;
  }

  const act = btn.dataset.act;
  const card = state.cards[state.index];
  switch (act) {
    case "flip": state.flipped = !state.flipped; render(); break;
    case "still": if (card) setStatus(card, "learning"); render(); break;
    case "got": if (card) setStatus(card, "known"); render(); break;
    case "prev": if (state.index > 0) { state.index--; state.flipped = false; render(); } break;
    case "next": if (state.index < state.cards.length - 1) { state.index++; state.flipped = false; render(); } break;
    case "quiz": startQuiz(state.cards); render(); break;
    case "signin": if (cfg) void startLogin(cfg.auth); break;
    case "signout": if (cfg) signOut(cfg.auth); break;
    case "qnext":
      if (state.quizIndex === state.quiz.length - 1) {
        state.screen = "quiz-result";
        // Record this completed quiz to the local history log (newest first).
        if (state.deck) {
          const r = scoreQuiz(state.quizAnswers);
          recordQuiz({ deck: state.deck, total: r.total, correct: r.correct });
        }
      } else { state.quizIndex++; state.quizChosen = null; }
      render(); break;
    case "retry": {
      const result = scoreQuiz(state.quizAnswers);
      const missed = state.cards.filter((c) => result.missedCardIds.includes(c.id));
      startQuiz(missed.length >= 4 ? missed : state.cards); render(); break;
    }
    default: {
      const opt = btn.dataset.opt;
      if (opt != null && state.quizChosen === null) {
        state.quizChosen = opt;
        const question = state.quiz[state.quizIndex]!;
        state.quizAnswers.push({ question, chosen: opt });
        record({ kind: "quiz", cardId: question.card.id, correct: isCorrect(question, opt) });
        render();
      }
    }
  }
});

// keyboard: Enter/Space flips in study (buttons already handle their own keys)
document.addEventListener("keydown", (e) => {
  if (state.screen === "study" && (e.key === "f" || e.key === "F")) {
    state.flipped = !state.flipped; render();
  }
});

async function bootstrap(): Promise<void> {
  render();                                   // device-only UI is shown immediately
  cfg = await loadConfig();
  if (!cfg) { render(); return; }
  const result = await completeLogin(cfg.auth);
  const sess = getSession();
  if (result === "signed-in" && sess) {
    const c = cfg;
    sync = new CloudSync(async (method, body) => {
      const s2 = getSession();
      if (!s2 || isExpired(s2.expiresAt, Date.now())) return { status: 401, json: {} };
      const r = await fetch(c.apiBase + "/progress", {
        method,
        headers: { authorization: `Bearer ${s2.accessToken}`, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
      });
      return { status: r.status, json: await r.json().catch(() => ({})) };
    });
    try {
      const remote = await sync.pull();
      // Pending local-only decisions made while signed out are not auto-merged here;
      // the server copy becomes the source of truth for this signed-in session.
      progress = remote.userId === "pending" ? emptyProgress("cloud") : remote;
      // The server tells us which device ids it knows; keep ours only if it is among them.
      device = reconcileDevice(loadDevice(), remote.devices ?? []);
      saveDevice(device);
      syncState = remote.state && remote.state !== "active" ? "deleted" : "idle";
    } catch { syncState = "offline"; }
  } else if (result === "failed") {
    syncState = "signed-out";
  }
  render();
}

void bootstrap();
