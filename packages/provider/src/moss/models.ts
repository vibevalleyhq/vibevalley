import { Effect, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";

export class MossModelError extends Schema.TaggedError<MossModelError, { readonly brand: unique symbol }>()("MossModelError", {
  reason: Schema.Literals(["Credentials", "Network", "Timeout", "HttpStatus", "InvalidResponse", "TooLarge"]),
  status: Schema.optionalKey(Schema.Int),
}) {}

const ModelList = Schema.fromJsonString(
  Schema.Struct({
    object: Schema.Literal("list"),
    data: Schema.Array(
      Schema.Struct({
        id: Schema.NonEmptyString,
        object: Schema.Literal("model"),
        created: Schema.Int,
        owned_by: Schema.String,
      }),
    ),
  }),
);

export const mossModels = Effect.fn("Provider.mossModels")(
  function* (key: string) {
    if (!key.trim() || /\s/u.test(key)) return yield* MossModelError.make({ reason: "Credentials" });
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.get("https://api.mosi.cn/v1/models", { headers: { authorization: `Bearer ${key}`, accept: "application/json" } });
    if (response.status < 200 || response.status >= 300) return yield* MossModelError.make({ reason: "HttpStatus", status: response.status });
    let size = 0;
    const chunks = yield* response.stream.pipe(
      Stream.mapEffect((chunk) => {
        size += chunk.byteLength;
        return size > 1 << 20 ? Effect.fail(MossModelError.make({ reason: "TooLarge" })) : Effect.succeed(chunk);
      }),
      Stream.runCollect,
    );
    const list = yield* Schema.decodeEffect(ModelList)(Buffer.concat(chunks).toString("utf8")).pipe(
      Effect.mapError(() => MossModelError.make({ reason: "InvalidResponse" })),
    );
    if (list.data.length > 1000) return yield* MossModelError.make({ reason: "TooLarge" });
    return list.data.map((model) => ({ id: model.id, owner: model.owned_by }));
  },
  // Fetch follows redirects below HttpClient; never forward this credential to a redirected endpoint.
  Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
  Effect.timeout("15 seconds"),
  // Transport errors contain authenticated requests; only safe classifications cross this boundary.
  Effect.catchTags({
    HttpClientError: () => Effect.fail(MossModelError.make({ reason: "Network" })),
    TimeoutError: () => Effect.fail(MossModelError.make({ reason: "Timeout" })),
  }),
);
