import { scriptedRuntime } from "@botiverse/oar/testing";
import { it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { expect } from "vite-plus/test";

import { issueId } from "@vibevalley/protocol/schema";

import { Agent } from "#/agent/agent.ts";
import { Session } from "#/session/session.ts";
import { starter, until } from "#/testing/layers.ts";
import { world } from "#/testing/world.ts";

import { Executor } from "./executor.ts";

it.live("regression: cancelling a close caller leaves disposal owned by the executor", () => {
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
  return Effect.gen(function* () {
    const executor = yield* Executor;
    const sessions = yield* Session;
    const agent = { ...starter("lab"), effort: "" };
    yield* (yield* Agent).save(agent);
    const hired = yield* sessions.send(agent, "work", "demo", {
      context: { kind: "issue", issue: { id: issueId("i1"), number: 1 } },
      hiring: (session) =>
        Effect.gen(function* () {
          expect(executor.find(session.id)?.attached).toBe(false);
          expect(yield* sessions.stop(session.id)).toBe(false);
          expect(interrupted).toBe(0);
        }),
    });
    const id = hired.session?.id;
    expect(id).toBeDefined();
    if (id === undefined) return;
    yield* until(() => sessions.sessionOf(id)?.phase._tag === "working", "the active turn");
    const acquired = executor.find(id)!;
    expect(Object.keys(acquired.owner).toSorted()).toEqual(["agent", "id", "issue", "project", "runtime"]);
    expect(Object.keys(acquired).toSorted()).toEqual(["attached", "closing", "owner", "pendingTasks", "sessionId"]);
    const closing = yield* Effect.forkChild(executor.close(id));
    yield* Effect.promise(() => disposing);
    yield* Fiber.interrupt(closing);
    expect(executor.find(id)?.closing).toBe(true);
    expect(acquired.closing).toBe(false);
    expect(sessions.sessionOf(id)?.phase._tag).toBe("working");
    expect(yield* sessions.stop(id)).toBe(false);
    expect(interrupted).toBe(0);
    expect(disposed).toBe(1);
    release();
    yield* executor.close(id);
    expect(executor.find(id)).toBeUndefined();
    expect(disposed).toBe(1);
  }).pipe(Effect.ensuring(Effect.sync(release)), Effect.scoped, Effect.provide(world({ runtimes: [runtime], repos: ["demo"] })));
});
