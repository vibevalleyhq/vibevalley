// Waiting in a test for what the farm does in the background: asked again every millisecond until it holds, or a defect
// that says what it waited for. The asking is on real time, apart from the farm's Clock: a test that moves a TestClock
// still waits this way for the farm's real work (git, the database, a helper's turn).

import { Effect } from "effect";

const aMoment = () => new Promise<void>((r) => setTimeout(r, 1));

/** What get answers once ok holds for it. what is said if it never does (a function: read when it is given up on). */
export const waitFor = <A, E, R>(get: Effect.Effect<A, E, R>, ok: (a: A) => boolean, what: string | (() => string), ms = 5_000): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const until = performance.now() + ms;
    for (;;) {
      const a = yield* get;
      if (ok(a)) return a;
      if (performance.now() > until) return yield* Effect.die(new Error(`waited for ${typeof what === "string" ? what : what()}`));
      yield* Effect.promise(aMoment);
    }
  });

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
