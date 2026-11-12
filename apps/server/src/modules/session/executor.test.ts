import { scriptedRuntime } from "@botiverse/oar/testing";
import { expect, test } from "vite-plus/test";

import { issueId } from "@vibevalley/protocol/schema";

import { starter, until } from "#/testing/layers.ts";
import { world } from "#/testing/world.ts";

test("regression: cancelling a close caller leaves disposal owned by the executor", async () => {
  const { promise: disposing, resolve: entered } = Promise.withResolvers<void>();
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  let disposed = 0;
  let interrupted = 0;
  const base = scriptedRuntime({
    id: "pi",
    turn: async (turn) => {
      await new Promise<void>((resolve) => turn.signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  });
  const runtime = {
    ...base,
    session: (...args: Parameters<typeof base.session>) =>
      base.session(...args).then((session) => ({
        ...session,
        abort: () => {
          interrupted++;
          return session.abort();
        },
        dispose: async () => {
          disposed++;
          entered();
          await gate;
          await session.dispose();
        },
      })),
  };
  await using farm = await world({ runtimes: [runtime], repos: ["demo"] });
  try {
    const machines = farm.session;
    const executor = machines.executions(machines.here());
    const sessions = farm.session;
    const agent = { ...starter("lab"), effort: "" };
    await farm.agent.save(agent);
    const { session: hired } = await sessions.hire(agent, "work", "demo", {
      context: { kind: "issue", issue: { id: issueId("i1"), number: 1 } },
      hiring: async (session) => {
        expect(executor.find(session.id)?.attached).toBe(false);
        const stopped2 = await sessions.stop(session.id);
        expect(stopped2).toBe(false);
        expect(interrupted).toBe(0);
      },
    });
    const id = hired.id;
    await until(() => sessions.sessionOf(id)?.phase._tag === "working", "the active turn");
    const acquired = executor.find(id)!;
    expect(Object.keys(acquired.owner).toSorted()).toEqual(["agent", "id", "issue", "repo", "runtime"]);
    expect(Object.keys(acquired).toSorted()).toEqual(["attached", "closing", "owner", "pendingTasks", "sessionId"]);
    const caller = new AbortController();
    const closing = executor.close(id, caller.signal).catch((e: unknown) => e);
    await disposing;
    caller.abort();
    await closing;
    expect(executor.find(id)?.closing).toBe(true);
    expect(acquired.closing).toBe(false);
    expect(sessions.sessionOf(id)?.phase._tag).toBe("working");
    const stopped = await sessions.stop(id);
    expect(stopped).toBe(false);
    expect(interrupted).toBe(0);
    expect(disposed).toBe(1);
    release();
    await executor.close(id);
    expect(executor.find(id)).toBeUndefined();
    expect(disposed).toBe(1);
  } finally {
    release();
  }
});
