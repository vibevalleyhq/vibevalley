// Logging from callback code inside a service (a promise's catch, a listener, a library's log hook): through Effect's
// logger like the rest, on a fiber that belongs to the service. Bare console.* is refused by lint outside the command
// line and the code that is not Effect (vite.config.ts).

import { Effect, FiberSet, type Scope } from "effect";

export interface CallbackLog {
  readonly info: (...message: ReadonlyArray<unknown>) => void;
  readonly warn: (...message: ReadonlyArray<unknown>) => void;
  readonly error: (...message: ReadonlyArray<unknown>) => void;
}

/** Effect's own logger, for code with no service to ask (the command line, a class tested on its own), as wallTime is
 * the clock for it. */
export const plainLog: CallbackLog = {
  info: (...m) => void Effect.runFork(Effect.log(...m)),
  warn: (...m) => void Effect.runFork(Effect.logWarning(...m)),
  error: (...m) => void Effect.runFork(Effect.logError(...m)),
};

/** Made in a service's make: the lines it writes end with the service and keep its logger. */
export const callbackLog: Effect.Effect<CallbackLog, never, Scope.Scope> = Effect.gen(function* () {
  const fork = yield* FiberSet.makeRuntime<never>();
  return {
    info: (...m) => void fork(Effect.log(...m)),
    warn: (...m) => void fork(Effect.logWarning(...m)),
    error: (...m) => void fork(Effect.logError(...m)),
  };
});
