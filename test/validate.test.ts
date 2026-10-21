import { describe, it, expect } from "vitest";
import { CARDS } from "../src/cards";
import { validateCards } from "../src/validate";
import type { Card } from "../src/types";

describe("content validation (Stage 0)", () => {
  it("the 60 shipped cards are valid", () => {
    expect(validateCards(CARDS)).toEqual([]);
  });

  it("has exactly 60 cards, 20 per deck", () => {
    expect(CARDS).toHaveLength(60);
    expect(CARDS.filter((c) => c.deck === "aws-technical")).toHaveLength(20);
    expect(CARDS.filter((c) => c.deck === "conference-conversation")).toHaveLength(20);
    expect(CARDS.filter((c) => c.deck === "west-coast-slang")).toHaveLength(20);
  });

  it("each deck is 10 Joanna / 10 Joey", () => {
    for (const deck of ["aws-technical", "conference-conversation", "west-coast-slang"] as const) {
      const inDeck = CARDS.filter((c) => c.deck === deck);
      expect(inDeck.filter((c) => c.voice === "Joanna")).toHaveLength(10);
      expect(inDeck.filter((c) => c.voice === "Joey")).toHaveLength(10);
    }
  });

  it("the LinkedIn correction is present and the old phrasing is gone", () => {
    expect(CARDS.some((c) => c.term === "Could we connect on LinkedIn?")).toBe(true);
    expect(CARDS.some((c) => c.term === "Can I grab your contact?")).toBe(false);
  });

  it("cold-start card no longer claims an unconditional guarantee", () => {
    const cold = CARDS.find((c) => c.term === "cold start")!;
    expect(cold.example.toLowerCase()).not.toContain("avoid a cold start");
  });

  it("flags a duplicate id", () => {
    const first = CARDS[0]!;
    const dup: Card = { ...first, term: "something else different" };
    const issues = validateCards([first, dup]);
    expect(issues.some((i) => i.problem === "duplicate id")).toBe(true);
  });

  it("flags a voice imbalance", () => {
    const twoJoanna = CARDS.filter((c) => c.deck === "aws-technical" && c.voice === "Joanna").slice(0, 2);
    const issues = validateCards(twoJoanna);
    expect(issues.some((i) => i.problem.includes("imbalance"))).toBe(true);
  });
});
