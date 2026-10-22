import type { LiveEvent, SessionEvent } from "@vibevalley/protocol";
import { expect, test } from "vite-plus/test";
import { SessionLogs } from "./sessionLogs";
import { stepLimit } from "../rules/rounds";

const step = (seq: number, revision = 0, text = `${seq}:${revision}`): SessionEvent => ({ seq, revision, time: seq, type: "assistant/message", text });

function source() {
  const reads: { id: string; resolve: (events: SessionEvent[]) => void; reject: (error: Error) => void }[] = [];
  let event: (e: LiveEvent) => void = () => {};
  let connected: () => void = () => {};
  let subscriptions = 0;
  let stopped = 0;
  const logs = new SessionLogs(
    (id) => new Promise((resolve, reject) => reads.push({ id, resolve, reject })),
    (onEvent, onConnected) => {
      event = onEvent;
      connected = onConnected;
      subscriptions++;
      return () => {
        stopped++;
      };
    },
  );
  return {
    logs,
    reads,
    send: (id: string, activity: SessionEvent) => event({ type: "event", at: 0, id, activity }),
    connect: () => connected(),
    subscriptions: () => subscriptions,
    stopped: () => stopped,
  };
}

test("one observed log owns snapshot/live order and shares it with every reader", async () => {
  const s = source();
  let first: SessionEvent[] = [];
  let second: SessionEvent[] = [];
  const stopFirst = s.logs.subscribe("a", (steps) => {
    first = steps;
  });
  const stopSecond = s.logs.subscribe("a", (steps) => {
    second = steps;
  });
  expect(s.reads).toHaveLength(1);
  expect(s.subscriptions()).toBe(1);
  s.send("a", step(0, 1, "newer live"));
  s.reads[0]!.resolve([step(0, 0, "older snapshot")]);
  await Promise.resolve();
  expect(first).toEqual([step(0, 1, "newer live")]);
  expect(second).toBe(first);
  s.send("a", step(0, 0, "late old live"));
  expect(second).toBe(first);

  s.connect();
  s.send("a", step(0, 1, "newer live"));
  s.reads[1]!.resolve([step(0, 2, "newer snapshot"), step(1)]);
  await Promise.resolve();
  expect(first).toEqual([step(0, 2, "newer snapshot"), step(1)]);
  expect(second).toBe(first);
  stopFirst();
  expect(s.stopped()).toBe(0);
  stopSecond();
  expect(s.stopped()).toBe(1);
});

test("a reconnect during a snapshot reads again, and removes steps outside the server's retained window", async () => {
  const s = source();
  let log: SessionEvent[] = [];
  const stop = s.logs.subscribe("a", (steps) => {
    log = steps;
  });
  s.connect();
  s.reads[0]!.resolve([step(0), step(1)]);
  await Promise.resolve();
  expect(s.reads).toHaveLength(2);
  s.send("a", step(3));
  s.reads[1]!.resolve([step(2)]);
  await Promise.resolve();
  expect(log).toEqual([step(2), step(3)]);
  for (let seq = 4; seq < stepLimit + 10; seq++) s.send("a", step(seq));
  expect(log).toHaveLength(stepLimit);
  expect(log[0]!.seq).toBe(10);
  stop();
});

test("a finished observer's late request cannot enter a new observation of the same session", async () => {
  const s = source();
  const stop = s.logs.subscribe("a", () => {});
  stop();
  let log: SessionEvent[] = [];
  const stopAgain = s.logs.subscribe("a", (steps) => {
    log = steps;
  });
  s.reads[1]!.resolve([step(3)]);
  await Promise.resolve();
  s.reads[0]!.resolve([step(0)]);
  await Promise.resolve();
  expect(log).toEqual([step(3)]);
  stopAgain();
});
