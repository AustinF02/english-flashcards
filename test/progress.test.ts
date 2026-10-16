import { describe, it, expect } from "vitest";
import vectors from "./vectors/progress.json";
import { applyOps, emptyProgress, nextLocalSeq, MAX_DEVICES } from "../src/progress";
import type { Progress, ProgressOp } from "../src/progress";

type Case = {
  name: string;
  initial: Partial<Progress>;
  ops: ProgressOp[];
  results: string[];
  expect: Partial<Progress>;
};

describe("shared progress vectors (must match backend/handler.py)", () => {
  for (const c of (vectors as { cases: Case[] }).cases) {
    it(c.name, () => {
      const prev: Progress = { ...emptyProgress("u"), ...c.initial } as Progress;
      const before = JSON.stringify(prev);
      const { state, results } = applyOps(prev, c.ops);
      expect(results.map((r) => r.outcome)).toEqual(c.results);
      for (const [k, v] of Object.entries(c.expect)) {
        expect((state as unknown as Record<string, unknown>)[k], k).toEqual(v);
      }
      expect(JSON.stringify(prev), "input must not be mutated").toBe(before);
    });
  }
});

describe("clock independence", () => {
  const op = (deviceId: string, status: "known" | "learning", clientTime: number) =>
    ({ kind: "status", deviceId, seq: 1, cardId: "t01", status, baseRev: 0, clientTime }) as unknown as ProgressOp;

  it("is decided by arrival order alone, whatever the device clocks say", () => {
    for (const [slow, fast] of [[1, 9e15], [9e15, 1], [0, 0], [-5, 5]] as [number, number][]) {
      const ab = applyOps(emptyProgress("u"), [op("A", "known", slow), op("B", "learning", fast)]).state;
      const ba = applyOps(emptyProgress("u"), [op("B", "learning", fast), op("A", "known", slow)]).state;
      expect(ab.cards["t01"]!.status).toBe("known");     // A arrived first
      expect(ba.cards["t01"]!.status).toBe("learning");  // B arrived first
    }
  });
});

describe("local-mode sequence helper", () => {
  it("continues after a reload instead of restarting at 1", () => {
    let p = emptyProgress("local");
    expect(nextLocalSeq(p, "local")).toBe(1);
    p = applyOps(p, [{ kind: "quiz", deviceId: "local", seq: 1, cardId: "t01", correct: true }]).state;
    p = applyOps(p, [{ kind: "quiz", deviceId: "local", seq: 2, cardId: "t01", correct: true }]).state;
    expect(nextLocalSeq(p, "local")).toBe(3);
  });
  it("device cap is 10", () => expect(MAX_DEVICES).toBe(10));
});
