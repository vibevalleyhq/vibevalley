/** Runs f after ms of real time. unref: it does not keep the process alive. */
export const afterRealTime = (ms: number, f: () => void, options: { readonly unref?: boolean } = {}): (() => void) => {
  const timer = setTimeout(f, Math.max(0, ms));
  if (options.unref === true) timer.unref();
  return () => clearTimeout(timer);
};
