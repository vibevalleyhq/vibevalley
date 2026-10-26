// Waiting in a test for what the farm does in the background: asked again every millisecond until it holds, or a defect
// that says what it waited for. The asking is on real time, apart from the farm's Clock: a test that moves a TestClock
// still waits this way for the farm's real work (git, the database, a helper's turn).

import type { WorkspaceState } from "@vibevalley/protocol";
import { Effect, Option, Stream } from "effect";
import { Core } from "../core/core.ts";

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

/** What pick finds in the core state: in it now, or in the first state the core moves to where it finds something. It
 * waits on the core's transitions, not by asking again; the deadline is real time, as for waitFor. */
export const whenState = <A>(pick: (state: WorkspaceState) => A | undefined | false, what: string | (() => string), ms = 5_000) =>
  Effect.scoped(
    Effect.gen(function* () {
      const core = yield* Core;
      const [now, changes] = yield* core.transitions;
      const first = pick(now);
      if (first) return first;
      const found = Stream.runHead(
        Stream.filter(
          Stream.map(changes, (t) => pick(t.after)),
          (a): a is A => !!a,
        ),
      );
      const late = Effect.as(
        Effect.promise(() => new Promise<void>((r) => setTimeout(r, ms))),
        Option.none<A>(),
      );
      const got = yield* Effect.raceFirst(found, late);
      if (Option.isNone(got)) return yield* Effect.die(new Error(`waited for ${typeof what === "string" ? what : what()}`));
      return got.value;
    }),
  );

/** until for a test written with promises (a fake runtime, a fake model): once ok holds, asked again every millisecond on
 * real time, or rejected with what it waited for. */
export const whenTrue = async (ok: () => boolean | Promise<boolean>, what: string, ms = 5_000): Promise<void> => {
  const deadline = performance.now() + ms;
  while (!(await ok())) {
    if (performance.now() > deadline) throw new Error(`waited for ${what}`);
    await aMoment();
  }
};

/** What p settles to, or a rejection naming what took longer than ms (real time): a deadline on something the test
 * cannot see the end of otherwise. */
export const within = <A>(p: Promise<A>, ms: number, what: string): Promise<A> =>
  new Promise<A>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms);
    p.then(
      (a) => {
        clearTimeout(timer);
        resolve(a);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });

/** A gate a fake waits at until the test opens it: a fake that should be busy is busy until the test says, not for a
 * guessed while. */
export const gate = () => {
  let open = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open: () => open() };
};

/** One turn of the event loop: whatever was set going before it (a publish taken by a forked reader, a promise already
 * resolved) has run. For "nothing came of it" when what could have come would have been set going already; it is not a
 * wait for time. */
export const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
export const aTurn = Effect.promise(nextTurn);
