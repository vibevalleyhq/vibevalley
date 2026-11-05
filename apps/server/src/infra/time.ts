import { Clock, Effect, FiberSet, type Scope } from "effect";

export interface Time {
  /** Unix milliseconds. */
  readonly now: () => number;
  /** Resolves after ms; rejects when signal aborts first. */
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Runs f after ms unless the function it returns is called first. */
  readonly after: (ms: number, f: () => void) => () => void;
}

/** The Clock of the service that asks, as a Time. */
export const timeHere: Effect.Effect<Time, never, Scope.Scope> = Effect.gen(function* () {
  const clock = yield* Clock.Clock;
  const run = yield* FiberSet.makeRuntimePromise();
  const fork = yield* FiberSet.makeRuntime();
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
      if (signal?.aborted === true) return reject(signal.reason);
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

/** A deadline on a real process or network call (a runtime's probe of its CLI): real time, whatever the Clock says, and it keeps nothing alive. */
export const withinRealTime = <A>(p: Promise<A>, ms: number, fallback: A): Promise<A> =>
  Promise.race([p.catch(() => fallback), new Promise<A>((resolve) => setTimeout(() => resolve(fallback), ms).unref())]);

/** A deadline on a real process (a command's timeout, the grace before SIGKILL): runs f after ms of real time, whatever the Clock says. */
export const afterRealTime = (ms: number, f: () => void, options: { readonly unref?: boolean } = {}): (() => void) => {
  const timer = setTimeout(f, Math.max(0, ms));
  if (options.unref === true) timer.unref();
  return () => clearTimeout(timer);
};

const pad = (n: number) => String(n).padStart(2, "0");

/** To the minute: what an input says the time is, so that it does not change between two requests a few seconds apart. */
export const localeMinute = (t: Date) => `${t.getFullYear()}/${t.getMonth() + 1}/${t.getDate()} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
