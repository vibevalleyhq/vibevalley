import { expect, it } from "vite-plus/test";

import { answering, failure, unreachable } from "../base/testing.ts";
import { mossTranscriptionModels } from "./transcription-models.ts";
import { createMossTranscriptionTask, prepareMossTranscription } from "./transcription.ts";

const input = { model: "moss-transcribe-1.0", fileId: "file-one" };

it.for(mossTranscriptionModels)("%s submits a stored file once without inline media or fake streaming", async (model) => {
  let calls = 0;
  const fetch = answering(async (request) => {
    calls++;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://api.mosi.cn/v1/audio/transcriptions");
    expect(request.headers.get("authorization")).toBe("Bearer transcription-account");
    expect(await request.json()).toEqual({
      model,
      file_id: "file-one",
      response_format: "json",
      stream: false,
      async: true,
    });
    return Response.json({ task_id: "transcription-one", retry_after: 0 }, { status: 202 });
  });
  const mossTranscriptionTaskCreated = await createMossTranscriptionTask("transcription-account", { ...input, model }, { fetch });
  expect(mossTranscriptionTaskCreated).toEqual({ taskId: "transcription-one", retryAfterSeconds: 0 });
  expect(calls).toBe(1);
});

it.for(["moss-transcribe-diarize-pro", "moss-transcribe-diarize-pro-2026-07-03"])("%s preserves diarization and Unicode keyterms", async (model) => {
  const keyterms = ["MOSS", "𝄞".repeat(30)];
  const mossTranscriptionPrepared = await prepareMossTranscription({ ...input, model, diarize: true, keyterms });
  expect(mossTranscriptionPrepared).toEqual({
    model,
    file_id: "file-one",
    response_format: "json",
    stream: false,
    async: true,
    diarize: true,
    keyterms,
  });
});

it("standard transcription preserves explicit false and an empty keyterm list", async () => {
  const mossTranscriptionPrepared = await prepareMossTranscription({ ...input, diarize: false, keyterms: [] });
  expect(mossTranscriptionPrepared).toMatchObject({ diarize: false, keyterms: [] });
});

it.for([
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
])("invalid transcription options %# cannot reach the vendor", async (patch) => {
  const mossTranscriptionTaskCreatedFailure = await failure(
    createMossTranscriptionTask("transcription-account", { ...input, ...patch }, { fetch: unreachable }),
  );
  expect(mossTranscriptionTaskCreatedFailure).toMatchObject({
    reason: "InvalidInput",
    outcome: "NotSubmitted",
  });
});
