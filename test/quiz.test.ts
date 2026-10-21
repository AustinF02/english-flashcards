import { describe, it, expect } from "vitest";
import { buildQuiz, buildQuestion, scoreQuiz, isCorrect, rng } from "../src/quiz";
import { cardsByDeck } from "../src/cards";

const pool = cardsByDeck("aws-technical");

describe("quiz generation", () => {
  it("builds the requested number of questions", () => {
    const q = buildQuiz(pool, 10, 1);
    expect(q).toHaveLength(10);
  });

  it("each question has 4 unique options containing the answer exactly once", () => {
    for (const q of buildQuiz(pool, 10, 7)) {
      expect(q.options).toHaveLength(4);
      expect(new Set(q.options).size).toBe(4);
      expect(q.options.filter((o) => o === q.answer)).toHaveLength(1);
    }
  });

  it("distractors never equal the answer", () => {
    const rand = rng(42);
    const q = buildQuestion(pool[0]!, pool, "meaning", rand);
    const distractors = q.options.filter((o) => o !== q.answer);
    expect(distractors).toHaveLength(3);
    expect(distractors).not.toContain(q.answer);
  });

  it("is deterministic for a fixed seed", () => {
    expect(buildQuiz(pool, 5, 99).map((q) => q.card.id))
      .toEqual(buildQuiz(pool, 5, 99).map((q) => q.card.id));
  });

  it("throws when the pool is too small for 4 options", () => {
    expect(() => buildQuiz(pool.slice(0, 3), 2, 1)).toThrow();
  });

  it("listening prompt never reveals the term (answer) — audio is the only cue", () => {
    const rand = rng(11);
    const q = buildQuestion(pool[0]!, pool, "listening", rand);
    expect(q.answer).toBe(pool[0]!.term);
    // The on-screen prompt must not show the English term; only the audio clip gives it away.
    expect(q.prompt).toBe("");
    expect(q.prompt).not.toContain(q.answer);
  });
});

describe("scoring", () => {
  it("counts correct answers and records missed card ids", () => {
    const q = buildQuiz(pool, 4, 3);
    const answers = q.map((question, i) => ({
      question,
      chosen: i === 0 ? "definitely wrong" : question.answer,
    }));
    const result = scoreQuiz(answers);
    expect(result.total).toBe(4);
    expect(result.correct).toBe(3);
    expect(result.missedCardIds).toEqual([q[0]!.card.id]);
  });

  it("isCorrect matches only the exact answer", () => {
    const q = buildQuiz(pool, 1, 5)[0]!;
    expect(isCorrect(q, q.answer)).toBe(true);
    expect(isCorrect(q, q.answer + " ")).toBe(false);
  });

  it("retry-missed reduces the pool to missed cards", () => {
    const q = buildQuiz(pool, 4, 3);
    const answers = q.map((question, i) => ({ question, chosen: i < 2 ? "x" : question.answer }));
    const missed = scoreQuiz(answers).missedCardIds;
    const retryPool = pool.filter((c) => missed.includes(c.id));
    expect(retryPool.map((c) => c.id).sort()).toEqual([q[0]!.card.id, q[1]!.card.id].sort());
  });
});
