import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest } from "effect/http";

import { readMossResponse } from "./response.ts";

const Id = Schema.String.check(
  Schema.isBetweenCodePoints(1, 256),
  Schema.isPattern(/^[^\s\p{Cc}/\\?#]+$/u),
  Schema.makeFilter((id) => id.isWellFormed() && id !== "." && id !== ".."),
);
const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const File = Schema.Struct({
  id: Id,
  object: Schema.Literal("file"),
  bytes: Count,
  created_at: Count,
  filename: Schema.String,
  purpose: Schema.String,
  status: Schema.String,
});
const Upload = Schema.Struct({
  file: Schema.instanceOf(Blob).check(Schema.makeFilter((file) => file.size > 0 && file.size <= 512_000_000)),
  filename: Schema.String.check(Schema.isBetweenCodePoints(1, 256), Schema.isPattern(/^[^\p{Cc}/\\]+$/u), Schema.isPattern(/\S/u)),
  purpose: Schema.Literals(["image", "video", "audio"]),
});
const Page = Schema.Struct({
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
  offset: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100000 }))),
});

class MossFileError extends Schema.TaggedError<MossFileError, { readonly brand: unique symbol }>()("MossFileError", {
  reason: Schema.Literals(["Credentials", "InvalidInput", "Network", "Timeout", "HttpStatus", "InvalidResponse", "TooLarge"]),
  outcome: Schema.Literals(["NotSubmitted", "Rejected", "Unknown"]),
  status: Schema.optionalKey(Schema.Int),
}) {}

const request = Effect.fn("Provider.mossFileRequest")(
  function* <A>(key: string, input: HttpClientRequest.HttpClientRequest, schema: Schema.Codec<A, string>) {
    if (!key.trim() || /\s/u.test(key)) return yield* MossFileError.make({ reason: "Credentials", outcome: "NotSubmitted" });
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.execute(input.pipe(HttpClientRequest.setHeaders({ authorization: `Bearer ${key}`, accept: "application/json" })));
    const raw = yield* readMossResponse(response).pipe(
      Effect.catchTag("MossResponseTooLarge", () => Effect.fail(MossFileError.make({ reason: "TooLarge", outcome: "Unknown" }))),
    );
    if (response.status < 200 || response.status >= 300)
      return yield* MossFileError.make({
        reason: "HttpStatus",
        status: response.status,
        outcome: [400, 401, 403, 413, 422, 429].includes(response.status) ? "Rejected" : "Unknown",
      });
    return yield* Schema.decodeEffect(schema)(raw).pipe(Effect.mapError(() => MossFileError.make({ reason: "InvalidResponse", outcome: "Unknown" })));
  },
  Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
  Effect.timeout("300 seconds"),
  Effect.catchTags({
    HttpClientError: () => Effect.fail(MossFileError.make({ reason: "Network", outcome: "Unknown" })),
    TimeoutError: () => Effect.fail(MossFileError.make({ reason: "Timeout", outcome: "Unknown" })),
  }),
);
const fileId = Effect.fnUntraced(function* (id: string) {
  return yield* Schema.decodeEffect(Id)(id).pipe(Effect.mapError(() => MossFileError.make({ reason: "InvalidInput", outcome: "NotSubmitted" })));
});

export const uploadMossFile = Effect.fn("Provider.uploadMossFile")(function* (key: string, input: unknown) {
  const upload = yield* Schema.decodeUnknownEffect(Upload)(input, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => MossFileError.make({ reason: "InvalidInput", outcome: "NotSubmitted" })),
  );
  const form = new FormData();
  form.append("purpose", upload.purpose);
  // A disk-backed Blob stays streaming; do not convert it to an ArrayBuffer or Base64 here.
  form.append("file", upload.file, upload.filename);
  const result = yield* request(key, HttpClientRequest.post("https://api.mosi.cn/v1/files", { body: HttpBody.formData(form) }), Schema.fromJsonString(File));
  if (result.bytes !== upload.file.size || result.purpose !== upload.purpose)
    return yield* MossFileError.make({ reason: "InvalidResponse", outcome: "Unknown" });
  return result;
});

export const getMossFile = Effect.fn("Provider.getMossFile")(function* (key: string, id: string) {
  const checked = yield* fileId(id);
  const result = yield* request(key, HttpClientRequest.get(`https://api.mosi.cn/v1/files/${encodeURIComponent(checked)}`), Schema.fromJsonString(File));
  if (result.id !== checked) return yield* MossFileError.make({ reason: "InvalidResponse", outcome: "Unknown" });
  return result;
});

export const deleteMossFile = Effect.fn("Provider.deleteMossFile")(function* (key: string, id: string) {
  const checked = yield* fileId(id);
  const result = yield* request(
    key,
    HttpClientRequest.delete(`https://api.mosi.cn/v1/files/${encodeURIComponent(checked)}`),
    Schema.fromJsonString(Schema.Struct({ id: Id, object: Schema.Literal("file"), deleted: Schema.Literal(true) })),
  );
  if (result.id !== checked) return yield* MossFileError.make({ reason: "InvalidResponse", outcome: "Unknown" });
  return result;
});

export const listMossFiles = Effect.fn("Provider.listMossFiles")(function* (key: string, input: unknown) {
  const page = yield* Schema.decodeUnknownEffect(Page)(input, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => MossFileError.make({ reason: "InvalidInput", outcome: "NotSubmitted" })),
  );
  const result = yield* request(
    key,
    HttpClientRequest.get("https://api.mosi.cn/v1/files", { urlParams: { limit: page.limit ?? 20, offset: page.offset ?? 0 } }),
    Schema.fromJsonString(Schema.Struct({ object: Schema.Literal("list"), data: Schema.Array(File).check(Schema.isMaxLength(200)) })),
  );
  if (result.data.length > (page.limit ?? 20)) return yield* MossFileError.make({ reason: "InvalidResponse", outcome: "Unknown" });
  return result.data;
});
