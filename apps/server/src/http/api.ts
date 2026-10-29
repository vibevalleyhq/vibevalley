// The API over HTTP: every endpoint in @vibevalley/protocol/api is a POST at its op's path, routed to its handler. An input
// that does not decode is a 400 with why (an empty body is {}); no answer is a 204; a refusal is its tagged JSON at its status.

import { messageOf } from "../errors.ts";
import { ApiError, type Endpoint, endpoints, errorStatus, type Handlers, pathOf } from "@vibevalley/protocol/api";
import { Cause, Effect, Schema, Metric } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { wireOf } from "../base/wire.ts";

// The same Schema the clients read it back with: a refusal that does not fit it is the server's bug, a 500.
const isApiError = Schema.is(ApiError);

const badRequest = (why: string) => HttpServerResponse.text(why + "\n", { status: 400 });

/** Each call of an endpoint, by its op and the status it answered. */
const requests = Metric.counter("vibevalley.http.requests", { description: "Calls of an endpoint, by op and status", incremental: true });

function serve(endpoint: Endpoint, handle: (input: unknown) => Effect.Effect<unknown, ApiError>) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    let input: unknown;
    if (endpoint.input) {
      const text = yield* request.text;
      let json: unknown;
      try {
        json = JSON.parse(text === "" ? "{}" : text);
      } catch (e) {
        return badRequest(messageOf(e));
      }
      const decoded = Schema.decodeUnknownExit(endpoint.input)(json);
      if (decoded._tag === "Failure") return badRequest(Cause.pretty(decoded.cause));
      input = decoded.value;
    }
    const out = yield* handle(input).pipe(Effect.result);
    if (out._tag === "Failure") {
      const e = out.failure;
      return yield* HttpServerResponse.schemaJson(ApiError)(e, { status: errorStatus[e._tag] });
    }
    if (!endpoint.result) return HttpServerResponse.empty({ status: 204 });
    return yield* HttpServerResponse.schemaJson(endpoint.result)(wireOf(out.success));
  }).pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
      const failure = Cause.squash(cause);
      if (isApiError(failure))
        return HttpServerResponse.schemaJson(ApiError)(failure, {
          status: errorStatus[failure._tag],
        });
      return Effect.as(Effect.logError("an endpoint failed", cause), HttpServerResponse.text(messageOf(failure) + "\n", { status: 500 }));
    }),
    Effect.tap((response) => Metric.update(requests.pipe(Metric.withAttributes({ op: endpoint.op, status: String(response.status) })), 1)),
    Effect.annotateLogs({ op: endpoint.op }),
  );
}

/** Routes every endpoint, or only those a caller may call (the lan listener's). The handlers have their services already. */
export function api(handlers: Handlers, only?: (e: Endpoint) => boolean) {
  return HttpRouter.use((router) =>
    Effect.forEach(
      endpoints.filter((e) => !only || only(e)),
      (e) => router.add("POST", pathOf(e.op) as HttpRouter.PathInput, serve(e, handlers[e.op] as (input: unknown) => Effect.Effect<unknown, ApiError>)),
      { discard: true },
    ),
  );
}
