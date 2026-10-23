// Waiting in a test for what the farm does in the background: asked again every 10 ms until it holds, or a defect that
// says what it waited for. The tests that wait run on the live clock (it.live).

import { Effect, Schedule } from "effect";

const notYet = { _tag: "NotYet" } as const;

/** What get answers once ok holds for it. what is said if it never does (a function: read when it is given up on). */
export const waitFor = <A, E, R>(get: Effect.Effect<A, E, R>, ok: (a: A) => boolean, what: string | (() => string), ms = 5_000): Effect.Effect<A, E, R> =>
  get.pipe(
    Effect.flatMap((a) => (ok(a) ? Effect.succeed(a) : Effect.fail(notYet))),
    Effect.retry({ schedule: Schedule.spaced("10 millis"), while: (e) => e === notYet }),
    Effect.timeoutOrElse({ duration: ms, orElse: () => Effect.die(new Error(`waited for ${typeof what === "string" ? what : what()}`)) }),
    // Not yet is retried until the time is up, so it never comes out: what does is get's own failure.
  ) as Effect.Effect<A, E, R>;

/** The value get gives once it is something. */
export const untilGot = <A>(get: () => A | undefined | false | Promise<A | undefined | false>, what: string | (() => string), ms = 5_000) =>
  Effect.map(
    waitFor(
      Effect.promise(async () => await get()),
      (got) => !!got,
      what,
      ms,
    ),
    (got) => got as A,
  );

/** Once ok holds. */
export const until = (ok: () => boolean | Promise<boolean>, what: string | (() => string) = "it", ms = 5_000) =>
  Effect.asVoid(
    waitFor(
      Effect.promise(async () => await ok()),
      (held) => held,
      what,
      ms,
    ),
  );
