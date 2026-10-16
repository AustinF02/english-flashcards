import type { Card } from "./types";

export type QuizKind = "meaning" | "reverse" | "listening";

export interface QuizQuestion {
  card: Card;
  kind: QuizKind;
  prompt: string;
  /** 4 option strings; exactly one equals the correct answer. */
  options: string[];
  answer: string;
}

export interface QuizResult {
  total: number;
  correct: number;
  missedCardIds: string[];
}

/** Deterministic PRNG (mulberry32) so quiz generation is testable. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rand: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const vi = out[i]!;
    out[i] = out[j]!;
    out[j] = vi;
  }
  return out;
}

/** The answer field used for a given quiz kind. */
function answerField(kind: QuizKind): "term" | "ja" {
  return kind === "meaning" ? "ja" : "term";
}

/**
 * Build one question. Distractors are drawn from OTHER cards in the same pool,
 * must differ from the answer, and are de-duplicated. Requires >= 4 cards.
 */
export function buildQuestion(
  card: Card,
  pool: Card[],
  kind: QuizKind,
  rand: () => number,
): QuizQuestion {
  if (pool.length < 4) throw new Error("need at least 4 cards for a quiz");
  const field = answerField(kind);
  const answer = card[field];

  const distractorValues: string[] = [];
  const seen = new Set<string>([answer]);
  for (const other of shuffle(pool, rand)) {
    if (other.id === card.id) continue;
    const v = other[field];
    if (seen.has(v)) continue;
    seen.add(v);
    distractorValues.push(v);
    if (distractorValues.length === 3) break;
  }
  // If the pool had duplicate values we may be short; that's a content bug, fail loudly.
  if (distractorValues.length < 3) {
    throw new Error(`not enough distinct distractors for card ${card.id}`);
  }

  const prompt =
    kind === "meaning" ? card.term
    : kind === "reverse" ? card.ja
    : card.term; // listening: UI plays audio; prompt shown as the term fallback

  const options = shuffle([answer, ...distractorValues], rand);
  return { card, kind, prompt, options, answer };
}

/** Build a quiz of up to `count` questions cycling through the kinds. */
export function buildQuiz(
  pool: Card[],
  count: number,
  seed: number,
): QuizQuestion[] {
  if (pool.length < 4) throw new Error("need at least 4 cards for a quiz");
  const rand = rng(seed);
  const kinds: QuizKind[] = ["meaning", "reverse", "listening"];
  const picks = shuffle(pool, rand).slice(0, Math.min(count, pool.length));
  return picks.map((card, i) =>
    buildQuestion(card, pool, kinds[i % kinds.length]!, rand),
  );
}

export function isCorrect(q: QuizQuestion, chosen: string): boolean {
  return chosen === q.answer;
}

/** Score an array of {question, chosen} answers. */
export function scoreQuiz(
  answers: { question: QuizQuestion; chosen: string }[],
): QuizResult {
  let correct = 0;
  const missed: string[] = [];
  for (const { question, chosen } of answers) {
    if (isCorrect(question, chosen)) correct++;
    else missed.push(question.card.id);
  }
  return { total: answers.length, correct, missedCardIds: missed };
}
