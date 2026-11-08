import { Effect, Schema } from "effect";
import { HttpBody, HttpClientRequest } from "effect/http";

import { AudioId, AudioResult, audioRequest, MossAudioError } from "./audio-response.ts";
import { mossSpeechFormats, mossSpeechLanguages, mossSpeechModels } from "./speech-models.ts";

const Text = Schema.String.check(Schema.isBetweenCodePoints(1, 10000), Schema.isPattern(/\S/u));
const Metadata = Schema.Struct({
  enabled: Schema.Boolean,
  contentPropagator: Schema.optionalKey(Schema.String.check(Schema.isBetweenCodePoints(1, 128))),
  propagateId: Schema.optionalKey(Schema.String.check(Schema.isBetweenCodePoints(1, 256))),
});
const Input = Schema.Struct({
  model: Schema.Literals(mossSpeechModels),
  text: Text,
  voice: AudioId,
  format: Schema.Literals(mossSpeechFormats),
  language: Schema.optionalKey(Schema.Literals(mossSpeechLanguages)),
  expectedDuration: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(3600))),
  metadata: Schema.optionalKey(Metadata),
}).check(
  Schema.makeFilter((input) => {
    if (input.model === "moss-tts-1.0-pro" || input.model === "moss-tts-1.0-pro-2026-02-07")
      return input.language === undefined && !input.text.includes("[pause");
    return [...input.text.matchAll(/\[pause[^\]]*\]/gu)].every(([pause]) => /^\[pause (?:0\.[1-9]\d*|[1-9](?:\.\d+)?|10(?:\.0+)?)s\]$/u.test(pause));
  }),
);
const SpeechResponse = Schema.fromJsonString(
  Schema.Struct({
    id: AudioId,
    object: Schema.Literal("audio.speech"),
    status: Schema.Literal("SUCCESS"),
    created_at: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    ...AudioResult.fields,
  }).check(Schema.makeFilter((result) => Schema.is(AudioResult)(result))),
);
const Submission = Schema.fromJsonString(Schema.Struct({ task_id: AudioId }));

export const prepareMossSpeech = Effect.fn("Provider.prepareMossSpeech")(function* (input: unknown) {
  const request = yield* Schema.decodeUnknownEffect(Input)(input, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => new MossAudioError({ reason: "InvalidInput", outcome: "NotSubmitted" })),
  );
  return {
    model: request.model,
    input: request.text,
    voice_id: request.voice,
    response_format: request.format,
    delivery_method: "url" as const,
    stream: false,
    ...(request.language !== undefined ? { language: request.language } : {}),
    ...(request.expectedDuration !== undefined ? { expected_duration_sec: request.expectedDuration } : {}),
    ...(request.metadata !== undefined
      ? {
          aigc_metadata: {
            enabled: request.metadata.enabled,
            ...(request.metadata.contentPropagator !== undefined ? { content_propagator: request.metadata.contentPropagator } : {}),
            ...(request.metadata.propagateId !== undefined ? { propagate_id: request.metadata.propagateId } : {}),
          },
        }
      : {}),
  };
});

const post = Effect.fnUntraced(function* (key: string, input: unknown, asynchronous: boolean) {
  const request = yield* prepareMossSpeech(input);
  const body = yield* HttpBody.json({ ...request, async: asynchronous }).pipe(
    Effect.mapError(() => new MossAudioError({ reason: "InvalidInput", outcome: "NotSubmitted" })),
  );
  const raw = yield* audioRequest(key, HttpClientRequest.post("https://api.mosi.cn/v1/audio/speech", { body }));
  return { raw, format: request.response_format };
});

export const generateMossSpeech = Effect.fn("Provider.generateMossSpeech")(
  function* (key: string, input: unknown) {
    const { raw, format } = yield* post(key, input, false);
    const result = yield* Schema.decodeEffect(SpeechResponse)(raw).pipe(
      Effect.mapError(() => new MossAudioError({ reason: "InvalidResponse", outcome: "Unknown" })),
    );
    if (result.response_format !== format) return yield* new MossAudioError({ reason: "InvalidResponse", outcome: "Unknown" });
    return { id: result.id, url: result.url.href, format: result.response_format, contentType: result.content_type, createdAt: result.created_at };
  },
  Effect.timeout("300 seconds"),
  Effect.catchTag("TimeoutError", () => Effect.fail(new MossAudioError({ reason: "Timeout", outcome: "Unknown" }))),
);

export const createMossSpeechTask = Effect.fn("Provider.createMossSpeechTask")(
  function* (key: string, input: unknown) {
    const { raw } = yield* post(key, input, true);
    const result = yield* Schema.decodeEffect(Submission)(raw).pipe(
      Effect.mapError(() => new MossAudioError({ reason: "InvalidResponse", outcome: "Unknown" })),
    );
    return { taskId: result.task_id };
  },
  Effect.timeout("300 seconds"),
  Effect.catchTag("TimeoutError", () => Effect.fail(new MossAudioError({ reason: "Timeout", outcome: "Unknown" }))),
);
