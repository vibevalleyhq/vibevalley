// Logging from callback code inside a service (a promise's catch, a listener, a library's log hook): through Effect's
// logger like the rest, on a fiber that belongs to the service. Bare console.* is refused by lint outside the command
// line and the code that is not Effect (vite.config.ts).

import { Cause, Effect, FiberSet, type Scope } from "effect";

export interface CallbackLog {
  readonly info: (...message: ReadonlyArray<unknown>) => void;
  readonly warn: (...message: ReadonlyArray<unknown>) => void;
  readonly error: (...message: ReadonlyArray<unknown>) => void;
}

/** Made in a service's make: the lines it writes end with the service and keep its logger. */
export const callbackLog: Effect.Effect<CallbackLog, never, Scope.Scope> = Effect.gen(function* () {
  const fork = yield* FiberSet.makeRuntime();
  return {
    info: (...m) => void fork(Effect.log(...m)),
    warn: (...m) => void fork(Effect.logWarning(...m)),
    error: (...m) => void fork(Effect.logError(...m)),
  };
});

/**
 * Work the caller goes on without: a failure or a defect is logged at Warn after what (the words say what was being
 * done), and the caller carries on. Interruption is not a failure of the work, so it passes through and a closing
 * service still stops what it started.
 */
export const bestEffort =
  (what: string) =>
  <A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
    Effect.catchCause(Effect.asVoid(work), (cause) => (Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.logWarning(what, cause)));
