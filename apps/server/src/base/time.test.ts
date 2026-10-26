import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { timeHere } from "./time.ts";

describe("a Time from the service's Clock", () => {
  it.effect("reads, waits and fires as TestClock moves", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000);
      const time = yield* timeHere;
      expect(time.now()).toBe(1_000);
      const fired: string[] = [];
      time.after(500, () => fired.push("after"));
      const cancel = time.after(500, () => fired.push("canceled"));
      cancel();
      const slept = yield* Effect.forkChild(Effect.promise(() => time.sleep(500).then(() => fired.push("slept"))));
      yield* TestClock.adjust(499);
      expect(fired).toEqual([]);
      yield* TestClock.adjust(1);
      yield* Fiber.join(slept);
      expect(fired.sort()).toEqual(["after", "slept"]);
      expect(time.now()).toBe(1_500);
    }),
  );
});
