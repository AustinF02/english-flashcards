import { describe, it, expect, beforeEach } from "vitest";
import { loadHistory, recordQuiz, clearHistory } from "../src/quizHistory";

// Minimal in-memory Storage for tests (jsdom env may not expose localStorage here).
function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => Array.from(m.keys())[i] ?? null,
    get length() { return m.size; },
  } as Storage;
}

let s: Storage;
beforeEach(() => { s = memStorage(); });

describe("quiz history", () => {
  it("starts empty", () => {
    expect(loadHistory(s)).toEqual([]);
  });

  it("records a completed quiz with a timestamp", () => {
    recordQuiz({ deck: "aws-technical", total: 10, correct: 7 }, s, 1000);
    const h = loadHistory(s);
    expect(h).toHaveLength(1);
    expect(h[0]).toEqual({ at: 1000, deck: "aws-technical", total: 10, correct: 7 });
  });

  it("returns entries latest-to-oldest", () => {
    recordQuiz({ deck: "aws-technical", total: 10, correct: 5 }, s, 1000);
    recordQuiz({ deck: "conference-conversation", total: 8, correct: 8 }, s, 3000);
    recordQuiz({ deck: "aws-technical", total: 10, correct: 9 }, s, 2000);
    expect(loadHistory(s).map((e) => e.at)).toEqual([3000, 2000, 1000]);
  });

  it("caps the log at 100 entries, keeping the newest", () => {
    for (let i = 1; i <= 105; i++) {
      recordQuiz({ deck: "aws-technical", total: 10, correct: 1 }, s, i);
    }
    const h = loadHistory(s);
    expect(h).toHaveLength(100);
    expect(h[0]!.at).toBe(105);          // newest kept
    expect(h[h.length - 1]!.at).toBe(6); // oldest 5 dropped
  });

  it("ignores corrupt data and returns []", () => {
    s.setItem("ef_quiz_history_v1", "not json");
    expect(loadHistory(s)).toEqual([]);
    s.setItem("ef_quiz_history_v1", JSON.stringify([{ bogus: true }, { at: 1, deck: "aws-technical", total: 5, correct: 2 }]));
    expect(loadHistory(s)).toEqual([{ at: 1, deck: "aws-technical", total: 5, correct: 2 }]);
  });

  it("clears history", () => {
    recordQuiz({ deck: "aws-technical", total: 10, correct: 7 }, s, 1000);
    clearHistory(s);
    expect(loadHistory(s)).toEqual([]);
  });
});
