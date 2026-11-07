import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { transcriptionAudio, transcribeAudio } from "./transcription.ts";

type Model = Parameters<typeof transcribeAudio>[0];

it.effect("transcription uses one explicit model call and preserves warnings, usage and response metadata", () =>
  Effect.gen(function* () {
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
    const result = yield* transcribeAudio(model, new Uint8Array([0, 0, 0]));
    expect(calls).toBe(1);
    expect(result).toMatchObject({
      text: "hello",
      usage: { seconds: 2 },
      warnings: [{ type: "other", message: "fixture warning" }],
      providerMetadata: { fixture: { requestId: "request-1" } },
    });
    expect(result.responses[0]?.headers).toEqual({ "x-request-id": "request-1" });
  }),
);

it.effect("transcription keeps the original model failure and does not retry", () =>
  Effect.gen(function* () {
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
    expect((yield* Effect.flip(transcribeAudio(model, new Uint8Array([1])))).cause).toBe(cause);
    expect(calls).toBe(1);
  }),
);

it.effect("transcription validates the six existing formats and audio before calling a model", () =>
  Effect.gen(function* () {
    for (const format of ["wav", "m4a", "mp3", "webm", "ogg", "flac"]) {
      expect((yield* transcriptionAudio("AAAA", ` .${format.toUpperCase()} `)).format).toBe(format);
    }
    expect(yield* Effect.flip(transcriptionAudio("AAAA", "aac"))).toEqual({ _tag: "UnsupportedFormat", format: "aac" });
    expect(yield* Effect.flip(transcriptionAudio("invalid!", "wav"))).toEqual({ _tag: "EmptyAudio" });
    expect(yield* Effect.flip(transcriptionAudio("", "wav"))).toEqual({ _tag: "EmptyAudio" });
  }),
);
