import { expect, it } from "vite-plus/test";

import { json } from "./testing.ts";
import { transcriptionModel } from "./transcription.ts";

it("compatible transcription keeps filenames, MIME types, model and json format without an implicit key", async () => {
  const sent: { url: string; authorization: string | null; form: FormData | undefined }[] = [];
  const fetcher: typeof fetch = (input, init) => {
    sent.push({
      url: input instanceof Request ? input.url : String(input),
      authorization: new Headers(init?.headers).get("authorization"),
      form: init?.body instanceof FormData ? init.body : undefined,
    });
    return Promise.resolve(new Response(json({ text: " ok ", usage: { seconds: 2 } }), { headers: { "x-request-id": "local-1" } }));
  };
  for (const [format, mime] of [
    ["wav", "audio/wav"],
    ["m4a", "audio/mp4"],
    ["mp3", "audio/mpeg"],
    ["webm", "audio/webm"],
    ["ogg", "audio/ogg"],
    ["flac", "audio/flac"],
  ] as const) {
    const model = transcriptionModel({ url: "http://transcription.invalid/v1", key: "", model: "explicit-model" }, format, { fetch: fetcher });
    const result = await model.doGenerate({ audio: new Uint8Array([1, 2]), mediaType: "audio/wav", abortSignal: new AbortController().signal });
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
});

it("regression: unrecognized transcription usage does not invalidate an existing text response", async () => {
  const body = json({ text: "ok", usage: "unknown vendor format" });
  const fetcher: typeof fetch = () => Promise.resolve(new Response(body));
  const model = transcriptionModel({ url: "http://transcription.invalid/v1", key: "", model: "explicit-model" }, "wav", { fetch: fetcher });
  const result = await model.doGenerate({ audio: new Uint8Array([1]), mediaType: "audio/wav", abortSignal: new AbortController().signal });
  expect(result.text).toBe("ok");
  expect(result.usage).toBeUndefined();
  expect(result.response.body).toBe(body);
});
