import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";

import { transcriptionModel } from "./transcription.ts";

it.effect("compatible transcription keeps filenames, MIME types, model and json format without an implicit key", () => {
  const sent: { url: string; authorization: string | null; form: FormData | undefined }[] = [];
  const fetcher: typeof fetch = (input, init) => {
    sent.push({
      url: input instanceof Request ? input.url : String(input),
      authorization: new Headers(init?.headers).get("authorization"),
      form: init?.body instanceof FormData ? init.body : undefined,
    });
    return Promise.resolve(new Response(JSON.stringify({ text: " ok ", usage: { seconds: 2 } }), { headers: { "x-request-id": "local-1" } }));
  };
  return Effect.gen(function* () {
    for (const [format, mime] of [
      ["wav", "audio/wav"],
      ["m4a", "audio/mp4"],
      ["mp3", "audio/mpeg"],
      ["webm", "audio/webm"],
      ["ogg", "audio/ogg"],
      ["flac", "audio/flac"],
    ] as const) {
      const model = yield* transcriptionModel({ url: "http://transcription.invalid/v1", key: "", model: "explicit-model" }, format);
      const result = yield* Effect.promise((abortSignal) =>
        Promise.resolve(model.doGenerate({ audio: new Uint8Array([1, 2]), mediaType: "audio/wav", abortSignal })),
      );
      expect(result.text).toBe("ok");
      expect(result.usage).toEqual({ seconds: 2 });
      expect(result.response.headers?.["x-request-id"]).toBe("local-1");
      const call = sent.at(-1);
      expect(call?.url).toBe("http://transcription.invalid/v1/audio/transcriptions");
      expect(call?.authorization).toBeNull();
      expect(call?.form?.get("model")).toBe("explicit-model");
      expect(call?.form?.get("response_format")).toBe("json");
      const file = call?.form?.get("file");
      expect(file instanceof File && file.name).toBe(`dictation.${format}`);
      expect(file instanceof File && file.type).toBe(mime);
    }
    expect(sent).toHaveLength(6);
  }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, fetcher));
});

it.effect("regression: unrecognized transcription usage does not invalidate an existing text response", () => {
  const body = JSON.stringify({ text: "ok", usage: "unknown vendor format" });
  const fetcher: typeof fetch = () => Promise.resolve(new Response(body));
  return Effect.gen(function* () {
    const model = yield* transcriptionModel({ url: "http://transcription.invalid/v1", key: "", model: "explicit-model" }, "wav");
    const result = yield* Effect.promise((abortSignal) =>
      Promise.resolve(model.doGenerate({ audio: new Uint8Array([1]), mediaType: "audio/wav", abortSignal })),
    );
    expect(result.text).toBe("ok");
    expect(result.usage).toBeUndefined();
    expect(result.response.body).toBe(body);
  }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, fetcher));
});
