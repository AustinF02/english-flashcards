import type { OpResult, Progress, ProgressOp } from "./progress";
import { emptyProgress } from "./progress";

export type SyncState = "synced" | "offline" | "signed-out" | "conflict" | "deleted";

export interface Transport {
  (method: "GET" | "PUT", body?: { baseVersion: number; ops: ProgressOp[] }): Promise<{
    status: number;
    json: unknown;
  }>;
}

export interface PushResult {
  state: SyncState;
  progress: Progress;
  /** ops the server received but did not apply (stale or expired): another device's decision won */
  dropped: number;
  /** the server did not recognise our device; the caller must start a fresh identity */
  expired: boolean;
}

const MAX_ATTEMPTS = 3;

/**
 * Client-side sync (spec §7.5). A 409 means "your base version is old": adopt the server's
 * copy and resend the SAME ops. That is safe because the server dedups by (device, seq) and
 * resolves each card by its revision, never by a clock.
 */
export class CloudSync {
  private base: Progress = emptyProgress("pending");
  private queue: ProgressOp[] = [];

  constructor(private transport: Transport) {}

  get pending(): ProgressOp[] { return this.queue; }
  get current(): Progress { return this.base; }

  enqueue(op: ProgressOp): void { this.queue.push(op); }

  async pull(): Promise<Progress> {
    const r = await this.transport("GET");
    if (r.status === 200) this.base = r.json as Progress;
    return this.base;
  }

  async push(): Promise<PushResult> {
    const out = (state: SyncState, dropped = 0, expired = false): PushResult =>
      ({ state, progress: this.base, dropped, expired });
    if (this.queue.length === 0) return out("synced");

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let r;
      try {
        r = await this.transport("PUT", { baseVersion: this.base.version, ops: this.queue });
      } catch {
        return out("offline");
      }
      if (r.status === 200) {
        const body = r.json as Progress & { results?: OpResult[] };
        const results = body.results ?? [];
        const { results: _drop, ...progress } = body;
        this.base = progress as Progress;
        this.queue = [];
        return out(
          "synced",
          results.filter((x) => x.outcome === "stale" || x.outcome === "expired").length,
          results.some((x) => x.outcome === "expired"),
        );
      }
      if (r.status === 401 || r.status === 403) return out("signed-out");
      if (r.status === 410) { this.queue = []; return out("deleted"); }
      if (r.status === 409) { this.base = r.json as Progress; continue; }
      return out("offline");
    }
    return out("conflict");
  }
}
