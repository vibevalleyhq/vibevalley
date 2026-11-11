/** What an abort without a reason of its own rejects with: the platform's AbortError, so `isAbort` reads both. */
export const abortError = (message = "aborted"): DOMException => new DOMException(message, "AbortError");

/** Whether e is an abort: the platform's AbortError, a TimeoutError, or the reason a signal was aborted with. */
export function isAbort(e: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true && e === signal.reason) return true;
  return e instanceof DOMException && (e.name === "AbortError" || e.name === "TimeoutError");
}

/** The signal's reason as a thrown value: an Error as it is, anything else an AbortError. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw reasonOf(signal);
}

export const reasonOf = (signal: AbortSignal): unknown =>
  signal.reason instanceof Error || signal.reason instanceof DOMException ? signal.reason : abortError();

/** Aborted when any of them is; no signal given is a signal never aborted. */
export const anySignal = (...signals: readonly (AbortSignal | undefined)[]): AbortSignal => {
  const given = signals.filter((s): s is AbortSignal => s !== undefined);
  return given.length === 1 ? given[0]! : AbortSignal.any(given);
};

/** p, or a rejection with the signal's reason once it aborts: for a library call that takes no signal of its own. What p
 * was doing goes on; only the waiting stops. */
export function abortable<A>(p: Promise<A>, signal: AbortSignal | undefined): Promise<A> {
  if (signal === undefined) return p;
  if (signal.aborted) return Promise.reject(reasonOf(signal));
  const { promise, reject } = Promise.withResolvers<never>();
  const onAbort = () => reject(reasonOf(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  return Promise.race([p, promise]).finally(() => signal.removeEventListener("abort", onAbort));
}
