import type { Card } from "./types";

export interface ValidationIssue {
  cardId: string;
  problem: string;
}

const MAX_TERM = 60;
const MAX_JA = 60;
const MAX_EXAMPLE = 140;
const MAX_EXAMPLE_JA = 120;

/**
 * Stage 0 content validation (spec §13). Does NOT require audio files to exist.
 * Checks schema, uniqueness, length caps, voice enum, and the 10/10 per-deck,
 * 20/20 overall Joanna/Joey balance.
 */
export function validateCards(cards: Card[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ids = new Set<string>();
  const terms = new Set<string>();

  for (const c of cards) {
    if (ids.has(c.id)) issues.push({ cardId: c.id, problem: "duplicate id" });
    ids.add(c.id);

    const key = `${c.deck}:${c.term}`;
    if (terms.has(key)) issues.push({ cardId: c.id, problem: "duplicate term in deck" });
    terms.add(key);

    if (!c.term.trim()) issues.push({ cardId: c.id, problem: "empty term" });
    if (!c.ja.trim()) issues.push({ cardId: c.id, problem: "empty ja" });
    if (c.term.length > MAX_TERM) issues.push({ cardId: c.id, problem: "term too long" });
    if (c.ja.length > MAX_JA) issues.push({ cardId: c.id, problem: "ja too long" });
    if (c.example.length > MAX_EXAMPLE) issues.push({ cardId: c.id, problem: "example too long" });
    if (c.exampleJa.length > MAX_EXAMPLE_JA) issues.push({ cardId: c.id, problem: "exampleJa too long" });
    if (c.voice !== "Joanna" && c.voice !== "Joey")
      issues.push({ cardId: c.id, problem: `invalid voice ${c.voice}` });
  }

  // voice balance per deck
  const decks = Array.from(new Set(cards.map((c) => c.deck)));
  for (const deck of decks) {
    const inDeck = cards.filter((c) => c.deck === deck);
    const joanna = inDeck.filter((c) => c.voice === "Joanna").length;
    const joey = inDeck.filter((c) => c.voice === "Joey").length;
    if (joanna !== joey)
      issues.push({ cardId: deck, problem: `voice imbalance ${joanna} Joanna / ${joey} Joey` });
  }
  return issues;
}
