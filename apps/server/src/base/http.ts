// Requests to outside services (a memory source, a chat app, a provider's balance, the voice line's tunnel) go through
// Effect's HTTP client over fetch, their answers read by a Schema (jsonOrNone) rather than cast. fetch is looked up when a
// request goes out, so a test's stub of it still answers.

import { Cause, Effect, Exit } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/http";

/** Runs requests behind a Promise seam (a Source, a connector's client, a runtime's probe): interrupted when signal aborts
 * and then thrown its reason, as fetch does; any other failure thrown as it was. */
export const outside = async <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>, signal?: AbortSignal): Promise<A> => {
  signal?.throwIfAborted();
  const exit = await Effect.runPromiseExit(Effect.provide(effect, FetchHttpClient.layer), signal ? { signal } : undefined);
  if (Exit.isSuccess(exit)) return exit.value;
  signal?.throwIfAborted();
  throw Cause.squash(exit.cause);
};
