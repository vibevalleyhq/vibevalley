// The API over HTTP: every endpoint in @vibevalley/protocol/api
// is routed to its handler. A path parameter that should be a number and is not is a 404, a query one is none; a body
// that does not decode is a 400 with why; no answer is a 204; a refusal is its tagged JSON at its status.

import { ApiError, type Endpoint, endpoints, errorStatus, type Handlers } from "@vibevalley/protocol/api";
import { Cause, Effect, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

// The same Schema the clients read it back with: a refusal that does not fit it is the server's bug, a 500.
const isApiError = Schema.is(ApiError);

const notFound = HttpServerResponse.text("404 page not found\n", { status: 404 });

const badRequest = (why: string) => HttpServerResponse.text(why + "\n", { status: 400 });

type Args = Record<string, unknown>;

function serve(endpoint: Endpoint, handle: (a: Args) => Effect.Effect<unknown, ApiError>) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const params = yield* HttpRouter.params;
    const args: Args = {};
    for (const p of endpoint.pathParams) {
      const raw = params[p.name] ?? "";
      if (!p.number) {
        args[p.name] = raw;
        continue;
      }
      const n = /^-?\d+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isSafeInteger(n)) return notFound;
      args[p.name] = n;
    }
    const query = new URL(request.url, "http://farm").searchParams;
    for (const p of endpoint.query) {
      if (!query.has(p.name)) continue;
      const raw = query.get(p.name)!;
      if (!p.number) args[p.name] = raw;
      else if (/^-?\d+$/.test(raw)) args[p.name] = Number(raw);
    }
    if (endpoint.body) {
      const text = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch (e) {
        return badRequest((e as Error).message);
      }
      const decoded = Schema.decodeUnknownExit(endpoint.body)(json);
      if (decoded._tag === "Failure") return badRequest(Cause.pretty(decoded.cause));
      args.body = decoded.value;
    }
    const out = yield* handle(args).pipe(Effect.result);
    if (out._tag === "Failure") {
      const e = out.failure;
      return HttpServerResponse.jsonUnsafe(e, { status: errorStatus[e._tag] });
    }
    if (!endpoint.result) return HttpServerResponse.empty({ status: 204 });
    return HttpServerResponse.jsonUnsafe(out.success);
  }).pipe(
    Effect.catchCause((cause) => {
      const failure = Cause.squash(cause);
      if (isApiError(failure)) return Effect.succeed(HttpServerResponse.jsonUnsafe(failure, { status: errorStatus[failure._tag] }));
      return Effect.as(
        Effect.logError(`${endpoint.op}: ${Cause.pretty(cause)}`),
        HttpServerResponse.text(String(failure instanceof Error ? failure.message : failure) + "\n", { status: 500 }),
      );
    }),
  );
}

const pathOf = (path: string) => path.replace(/\{(\w+)\}/g, ":$1") as HttpRouter.PathInput;

/** Routes every endpoint, or only those a caller may call (the lan listener's). The handlers have their services already. */
export function api(handlers: Handlers, only?: (e: Endpoint) => boolean) {
  return HttpRouter.use((router) =>
    Effect.forEach(
      endpoints.filter((e) => !only || only(e)),
      (e) => router.add(e.method, pathOf(e.path), serve(e, handlers[e.op] as (a: Args) => Effect.Effect<unknown, ApiError>)),
      { discard: true },
    ),
  );
}
