import type { TranscriptionModelV4 } from "@ai-sdk/provider";
import { type Cause, DateTime, Effect, FiberSet, Schema } from "effect";
import { HttpBody, HttpClient, type HttpClientError } from "effect/http";

import { mossTranscriptionModels } from "./moss/transcription-models.ts";

export const mossTranscription = { url: "https://api.mosi.cn/v1", models: mossTranscriptionModels } as const;
const transcriptionFormats = {
  wav: "audio/wav",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  webm: "audio/webm",
  ogg: "audio/ogg",
  flac: "audio/flac",
} as const;
export const TranscriptionFormat = Schema.Literals(["wav", "m4a", "mp3", "webm", "ogg", "flac"]);
export type TranscriptionFormat = typeof TranscriptionFormat.Type;

export class TranscriptionRequestError extends Schema.TaggedError<TranscriptionRequestError, { readonly brand: unique symbol }>()("TranscriptionRequestError", {
  reason: Schema.Literals(["Unreachable", "Cut", "HttpStatus", "InvalidResponse"]),
  message: Schema.String,
  status: Schema.optionalKey(Schema.Int),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const ResponseSchema = Schema.fromJsonString(
  Schema.Struct({
    text: Schema.optionalKey(Schema.String),
    usage: Schema.optionalKey(Schema.Unknown),
    error: Schema.optionalKey(Schema.Struct({ message: Schema.optionalKey(Schema.String) })),
  }),
);
const errorMessage = (u: unknown): string => (u instanceof Error ? u.message : String(u));
const causeText = (e: HttpClientError.HttpClientError | Cause.TimeoutError) =>
  e._tag === "HttpClientError" && "cause" in e.reason && e.reason.cause !== undefined ? errorMessage(e.reason.cause) : e.message;

// MOSS and configured compatible endpoints require json, not OpenAI's verbose_json response format.
export const transcriptionModel = Effect.fn("Provider.transcriptionModel")(function* (
  connection: {
    readonly url: string;
    readonly model: string;
    readonly key: string;
  },
  format: TranscriptionFormat,
) {
  const http = yield* HttpClient.HttpClient;
  const run = yield* FiberSet.makeRuntimePromise();
  const model: TranscriptionModelV4 = {
    specificationVersion: "v4",
    provider: "compatible-transcription",
    modelId: connection.model,
    doGenerate: (options) =>
      run(
        Effect.gen(function* () {
          const audio = typeof options.audio === "string" ? Buffer.from(options.audio, "base64") : Buffer.from(options.audio);
          const form = new FormData();
          form.append("file", new Blob([audio], { type: transcriptionFormats[format] }), `dictation.${format}`);
          form.append("model", connection.model);
          form.append("response_format", "json");
          const res = yield* http
            .post(connection.url + "/audio/transcriptions", {
              headers: connection.key ? { authorization: "Bearer " + connection.key } : {},
              body: HttpBody.formData(form),
            })
            .pipe(
              Effect.timeout("120 seconds"),
              Effect.mapError((cause) => TranscriptionRequestError.make({ reason: "Unreachable", message: causeText(cause), cause })),
            );
          const raw = (yield* res.text.pipe(
            Effect.mapError((cause) => TranscriptionRequestError.make({ reason: "Cut", message: causeText(cause), cause })),
          )).slice(0, 1 << 20);
          const got = Schema.decodeOption(ResponseSchema)(raw);
          const detail = got._tag === "Some" ? got.value.error?.message : undefined;
          if (res.status < 200 || res.status >= 300)
            return yield* TranscriptionRequestError.make({
              reason: "HttpStatus",
              status: res.status,
              message: [...(detail || raw.trim())].slice(0, 200).join(""),
            });
          if (got._tag === "None") return yield* TranscriptionRequestError.make({ reason: "InvalidResponse", message: "Invalid transcription response" });
          const usage = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.MutableJson))(got.value.usage);
          const now = yield* DateTime.now;
          return {
            text: (got.value.text ?? "").trim(),
            segments: [],
            language: undefined,
            durationInSeconds: undefined,
            ...(usage._tag === "Some" ? { usage: usage.value } : {}),
            warnings: [],
            response: { timestamp: DateTime.toDateUtc(now), modelId: connection.model, headers: res.headers, body: raw },
          };
        }),
        { signal: options.abortSignal },
      ),
  };
  return model;
});
