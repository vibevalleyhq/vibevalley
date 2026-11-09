import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import { mossUnderstandingModels } from "./understanding-models.ts";
import { prepareMossUnderstanding, understandMossMedia } from "./understanding.ts";

const input = { model: "moss-vl-1.0", text: "Describe this scene", media: [{ kind: "image", fileId: "file-image" }] };
const result = {
  id: "response-id",
  model: "moss-vl-1.0",
  status: "completed",
  output: [{ content: [{ type: "output_text", text: "A farm." }] }],
  usage: { input_tokens: 120, output_tokens: 4, total_tokens: 124 },
};
const answer = (body: string, status = 200) =>
  HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status }))));

it.effect.each(mossUnderstandingModels)("%s submits exactly once with explicit credentials and no redirects", (model) => {
  const sent: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher: typeof fetch = (url, init) => {
    sent.push({ url: url instanceof Request ? url.url : String(url), init });
    return Promise.resolve(new Response(JSON.stringify(result)));
  };
  return Effect.gen(function* () {
    const understood = yield* understandMossMedia("test-key", { ...input, model, maxOutputTokens: 8192 });
    expect(understood).toEqual({
      id: "response-id",
      model: "moss-vl-1.0",
      status: "completed",
      text: "A farm.",
      incompleteReason: null,
      usage: { inputTokens: 120, outputTokens: 4, totalTokens: 124 },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://api.mosi.cn/v1/responses");
    const init = sent[0]?.init;
    expect(init?.redirect).toBe("manual");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
    expect(yield* Effect.promise(() => new Response(init?.body).json())).toEqual({
      model,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: input.text },
            { type: "input_image", file_id: "file-image" },
          ],
        },
      ],
      max_output_tokens: 8192,
    });
  }).pipe(Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, fetcher));
});

it.effect.each([
  { media: Array.from({ length: 5 }, (_, i) => ({ kind: "image", fileId: `file-${i}` })), expected: { type: "input_image", file_id: "file-0" } },
  {
    media: [{ kind: "image", url: "https://images.example.com/a.png?signature=private" }],
    expected: { type: "input_image", image_url: "https://images.example.com/a.png?signature=private" },
  },
  { media: [{ kind: "video", fileId: "file-video" }], expected: { type: "input_video", file_id: "file-video" } },
  { media: [{ kind: "video", url: "https://video.example.com/a.mp4" }], expected: { type: "input_video", video_url: "https://video.example.com/a.mp4" } },
])("one image group or one video is encoded without inline media %#", ({ media, expected }) =>
  Effect.gen(function* () {
    const request = yield* prepareMossUnderstanding({ ...input, media });
    expect(request.input[0]?.content[1]).toEqual(expected);
    expect(request).not.toHaveProperty("max_output_tokens");
  }),
);

it.effect.each([
  { text: "" },
  { text: " \n" },
  { text: "x".repeat(64001) },
  { model: "moss-live-1.0" },
  { media: [] },
  { media: Array.from({ length: 6 }, () => ({ kind: "image", fileId: "f" })) },
  {
    media: [
      { kind: "image", fileId: "f" },
      { kind: "video", fileId: "v" },
    ],
  },
  {
    media: [
      { kind: "video", fileId: "a" },
      { kind: "video", fileId: "b" },
    ],
  },
  { media: [{ kind: "image" }] },
  { media: [{ kind: "image", fileId: "f", url: "https://example.com/a.png" }] },
  { media: [{ kind: "image", url: "data:image/png;base64,AA==" }] },
  { media: [{ kind: "image", url: "file:///private/image.png" }] },
  { media: [{ kind: "image", url: "http://example.com/a.png" }] },
  { media: [{ kind: "image", url: "https://user:password@example.com/a.png" }] },
  { media: [{ kind: "image", fileId: "" }] },
  { media: [{ kind: "image", fileId: "x".repeat(257) }] },
  { media: [{ kind: "image", url: `https://example.com/${"x".repeat(8192)}` }] },
  { media: [{ kind: "image", url: "https://example.com/a.png#part" }] },
  { maxOutputTokens: 0 },
  { maxOutputTokens: 8193 },
  { maxOutputTokens: 1.5 },
  { stream: true },
  { asynchronous: true },
])("invalid understanding input is refused before any transport %#", (invalid) => {
  let calls = 0;
  const http = HttpClient.make(() => {
    calls++;
    return Effect.never;
  });
  return Effect.gen(function* () {
    expect(yield* Effect.flip(understandMossMedia("test-key", { ...input, ...invalid }))).toMatchObject({ reason: "InvalidInput", outcome: "NotSubmitted" });
    expect(calls).toBe(0);
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});

it.effect.each(["", " ", "key\nheader", "key with spaces"])("invalid credentials never submit %#", (key) =>
  Effect.gen(function* () {
    expect(yield* Effect.flip(understandMossMedia(key, input))).toMatchObject({ reason: "Credentials", outcome: "NotSubmitted" });
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("must not send")),
    ),
  ),
);

it.effect.each(["max_output_tokens", "private-upstream-details", null])(
  "incomplete text and reported usage survive without leaking arbitrary reasons %#",
  (reason) =>
    Effect.gen(function* () {
      const understood = yield* understandMossMedia("test-key", input);
      expect(understood.status).toBe("incomplete");
      expect(understood.text).toBe("A farm.\nA partial sentence");
      expect(understood.incompleteReason).toBe(reason === "max_output_tokens" ? reason : null);
      expect(understood.usage.totalTokens).toBe(124);
      expect(JSON.stringify(understood)).not.toContain("private-upstream-details");
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        answer(
          JSON.stringify({
            ...result,
            status: "incomplete",
            incomplete_details: { reason },
            output: [...result.output, { content: [{ type: "output_text", text: "A partial sentence" }] }],
          }),
        ),
      ),
    ),
);

it.effect.each([400, 401, 403, 413, 422, 429, 302, 404, 408, 500, 503])("HTTP %s is sanitized and never retried", (status) => {
  let calls = 0;
  const http = HttpClient.make((request) => {
    calls++;
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("test-key private-url", { status })));
  });
  return Effect.gen(function* () {
    const error = yield* Effect.flip(understandMossMedia("test-key", input));
    expect(error).toMatchObject({ reason: "HttpStatus", status, outcome: [400, 401, 403, 413, 422, 429].includes(status) ? "Rejected" : "Unknown" });
    expect(JSON.stringify(error)).not.toMatch(/test-key|private-url/u);
    expect(calls).toBe(1);
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});

it.effect.each([
  "not JSON",
  JSON.stringify({ ...result, status: "queued" }),
  JSON.stringify({ ...result, output: [] }),
  JSON.stringify({ ...result, usage: { input_tokens: -1, output_tokens: 1, total_tokens: 0 } }),
])("invalid responses remain unknown %#", (body) =>
  Effect.gen(function* () {
    expect(yield* Effect.flip(understandMossMedia("test-key", input))).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
  }).pipe(Effect.provideService(HttpClient.HttpClient, answer(body))),
);

it.effect("understanding bounds response bytes", () =>
  Effect.gen(function* () {
    expect(yield* Effect.flip(understandMossMedia("test-key", input))).toMatchObject({ reason: "TooLarge", outcome: "Unknown" });
  }).pipe(Effect.provideService(HttpClient.HttpClient, answer("x".repeat((1 << 20) + 1)))),
);

it.effect("understanding's deadline includes body reading and aborts without resubmitting", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let canceled = false;
    let calls = 0;
    const http = HttpClient.make((request) => {
      calls++;
      return Deferred.succeed(started, undefined).pipe(
        Effect.as(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              new ReadableStream<Uint8Array>({
                cancel() {
                  canceled = true;
                },
              }),
            ),
          ),
        ),
      );
    });
    const fiber = yield* understandMossMedia("test-key", input).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.flip, Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("180 seconds");
    expect(yield* Fiber.join(fiber)).toMatchObject({ reason: "Timeout", outcome: "Unknown" });
    expect(canceled).toBe(true);
    expect(calls).toBe(1);
  }),
);
