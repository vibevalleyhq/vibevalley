import { expect, test } from "vite-plus/test";

import { TranscriptionFailed, transcriptionAudio, transcribeAudio } from "./transcription.ts";

type Model = Parameters<typeof transcribeAudio>[0];

test("transcription uses one explicit model call and preserves warnings, usage and response metadata", async () => {
  let calls = 0;
  const model: Model = {
    specificationVersion: "v4",
    provider: "fixture",
    modelId: "test-transcription",
    doGenerate: (options) => {
      calls++;
      expect(options.audio).toEqual(new Uint8Array([0, 0, 0]));
      expect(options.abortSignal).toBeDefined();
      return Promise.resolve({
        text: "hello",
        segments: [],
        language: "en",
        durationInSeconds: 2,
        warnings: [{ type: "other", message: "fixture warning" }],
        usage: { seconds: 2 },
        providerMetadata: { fixture: { requestId: "request-1" } },
        response: { timestamp: new Date(0), modelId: "test-transcription", headers: { "x-request-id": "request-1" } },
      });
    },
  };
  const result = await transcribeAudio(model, new Uint8Array([0, 0, 0]));
  expect(calls).toBe(1);
  expect(result).toMatchObject({
    text: "hello",
    usage: { seconds: 2 },
    warnings: [{ type: "other", message: "fixture warning" }],
    providerMetadata: { fixture: { requestId: "request-1" } },
  });
  expect(result.responses[0]?.headers).toEqual({ "x-request-id": "request-1" });
});

test("transcription keeps the original model failure and does not retry", async () => {
  const cause = new Error("fixture unavailable");
  let calls = 0;
  const model: Model = {
    specificationVersion: "v4",
    provider: "fixture",
    modelId: "test",
    doGenerate: () => {
      calls++;
      return Promise.reject(cause);
    },
  };
  const failed = await transcribeAudio(model, new Uint8Array([1])).catch((e: unknown) => e);
  expect(failed).toBeInstanceOf(TranscriptionFailed);
  expect(failed).toMatchObject({ cause });
  expect(calls).toBe(1);
});

test("transcription validates the six existing formats and audio before calling a model", async () => {
  for (const format of ["wav", "m4a", "mp3", "webm", "ogg", "flac"]) {
    expect((await transcriptionAudio("AAAA", ` .${format.toUpperCase()} `)).format).toBe(format);
  }
  const transcriptionAudioFailure = await transcriptionAudio("AAAA", "aac").catch((e: unknown) => e);
  expect(transcriptionAudioFailure).toMatchObject({ _tag: "UnsupportedFormat", format: "aac" });
  const transcriptionAudioFailure2 = await transcriptionAudio("invalid!", "wav").catch((e: unknown) => e);
  expect(transcriptionAudioFailure2).toMatchObject({ _tag: "EmptyAudio" });
  const transcriptionAudioFailure3 = await transcriptionAudio("", "wav").catch((e: unknown) => e);
  expect(transcriptionAudioFailure3).toMatchObject({ _tag: "EmptyAudio" });
});
