// The one file of the agent that may touch the wall clock (vibevalley/no-wall-clock): deadlines on real processes and
// network calls run on real time, whatever Effect's Clock says.

/** Runs f after ms of real time; unref: it does not keep the process alive. Returns what cancels it. */
export const afterRealTime = (ms: number, f: () => void, options: { readonly unref?: boolean } = {}): (() => void) => {
  const timer = setTimeout(f, Math.max(0, ms));
  if (options.unref) timer.unref();
  return () => clearTimeout(timer);
};
