import { abortError, isAbort, reasonOf } from "./abort.ts";
import { type Clock, systemClock } from "./clock.ts";

export interface RetryOptions {
  /** Tries after the first; 0 is no retry. */
  readonly retries: number;
  /** The wait before try n (1 is the first retry). Default: none. */
  readonly delay?: (attempt: number) => number;
  /** Whether a failure is worth another try; an abort never is. Default: every failure. */
  readonly when?: (error: unknown, attempt: number) => boolean;
  readonly signal?: AbortSignal;
  readonly clock?: Clock;
}

/** f, tried again on failure up to options.retries times; the last failure is what it rejects with. */
export async function retry<A>(f: (attempt: number) => Promise<A>, options: RetryOptions): Promise<A> {
  const clock = options.clock ?? systemClock;
  for (let attempt = 0; ; attempt++) {
    if (options.signal?.aborted === true) throw reasonOf(options.signal);
    try {
      return await f(attempt);
    } catch (e) {
      if (isAbort(e, options.signal) || attempt >= options.retries || options.when?.(e, attempt + 1) === false) throw e;
      const wait = options.delay?.(attempt + 1) ?? 0;
      if (wait > 0) await clock.sleep(wait, options.signal);
    }
  }
}

/** base·factor^(n-1), capped: the usual backoff. */
export const exponential =
  (base: number, factor = 2, cap = Number.POSITIVE_INFINITY) =>
  (attempt: number): number =>
    Math.min(cap, base * factor ** Math.max(0, attempt - 1));

/** A timeout: what `withTimeout` rejects with, so a caller can tell it from the task's own failure. */
export const timeoutError = (ms: number, what = "the call"): DOMException => new DOMException(`${what} took longer than ${ms} ms`, "TimeoutError");

/** f with a deadline: its signal aborts at ms, and the result rejects with a TimeoutError then. */
export async function withTimeout<A>(
  f: (signal: AbortSignal) => Promise<A>,
  ms: number,
  options: { readonly signal?: AbortSignal; readonly clock?: Clock; readonly what?: string } = {},
): Promise<A> {
  const clock = options.clock ?? systemClock;
  const controller = new AbortController();
  const stop = new AbortController();
  const outer = options.signal;
  const onOuter = () => controller.abort(outer?.reason ?? abortError());
  outer?.addEventListener("abort", onOuter, { once: true });
  if (outer?.aborted === true) onOuter();
  const deadline = clock.sleep(ms, stop.signal).then(
    () => {
      const e = timeoutError(ms, options.what);
      controller.abort(e);
      throw e;
    },
    () => new Promise<never>(() => undefined),
  );
  try {
    return await Promise.race([f(controller.signal), deadline]);
  } finally {
    stop.abort();
    outer?.removeEventListener("abort", onOuter);
  }
}
