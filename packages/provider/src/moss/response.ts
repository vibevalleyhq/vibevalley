import { Effect, Schema, Stream } from "effect";
import type { HttpClientResponse } from "effect/http";

class MossResponseTooLarge extends Schema.TaggedError<MossResponseTooLarge, { readonly brand: unique symbol }>()("MossResponseTooLarge", {}) {}

export const readMossResponse = Effect.fn("Provider.readMossResponse")(function* (response: HttpClientResponse.HttpClientResponse) {
  let bytes = 0;
  const chunks = yield* response.stream.pipe(
    Stream.mapEffect((chunk) => {
      bytes += chunk.byteLength;
      return bytes > 1 << 20 ? Effect.fail(new MossResponseTooLarge()) : Effect.succeed(chunk);
    }),
    Stream.runCollect,
  );
  return Buffer.concat(chunks).toString("utf8");
});
