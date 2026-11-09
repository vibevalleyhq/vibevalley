import { Effect, Schema, Stream } from "effect";

import { attachmentMax } from "@vibevalley/protocol";

import { PublicHttp, publicHttps } from "#/infra/publicHttp.ts";

import { validPng } from "./png.ts";

class DownloadFailed extends Schema.TaggedError<DownloadFailed, { readonly brand: unique symbol }>()("DownloadFailed", {}) {}

export const downloadImage = Effect.fn("Media.downloadImage")(
  function* (address: string, width: number, height: number) {
    const url = yield* Schema.decodeEffect(Schema.URLFromString)(address).pipe(Effect.mapError(() => new DownloadFailed()));
    if (!publicHttps(url)) return yield* new DownloadFailed();
    const http = yield* PublicHttp;
    const response = yield* http.get(url, { headers: { accept: "image/png" } });
    if (response.status !== 200 || response.headers["content-type"]?.split(";")[0]?.trim() !== "image/png") return yield* new DownloadFailed();
    let size = 0;
    const chunks = yield* response.stream.pipe(
      Stream.mapEffect((chunk) => {
        size += chunk.byteLength;
        return size > attachmentMax ? Effect.fail(new DownloadFailed()) : Effect.succeed(chunk);
      }),
      Stream.runCollect,
    );
    const bytes = Buffer.concat(chunks);
    if (!validPng(bytes, width, height)) return yield* new DownloadFailed();
    return bytes;
  },
  Effect.timeout("60 seconds"),
  Effect.catchTags({ HttpClientError: () => Effect.fail(new DownloadFailed()), TimeoutError: () => Effect.fail(new DownloadFailed()) }),
);
