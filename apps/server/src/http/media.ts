import { ByteSize, Effect, Stream } from "effect";
import { HttpIncomingMessage, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { t } from "@vibevalley/i18n";
import { ApiError, errorStatus } from "@vibevalley/protocol/api";
import { MediaInput } from "@vibevalley/protocol/schema";

import { refused } from "#/base/errors.ts";
import { Media } from "#/media/media.ts";

import { fromTheFarm } from "./rpc.ts";

// This route is deliberately absent from the LAN listener: only the local owner can upload new inputs.
export const mediaUploads = HttpRouter.add(
  "PUT",
  "/api/v1/media/input/:id/content",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!fromTheFarm(request.headers)) return HttpServerResponse.empty({ status: 403 });
    if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/octet-stream") return HttpServerResponse.empty({ status: 415 });
    if (Number(request.headers["content-length"] ?? 0) > 512_000_000) return HttpServerResponse.empty({ status: 413 });
    const { id = "" } = yield* HttpRouter.params;
    if (!/^[0-9a-f-]{36}$/u.test(id)) return HttpServerResponse.empty({ status: 404 });
    const media = yield* Media;
    const source = request.stream.pipe(
      Stream.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(512_000_000)),
      Stream.mapError(() => refused(t("server.media.inputDisconnected"))),
    );
    return yield* media.inputs.upload(id, source).pipe(
      Effect.matchEffect({
        onFailure: (error) => HttpServerResponse.schemaJson(ApiError)(error, { status: errorStatus[error._tag] }),
        onSuccess: HttpServerResponse.schemaJson(MediaInput),
      }),
    );
  }),
);

export const mediaInputContent = HttpRouter.add(
  "GET",
  "/api/v1/media/input/:id/content",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!fromTheFarm(request.headers)) return HttpServerResponse.empty({ status: 403 });
    const { id = "" } = yield* HttpRouter.params;
    if (!/^[0-9a-f-]{36}$/u.test(id)) return HttpServerResponse.empty({ status: 404 });
    const found = yield* (yield* Media).inputs.content(id);
    let start = 0;
    let end = found.size - 1;
    const range = request.headers.range;
    if (range !== undefined) {
      const parts = /^bytes=(\d*)-(\d*)$/u.exec(range);
      if (!parts || (!parts[1] && !parts[2])) return HttpServerResponse.empty({ status: 416, headers: { "content-range": `bytes */${found.size}` } });
      start = parts[1] ? Number(parts[1]) : Math.max(0, found.size - Number(parts[2]));
      end = parts[1] && parts[2] ? Math.min(Number(parts[2]), found.size - 1) : found.size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= found.size)
        return HttpServerResponse.empty({ status: 416, headers: { "content-range": `bytes */${found.size}` } });
    }
    return yield* HttpServerResponse.file(found.path, {
      status: range === undefined ? 200 : 206,
      contentType: found.mime,
      offset: start,
      bytesToRead: end - start + 1,
      headers: {
        "accept-ranges": "bytes",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(found.name)}`,
        ...(range === undefined ? {} : { "content-range": `bytes ${start}-${end}/${found.size}` }),
      },
    });
  }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 404 }))),
);

export const mediaSpeechStream = HttpRouter.add(
  "GET",
  "/api/v1/media/speech/:id/stream",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!fromTheFarm(request.headers)) return HttpServerResponse.empty({ status: 403 });
    const { id = "" } = yield* HttpRouter.params;
    const events = yield* (yield* Media).speechEvents(id);
    const encoder = new TextEncoder();
    return HttpServerResponse.stream(events.pipe(Stream.map((event) => encoder.encode(`${JSON.stringify(event)}\n`))), {
      contentType: "application/x-ndjson",
      headers: { "cache-control": "no-store", "x-accel-buffering": "no", "x-content-type-options": "nosniff" },
    });
  }).pipe(Effect.catch((error) => HttpServerResponse.schemaJson(ApiError)(error, { status: errorStatus[error._tag] }))),
);
