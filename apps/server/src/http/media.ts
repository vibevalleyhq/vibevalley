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
    if (Number(request.headers["content-length"] ?? 0) > 200_000_000) return HttpServerResponse.empty({ status: 413 });
    const { id = "" } = yield* HttpRouter.params;
    if (!/^[0-9a-f-]{36}$/u.test(id)) return HttpServerResponse.empty({ status: 404 });
    const media = yield* Media;
    const source = request.stream.pipe(
      Stream.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(200_000_000)),
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
