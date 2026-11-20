import { effect, signal } from "nsh";
import { expect, test } from "nsh/test";

import { type Channel, type Issue, type LiveEvent, type SessionEvent, type SessionId, type SessionView, type StateFrame } from "@vibevalley/protocol";

import "../polyfill";
import { state as baseState } from "../fixtures/workbench";
import { useNow } from "../web/base/dom";
import { mergeSteps, SessionLogs } from "../web/features/session/runs";
import { createFrames, FramesContext, type FramesSource, useIssue, useSession, useThreadOwner } from "../web/infra/frame";

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

test("mergeSteps handles fast ascending appends, stale revisions, and stepLimit eviction", () => {
  const e1 = makeEvent(1, 1);
  const e2 = makeEvent(2, 1);
  const initial = mergeSteps([], [e1, e2]);
  expect(initial.map((s) => s.seq)).toEqual([1, 2]);

  // Fast path: higher revision on tail replaces last element.
  const e2Rev2 = makeEvent(2, 2);
  const replaced = mergeSteps(initial, [e2Rev2]);
  expect(replaced.at(-1)?.revision).toBe(2);

  // Fast path: equal or lower revision returns exact same array reference.
  expect(mergeSteps(replaced, [makeEvent(2, 2)])).toBe(replaced);
  expect(mergeSteps(replaced, [makeEvent(2, 1)])).toBe(replaced);

  // Out-of-order middle event merges in seq order.
  const e3 = makeEvent(3, 1);
  const withThree = mergeSteps(replaced, [e3]);
  const withMid = mergeSteps(withThree, [makeEvent(0, 1)]);
  expect(withMid.map((s) => s.seq)).toEqual([0, 1, 2, 3]);

  // Capped at 240 events.
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

  globalThis.setInterval = ((_fn: (...args: unknown[]) => void, _ms?: number) => {
    activeIntervals++;
    createdIntervals++;
    return createdIntervals as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = ((id?: ReturnType<typeof setInterval>) => {
    if (id !== undefined) {
      clearedIds.push(id);
      activeIntervals--;
    }
  }) as typeof clearInterval;

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

test("frame indexed selectors resolve sessions, issues, and thread owners in O(1)", () => {
  let currentFrame: StateFrame = baseState;
  const listeners = new Set<() => void>();
  const source: FramesSource = {
    get: () => ({ frame: currentFrame, link: "open", count: currentFrame.seq }),
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };

  let pickedSession: SessionView | undefined;
  let pickedIssue: Issue | undefined;
  let threadOwner: SessionView | undefined;
  const session = baseState.state.sessions[0];
  const issue = baseState.state.issues[0];
  if (!session || !issue) throw new Error("expected fixture session and issue");
  const fakeThread = { id: "t-test", type: "thread", subjectKind: "talk", subjectId: session.id } as unknown as Channel;

  const alive = signal(true);
  effect(() => {
    if (!alive()) return;
    const f = createFrames(source);
    FramesContext.Provider({
      value: f,
      get children() {
        const s = useSession(() => session.id);
        const i = useIssue(() => issue.id);
        const owner = useThreadOwner(() => fakeThread);
        effect(() => {
          pickedSession = s();
          pickedIssue = i();
          threadOwner = owner();
        });
        return null;
      },
    });
  });

  expect(pickedSession?.id).toBe(session.id);
  expect(pickedIssue?.id).toBe(issue.id);
  expect(threadOwner?.id).toBe(session.id);

  currentFrame = {
    ...baseState,
    seq: baseState.seq + 1,
    state: {
      ...baseState.state,
      sessions: baseState.state.sessions.map((s) => (s.id === session.id ? { ...s, name: "Renamed" } : s)),
    },
  };
  for (const l of listeners) l();
  expect(pickedSession?.name).toBe("Renamed");
  alive.set(false);
});
