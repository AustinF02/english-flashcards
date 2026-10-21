import type { Deck } from "./types";

/**
 * Local-only quiz history log. This is intentionally separate from the synced
 * `Progress` model (src/progress.ts): that model carries per-card counters under a
 * strict conflict/dedup protocol shared with the backend, and is not a place for
 * per-session records. History is a simple device-local journal, newest first.
 *
 * Stored in its own localStorage key so it never interferes with progress sync.
 */
export interface QuizHistoryEntry {
  /** epoch milliseconds when the quiz was completed */
  at: number;
  deck: Deck;
  total: number;
  correct: number;
}

const KEY = "ef_quiz_history_v1";
const MAX_ENTRIES = 100; // cap so localStorage can't grow without bound

function isEntry(v: unknown): v is QuizHistoryEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.at === "number" &&
    (e.deck === "aws-technical" || e.deck === "conference-conversation" || e.deck === "west-coast-slang") &&
    typeof e.total === "number" &&
    typeof e.correct === "number"
  );
}

/** Read the history, newest first. Returns [] on missing or corrupt data. */
export function loadHistory(storage: Storage = localStorage): QuizHistoryEntry[] {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const entries = parsed.filter(isEntry);
    // Sort defensively so callers always get latest-to-oldest regardless of stored order.
    return entries.sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

/**
 * Append one completed quiz and persist. Returns the updated list (newest first).
 * Pure except for the storage write; the `now` arg keeps it testable.
 */
export function recordQuiz(
  entry: Omit<QuizHistoryEntry, "at">,
  storage: Storage = localStorage,
  now: number = Date.now(),
): QuizHistoryEntry[] {
  const next: QuizHistoryEntry = { at: now, ...entry };
  const list = [next, ...loadHistory(storage)].slice(0, MAX_ENTRIES);
  try {
    storage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage full or blocked: history just isn't persisted this time */
  }
  return list;
}

export function clearHistory(storage: Storage = localStorage): void {
  try {
    storage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
