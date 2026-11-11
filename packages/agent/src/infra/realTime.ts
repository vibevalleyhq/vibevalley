import { Effect } from "effect";

/** Runs f after ms of real time. unref: it does not keep the process alive. */
export const afterRealTime = (ms: number, f: () => void, options: { readonly unref?: boolean } = {}): (() => void) => {
  const timer = setTimeout(f, Math.max(0, ms));
  if (options.unref === true) timer.unref();
  return () => clearTimeout(timer);
};

/** Never succeeds: fails with timedOut() after ms of real time; interrupted, its timer is cleared. */
export const failAfterRealTime = <E>(ms: number, timedOut: () => E): Effect.Effect<never, E> =>
  Effect.callback<never, E>((resume) => {
    const cancel = afterRealTime(ms, () => resume(Effect.fail(timedOut())));
    return Effect.sync(cancel);
  });
