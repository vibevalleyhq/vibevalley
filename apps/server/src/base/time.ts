// Time for the code that lives outside Effect (the connectors, the journal, a call's host): read and waited
// on the Clock of the service that made it, so that a test's TestClock moves it as it moves the services.
// The one file in apps/server/src that may touch the wall clock (vibevalley/no-wall-clock): wallTime below.

import { Clock, Effect } from "effect";

export interface Time {
  /** Unix milliseconds. */
  readonly now: () => number;
  /** Resolves after ms; rejects when signal aborts first. */
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Runs f after ms unless the function it returns is called first. */
  readonly after: (ms: number, f: () => void) => () => void;
}

/** The Clock of the service that asks, as a Time: what it sleeps on runs with the service's own context. */
export const timeHere: Effect.Effect<Time> = Effect.gen(function* () {
  const context = yield* Effect.context<never>();
  const clock = yield* Clock.Clock;
  const run = Effect.runPromiseWith(context);
  const fork = Effect.runForkWith(context);
  return {
    now: () => clock.currentTimeMillisUnsafe(),
    sleep: (ms, signal) => run(Effect.sleep(Math.max(0, ms)), signal ? { signal } : undefined),
    after: (ms, f) => {
      const fiber = fork(Effect.andThen(Effect.sleep(Math.max(0, ms)), Effect.sync(f)));
      return () => fiber.interruptUnsafe();
    },
  };
});

/** The wall clock, for code with no service to ask: a class tested on its own, the command line. */
export const wallTime: Time = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const timer = setTimeout(done, Math.max(0, ms));
      function done() {
        signal?.removeEventListener("abort", abort);
        resolve();
      }
      function abort() {
        clearTimeout(timer);
        reject(signal!.reason);
      }
      signal?.addEventListener("abort", abort, { once: true });
    }),
  // Kept alive by nothing: a command line's pending fold or tick does not hold it open.
  after: (ms, f) => {
    const timer = setTimeout(f, Math.max(0, ms));
    timer.unref();
    return () => clearTimeout(timer);
  },
};

/** A deadline on a real process or network call (a runtime's probe of its CLI): real time, whatever the Clock says, and
 * it keeps nothing alive. The fallback when p has not settled by then, or when it fails. */
export const withinRealTime = <A>(p: Promise<A>, ms: number, fallback: A): Promise<A> =>
  Promise.race([p.catch(() => fallback), new Promise<A>((resolve) => setTimeout(() => resolve(fallback), ms).unref())]);

/** A deadline on a real process (a command's timeout, the grace before SIGKILL): runs f after ms of real time, whatever
 * the Clock says. unref: it does not keep the process alive. Returns what cancels it. */
export const afterRealTime = (ms: number, f: () => void, options: { readonly unref?: boolean } = {}): (() => void) => {
  const timer = setTimeout(f, Math.max(0, ms));
  if (options.unref) timer.unref();
  return () => clearTimeout(timer);
};

const pad = (n: number) => String(n).padStart(2, "0");

/** To the minute: what an input says the time is, so that it does not change between two requests a few seconds apart. */
export const localeMinute = (t: Date) => `${t.getFullYear()}/${t.getMonth() + 1}/${t.getDate()} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
