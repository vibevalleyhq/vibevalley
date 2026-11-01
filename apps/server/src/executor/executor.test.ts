import { scriptedRuntime } from "@botiverse/oar/testing";
import { it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { expect } from "vite-plus/test";

import { issueId } from "@vibevalley/protocol/schema";

import { Agent } from "@/agent/agent.ts";
import { Session } from "@/session/session.ts";
import { starter } from "@/testing/layers.ts";
import { world } from "@/testing/world.ts";

import { Executor } from "./executor.ts";

it.live("regression: cancelling a close caller leaves disposal owned by the executor", () => {
  const { promise: disposing, resolve: entered } = Promise.withResolvers<void>();
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  let disposed = 0;
  const base = scriptedRuntime({ id: "pi", turn: async (turn) => turn.say("done") });
  const runtime = {
    ...base,
    session: (...args: Parameters<typeof base.session>) =>
      base.session(...args).then((session) => ({
        ...session,
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
    const hired = yield* sessions.send(agent, "work", "demo", { context: { kind: "issue", issue: { id: issueId("i1"), number: 1 } } });
    const id = hired.session?.id;
    expect(id).toBeDefined();
    if (id === undefined) return;
    const closing = yield* Effect.forkChild(executor.close(id));
    yield* Effect.promise(() => disposing);
    yield* Fiber.interrupt(closing);
    expect(executor.find(id)?.closing).toBe(true);
    expect(disposed).toBe(1);
    release();
    yield* executor.close(id);
    expect(executor.find(id)).toBeUndefined();
    expect(disposed).toBe(1);
  }).pipe(Effect.ensuring(Effect.sync(release)), Effect.scoped, Effect.provide(world({ runtimes: [runtime], repos: ["demo"] })));
});
