// A clock for a test that needs the time to be what it says: every reading of now asks at(); sleeping is real (the tests
// run live, and the farm under test still waits on its own timers).

import { Clock, Duration, Effect, Layer } from "effect";

export const clockAt = (at: () => number): Clock.Clock => ({
  currentTimeMillisUnsafe: at,
  currentTimeMillis: Effect.sync(at),
  currentTimeNanosUnsafe: () => BigInt(Math.round(at())) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => BigInt(Math.round(at())) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => process.hrtime.bigint(),
  monotonicTimeNanos: Effect.sync(() => process.hrtime.bigint()),
  sleep: (duration) =>
    Effect.callback<void>((resume) => {
      const timer = setTimeout(() => resume(Effect.void), Duration.toMillis(duration));
      return Effect.sync(() => clearTimeout(timer));
    }),
});

/** The farm's Clock, read from at. */
export const clockLayer = (at: () => number) => Layer.succeed(Clock.Clock, clockAt(at));
