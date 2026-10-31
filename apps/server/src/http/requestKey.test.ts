import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";

import type { ApiError } from "@vibevalley/protocol/api";

import { requestKeyMax, requestKeys } from "./requestKey.ts";

describe("a request key", () => {
  it.effect("does the work once for a repeated key and returns the first result", () =>
    Effect.gen(function* () {
      let runs = 0;
      const once = requestKeys<number>();
      const work = Effect.sync(() => ++runs);
      expect([yield* once("k", work), yield* once("k", work), yield* once("other", work)]).toEqual([1, 1, 2]);
      // No key: every request is its own.
      expect([yield* once(undefined, work), yield* once("", work)]).toEqual([3, 4]);
    }),
  );

  it.effect("has a duplicate that comes while the first runs wait for it", () =>
    Effect.gen(function* () {
      let runs = 0;
      const gate = yield* Deferred.make<void>();
      const once = requestKeys<number>();
      const work = Effect.andThen(
        Deferred.await(gate),
        Effect.sync(() => ++runs),
      );
      const first = yield* Effect.forkChild(once("k", work));
      const second = yield* Effect.forkChild(once("k", work));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, undefined);
      expect([yield* Fiber.join(first), yield* Fiber.join(second), runs]).toEqual([1, 1, 1]);
    }),
  );

  it.effect("forgets a key whose request failed, so a retry runs again", () =>
    Effect.gen(function* () {
      let runs = 0;
      const once = requestKeys<number>();
      const refusal: ApiError = { _tag: "Refused", reason: "not now" };
      const work = Effect.suspend(() => (++runs === 1 ? Effect.fail(refusal) : Effect.succeed(runs)));
      expect(yield* Effect.flip(once("k", work))).toEqual(refusal);
      expect([yield* once("k", work), yield* once("k", work), runs]).toEqual([2, 2, 2]);
    }),
  );

  it.effect("refuses a key longer than a sendKey may be", () =>
    Effect.gen(function* () {
      const once = requestKeys<number>();
      expect(yield* Effect.flip(once("x".repeat(requestKeyMax + 1), Effect.succeed(1)))).toMatchObject({ _tag: "Refused" });
    }),
  );
});
