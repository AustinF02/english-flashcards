import { describe, it, expect } from "vitest";
import { CloudSync } from "../src/cloud";
import { applyOps, emptyProgress } from "../src/progress";
import type { Progress, ProgressOp, OpResult } from "../src/progress";
import { reconcileDevice } from "../src/device";

/** In-memory fake of the server contract (mirrors backend/handler.py). Nothing real is contacted. */
function fakeServer() {
  let item: Progress = emptyProgress("srv");
  let failNextResponse = false;
  let status = 200;
  return {
    set httpStatus(s: number) { status = s; },
    failNextResponseOnce() { failNextResponse = true; },
    other(op: ProgressOp) { item = applyOps(item, [op]).state; },
    get item() { return item; },
    fetch: async (method: string, body?: { baseVersion: number; ops: ProgressOp[] }) => {
      if (status !== 200) return { status, json: {} };
      if (method === "GET") return { status: 200, json: structuredClone(item) };
      if (body!.baseVersion !== item.version) return { status: 409, json: structuredClone(item) };
      const r = applyOps(item, body!.ops);
      item = r.state;
      if (failNextResponse) { failNextResponse = false; throw new Error("network dropped after commit"); }
      return { status: 200, json: { ...structuredClone(item), results: r.results satisfies OpResult[] } };
    },
  };
}

const st = (seq: number, cardId: string, s: "known" | "learning", baseRev = 0, deviceId = "A"): ProgressOp =>
  ({ kind: "status", deviceId, seq, cardId, status: s, baseRev });
const qz = (seq: number, cardId = "t01", correct = true, deviceId = "A"): ProgressOp =>
  ({ kind: "quiz", deviceId, seq, cardId, correct });

describe("CloudSync", () => {
  it("pulls the server item", async () => {
    const srv = fakeServer();
    srv.other(st(1, "t01", "known", 0, "B"));
    const p = await new CloudSync(srv.fetch).pull();
    expect(p.cards["t01"]!.status).toBe("known");
  });

  it("pushes pending ops and clears them", async () => {
    const srv = fakeServer();
    const sync = new CloudSync(srv.fetch);
    await sync.pull();
    sync.enqueue(st(1, "t02", "known"));
    const res = await sync.push();
    expect(res).toMatchObject({ state: "synced", dropped: 0 });
    expect(sync.pending).toHaveLength(0);
    expect(res.progress.cards["t02"]!.rev).toBe(1);
  });

  it("different cards edited on two devices both survive a 409", async () => {
    const srv = fakeServer();
    const sync = new CloudSync(srv.fetch);
    await sync.pull();
    srv.other(st(1, "t03", "known", 0, "B"));
    sync.enqueue(st(1, "t04", "known"));
    const res = await sync.push();
    expect(res.state).toBe("synced");
    expect(res.progress.cards["t03"]!.status).toBe("known");
    expect(res.progress.cards["t04"]!.status).toBe("known");
  });

  it("the same card decided on two devices: the later arrival is dropped and counted", async () => {
    const srv = fakeServer();
    const sync = new CloudSync(srv.fetch);
    await sync.pull();
    srv.other(st(1, "t01", "learning", 0, "B"));      // B reaches the server first
    sync.enqueue(st(1, "t01", "known", 0));          // A decided earlier but arrives later
    const res = await sync.push();
    expect(res.progress.cards["t01"]!.status).toBe("learning");
    expect(res.dropped).toBe(1);
    expect(sync.pending).toHaveLength(0);
  });

  it("a response lost after the server committed is retried without double counting", async () => {
    const srv = fakeServer();
    const sync = new CloudSync(srv.fetch);
    await sync.pull();
    sync.enqueue(qz(1));
    srv.failNextResponseOnce();
    expect((await sync.push()).state).toBe("offline");
    expect(sync.pending).toHaveLength(1);
    const second = await sync.push();
    expect(second.state).toBe("synced");
    expect(second.progress.quiz["t01"]).toEqual({ seen: 1, correct: 1 });
  });

  it("many replays never change the totals", async () => {
    const srv = fakeServer();
    const sync = new CloudSync(srv.fetch);
    await sync.pull();
    for (let i = 0; i < 20; i++) {
      sync.enqueue(qz(1));          // the same op resent again and again
      await sync.push();
    }
    expect(srv.item.quiz["t01"]).toEqual({ seen: 1, correct: 1 });
  });

  it("an op the server calls expired is dropped and reported so the device can re-register", async () => {
    const srv = fakeServer();
    const sync = new CloudSync(srv.fetch);
    await sync.pull();
    sync.enqueue(qz(7, "t01", true, "evicted"));
    const res = await sync.push();
    expect(res).toMatchObject({ state: "synced", dropped: 1, expired: true });
    expect(srv.item.quiz).toEqual({});
  });

  it("stays offline (keeps ops) when the network is down", async () => {
    const sync = new CloudSync(async () => { throw new Error("down"); });
    sync.enqueue(st(1, "t01", "known"));
    expect((await sync.push()).state).toBe("offline");
    expect(sync.pending).toHaveLength(1);
  });

  it("401 reports signed-out and keeps the ops", async () => {
    const srv = fakeServer();
    srv.httpStatus = 401;
    const sync = new CloudSync(srv.fetch);
    sync.enqueue(st(1, "t01", "known"));
    expect((await sync.push()).state).toBe("signed-out");
    expect(sync.pending).toHaveLength(1);
  });

  it("410 means the account was deleted: ops are discarded, not retried", async () => {
    const srv = fakeServer();
    srv.httpStatus = 410;
    const sync = new CloudSync(srv.fetch);
    sync.enqueue(st(1, "t01", "known"));
    expect((await sync.push()).state).toBe("deleted");
    expect(sync.pending).toHaveLength(0);
  });

  it("gives up after bounded retries instead of looping", async () => {
    let n = 0;
    const alwaysConflict = async (m: string) => {
      n++;
      return m === "GET" ? { status: 200, json: emptyProgress("s") } : { status: 409, json: { ...emptyProgress("s"), version: n } };
    };
    const sync = new CloudSync(alwaysConflict);
    await sync.pull();
    sync.enqueue(st(1, "t01", "known"));
    expect((await sync.push()).state).toBe("conflict");
    expect(n).toBeLessThan(12);
    expect(sync.pending).toHaveLength(1);
  });
});

describe("device identity (reconcileDevice)", () => {
  const fresh = () => "NEWID";
  it("first ever use: new id, seq 1", () => {
    expect(reconcileDevice(null, [], fresh)).toEqual({ id: "NEWID", nextSeq: 1 });
  });
  it("known to the server: keeps its id and continues after the server's mark", () => {
    expect(reconcileDevice({ id: "A", nextSeq: 3 }, [["A", 9]], fresh)).toEqual({ id: "A", nextSeq: 10 });
  });
  it("never goes backwards if local storage is ahead", () => {
    expect(reconcileDevice({ id: "A", nextSeq: 20 }, [["A", 9]], fresh)).toEqual({ id: "A", nextSeq: 20 });
  });
  it("unknown to the server (evicted, other user, cleared): fresh identity at seq 1", () => {
    expect(reconcileDevice({ id: "A", nextSeq: 57 }, [["B", 2]], fresh)).toEqual({ id: "NEWID", nextSeq: 1 });
  });
});
