import { expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { mossTranscriptionModels } from "./transcription-models.ts";
import { createMossTranscriptionTask, prepareMossTranscription } from "./transcription.ts";

const bodyOf = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown));

const input = { model: "moss-transcribe-1.0", fileId: "file-one" };

it.effect.each(mossTranscriptionModels)("%s submits a stored file once without inline media or fake streaming", (model) => {
  let calls = 0;
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      calls++;
      expect(request.method).toBe("POST");
      expect(request.url).toBe("https://api.mosi.cn/v1/audio/transcriptions");
      expect(request.headers.authorization).toBe("Bearer transcription-account");
      if (request.body._tag !== "Uint8Array") return yield* Effect.die("Expected JSON");
      expect(Option.getOrUndefined(bodyOf(new TextDecoder().decode(request.body.body)))).toEqual({
        model,
        file_id: "file-one",
        response_format: "json",
        stream: false,
        async: true,
      });
      return HttpClientResponse.fromWeb(request, Response.json({ task_id: "transcription-one", retry_after: 0 }, { status: 202 }));
    }),
  );
  return Effect.gen(function* () {
    const mossTranscriptionTaskCreated = yield* createMossTranscriptionTask("transcription-account", { ...input, model });
    expect(mossTranscriptionTaskCreated).toEqual({ taskId: "transcription-one", retryAfterSeconds: 0 });
    expect(calls).toBe(1);
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});

it.effect.each(["moss-transcribe-diarize-pro", "moss-transcribe-diarize-pro-2026-07-03"])("%s preserves diarization and Unicode keyterms", (model) =>
  Effect.gen(function* () {
    const keyterms = ["MOSS", "𝄞".repeat(30)];
    const mossTranscriptionPrepared = yield* prepareMossTranscription({ ...input, model, diarize: true, keyterms });
    expect(mossTranscriptionPrepared).toEqual({
      model,
      file_id: "file-one",
      response_format: "json",
      stream: false,
      async: true,
      diarize: true,
      keyterms,
    });
  }),
);

it.effect("standard transcription preserves explicit false and an empty keyterm list", () =>
  Effect.gen(function* () {
    const mossTranscriptionPrepared = yield* prepareMossTranscription({ ...input, diarize: false, keyterms: [] });
    expect(mossTranscriptionPrepared).toMatchObject({ diarize: false, keyterms: [] });
  }),
);

it.effect.each([
  { fileId: "" },
  { fileId: "../file" },
  { model: "moss-tts-1.0-pro" },
  { diarize: true },
  { keyterms: ["MOSS"] },
  { model: "moss-transcribe-1.0-2026-07-22", diarize: true },
  { model: "moss-transcribe-diarize-pro", keyterms: ["x".repeat(31)] },
  { model: "moss-transcribe-diarize-pro", keyterms: Array.from({ length: 21 }, () => "MOSS") },
  { model: "moss-transcribe-diarize-pro", keyterms: [" "] },
  { model: "moss-transcribe-diarize-pro", keyterms: [5] },
  { audio_data: "base64" },
  { url: "https://example.com/audio.wav" },
  { stream: true },
  { async: false },
  { response_format: "verbose_json" },
])("invalid transcription options %# cannot reach the vendor", (patch) =>
  Effect.gen(function* () {
    const mossTranscriptionTaskCreatedFailure = yield* createMossTranscriptionTask("transcription-account", { ...input, ...patch }).pipe(Effect.flip);
    expect(mossTranscriptionTaskCreatedFailure).toMatchObject({
      reason: "InvalidInput",
      outcome: "NotSubmitted",
    });
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Must not submit")),
    ),
  ),
);
