import { ByteSize, Cause, Clock, Deferred, Effect, Exit, Metric, Schema } from "effect";
import { HttpIncomingMessage, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { t } from "@vibevalley/i18n";
import { artifactPrefix, attachmentMax, attachmentPath, mossLinePath, visionLinePath } from "@vibevalley/protocol";
import {
  ApiError,
  ApiErrorEnvelope,
  apiSuccessEnvelope,
  ApiVoidEnvelope,
  BizCode,
  type Endpoint,
  endpoints,
  type Handlers,
  pathOf,
} from "@vibevalley/protocol/api";
import { artifactId } from "@vibevalley/protocol/schema";

import { bizError, messageOf, reasonOf } from "#/base/errors.ts";
import { wireOf } from "#/base/json.ts";
import { Voice } from "#/gateway/voice/voice.ts";
import { Artifact } from "#/modules/artifact/artifact.ts";
import { artifactHeaders, artifactPrintHeaders } from "#/modules/artifact/policy.ts";
import { shellThemeOf, withShell } from "#/modules/artifact/shell.ts";
import { Attachment } from "#/modules/attachment/attachment.ts";

import { fromTheFarm } from "./rpc.ts";

// The same Schema the clients read it back with: a refusal that does not fit it is the server's bug, a 500.
const isApiError = Schema.is(ApiError);

/** Encodes a structured ApiError into its full JSON wire envelope with the status mapped from its BizCode. */
export const replyError = (e: ApiError) => HttpServerResponse.schemaJson(ApiErrorEnvelope)(e.toEnvelope(), { status: e.status });

const notFound = () => HttpServerResponse.text("404 page not found\n", { status: 404 });
const serverError = (route: string, error: unknown) =>
  Effect.as(Effect.logError(`vibevalley: ${route} failed`, error), HttpServerResponse.text(messageOf(error) + "\n", { status: 500 }));

/** The most a body may be, read before it is decoded: an attachment comes as base64 in JSON, everything else is small. */
const bodyMax = 2 * 1024 * 1024;
const attachmentBodyMax = Math.ceil(attachmentMax / 3) * 4 + 64 * 1024;
const bodyMaxOf = (endpoint: Endpoint) => (endpoint.op === "attachment.create" ? attachmentBodyMax : bodyMax);

/** Each call of an endpoint, by its op and the status it answered. */
const requests = Metric.counter("vibevalley.http.requests", { description: "Calls of an endpoint, by op and status", incremental: true });

function serve(endpoint: Endpoint, handle: (input: unknown) => Effect.Effect<unknown, ApiError>) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!fromTheFarm(request.headers)) return yield* replyError(bizError(BizCode.Forbidden, "forbidden"));
    let input: unknown;
    if (endpoint.input) {
      const max = bodyMaxOf(endpoint);
      // A body that says it is too big is refused before it is read; one that grows past the limit on the way stops there.
      const length = Number(request.headers["content-length"] ?? 0);
      if (length > max) return yield* replyError(bizError(BizCode.PayloadTooLarge, `the body is ${length} bytes, at most ${max}`));
      const text = yield* Effect.provideService(request.text, HttpIncomingMessage.MaxBodySize, ByteSize.bytes(max)).pipe(
        Effect.catchReason("HttpServerError", "RequestParseError", (e) => (e.reason === "BodyTooLarge" ? Effect.undefined : Effect.fail(e))),
      );
      if (text === undefined) return yield* replyError(bizError(BizCode.PayloadTooLarge, `the body grew past ${max}`));
      const decoded = Schema.decodeExit(Schema.fromJsonString(endpoint.input))(text === "" ? "{}" : text);
      if (decoded._tag === "Failure") return yield* replyError(bizError(BizCode.InvalidInput, Cause.pretty(decoded.cause)));
      input = decoded.value;
    }
    const out = yield* handle(input).pipe(Effect.result);
    if (out._tag === "Failure") return yield* replyError(out.failure);
    if (!endpoint.result) return yield* HttpServerResponse.schemaJson(ApiVoidEnvelope)({ bizCode: 0, message: "ok" });
    return yield* HttpServerResponse.schemaJson(apiSuccessEnvelope(endpoint.result))({ bizCode: 0, message: "ok", data: wireOf(out.success) });
  }).pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
      const failure = Cause.squash(cause);
      if (isApiError(failure)) return replyError(failure);
      return Effect.andThen(Effect.logError("an endpoint failed", cause), replyError(bizError(BizCode.InternalError, messageOf(failure))));
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
  }).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(notFound())),
    Effect.catch((error) => serverError("attachment", error)),
  ),
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
  }).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(notFound())),
    Effect.catchTag("ApiError", (e) => (e.kind === "Missing" ? Effect.succeed(notFound()) : Effect.fail(e))),
    Effect.catch((error) => serverError("artifact", error)),
  ),
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
const requestKeyTtlMs = 5 * 60_000;

/** One op's memo, in memory: a restart forgets every key. Duplicates wait for the first write, which runs uninterruptibly so a
 * caller that disconnects mid-write still leaves its result for the retry; a failure forgets the key at once. Not `Cache`:
 * its entry is dropped when the only waiter is interrupted, so the retry would write again. */
export const requestKeys = <A>() =>
  Effect.sync(() => {
    const seen = new Map<string, { readonly done: Deferred.Deferred<A, ApiError>; expiresAt: number }>();
    return (key: string | undefined, work: Effect.Effect<A, ApiError>): Effect.Effect<A, ApiError> => {
      if (key === undefined || key === "") return work;
      if (key.length > requestKeyMax) return Effect.fail(bizError(BizCode.RequestKeyTooLong, t("server.base.requestKeyLong", { max: requestKeyMax })));
      return Effect.flatMap(Clock.currentTimeMillis, (now) => {
        const first = seen.get(key);
        if (first !== undefined && first.expiresAt > now) return Deferred.await(first.done);
        const mine = { done: Deferred.makeUnsafe<A, ApiError>(), expiresAt: Number.POSITIVE_INFINITY };
        seen.delete(key);
        seen.set(key, mine);
        // Map keeps insertion order: the first key is the oldest.
        for (const old of seen.keys()) {
          if (seen.size <= remembered) break;
          seen.delete(old);
        }
        return Effect.uninterruptible(
          work.pipe(
            Effect.onExit((exit) =>
              Effect.flatMap(Clock.currentTimeMillis, (at) => {
                if (Exit.isSuccess(exit)) mine.expiresAt = at + requestKeyTtlMs;
                else if (seen.get(key) === mine) seen.delete(key);
                return Deferred.done(mine.done, exit);
              }),
            ),
          ),
        );
      });
    };
  });
