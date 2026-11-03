// The API over HTTP: every endpoint in @vibevalley/protocol/api is a POST at its op's path, routed to its handler. An input
// that does not decode is a 400 with why (an empty body is {}); no answer is a 204; a refusal is its tagged JSON at its status.
// The things a browser asks for by itself are GETs here too: an attachment, an artifact's version and MOSS Live's line.

import { ByteSize, Cause, Deferred, Effect, Exit, Metric, Schema } from "effect";
import { HttpIncomingMessage, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { t } from "@vibevalley/i18n";
import { artifactPrefix, attachmentMax, attachmentPath, mossLinePath } from "@vibevalley/protocol";
import { ApiError, type Endpoint, endpoints, errorStatus, type Handlers, pathOf } from "@vibevalley/protocol/api";
import { artifactId } from "@vibevalley/protocol/schema";

import { Artifact } from "@/artifact/artifact.ts";
import { artifactHeaders } from "@/artifact/policy.ts";
import { wireOf } from "@/base/json.ts";
import { Channel } from "@/channel/channel.ts";
import { messageOf, refused } from "@/errors.ts";
import { Voice } from "@/voice/voice.ts";

import { fromTheFarm } from "./rpc.ts";

// The same Schema the clients read it back with: a refusal that does not fit it is the server's bug, a 500.
const isApiError = Schema.is(ApiError);

const badRequest = (why: string) => HttpServerResponse.text(why + "\n", { status: 400 });
const notFound = () => HttpServerResponse.text("404 page not found\n", { status: 404 });

/** The most a body may be, read before it is decoded: an attachment comes as base64 in JSON, everything else is small. */
const bodyMax = 2 * 1024 * 1024;
const attachmentBodyMax = Math.ceil(attachmentMax / 3) * 4 + 64 * 1024;
const bodyMaxOf = (endpoint: Endpoint) => (endpoint.op === "channel.attachment.create" ? attachmentBodyMax : bodyMax);

/** Each call of an endpoint, by its op and the status it answered. */
const requests = Metric.counter("vibevalley.http.requests", { description: "Calls of an endpoint, by op and status", incremental: true });

function serve(endpoint: Endpoint, handle: (input: unknown) => Effect.Effect<unknown, ApiError>) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!fromTheFarm(request.headers)) return HttpServerResponse.empty({ status: 403 });
    let input: unknown;
    if (endpoint.input) {
      const max = bodyMaxOf(endpoint);
      // A body that says it is too big is refused before it is read; one that grows past the limit on the way stops there.
      const length = Number(request.headers["content-length"] ?? 0);
      if (length > max) return HttpServerResponse.text(`the body is ${length} bytes, at most ${max}\n`, { status: 413 });
      const text = yield* Effect.provideService(request.text, HttpIncomingMessage.MaxBodySize, ByteSize.bytes(max));
      const decoded = Schema.decodeExit(Schema.fromJsonString(endpoint.input))(text === "" ? "{}" : text);
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
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- each handler takes its endpoint's input, which serve decodes with e.input; pathOf starts with a slash
      (e) => router.add("POST", pathOf(e.op) as HttpRouter.PathInput, serve(e, handlers[e.op] as (input: unknown) => Effect.Effect<unknown, ApiError>)),
      { discard: true },
    ),
  );
}

// The one read that is a GET, since a page's <img src> can only GET. Named by its sha256, a file never changes: cached for good.
const attachmentPrefix = attachmentPath("");
const inline = (type: string) => /^(image|video|audio)\//u.test(type) || type === "application/pdf";

export const attachments = HttpRouter.add(
  "GET",
  "/api/v1/attachment/:id",
  Effect.gen(function* () {
    const chat = yield* Channel;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const id = new URL(request.url, "http://farm").pathname.slice(attachmentPrefix.length);
    if (!/^[0-9a-f]{64}$/u.test(id)) return notFound();
    const found = yield* chat.attachment(id);
    if (!found) return notFound();
    const pdf = found.type === "application/pdf";
    return yield* HttpServerResponse.file(found.path, {
      contentType: found.type,
      headers: {
        "cache-control": "private, max-age=31536000, immutable",
        // Shown in the page (an image, a video, a sound) or a tab of its own (a PDF), else saved: never run as one of the
        // farm's own pages. The browser's PDF viewer does not open under a sandbox; nosniff keeps a PDF a PDF.
        "content-disposition": `${inline(found.type) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(found.name)}`,
        "x-content-type-options": "nosniff",
        ...(pdf ? {} : { "content-security-policy": "sandbox" }),
      },
    });
  }).pipe(Effect.orElseSucceed(notFound)),
);

// A GET since an <iframe src> can only GET; a version never changes once made, so it is cached for good. Its headers keep
// an HTML page from running as one of the farm's (artifact/policy.ts).
export const artifactContent = HttpRouter.add(
  "GET",
  "/api/v1/artifact/:id/:version",
  Effect.gen(function* () {
    const artifacts = yield* Artifact;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const [id = "", version = ""] = new URL(request.url, "http://farm").pathname.slice(artifactPrefix.length).split("/");
    if (!/^[0-9a-f-]{36}$/u.test(id) || !/^[1-9]\d*$/u.test(version)) return notFound();
    const path = yield* artifacts.file(artifactId(id), Number(version));
    if (!path) return notFound();
    return yield* HttpServerResponse.file(path, { contentType: artifactHeaders["content-type"]!, headers: artifactHeaders });
  }).pipe(Effect.orElseSucceed(notFound)),
);

// A page's line to MOSS Live (voice/moss.ts relay): a WebSocket at mossLinePath, for the farm's own page only, as the
// RPC socket is (rpc.ts fromTheFarm). The key stays on the server; with none saved the upgrade is refused with why.
export const mossLine = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const voice = yield* Voice;
    yield* router.add(
      "GET",
      mossLinePath,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (!fromTheFarm(request.headers)) return HttpServerResponse.text("not the farm's page", { status: 403 });
        const problem = voice.mossProblem();
        if (problem) return HttpServerResponse.text(problem, { status: 409 });
        const page = yield* Effect.orDie(request.upgrade);
        yield* voice.mossLine(page);
        return HttpServerResponse.empty();
      }),
    );
  }),
);

// A client's request key: the same key again gets the first request's result, and the work is done once. A reply lost on
// the way (the page's retry after a dropped connection) would otherwise create or move a second time.

/** As long as a chat message's sendKey may be. */
export const requestKeyMax = 64;

/** Keys remembered per op: a retry comes within seconds, so the newest few hundred are plenty. */
const remembered = 500;

/**
 * One op's memo, in memory: a restart forgets every key. Duplicates that come while the first is running wait for it.
 * Only a success is remembered: a refused or failed request changed nothing, so a retry with the same key runs again.
 */
export function requestKeys<A>(): (key: string | undefined, work: Effect.Effect<A, ApiError>) => Effect.Effect<A, ApiError> {
  const seen = new Map<string, Deferred.Deferred<A, ApiError>>();
  return (key, work) => {
    if (key === undefined || key === "") return work;
    if (key.length > requestKeyMax) return Effect.fail(refused(t("server.base.requestKeyLong", { max: requestKeyMax })));
    return Effect.suspend(() => {
      const first = seen.get(key);
      if (first) return Deferred.await(first);
      const mine = Deferred.makeUnsafe<A, ApiError>();
      seen.set(key, mine);
      // Map keeps insertion order: the first key is the oldest.
      if (seen.size > remembered) for (const old of seen.keys()) if (seen.size > remembered) seen.delete(old);
      return work.pipe(
        Effect.onExit((exit) => {
          if (!Exit.isSuccess(exit) && seen.get(key) === mine) seen.delete(key);
          return Deferred.done(mine, exit);
        }),
      );
    });
  };
}
