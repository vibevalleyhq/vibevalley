import { describe, expect, test } from "vite-plus/test";

import type { BoardSlice, SessionEvent, SliceKind } from "../index";
import { SessionId } from "../schema";
import { applySessionWatchEvent, createSliceStore, EMPTY_SESSION_WATCH_STATE, mergeSessionEvents, type SliceMap } from "./index";

describe("client SliceStore & SessionWatch reducer", () => {
  test("createSliceStore refcounts subscriptions, preserves snapshot on refresh, and reconnects active channels", () => {
    const callbacks = new Map<SliceKind, ((data: unknown) => void)[]>();
    let stops = 0;
    const store = createSliceStore(() => ({
      slice: <K extends SliceKind>(kind: K, on: (data: SliceMap[K]) => void) => {
        const list = callbacks.get(kind) ?? [];
        list.push(on as (data: unknown) => void);
        callbacks.set(kind, list);
        return () => {
          stops += 1;
        };
      },
    }));

    expect(store.link()).toBe("connecting");
    let linkTicks = 0;
    const stopLink = store.subscribeLink(() => {
      linkTicks += 1;
    });

    let boardTicks = 0;
    const unsub1 = store.subscribe("board", () => {
      boardTicks += 1;
    });
    const unsub2 = store.subscribe("board", () => {});
    expect(callbacks.get("board")?.length).toBe(1);

    const frame1 = { seq: 1, issues: [], notes: [] } as unknown as BoardSlice;
    callbacks.get("board")?.[0]?.(frame1);
    expect(store.get("board")).toBe(frame1);
    expect(store.link()).toBe("open");
    expect(boardTicks).toBe(1);
    expect(linkTicks).toBe(1);

    // Refresh reconnects without clearing cached snapshot
    store.refresh("board");
    expect(store.get("board")).toBe(frame1);
    expect(callbacks.get("board")?.length).toBe(2);

    // reconnectAll resets link and re-subscribes active channels
    store.reconnectAll();
    expect(store.link()).toBe("connecting");
    expect(store.get("board")).toBeUndefined();
    expect(callbacks.get("board")?.length).toBe(3);

    unsub1();
    expect(stops).toBe(2);
    unsub2();
    expect(stops).toBe(3);
    stopLink();
  });

  test("mergeSessionEvents and applySessionWatchEvent fold revisions and permission/interaction queues", () => {
    const e1: SessionEvent = { seq: 2, revision: 1, time: 10, type: "assistant/message", text: "v1" };
    const e1Updated: SessionEvent = { seq: 2, revision: 2, time: 11, type: "assistant/message", text: "v2" };
    const e0: SessionEvent = { seq: 1, revision: 1, time: 5, type: "user/message", text: "hi" };
    const merged = mergeSessionEvents([e1], [e0, e1Updated]);
    expect(merged.map((e) => [e.seq, e.text])).toEqual([
      [1, "hi"],
      [2, "v2"],
    ]);

    const permReq = {
      requestId: "req-1",
      tool: "bash",
      summary: "Run tests",
      options: [],
      at: 100,
    };
    const sid = SessionId.parse("sess-1");
    const s1 = applySessionWatchEvent(EMPTY_SESSION_WATCH_STATE, {
      kind: "event",
      session: sid,
      event: { seq: 3, revision: 1, time: 100, type: "permission/request", text: "", permission: permReq },
    });
    expect(s1.pendingPermissions).toHaveLength(1);

    const s2 = applySessionWatchEvent(s1, {
      kind: "event",
      session: sid,
      event: { seq: 4, revision: 1, time: 105, type: "permission/resolved", text: "", permission: permReq },
    });
    expect(s2.pendingPermissions).toHaveLength(0);

    const s3 = applySessionWatchEvent(s2, { kind: "missing", session: sid });
    expect(s3.missing).toBe(true);
  });
});
