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

/** Work the caller goes on without: a failure or a defect is logged at Warn after what (the words say what was being done), and the caller carries on. */
export const bestEffort =
  (what: string) =>
  <A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
    Effect.catchCause(Effect.asVoid(work), (cause) => (Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.logWarning(what, cause)));
