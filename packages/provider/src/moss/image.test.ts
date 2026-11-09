import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Formatter, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import { generateMossImage } from "./image.ts";

const bodyOf = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown));

const input = { model: "moss-image-base-1.0", prompt: "A small farm in pixel art" };
const layout = {
  summary: { caption: "A poster", meta: ["poster"], canvas: "single" },
  items: [{ label: "text", caption: "A title", text: "MOSS", bbox: [-416, -384, -288, 384] }],
  bbox_format: "yxyx",
  bbox_coord_space: "abs_centralized",
};
const result = {
  created: 1792380763,
  data: [{ url: "https://images.example.com/generated.png?signature=private-result" }],
  usage: { generated_images: 1, output_width: 1024, output_height: 1024 },
};
const answer = (body: string, status = 200) =>
  HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status }))));

it.effect.each(["moss-image-base-1.0", "moss-image-sft-1.0", "moss-image-base-1.0-2026-10-09", "moss-image-sft-1.0-2026-10-09"])(
  "MOSS image %s uses one authenticated request and returns a URL without downloading it",
  (model) => {
    const sent: { url: string; init: RequestInit | undefined }[] = [];
    const fetcher: typeof fetch = (url, init) => {
      sent.push({ url: url instanceof Request ? url.url : String(url), init });
      return Promise.resolve(new Response(Formatter.formatJson(result)));
    };
    return Effect.gen(function* () {
      const generateMossImage2 = yield* generateMossImage("test-key", { ...input, model });
      expect(generateMossImage2).toEqual({ url: result.data[0]?.url, created: result.created, usage: result.usage });
      expect(sent).toHaveLength(1);
      expect(sent[0]?.url).toBe("https://api.mosi.cn/v1/images/generations");
      const init = sent[0]?.init;
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
      expect(new Headers(init?.headers).get("content-type")).toContain("application/json");
      const body = yield* Effect.promise(() => new Response(init?.body).json());
      expect(body).toEqual({
        model,
        prompt: input.prompt,
        size: "1024x1024",
        n: 1,
        response_format: "url",
        prompt_enhance: false,
        output_watermark: { enabled: true },
      });
    }).pipe(Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, fetcher));
  },
);

it.effect.each([
  { width: 256, height: 256 },
  { width: 2048, height: 1024 },
  { width: 1024, height: 2048 },
])("MOSS accepts valid dimension boundaries and counts prompt Unicode code points %#", (size) =>
  Effect.gen(function* () {
    const generated = yield* generateMossImage("test-key", {
      ...input,
      size,
      prompt: "🌱".repeat(4000),
      seed: Number.MAX_SAFE_INTEGER,
      steps: 100,
      guidance: 10,
      enhance: true,
    });
    expect(generated.usage).toEqual({ generated_images: 1, output_width: size.width, output_height: size.height });
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      answer(Formatter.formatJson({ ...result, usage: { generated_images: 1, output_width: size.width, output_height: size.height } })),
    ),
  ),
);

it.effect("MOSS layout serializes centered coordinates and preserves explicit zero and false options", () => {
  const sent: unknown[] = [];
  const http = HttpClient.make((request) => {
    expect(request.body._tag).toBe("Uint8Array");
    if (request.body._tag === "Uint8Array") sent.push(Option.getOrUndefined(bodyOf(new TextDecoder().decode(request.body.body))));
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(Formatter.formatJson(result))));
  });
  return Effect.gen(function* () {
    yield* generateMossImage("test-key", { ...input, prompt: layout, seed: 0, guidance: 0, steps: 1, watermark: false, enhance: false, negativePrompt: "" });
    expect(sent).toEqual([
      {
        model: input.model,
        prompt: Formatter.formatJson(layout),
        size: "1024x1024",
        n: 1,
        response_format: "url",
        prompt_enhance: false,
        output_watermark: { enabled: false },
        seed: 0,
        guidance_scale: 0,
        num_inference_steps: 1,
        negative_prompt: "",
      },
    ]);
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});

it.effect.each([
  null,
  { ...input, model: "moss-image-future" },
  { ...input, prompt: " " },
  { ...input, prompt: "x".repeat(4001) },
  { ...input, negativePrompt: "x".repeat(4001) },
  { ...input, size: { width: 255, height: 1024 } },
  { ...input, size: { width: 2049, height: 1024 } },
  { ...input, size: { width: 1000, height: 1024 } },
  { ...input, size: { width: 2048, height: 2048 } },
  { ...input, seed: -1 },
  { ...input, seed: 0.5 },
  { ...input, seed: Number.MAX_SAFE_INTEGER + 1 },
  { ...input, steps: 0 },
  { ...input, steps: 101 },
  { ...input, guidance: -1 },
  { ...input, guidance: 11 },
  { ...input, guidance: NaN },
  { ...input, guidance: Infinity },
  { ...input, n: 2 },
  { ...input, image: "https://example.com/reference.png" },
  { ...input, prompt: { ...layout, bbox_format: "xyxy" } },
  { ...input, prompt: { ...layout, items: [] } },
  { ...input, prompt: { ...layout, items: [{ label: "object", caption: "A farm", bbox: [-513, 0, 20, 20] }] } },
  { ...input, prompt: { ...layout, items: [{ label: "object", caption: "A farm", bbox: [0, 20, 20, 0] }] } },
  { ...input, prompt: { ...layout, items: [{ label: "object", caption: "A farm", bbox: [0, 0, Infinity, 20] }] } },
  { ...input, prompt: { ...layout, summary: { caption: "x".repeat(3999) } } },
])("invalid image request %# never reaches the network", (request) => {
  let calls = 0;
  const http = HttpClient.make(() => {
    calls++;
    return Effect.die("Unexpected request");
  });
  return Effect.gen(function* () {
    const error = yield* generateMossImage("test-key", request).pipe(Effect.flip);
    expect(error).toMatchObject({ reason: "InvalidInput", outcome: "NotSubmitted" });
    expect(Formatter.formatJson(error)).not.toContain("test-key");
    expect(calls).toBe(0);
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});

it.effect.each(["", " ", "key\nheader", "invalid key"])("invalid credential %# is refused locally", (key) =>
  Effect.gen(function* () {
    const generateMossImageFailure = yield* generateMossImage(key, input).pipe(Effect.flip);
    expect(generateMossImageFailure).toMatchObject({ reason: "Credentials", outcome: "NotSubmitted" });
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Unexpected request")),
    ),
  ),
);

it.effect.each([301, 400, 401, 403, 404, 408, 429, 500, 502, 503])("HTTP %i never retries and never exposes upstream secrets", (status) => {
  let calls = 0;
  const http = HttpClient.make((request) => {
    calls++;
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(Formatter.formatJson({ error: { code: "safety_guardrail_blocked", message: "test-key private-prompt" } }), { status }),
      ),
    );
  });
  return Effect.gen(function* () {
    const error = yield* generateMossImage("test-key", input).pipe(Effect.flip);
    expect(error).toMatchObject({
      reason: "HttpStatus",
      status,
      code: "safety_guardrail_blocked",
      outcome: [400, 401, 403, 429].includes(status) ? "Rejected" : "Unknown",
    });
    expect(Formatter.formatJson(error)).not.toMatch(/test-key|private-prompt/u);
    expect(calls).toBe(1);
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});

it.effect("unknown vendor error codes are not copied into public errors", () =>
  Effect.gen(function* () {
    const error = yield* generateMossImage("test-key", input).pipe(Effect.flip);
    expect(error).toMatchObject({ reason: "HttpStatus", status: 403, outcome: "Rejected" });
    expect(error.code).toBeUndefined();
    expect(Formatter.formatJson(error)).not.toContain("reflected-private-input");
  }).pipe(Effect.provideService(HttpClient.HttpClient, answer('{"error":{"code":"reflected-private-input"}}', 403))),
);

it.effect.each([
  "not-json",
  "{}",
  Formatter.formatJson({ ...result, data: [] }),
  Formatter.formatJson({ ...result, data: [...result.data, ...result.data] }),
  Formatter.formatJson({ ...result, data: [{ url: "http://images.example.com/image.png" }] }),
  Formatter.formatJson({ ...result, data: [{ url: "https://user:password@images.example.com/image.png" }] }),
  Formatter.formatJson({ ...result, data: [{ url: "data:image/png;base64,AAAA" }] }),
  Formatter.formatJson({ ...result, usage: { ...result.usage, generated_images: 2 } }),
  Formatter.formatJson({ ...result, usage: { ...result.usage, output_width: 512 } }),
])("invalid result %# means unknown outcome, not permission to generate again", (body) =>
  Effect.gen(function* () {
    const error = yield* generateMossImage("test-key", input).pipe(Effect.flip);
    expect(error).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
    expect(Formatter.formatJson(error)).not.toContain("private-result");
  }).pipe(Effect.provideService(HttpClient.HttpClient, answer(body))),
);

it.effect("oversized response stops reading instead of truncating a result", () =>
  Effect.gen(function* () {
    const generateMossImageFailure = yield* generateMossImage("test-key", input).pipe(Effect.flip);
    expect(generateMossImageFailure).toMatchObject({ reason: "TooLarge", outcome: "Unknown" });
  }).pipe(Effect.provideService(HttpClient.HttpClient, answer(" ".repeat((1 << 20) + 1)))),
);

it.effect("image transport errors are ambiguous and sanitized", () => {
  let calls = 0;
  const fetcher: typeof fetch = () => {
    calls++;
    return Promise.reject(new Error("test-key private-prompt"));
  };
  return Effect.gen(function* () {
    const error = yield* generateMossImage("test-key", input).pipe(Effect.flip);
    expect(error).toMatchObject({ reason: "Network", outcome: "Unknown" });
    expect(Formatter.formatJson(error)).not.toMatch(/test-key|private-prompt/u);
    expect(calls).toBe(1);
  }).pipe(Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, fetcher));
});

it.effect("an interrupted response body does not leak the upstream exception", () =>
  Effect.gen(function* () {
    const error = yield* generateMossImage("test-key", input).pipe(Effect.flip);
    expect(error).toMatchObject({ reason: "Network", outcome: "Unknown" });
    expect(Formatter.formatJson(error)).not.toContain("private-body-error");
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.error(new Error("private-body-error"));
                },
              }),
            ),
          ),
        ),
      ),
    ),
  ),
);

it.effect("image timeout interrupts the transport once and preserves an unknown outcome", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const stopped = yield* Deferred.make<void>();
    let calls = 0;
    const http = HttpClient.make(() => {
      calls++;
      return Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
      );
    });
    const fiber = yield* generateMossImage("test-key", input).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.flip, Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("900 seconds");
    const fiber2 = yield* Fiber.join(fiber);
    expect(fiber2).toMatchObject({ reason: "Timeout", outcome: "Unknown" });
    const isDone2 = yield* Deferred.isDone(stopped);
    expect(isDone2).toBe(true);
    expect(calls).toBe(1);
  }),
);

it.effect("image timeout includes reading the response body", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let canceled = false;
    const http = HttpClient.make((request) =>
      Deferred.succeed(started, undefined).pipe(
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
      ),
    );
    const fiber = yield* generateMossImage("test-key", input).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.flip, Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("900 seconds");
    const fiber2 = yield* Fiber.join(fiber);
    expect(fiber2).toMatchObject({ reason: "Timeout", outcome: "Unknown" });
    expect(canceled).toBe(true);
  }),
);

it.effect("canceling local generation stops its transport without resubmission", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const stopped = yield* Deferred.make<void>();
    const http = HttpClient.make(() =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
      ),
    );
    const fiber = yield* generateMossImage("test-key", input).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.forkChild);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    const isDone2 = yield* Deferred.isDone(stopped);
    expect(isDone2).toBe(true);
  }),
);
