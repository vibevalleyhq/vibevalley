import type { Cursor, Frame, RawEvent } from "@botiverse/oar";
import { describe, expect, it } from "vite-plus/test";

import type { ToolConnection } from "@vibevalley/protocol";

import { loopbackEnvironment, observeToolConnections } from "./access.ts";

describe("worker proxy bypass", () => {
  it("regression: inherited bypasses are preserved in both child variables", () => {
    const source = Object.freeze({ NO_PROXY: "corp, localhost,corp", no_proxy: "internal,::1" });
    expect(loopbackEnvironment({ HTTP_PROXY: "http://proxy" }, source)).toEqual({
      HTTP_PROXY: "http://proxy",
      NO_PROXY: "corp,localhost,internal,::1,127.0.0.1",
      no_proxy: "corp,localhost,internal,::1,127.0.0.1",
    });
    expect(source).toEqual({ NO_PROXY: "corp, localhost,corp", no_proxy: "internal,::1" });
    expect(loopbackEnvironment(undefined, {})).toEqual({ NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1" });
  });
});

it("regression: connection observation replays validated root records and releases its subscription", () => {
  const seen: ToolConnection[] = [];
  let emit: (record: RawEvent) => void = () => {};
  let stopped = false;
  const record = (native: unknown, changes: Partial<Frame> = {}): Frame => ({
    kind: "frame",
    sessionId: "root",
    agentPath: [],
    seq: 1,
    receivedAt: 1,
    body: { type: "mcpServer/startupStatus/updated", native, events: [] },
    ...changes,
  });
  const session = {
    id: "root",
    rawEvents: (observer: (record: RawEvent) => void, cursor?: Cursor) => {
      expect(cursor).toEqual({ sessionId: "root", afterSeq: -1 });
      emit = observer;
      observer(record({ name: "vibevalley", status: "failed", error: "Bearer abcdefghijklmnop" }));
      return () => {
        stopped = true;
      };
    },
  };
  const stop = observeToolConnections(session, "codex", ["vibevalley"], (connection) => seen.push(connection));
  expect(seen).toEqual([
    { server: "vibevalley", status: "unknown" },
    { server: "vibevalley", status: "failed", reason: "Bearer [redacted]" },
  ]);
  for (const native of [
    { name: "vibevalley", status: "unexpected" },
    { name: "vibevalley", status: "ready", error: 1 },
    { name: "other", status: "ready" },
  ])
    emit(record(native));
  emit(record({ name: "vibevalley", status: "ready" }, { sessionId: "foreign" }));
  emit(record({ name: "vibevalley", status: "ready" }, { agentPath: ["child"] }));
  emit(record({ name: "vibevalley", status: "ready", threadId: "foreign" }));
  expect(seen).toHaveLength(2);
  emit(record({ name: "vibevalley", status: "ready", error: null }));
  expect(seen.at(-1)).toEqual({ server: "vibevalley", status: "ready" });
  emit(record({ name: "vibevalley", status: "starting", threadId: null }));
  expect(seen.at(-1)).toEqual({ server: "vibevalley", status: "starting" });
  emit(record({ name: "vibevalley", status: "ready", threadId: "root" }));
  expect(seen.at(-1)).toEqual({ server: "vibevalley", status: "ready" });
  stop();
  expect(stopped).toBe(true);
  const unobserved: ToolConnection[] = [];
  observeToolConnections(session, "pi", ["vibevalley"], (connection) => unobserved.push(connection))();
  expect(unobserved).toEqual([{ server: "vibevalley", status: "unknown" }]);
});

it("regression: profile bypasses extend inherited entries and empty or null values do not remove loopback access", () => {
  const inherited = { NO_PROXY: "corp,localhost", no_proxy: "internal" };
  expect(loopbackEnvironment({ NO_PROXY: "profile,corp", no_proxy: "extra" }, inherited)).toEqual({
    NO_PROXY: "corp,localhost,internal,profile,extra,127.0.0.1,::1",
    no_proxy: "corp,localhost,internal,profile,extra,127.0.0.1,::1",
  });
  expect(loopbackEnvironment({ NO_PROXY: null, no_proxy: "", HTTP_PROXY: null }, inherited)).toEqual({
    NO_PROXY: "corp,localhost,internal,127.0.0.1,::1",
    no_proxy: "corp,localhost,internal,127.0.0.1,::1",
    HTTP_PROXY: null,
  });
});

it("regression: runtimes that refuse env receive no injected overrides", () => {
  expect(loopbackEnvironment(undefined, { NO_PROXY: "corp" }, "unsupported")).toBeUndefined();
  const env = Object.freeze({ SOME_SETTING: "value" });
  expect(loopbackEnvironment(env, {}, "unsupported")).toBe(env);
});
