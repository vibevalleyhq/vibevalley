// Requests to outside services (a memory source, a chat app, a provider's balance, the voice line's tunnel) go through
// Effect's HTTP client over fetch, their answers read by a Schema (jsonOrNone) rather than cast. fetch is looked up when a
// request goes out, so a test's stub of it still answers.

import { Cause, Effect, Exit } from "effect";
import { FetchHttpClient, HttpClient, type HttpClientError, type HttpClientRequest } from "effect/http";

/** Runs requests behind a Promise seam (a Source, a connector's client, a runtime's probe): interrupted when signal aborts
 * and then thrown its reason, as fetch does; any other failure thrown as it was. */
export const outside = async <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>, signal?: AbortSignal): Promise<A> => {
  signal?.throwIfAborted();
  const exit = await Effect.runPromiseExit(Effect.provide(effect, FetchHttpClient.layer), signal ? { signal } : undefined);
  if (Exit.isSuccess(exit)) return exit.value;
  signal?.throwIfAborted();
  throw Cause.squash(exit.cause);
};

export interface Answer {
  readonly status: number;
  /** A 2xx status. */
  readonly ok: boolean;
  readonly contentType: string;
  readonly text: string;
}

/** A request's status and its body as text, cut at most characters: an outside answer is never kept whole. */
export const answer = (
  request: HttpClientRequest.HttpClientRequest,
  most = 4 << 20,
): Effect.Effect<Answer, HttpClientError.HttpClientError, HttpClient.HttpClient> =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((res) =>
      Effect.map(res.text, (text): Answer => ({
        status: res.status,
        ok: res.status >= 200 && res.status < 300,
        contentType: res.headers["content-type"] ?? "",
        text: text.slice(0, most),
      })),
    ),
  );
