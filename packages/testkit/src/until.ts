// Waiting in a test for what runs in the background: asked again until it holds, or a defect that says what it waited
// for. The asks thin out (1, 2, 5, 15, then every 30 ms): a wait of a second asks some forty times, not a thousand, and
// each ask may be a query on the one database connection the work itself needs. The asking is on real time, apart from Effect's Clock: a test that moves a TestClock still waits
// this way for real work (git, a database, an agent's turn).

import { Effect } from "effect";

const gaps = [1, 2, 5, 15, 30];
const aMoment = (asked: number) => new Promise<void>((r) => setTimeout(r, gaps[Math.min(asked, gaps.length - 1)]));

/** What get answers once ok holds for it. what is said if it never does (a function: read when it is given up on). */
export const waitFor = <A, E, R>(get: Effect.Effect<A, E, R>, ok: (a: A) => boolean, what: string | (() => string), ms = 5_000): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const until = performance.now() + ms;
    for (let asked = 0; ; asked++) {
      const a = yield* get;
      if (ok(a)) return a;
      if (performance.now() > until) return yield* Effect.die(new Error(`waited for ${typeof what === "string" ? what : what()}`));
      yield* Effect.promise(() => aMoment(asked));
    }
  });

/** The value get gives once it is something. */
export const untilGot = <A>(get: () => A | undefined | false | Promise<A | undefined | false>, what: string | (() => string), ms = 5_000) =>
  Effect.map(
    waitFor(
      Effect.promise(async () => get()),
      (got) => got !== undefined && got !== false,
      what,
      ms,
    ),
    (got) => got as A,
  );

/** Once ok holds. */
export const until = (ok: () => boolean | Promise<boolean>, what: string | (() => string) = "it", ms = 5_000) =>
  Effect.asVoid(
    waitFor(
      Effect.promise(async () => ok()),
      (held) => held,
      what,
      ms,
    ),
  );

/** until for a test written with promises (a fake runtime, a fake model): once ok holds, asked again as waitFor does on
 * real time, or rejected with what it waited for. */
export const whenTrue = async (ok: () => boolean | Promise<boolean>, what: string, ms = 5_000): Promise<void> => {
  const deadline = performance.now() + ms;
  /* oxlint-disable eslint/no-await-in-loop -- a poll: each try waits for the one before */
  for (let asked = 0; !(await ok()); asked++) {
    if (performance.now() > deadline) throw new Error(`waited for ${what}`);
    await aMoment(asked);
    /* oxlint-enable eslint/no-await-in-loop */
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
