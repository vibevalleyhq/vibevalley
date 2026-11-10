import { ByteSize, Cause, Deferred, Effect, Exit, Metric, Schema } from "effect";
import { HttpIncomingMessage, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { t } from "@vibevalley/i18n";
import { artifactPrefix, attachmentMax, attachmentPath, mossLinePath, visionLinePath } from "@vibevalley/protocol";
import { ApiError, type Endpoint, endpoints, errorStatus, type Handlers, pathOf } from "@vibevalley/protocol/api";
import { artifactId } from "@vibevalley/protocol/schema";

import { Artifact } from "#/artifact/artifact.ts";
import { artifactHeaders, artifactPrintHeaders } from "#/artifact/policy.ts";
import { shellThemeOf, withShell } from "#/artifact/shell.ts";
import { Attachment } from "#/attachment/attachment.ts";
import { messageOf, reasonOf, refused } from "#/base/errors.ts";
import { wireOf } from "#/base/json.ts";
import { Voice } from "#/voice/voice.ts";

import { fromTheFarm } from "./rpc.ts";

// The same Schema the clients read it back with: a refusal that does not fit it is the server's bug, a 500.
const isApiError = Schema.is(ApiError);

const badRequest = (why: string) => HttpServerResponse.text(why + "\n", { status: 400 });
const notFound = () => HttpServerResponse.text("404 page not found\n", { status: 404 });

/** The most a body may be, read before it is decoded: an attachment comes as base64 in JSON, everything else is small. */
const bodyMax = 2 * 1024 * 1024;
const attachmentBodyMax = Math.ceil(attachmentMax / 3) * 4 + 64 * 1024;
const bodyMaxOf = (endpoint: Endpoint) => (endpoint.op === "attachment.create" ? attachmentBodyMax : bodyMax);

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
      const text = yield* Effect.provideService(request.text, HttpIncomingMessage.MaxBodySize, ByteSize.bytes(max)).pipe(
        Effect.catchReason("HttpServerError", "RequestParseError", (e) => (e.reason === "BodyTooLarge" ? Effect.undefined : Effect.fail(e))),
      );
      if (text === undefined) return HttpServerResponse.text(`the body grew past ${max} bytes\n`, { status: 413 });
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
    const files = yield* Attachment;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const id = new URL(request.url, "http://farm").pathname.slice(attachmentPrefix.length);
    if (!/^[0-9a-f]{64}$/u.test(id)) return notFound();
    const found = yield* files.get(id);
    if (!found) return notFound();
    const pdf = found.type === "application/pdf";
    return yield* HttpServerResponse.file(found.path, {
      contentType: found.type,
      headers: {
        "cache-control": "private, max-age=31536000, immutable",
        // Shown in the page (an image, a video, a sound) or a tab of its own (a PDF), else saved: never run as one of the farm's own pages.
        "content-disposition": `${inline(found.type) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(found.name)}`,
        "x-content-type-options": "nosniff",
        ...(pdf ? {} : { "content-security-policy": "sandbox" }),
      },
    });
  }).pipe(Effect.orElseSucceed(notFound)),
);

// A GET since an <iframe src> can only GET. a version never changes once made, so it is cached for good.
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
    const contentType = artifactHeaders["content-type"] ?? "text/html; charset=utf-8";
    const asked = new URL(request.url, "http://farm").searchParams;
    if (asked.get("shell") !== "1") return yield* HttpServerResponse.file(path, { contentType, headers: artifactHeaders });
    // The workbench's view: the page with the runtime after it, for how it is shown and in the workbench's theme (artifact/shell.ts).
    const page = yield* artifacts.content(artifactId(id), Number(version));
    const shown = yield* artifacts.get(artifactId(id));
    // ?print=1 is that page opened on its own to be printed: only it may open the print dialog.
    const headers = asked.get("print") === "1" ? artifactPrintHeaders : artifactHeaders;
    return HttpServerResponse.text(withShell({ page: page.content, display: shown.display ?? "page", theme: shellThemeOf(asked.get("theme")) }), {
      contentType,
      headers,
    });
  }).pipe(Effect.orElseSucceed(notFound)),
);

// Both protocols freeze their own provider binding before upgrading the user's page.
export const mossLine = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const voice = yield* Voice;
    yield* Effect.forEach(
      [
        [mossLinePath, voice.mossLine],
        [visionLinePath, voice.visionLine],
      ] as const,
      ([path, prepare]) =>
        router.add(
          "GET",
          path,
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            if (!fromTheFarm(request.headers)) return HttpServerResponse.text("not the farm's page", { status: 403 });
            const line = yield* prepare();
            const page = yield* Effect.orDie(request.upgrade);
            yield* line.run(page);
            return HttpServerResponse.empty();
          }).pipe(Effect.catch((error) => Effect.succeed(HttpServerResponse.text(reasonOf(error), { status: 409 })))),
        ),
      { discard: true },
    );
  }),
);

// A client's request key: the same key again gets the first request's result, and the work is done once.

/** As long as a chat message's sendKey may be. */
export const requestKeyMax = 64;

/** Keys remembered per op: a retry comes within seconds, so the newest few hundred are plenty. */
const remembered = 500;

/** One op's memo, in memory: a restart forgets every key. Duplicates that come while the first is running wait for it. */
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
