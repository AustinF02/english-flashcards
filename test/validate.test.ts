import { describe, it, expect } from "vitest";
import { CARDS } from "../src/cards";
import { validateCards } from "../src/validate";
import type { Card } from "../src/types";
import exportedCards from "../cards.json";
import publicCards from "../public/cards.json";

describe("content validation (Stage 0)", () => {
  it("the 140 shipped cards are valid", () => {
    expect(validateCards(CARDS)).toEqual([]);
  });

  it("ships all six decks with the requested card counts", () => {
    expect(CARDS).toHaveLength(140);
    expect(CARDS.filter((c) => c.deck === "aws-technical")).toHaveLength(20);
    expect(CARDS.filter((c) => c.deck === "conference-conversation")).toHaveLength(20);
    expect(CARDS.filter((c) => c.deck === "west-coast-slang")).toHaveLength(20);
    expect(CARDS.filter((c) => c.deck === "arriving-in-the-us")).toHaveLength(30);
    expect(CARDS.filter((c) => c.deck === "restaurants-and-drinks")).toHaveLength(30);
    expect(CARDS.filter((c) => c.deck === "small-talk")).toHaveLength(20);
  });

  it("balances Joanna and Joey within every deck", () => {
    for (const deck of new Set(CARDS.map((c) => c.deck))) {
      const inDeck = CARDS.filter((c) => c.deck === deck);
      expect(inDeck.filter((c) => c.voice === "Joanna")).toHaveLength(inDeck.length / 2);
      expect(inDeck.filter((c) => c.voice === "Joey")).toHaveLength(inDeck.length / 2);
    }
  });

  it("exports the same cards for the website and Lambda validation", () => {
    expect(exportedCards).toEqual(CARDS);
    expect(publicCards).toEqual(CARDS);
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
