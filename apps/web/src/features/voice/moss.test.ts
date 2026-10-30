import { describe, expect, it } from "vite-plus/test";

import { heard, levelOf, Playback, type MossTurn } from "./moss";

describe("heard", () => {
  it("revises a turn's words in place and starts a line for the next turn", () => {
    let turns: MossTurn[] = [];
    turns = heard(turns, "moss", "t1", "Hel", false);
    turns = heard(turns, "moss", "t1", "Hello", true);
    turns = heard(turns, "moss", "t2", "Again", false);
    expect(turns).toEqual([
      { who: "moss", key: "t1", text: "Hello", done: true },
      { who: "moss", key: "t2", text: "Again", done: false },
    ]);
  });

  it("names the owner's line when MOSS names its turn, and keeps the sides apart", () => {
    let turns: MossTurn[] = [];
    turns = heard(turns, "owner", "", "hi", false);
    turns = heard(turns, "moss", "m1", "yes", false);
    turns = heard(turns, "owner", "o1", "hi there", true);
    expect(turns).toEqual([
      { who: "owner", key: "o1", text: "hi there", done: true },
      { who: "moss", key: "m1", text: "yes", done: false },
    ]);
  });

  it("ignores empty words", () => {
    expect(heard([], "owner", "o1", "", false)).toEqual([]);
  });
});

describe("levelOf", () => {
  it("is 0 for silence and nothing, and tops out at 100", () => {
    expect(levelOf(new Int16Array(320))).toBe(0);
    expect(levelOf(new Int16Array(0))).toBe(0);
    expect(levelOf(new Int16Array(320).fill(0x7fff))).toBe(100);
  });
});

const piece = (chunk: string, run = "r1", turn = "t1") => ({ chunk, run, turn });

describe("Playback", () => {
  it("queues pieces back to back, and says a run is complete once it is both sent and played", () => {
    const p = new Playback();
    const a = p.queue(piece("c1"), 0.2, 1);
    const b = p.queue(piece("c2"), 0.2, 1.05);
    expect([a.at, b.at]).toEqual([1, 1.2]);
    expect(p.aheadMs(1.1)).toBe(300);
    expect(p.ended(a)).toEqual([{ action: "playback.chunk.completed", chunk_id: "c1", run_id: "r1", turn_id: "t1" }]);
    expect(p.sent("r1", "t1")).toEqual([]);
    expect(p.ended(b)).toEqual([
      { action: "playback.chunk.completed", chunk_id: "c2", run_id: "r1", turn_id: "t1" },
      { action: "playback.completed", run_id: "r1", turn_id: "t1" },
    ]);
    expect(p.gaps).toBe(0);
  });

  it("completes a run sent after its last piece played", () => {
    const p = new Playback();
    p.ended(p.queue(piece("c1"), 0.2, 0));
    expect(p.sent("r1", "t1")).toEqual([{ action: "playback.completed", run_id: "r1", turn_id: "t1" }]);
  });

  it("counts a gap when a run's next piece comes after the one before has finished", () => {
    const p = new Playback();
    p.queue(piece("c1"), 0.2, 0);
    p.queue(piece("c2"), 0.2, 0.5);
    p.queue(piece("c3", "r2"), 0.2, 2);
    expect(p.gaps).toBe(1);
  });

  it("cuts a run with how far it got, and a piece cut off reports nothing when it ends", () => {
    const p = new Playback();
    const a = p.queue(piece("c1"), 0.2, 0);
    const b = p.queue(piece("c2"), 0.2, 0);
    p.ended(a);
    const { stop, actions } = p.cut("r1", "t1", 0.25);
    expect(stop).toEqual([b]);
    expect(actions).toEqual([{ action: "playback.stopped", run_id: "r1", turn_id: "t1", played_audio_ms: 250 }]);
    expect(p.ended(b)).toEqual([]);
    expect(p.aheadMs(0.25)).toBe(0);
  });

  it("says nothing when cutting a run it never heard of", () => {
    expect(new Playback().cut("r9", "t9", 1)).toEqual({ stop: [], actions: [] });
  });
});
