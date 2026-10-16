import type { Progress } from "./progress";
import { emptyProgress } from "./progress";

/** Device-only progress. Cloud progress is handled by CloudSync (src/cloud.ts). */
export interface ProgressStore {
  load(): Progress;
  save(p: Progress): void;
}

const KEY = "ef_progress_v3";   // v3: per-card rev + per-device sequence (no clocks)

export class LocalStore implements ProgressStore {
  constructor(private userId = "local-device") {}

  load(): Progress {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return emptyProgress(this.userId);
      const p = JSON.parse(raw) as Partial<Progress>;
      // Defensive: reset cleanly on corrupt data instead of crashing the app.
      if (!p || typeof p !== "object" || typeof p.version !== "number") return emptyProgress(this.userId);
      return {
        userId: this.userId,
        version: p.version,
        cards: p.cards && typeof p.cards === "object" ? p.cards : {},
        quiz: p.quiz && typeof p.quiz === "object" ? p.quiz : {},
        state: "active",
        devices: Array.isArray(p.devices) ? p.devices : [],
      };
    } catch {
      return emptyProgress(this.userId);
    }
  }

  save(p: Progress): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(p));
    } catch {
      /* storage full or blocked: progress stays in memory for this session */
    }
  }
}
