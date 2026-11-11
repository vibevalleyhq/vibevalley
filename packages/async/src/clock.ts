import { abortable, reasonOf } from "./abort.ts";

/** Time as a service: the server reads the wall clock and waits only through one, so a test can hold time still (vitest's
 * fake timers move both). */
export interface Clock {
  /** Milliseconds since the epoch. */
  readonly now: () => number;
  /** Resolves after ms, or rejects with the signal's reason once it aborts. */
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(reasonOf(signal));
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, Math.max(0, ms));
  return abortable(promise, signal).finally(() => clearTimeout(timer));
}

export const systemClock: Clock = { now: () => Date.now(), sleep };
