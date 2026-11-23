import { effect, signal } from "nsh";
import { expect, test } from "nsh/test";

import {
  type Channel,
  type Issue,
  type LiveEvent,
  type SessionEvent,
  type SessionId,
  type SessionView,
  type SliceBundle,
  type SliceKind,
} from "@vibevalley/protocol";

import "../infra/polyfill";
import { createComposer, draftOf, drafts, flushDrafts } from "../features/channel/model/composing";
import { mergeSteps, SessionLogs } from "../features/session/runs";
import { state as baseState } from "../fixtures/workbench";
import { useNow } from "../infra/base/dom";
import {
  createSlices,
  type Link,
  SlicesContext,
  type SlicesSource,
  useBoardSlice,
  useCollabSlice,
  useIssue,
  useSession,
  useSessionsSlice,
  useThreadOwner,
} from "../infra/frame";
import type { SliceMap } from "../infra/transport";

function makeEvent(seq: number, revision = 1, run = "r1"): SessionEvent {
  return {
    seq,
    revision,
    time: seq * 100,
    type: "assistant/message",
    run,
    text: `step-${seq}-rev-${revision}`,
  };
}

function createMockSlicesSource(initial: SliceBundle) {
  const values: { [K in SliceKind]: SliceMap[K] } = {
    board: initial.board,
    sessions: initial.sessions,
    collab: initial.collab,
    inbox: initial.inbox,
    ops: initial.ops,
    farm: initial.farm,
  };
  const sliceListeners: { readonly [K in SliceKind]: Set<() => void> } = {
    board: new Set(),
    sessions: new Set(),
    collab: new Set(),
    inbox: new Set(),
    ops: new Set(),
    farm: new Set(),
  };
  let link: Link = "open";
  const linkListeners = new Set<() => void>();

  const source: SlicesSource = {
    get: <K extends SliceKind>(kind: K): SliceMap[K] => values[kind],
    subscribe: (kind: SliceKind, listener: () => void) => {
      sliceListeners[kind].add(listener);
      return () => {
        sliceListeners[kind].delete(listener);
      };
    },
    link: () => link,
    subscribeLink: (listener) => {
      linkListeners.add(listener);
      return () => {
        linkListeners.delete(listener);
      };
    },
  };

  return {
    source,
    push: <K extends SliceKind>(kind: K, next: SliceMap[K]) => {
      values[kind] = next;
      for (const listener of [...sliceListeners[kind]]) listener();
    },
    setLink: (next: Link) => {
      link = next;
      for (const listener of [...linkListeners]) listener();
    },
  };
}

test("mergeSteps handles fast ascending appends, stale revisions, and stepLimit eviction", () => {
  const e1 = makeEvent(1, 1);
  const e2 = makeEvent(2, 1);
  const initial = mergeSteps([], [e1, e2]);
  expect(initial.map((s) => s.seq)).toEqual([1, 2]);

  const e2Rev2 = makeEvent(2, 2);
  const replaced = mergeSteps(initial, [e2Rev2]);
  expect(replaced.at(-1)?.revision).toBe(2);

  expect(mergeSteps(replaced, [makeEvent(2, 2)])).toBe(replaced);
  expect(mergeSteps(replaced, [makeEvent(2, 1)])).toBe(replaced);

  const e3 = makeEvent(3, 1);
  const withThree = mergeSteps(replaced, [e3]);
  const withMid = mergeSteps(withThree, [makeEvent(0, 1)]);
  expect(withMid.map((s) => s.seq)).toEqual([0, 1, 2, 3]);

  let log: SessionEvent[] = [];
  for (let i = 1; i <= 260; i++) log = mergeSteps(log, [makeEvent(i, 1)]);
  expect(log.length).toBe(240);
  expect(log[0]?.seq).toBe(21);
  expect(log.at(-1)?.seq).toBe(260);
});

test("SessionLogs.subscribeRun isolates live updates to the target run", async () => {
  let pushLive: ((e: LiveEvent) => void) | undefined;
  const logs = new SessionLogs(
    () => Promise.resolve([makeEvent(1, 1, "run-1"), makeEvent(2, 1, "run-2")]),
    (onEvent, connected) => {
      pushLive = onEvent;
      connected();
      return () => {
        pushLive = undefined;
      };
    },
  );

  const sid = "s1" as SessionId;
  const run1Updates: SessionEvent[][] = [];
  const run2Updates: SessionEvent[][] = [];
  const off1 = logs.subscribeRun(sid, "run-1", (steps) => run1Updates.push(steps));
  const off2 = logs.subscribeRun(sid, "run-2", (steps) => run2Updates.push(steps));

  await Promise.resolve();
  await Promise.resolve();
  expect(run1Updates.at(-1)?.map((s) => s.seq)).toEqual([1]);
  expect(run2Updates.at(-1)?.map((s) => s.seq)).toEqual([2]);

  const run1CallsBeforeLive = run1Updates.length;
  pushLive?.({ type: "event", at: 300, id: sid, activity: makeEvent(3, 1, "run-2") });
  pushLive?.({ type: "event", at: 400, id: sid, activity: makeEvent(4, 1, "run-2") });

  expect(run1Updates.length).toBe(run1CallsBeforeLive);
  expect(run2Updates.at(-1)?.map((s) => s.seq)).toEqual([2, 3, 4]);

  off1();
  off2();
});

test("useNow shares one setInterval per interval bucket and clears when the last listener unmounts", () => {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  let activeIntervals = 0;
  let createdIntervals = 0;
  const clearedIds: unknown[] = [];

  globalThis.setInterval = (_fn: (...args: unknown[]) => void, _ms?: number) => {
    activeIntervals++;
    createdIntervals++;
    return createdIntervals;
  };
  globalThis.clearInterval = (id?: number) => {
    if (id !== undefined) {
      clearedIds.push(id);
      activeIntervals--;
    }
  };

  try {
    const mounted = signal(true);
    effect(() => {
      if (!mounted()) return;
      const a = useNow(12_345);
      const b = useNow(12_345);
      expect(typeof a()).toBe("number");
      expect(typeof b()).toBe("number");
    });
    expect(createdIntervals).toBe(1);
    expect(activeIntervals).toBe(1);
    mounted.set(false);
    expect(activeIntervals).toBe(0);
    expect(clearedIds.length).toBe(1);
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
});

test("slice indexed selectors resolve in O(1) and isolate reactivity per slice", () => {
  const mock = createMockSlicesSource(baseState);

  let pickedSession: SessionView | undefined;
  let pickedIssue: Issue | undefined;
  let threadOwner: SessionView | undefined;
  let boardRuns = 0;
  let sessionsRuns = 0;
  let collabRuns = 0;

  const session = baseState.sessions.sessions.at(0);
  const issue = baseState.board.issues.at(0);
  if (!session || !issue) throw new Error("expected fixture session and issue");
  const fakeThread = { id: "t-test", type: "thread", subjectKind: "talk", subjectId: session.id } as unknown as Channel;

  const alive = signal(true);
  effect(() => {
    if (!alive()) return;
    const s = createSlices(mock.source);
    SlicesContext.Provider({
      value: s,
      get children() {
        const board = useBoardSlice();
        const sessions = useSessionsSlice();
        const collab = useCollabSlice();
        const selSession = useSession(() => session.id);
        const selIssue = useIssue(() => issue.id);
        const owner = useThreadOwner(() => fakeThread);

        effect(() => {
          boardRuns++;
          void board();
          pickedIssue = selIssue();
        });
        effect(() => {
          sessionsRuns++;
          void sessions();
          pickedSession = selSession();
          threadOwner = owner();
        });
        effect(() => {
          collabRuns++;
          void collab();
        });
        return null;
      },
    });
  });

  expect(pickedSession?.id).toBe(session.id);
  expect(pickedIssue?.id).toBe(issue.id);
  expect(threadOwner?.id).toBe(session.id);
  expect(boardRuns).toBe(1);
  expect(sessionsRuns).toBe(1);
  expect(collabRuns).toBe(1);

  mock.push("collab", { ...baseState.collab, seq: baseState.collab.seq + 1 });
  expect(collabRuns).toBe(2);
  expect(boardRuns).toBe(1);
  expect(sessionsRuns).toBe(1);

  mock.push("sessions", {
    ...baseState.sessions,
    seq: baseState.sessions.seq + 1,
    sessions: baseState.sessions.sessions.map((x) => (x.id === session.id ? { ...x, name: "Renamed" } : x)),
  });
  expect(pickedSession?.name).toBe("Renamed");
  expect(threadOwner?.name).toBe("Renamed");
  expect(sessionsRuns).toBe(2);
  expect(boardRuns).toBe(1);
  expect(collabRuns).toBe(2);

  mock.push("board", {
    ...baseState.board,
    seq: baseState.board.seq + 1,
    issues: baseState.board.issues.map((x) => (x.id === issue.id ? { ...x, title: "Updated title" } : x)),
  });
  expect(pickedIssue?.title).toBe("Updated title");
  expect(boardRuns).toBe(2);
  expect(sessionsRuns).toBe(2);
  expect(collabRuns).toBe(2);

  alive.set(false);
});

test("drafts.text debounces localStorage writes and createComposer memoizes canSend across typing", () => {
  const realSetItem = localStorage.setItem.bind(localStorage);
  const draftWrites: string[] = [];
  localStorage.setItem = (key: string, value: string) => {
    if (key === "vibevalley.chat.drafts") draftWrites.push(value);
    realSetItem(key, value);
  };

  try {
    const channel = "perf-draft-channel";
    drafts.clear(channel);
    draftWrites.length = 0;

    let typed = "";
    const chars = "abcdefghijklmnopqrst";
    for (const ch of chars) {
      typed += ch;
      drafts.text(channel, typed);
    }
    expect(draftWrites.length).toBe(0);
    expect(draftOf(channel).text).toBe(chars);

    flushDrafts();
    expect(draftWrites.length).toBe(1);
    expect(JSON.parse(draftWrites[0] ?? "{}")).toMatchObject({ [channel]: { text: chars } });

    drafts.text(channel, "cancelled-before-flush");
    drafts.clear(channel);
    flushDrafts();
    expect(draftWrites.length).toBe(2);
    expect(JSON.parse(draftWrites[1] ?? "{}")[channel]).toBeUndefined();
    expect(draftOf(channel).text).toBeUndefined();

    // Buffered text must survive drafts.reply without losing what was typed.
    drafts.text(channel, "draft-with-reply");
    drafts.reply(channel, { id: "m-1", number: 7 } as unknown as Parameters<typeof drafts.reply>[1]);
    expect(draftOf(channel)).toMatchObject({ text: "draft-with-reply", reply: { id: "m-1", number: 7 } });
    expect(draftWrites.length).toBe(3);
    drafts.clear(channel);
    expect(draftWrites.length).toBe(4);

    const alive = signal(true);
    const canSendHistory: boolean[] = [];
    let box!: ReturnType<typeof createComposer>;
    effect(() => {
      if (!alive()) return;
      box = createComposer(
        () => undefined,
        () => undefined,
        () => {},
        {
          target: () => ({ id: channel, ...(draftOf(channel).files.length > 0 ? { attachments: draftOf(channel).files.map((f) => f.id) } : {}) }),
          says: { send: () => ({ done: Promise.resolve(undefined) }), items: () => [] } as unknown as Parameters<typeof createComposer>[3]["says"],
          failed: () => {},
          edited: (v) => drafts.text(channel, v),
        },
      );
      effect(() => {
        canSendHistory.push(box.canSend());
      });
    });

    expect(canSendHistory).toEqual([false]);
    let boxText = "";
    for (let i = 0; i < chars.length; i++) {
      boxText += chars[i];
      box.edit(boxText, i + 1);
    }
    expect(canSendHistory).toEqual([false, true]);
    expect(draftWrites.length).toBe(4);
    flushDrafts();
    expect(draftWrites.length).toBe(5);

    drafts.clear(channel);
    alive.set(false);
  } finally {
    localStorage.setItem = realSetItem;
  }
});
