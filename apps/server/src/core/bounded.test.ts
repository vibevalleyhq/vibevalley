import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, PubSub, Stream } from "effect";
import { TestClock } from "effect/testing";

import { bounded } from "./bounded.ts";

describe("bounded streams", () => {
  it.effect("keeps the source order", () =>
    Effect.gen(function* () {
      expect(yield* bounded(Stream.make(1, 2, 3), "test").pipe(Stream.runCollect)).toEqual([1, 2, 3]);
    }),
  );

  it.effect("ends the slow subscription and runs the source finalizer once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const pubsub = yield* PubSub.unbounded<number>();
        let finalized = 0;
        const source = Stream.fromPubSub(pubsub).pipe(Stream.ensuring(Effect.sync(() => finalized++)));
        const fiber = yield* Effect.forkChild(Stream.runDrain(bounded(source, "test", 2)));
        yield* TestClock.adjust(5);
        yield* PubSub.publish(pubsub, 1);
        yield* PubSub.publish(pubsub, 2);
        yield* PubSub.publish(pubsub, 3);
        yield* Fiber.await(fiber);
        expect(finalized).toBe(1);
      }),
    ),
  );
});
