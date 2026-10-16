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
    expect(decks).toHaveLength(2);
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
});
