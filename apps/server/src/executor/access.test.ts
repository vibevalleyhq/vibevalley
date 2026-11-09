import type { RawEvent, SessionOptions } from "@botiverse/oar";
import { scriptedRuntime } from "@botiverse/oar/testing";
import { it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import { expect } from "vite-plus/test";

import { issueId } from "@vibevalley/protocol/schema";

import { Core } from "#/core/core.ts";
import { Session } from "#/session/session.ts";
import { starter, until } from "#/testing/layers.ts";
import { world } from "#/testing/world.ts";

import { Executor } from "./executor.ts";

it.live("regression: worker environments merge proxy bypasses without changing their source", () => {
  const env = { NO_PROXY: "example.com,localhost,example.com", no_proxy: "internal,::1", HTTPS_PROXY: "http://proxy.invalid:8080" };
  let received: SessionOptions["env"];
  const base = scriptedRuntime({ id: "pi", turn: () => {} });
  const runtime = {
    ...base,
    session: (...args: Parameters<typeof base.session>) => {
      received = args[1].env;
      return base.session(...args);
    },
  };
  return Effect.gen(function* () {
    const sessions = yield* Session;
    const sent = yield* sessions.hire({ ...starter("lab"), effort: "", env }, "work", "demo", {
      context: { kind: "issue", issue: { id: issueId("i1"), number: 1 } },
    });
    expect(sent.refused).toBeUndefined();
    expect(received).toMatchObject({
      NO_PROXY: "example.com,localhost,internal,::1,127.0.0.1",
      no_proxy: "example.com,localhost,internal,::1,127.0.0.1",
      HTTPS_PROXY: env.HTTPS_PROXY,
    });
    expect(env).toEqual({ NO_PROXY: "example.com,localhost,example.com", no_proxy: "internal,::1", HTTPS_PROXY: "http://proxy.invalid:8080" });
  }).pipe(
    Effect.scoped,
    Effect.provide(world({ runtimes: [runtime], repos: ["demo"] })),
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
  );
});

it.live("regression: early tool connection failures reach the journal and core without failing the run", () => {
  const base = scriptedRuntime({ id: "codex", turn: () => {} });
  let released = 0;
  let subscribed = 0;
  let observing = false;
  const runtime = {
    ...base,
    session: (...args: Parameters<typeof base.session>) =>
      base.session(...args).then((session) => ({
        ...session,
        rawEvents: (observe: (record: RawEvent) => void, cursor?: Parameters<typeof session.rawEvents>[1]) => {
          const owned = observing;
          if (owned) subscribed++;
          const stop = session.rawEvents(observe, cursor);
          if (cursor?.afterSeq === -1)
            observe({
              kind: "frame",
              sessionId: session.id,
              agentPath: [],
              seq: 999,
              receivedAt: 1,
              body: { type: "mcpServer/startupStatus/updated", native: { name: "vibevalley", status: "failed", error: "connection refused" }, events: [] },
            });
          return () => {
            if (owned) released++;
            stop();
          };
        },
      })),
  };
  return Effect.gen(function* () {
    const sessions = yield* Session;
    const core = yield* Core;
    const sent = yield* sessions.hire({ ...starter("lab"), runtime: "codex", effort: "" }, "work", "demo", {
      hiring: () =>
        Effect.sync(() => {
          observing = true;
        }),
      context: { kind: "issue", issue: { id: issueId("i1"), number: 1 } },
    });
    const id = sent.session?.id;
    expect(id).toBeDefined();
    if (!id) return;
    expect(core.session(id)).toMatchObject({ toolConnections: [{ server: "vibevalley", status: "failed", reason: "connection refused" }] });
    const events2 = yield* sessions.events(id);
    expect(events2).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "run/error", connection: { server: "vibevalley", status: "failed", reason: "connection refused" } }),
      ]),
    );
    yield* until(() => core.session(id)?.phase._tag === "done", "the successful run despite optional MCP failure");
    yield* (yield* Executor).close(id);
    expect(subscribed).toBeGreaterThan(0);
    expect(released).toBe(subscribed);
  }).pipe(
    Effect.scoped,
    Effect.provide(world({ runtimes: [runtime], repos: ["demo"] })),
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
  );
});
