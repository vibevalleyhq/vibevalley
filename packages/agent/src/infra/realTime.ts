/** Runs f after ms of real time. unref: it does not keep the process alive. */
const afterRealTime = (ms: number, f: () => void, options: { readonly unref?: boolean } = {}): (() => void) => {
  const timer = setTimeout(f, Math.max(0, ms));
  if (options.unref === true) timer.unref();
  return () => clearTimeout(timer);
};

/** Rejects with timedOut() after ms of real time, unless the signal aborts first (then it never settles and its timer is
 * cleared): the deadline of something that takes no signal of its own. */
export const failAfterRealTime = (ms: number, timedOut: () => unknown, signal?: AbortSignal): Promise<never> =>
  new Promise<never>((_, reject) => {
    const cancel = afterRealTime(ms, () => reject(timedOut()));
    signal?.addEventListener("abort", cancel, { once: true });
  });
