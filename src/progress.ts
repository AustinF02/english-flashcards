import type { CardStatus } from "./types";

/**
 * Progress model shared by local mode, the cloud client and (mirrored in
 * backend/handler.py, driven by the same test/vectors/progress.json) the server.
 *
 * CONFLICT RULE (no clocks anywhere):
 *   Every card has a revision `rev` (0 = never decided). A status op carries the
 *   `baseRev` the device saw when the user decided. The server applies it only if
 *   baseRev === the card's current rev, then bumps rev. Otherwise the op is STALE:
 *   another device decided first, the op is dropped, and the device adopts the
 *   server state. So: first decision to REACH the server wins; a late offline
 *   decision can never overwrite a newer one; different cards never conflict.
 *   Limitation: the losing device's decision is discarded, not merged.
 *
 * IDEMPOTENCY WINDOW (exact, not "recent 200"):
 *   Each device numbers its ops 1,2,3... The server keeps one high-water mark per
 *   device; an op with seq <= mark is a DUPLICATE and does nothing, however old.
 *   At most MAX_DEVICES (10) devices are remembered per user, least-recently-used
 *   evicted first. A device the server does not know may only start at seq 1;
 *   anything else is EXPIRED (rejected, not applied). Known limit: a device that
 *   was evicted and then replays its very first op (seq 1) looks like a new device.
 */
export interface CardProgress {
  status: CardStatus;
  rev: number;
}

export interface QuizCounter {
  seen: number;
  correct: number;
}

export type DeviceEntry = [deviceId: string, lastSeq: number];
export type AccountState = "active" | "deleting" | "deleted";

export interface Progress {
  userId: string;
  version: number;
  state: AccountState;
  cards: Record<string, CardProgress>;
  quiz: Record<string, QuizCounter>;
  /** least-recently-used first */
  devices: DeviceEntry[];
}

export type ProgressOp =
  | { kind: "status"; deviceId: string; seq: number; cardId: string; status: CardStatus; baseRev: number }
  | { kind: "quiz"; deviceId: string; seq: number; cardId: string; correct: boolean };

export type Outcome = "applied" | "duplicate" | "stale" | "expired";
export interface OpResult {
  deviceId: string;
  seq: number;
  outcome: Outcome;
}

export const MAX_DEVICES = 10;

export function emptyProgress(userId: string): Progress {
  return { userId, version: 0, state: "active", cards: {}, quiz: {}, devices: [] };
}

/** Next sequence number for a device that is already in `p` (or 1 if unknown). */
export function nextLocalSeq(p: Progress, deviceId: string): number {
  return (p.devices.find(([id]) => id === deviceId)?.[1] ?? 0) + 1;
}

/** Apply ops in order. Pure: returns a new state and one result per op. */
export function applyOps(prev: Progress, ops: ProgressOp[]): { state: Progress; results: OpResult[] } {
  const state: Progress = {
    ...prev,
    cards: { ...prev.cards },
    quiz: Object.fromEntries(Object.entries(prev.quiz).map(([k, v]) => [k, { ...v }])),
    devices: prev.devices.map(([id, s]) => [id, s] as DeviceEntry),
  };
  const results: OpResult[] = [];
  let changed = false;

  for (const op of ops) {
    const done = (outcome: Outcome) => results.push({ deviceId: op.deviceId, seq: op.seq, outcome });
    const at = state.devices.findIndex(([id]) => id === op.deviceId);

    if (at === -1) {
      if (op.seq !== 1) { done("expired"); continue; }
      state.devices.push([op.deviceId, 0]);
      if (state.devices.length > MAX_DEVICES) state.devices.shift();
    } else if (op.seq <= state.devices[at]![1]) {
      done("duplicate");
      continue;
    }

    // the op is processed from here on: advance the device mark and mark it most-recently-used
    const i = state.devices.findIndex(([id]) => id === op.deviceId);
    state.devices.splice(i, 1);
    state.devices.push([op.deviceId, op.seq]);
    changed = true;

    if (op.kind === "status") {
      const cur = state.cards[op.cardId] ?? { status: op.status, rev: 0 };
      if (op.baseRev !== cur.rev) { done("stale"); continue; }
      state.cards[op.cardId] = { status: op.status, rev: cur.rev + 1 };
    } else {
      const c = state.quiz[op.cardId] ?? { seen: 0, correct: 0 };
      state.quiz[op.cardId] = { seen: c.seen + 1, correct: c.correct + (op.correct ? 1 : 0) };
    }
    done("applied");
  }

  if (changed) state.version = prev.version + 1;
  return { state, results };
}
