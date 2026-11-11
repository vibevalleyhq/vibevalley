import { Effect, Schema, Stream } from "effect";

import { attachmentMax } from "@vibevalley/protocol";

import { type PublicHttp, publicHttps } from "#/infra/publicHttp.ts";

import { validPng } from "./png.ts";

class DownloadFailed extends Schema.TaggedError<DownloadFailed, { readonly brand: unique symbol }>()("DownloadFailed", {}) {}

export const downloadImage = Effect.fn("Media.downloadImage")(
  function* (http: PublicHttp["Service"], address: string, width: number, height: number) {
    const url = yield* Schema.decodeEffect(Schema.URLFromString)(address).pipe(Effect.mapError(() => DownloadFailed.make()));
    if (!publicHttps(url)) return yield* DownloadFailed.make();
    const response = yield* http.get(url, { headers: { accept: "image/png" } });
    if (response.status !== 200 || response.headers["content-type"]?.split(";")[0]?.trim() !== "image/png") return yield* DownloadFailed.make();
    let size = 0;
    const chunks = yield* response.stream.pipe(
      Stream.mapEffect((chunk) => {
        size += chunk.byteLength;
        return size > attachmentMax ? Effect.fail(DownloadFailed.make()) : Effect.succeed(chunk);
      }),
      Stream.runCollect,
    );
    const bytes = Buffer.concat(chunks);
    if (!validPng(bytes, width, height)) return yield* DownloadFailed.make();
    return bytes;
  },
  Effect.timeout("60 seconds"),
  Effect.catchTags({ HttpClientError: () => Effect.fail(DownloadFailed.make()), TimeoutError: () => Effect.fail(DownloadFailed.make()) }),
);
