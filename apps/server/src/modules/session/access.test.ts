import { antigravityRuntime, type RawEvent, type SessionOptions } from "@botiverse/oar";
import { scriptedRuntime } from "@botiverse/oar/testing";
import { expect, test } from "vite-plus/test";

import { issueId } from "@vibevalley/protocol/schema";

import { starter, until } from "#/testing/layers.ts";
import { world } from "#/testing/world.ts";

import { workSessionPolicy } from "./session.ts";

/** Runs with no proxy bypass in the server's own environment, as a farm started without one. */
async function withoutProxyEnvironment<A>(work: () => Promise<A>): Promise<A> {
  const was = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
  delete process.env.NO_PROXY;
  delete process.env.no_proxy;
  try {
    return await work();
  } finally {
    for (const [key, value] of Object.entries(was))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
}

test("regression: worker environments merge proxy bypasses without changing their source", () => {
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
  return withoutProxyEnvironment(async () => {
    await using farm = await world({ runtimes: [runtime], repos: ["demo"] });
    const sessions = farm.inside;
    const sent = await sessions.hire({ ...starter("lab"), effort: "", env }, "work", "demo", {
      scope: { kind: "issue", id: issueId("i1") },
      policy: workSessionPolicy,
      checkoutNumber: 1,
    });
    expect(sent.session.id).toBeTruthy();
    expect(received).toMatchObject({
      NO_PROXY: "example.com,localhost,internal,::1,127.0.0.1",
      no_proxy: "example.com,localhost,internal,::1,127.0.0.1",
      HTTPS_PROXY: env.HTTPS_PROXY,
    });
    expect(env).toEqual({ NO_PROXY: "example.com,localhost,example.com", no_proxy: "internal,::1", HTTPS_PROXY: "http://proxy.invalid:8080" });
  });
});

test("regression: early tool connection failures reach the journal and core without failing the run", () => {
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
  return withoutProxyEnvironment(async () => {
    await using farm = await world({ runtimes: [runtime], repos: ["demo"] });
    const sessions = farm.inside;
    const core = farm.core;
    const machines = farm.inside;
    const sent = await sessions.hire({ ...starter("lab"), runtime: "codex", effort: "" }, "work", "demo", {
      hiring: async () => {
        observing = true;
      },
      scope: { kind: "issue", id: issueId("i1") },
      policy: workSessionPolicy,
      checkoutNumber: 1,
    });
    const id = sent.session.id;
    expect(core.session(id)).toMatchObject({ toolConnections: [{ server: "vibevalley", status: "failed", reason: "connection refused" }] });
    const events2 = await sessions.events(id);
    expect(events2).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "run/error", connection: { server: "vibevalley", status: "failed", reason: "connection refused" } }),
      ]),
    );
    await until(() => core.session(id)?.phase._tag === "done", "the successful run despite optional MCP failure");
    await machines.executions(machines.here()).close(id);
    expect(subscribed).toBeGreaterThan(0);
    expect(released).toBe(subscribed);
  });
});

test("regression: antigravity drops credentialed built-in mcpServers while keeping appendSystemPrompt and plain servers", () => {
  let received: SessionOptions | undefined;
  const base = scriptedRuntime({ id: "antigravity", turn: () => {} });
  const runtime = {
    ...base,
    refusedSessionOptions: antigravityRuntime.refusedSessionOptions,
    session: (...args: Parameters<typeof base.session>) => {
      received = args[1];
      return base.session(...args);
    },
  };
  return withoutProxyEnvironment(async () => {
    await using farm = await world({ runtimes: [runtime], repos: ["demo"] });
    const sessions = farm.inside;
    const core = farm.core;
    const machines = farm.inside;
    const sent = await sessions.hire(
      {
        ...starter("lab"),
        runtime: "antigravity",
        effort: "",
        personaMode: "append",
        mcpServers: [{ type: "stdio", name: "plain", command: "npx", args: [], env: {} }],
      },
      "work",
      "demo",
      { scope: { kind: "issue", id: issueId("i1") }, policy: workSessionPolicy, checkoutNumber: 1 },
    );
    expect(sent.session.id).toBeTruthy();
    expect(received?.appendSystemPrompt).toContain("## 会话命令行");
    expect(received?.mcpServers).toEqual([{ name: "plain", command: "npx", args: [], env: {} }]);
    expect(core.session(sent.session.id)?.toolConnections).toEqual([{ server: "plain", status: "unknown" }]);
    await until(() => core.session(sent.session.id)?.phase._tag === "done", "antigravity run completes without credentialed mcpServers");
    await machines.executions(machines.here()).close(sent.session.id);

    const noUserServers = await sessions.hire(
      {
        ...starter("lab"),
        runtime: "antigravity",
        effort: "",
        personaMode: "append",
        mcpServers: [],
      },
      "work",
      "demo",
      { scope: { kind: "issue", id: issueId("i1") }, policy: workSessionPolicy, checkoutNumber: 1 },
    );
    expect(received?.mcpServers).toBeUndefined();
    expect(core.session(noUserServers.session.id)?.toolConnections).toEqual([]);
    await until(() => core.session(noUserServers.session.id)?.phase._tag === "done", "antigravity run completes with no mcpServers");
    await machines.executions(machines.here()).close(noUserServers.session.id);
  });
});
