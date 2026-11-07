import { describe, expect, it } from "vite-plus/test";

import type { SessionEvent } from "@vibevalley/protocol";

import { eventCursor } from "./issue-watch.ts";

const event = (seq: number, revision = 0, run = "one"): SessionEvent => ({ seq, revision, run, time: 0, type: "assistant/message", text: "hello" });

describe("issue watch cursor", () => {
  it("regression: replay deduplicates by session and accepts higher revisions and new runs", () => {
    const cursor = eventCursor();
    expect(cursor.accept("a", event(700))).toBe(true);
    expect(cursor.accept("a", event(700))).toBe(false);
    expect(cursor.accept("a", event(700, 1))).toBe(true);
    expect(cursor.accept("a", event(700))).toBe(false);
    expect(cursor.accept("b", event(0))).toBe(true);
    expect(cursor.accept("a", event(701, 0, "two"))).toBe(true);
  });
  it("regression: reconnect keeps event cursors independent of reset frame sequences", () => {
    const cursor = eventCursor();
    expect(cursor.accept("a", event(700))).toBe(true);
    cursor.sessions(["a"]);
    expect(cursor.accept("a", event(700))).toBe(false);
    expect(cursor.accept("a", event(701, 0, "after-restart"))).toBe(true);
  });
  it("regression: evicted event revisions cannot replay as new events", () => {
    const cursor = eventCursor();
    for (let seq = 0; seq < 1000; seq++) expect(cursor.accept("a", event(seq))).toBe(true);
    expect(cursor.accept("a", event(0, 100))).toBe(false);
    expect(cursor.accept("a", event(999, 1))).toBe(true);
    cursor.sessions(["b"]);
    expect(cursor.accept("b", event(0))).toBe(true);
  });
});
