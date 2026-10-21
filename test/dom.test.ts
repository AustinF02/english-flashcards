// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

// jsdom in this setup doesn't expose Storage; provide a minimal in-memory one.
if (typeof globalThis.localStorage === "undefined") {
  const mem = new Map<string, string>();
  const store = {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
    get length() { return mem.size; },
  };
  Object.defineProperty(globalThis, "localStorage", { value: store, configurable: true });
}

/**
 * DOM smoke test: renders the real app in jsdom and drives it through
 * deck -> study -> flip -> quiz. This executes the UI wiring (not static
 * reasoning). It is not a pixel/visual check — that still needs a browser.
 */

// jsdom lacks these; stub so app.ts can import/run.
beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  document.body.innerHTML = `<main id="app"></main>`;
  // @ts-expect-error jsdom has no Audio
  globalThis.Audio = class { play() { return Promise.resolve(); } };
  globalThis.fetch = vi.fn(async () =>
    new Response(null, { status: 404 })) as unknown as typeof fetch;
});

async function boot() {
  await import("../src/app");
}

describe("app DOM flow", () => {
  it("renders deck selection with both decks", async () => {
    await boot();
    const decks = document.querySelectorAll("button.deck");
    expect(decks).toHaveLength(3);
    expect(document.querySelector(".mode-note")!.textContent).toContain("on this device only");
    expect(document.querySelector(".mode-note")!.getAttribute("data-mode")).toBe("device");
    expect(document.body.textContent).not.toContain("Sign in"); // no fake sign-in without a config
  });

  it("opens a deck, flips a card, and shows Japanese on the back", async () => {
    await boot();
    (document.querySelector('button[data-deck="aws-technical"]') as HTMLButtonElement).click();
    expect(document.querySelector(".term")!.getAttribute("lang")).toBe("en");

    (document.querySelector('button[data-act="flip"]') as HTMLButtonElement).click();
    const meaning = document.querySelector(".meaning")!;
    expect(meaning.getAttribute("lang")).toBe("ja");
    expect(document.querySelector(".card")!.classList.contains("flipped")).toBe(true);
  });

  it("marks a card 'Got it' and persists to localStorage", async () => {
    await boot();
    (document.querySelector('button[data-deck="aws-technical"]') as HTMLButtonElement).click();
    (document.querySelector('button[data-act="got"]') as HTMLButtonElement).click();
    expect(localStorage.getItem("ef_progress_v3")).toContain('"status":"known"');
  });

  it("runs a quiz question and shows feedback after choosing", async () => {
    await boot();
    (document.querySelector('button[data-deck="conference-conversation"]') as HTMLButtonElement).click();
    (document.querySelector('button[data-act="quiz"]') as HTMLButtonElement).click();
    expect(document.querySelectorAll("button.opt")).toHaveLength(4);
    (document.querySelector("button.opt") as HTMLButtonElement).click();
    expect(document.querySelector(".feedback")).not.toBeNull();
    // options disabled after answering
    expect((document.querySelector("button.opt") as HTMLButtonElement).disabled).toBe(true);
  });

  it("records a completed quiz and shows it on the history screen, newest first", async () => {
    await boot();
    // Drive a full quiz to completion: answer each question, then advance.
    (document.querySelector('button[data-deck="aws-technical"]') as HTMLButtonElement).click();
    (document.querySelector('button[data-act="quiz"]') as HTMLButtonElement).click();
    // Loop: pick first option, then click the qnext button, until we reach the result.
    for (let guard = 0; guard < 20; guard++) {
      const result = document.querySelector('[id="h-res"]');
      if (result) break;
      const opt = document.querySelector("button.opt") as HTMLButtonElement | null;
      if (opt) opt.click();
      const qnext = document.querySelector('button[data-act="qnext"]') as HTMLButtonElement | null;
      if (qnext) qnext.click();
    }
    // Now on the result screen — history entry should be persisted.
    expect(localStorage.getItem("ef_quiz_history_v1")).toContain('"deck":"aws-technical"');

    // Open the history screen and confirm an entry is listed.
    (document.querySelector('button[data-nav="history"]') as HTMLButtonElement).click();
    const rows = document.querySelectorAll(".hist-row");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(document.querySelector(".hist-deck")!.textContent).toBeTruthy();
  });

  it("shows an empty-state on the history screen before any quiz", async () => {
    await boot();
    (document.querySelector('button[data-nav="history"]') as HTMLButtonElement).click();
    expect(document.querySelectorAll(".hist-row")).toHaveLength(0);
    expect(document.body.textContent).toContain("No quizzes yet");
  });
});
