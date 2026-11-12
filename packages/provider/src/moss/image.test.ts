import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { answering, failure, hanging, json, shown, unreachable } from "../base/testing.ts";
import { generateMossImage } from "./image.ts";

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
const answer = (body: string, status = 200) => ({ fetch: answering(() => new Response(body, { status })) });

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

it.for(["moss-image-base-1.0", "moss-image-sft-1.0", "moss-image-base-1.0-2026-10-09", "moss-image-sft-1.0-2026-10-09"])(
  "MOSS image %s uses one authenticated request and returns a URL without downloading it",
  async (model) => {
    const sent: { url: string; init: RequestInit | undefined }[] = [];
    const fetcher: typeof fetch = (url, init) => {
      sent.push({ url: url instanceof Request ? url.url : String(url), init });
      return Promise.resolve(new Response(json(result)));
    };
    const generateMossImage2 = await generateMossImage("test-key", { ...input, model }, { fetch: fetcher });
    expect(generateMossImage2).toEqual({ url: result.data[0]?.url, created: result.created, usage: result.usage });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://api.mosi.cn/v1/images/generations");
    const init = sent[0]?.init;
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
    expect(new Headers(init?.headers).get("content-type")).toContain("application/json");
    const body: unknown = await new Response(init?.body).json();
    expect(body).toEqual({
      model,
      prompt: input.prompt,
      size: "1024x1024",
      n: 1,
      response_format: "url",
      prompt_enhance: false,
      output_watermark: { enabled: true },
    });
  },
);

it.for([
  { width: 256, height: 256 },
  { width: 2048, height: 1024 },
  { width: 1024, height: 2048 },
])("MOSS accepts valid dimension boundaries and counts prompt Unicode code points %#", async (size) => {
  const generated = await generateMossImage(
    "test-key",
    {
      ...input,
      size,
      prompt: "🌱".repeat(4000),
      seed: Number.MAX_SAFE_INTEGER,
      steps: 100,
      guidance: 10,
      enhance: true,
    },
    answer(json({ ...result, usage: { generated_images: 1, output_width: size.width, output_height: size.height } })),
  );
  expect(generated.usage).toEqual({ generated_images: 1, output_width: size.width, output_height: size.height });
});

it("MOSS layout serializes centered coordinates and preserves explicit zero and false options", async () => {
  const sent: unknown[] = [];
  const fetch = answering(async (request) => {
    sent.push(await request.json());
    return new Response(json(result));
  });
  await generateMossImage(
    "test-key",
    { ...input, prompt: layout, seed: 0, guidance: 0, steps: 1, watermark: false, enhance: false, negativePrompt: "" },
    { fetch },
  );
  expect(sent).toEqual([
    {
      model: input.model,
      prompt: json(layout),
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
});

it.for([
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
])("invalid image request %# never reaches the network", async (request) => {
  let calls = 0;
  const fetcher: typeof fetch = () => {
    calls++;
    throw new Error("Unexpected request");
  };
  const error = await failure(generateMossImage("test-key", request, { fetch: fetcher }));
  expect(error).toMatchObject({ reason: "InvalidInput", outcome: "NotSubmitted" });
  expect(shown(error)).not.toContain("test-key");
  expect(calls).toBe(0);
});

it.for(["", " ", "key\nheader", "invalid key"])("invalid credential %# is refused locally", async (key) => {
  const generateMossImageFailure = await failure(generateMossImage(key, input, { fetch: unreachable }));
  expect(generateMossImageFailure).toMatchObject({ reason: "Credentials", outcome: "NotSubmitted" });
});

it.for([301, 400, 401, 403, 404, 408, 429, 500, 502, 503])("HTTP %i never retries and never exposes upstream secrets", async (status) => {
  let calls = 0;
  const fetch = answering(() => {
    calls++;
    return new Response(json({ error: { code: "safety_guardrail_blocked", message: "test-key private-prompt" } }), { status });
  });
  const error = await failure(generateMossImage("test-key", input, { fetch }));
  expect(error).toMatchObject({
    reason: "HttpStatus",
    status,
    code: "safety_guardrail_blocked",
    outcome: [400, 401, 403, 429].includes(status) ? "Rejected" : "Unknown",
  });
  expect(shown(error)).not.toMatch(/test-key|private-prompt/u);
  expect(calls).toBe(1);
});

it("unknown vendor error codes are not copied into public errors", async () => {
  const error = await failure(generateMossImage("test-key", input, answer('{"error":{"code":"reflected-private-input"}}', 403)));
  expect(error).toMatchObject({ reason: "HttpStatus", status: 403, outcome: "Rejected" });
  expect(error).not.toHaveProperty("code");
  expect(shown(error)).not.toContain("reflected-private-input");
});

it.for([
  "not-json",
  "{}",
  json({ ...result, data: [] }),
  json({ ...result, data: [...result.data, ...result.data] }),
  json({ ...result, data: [{ url: "http://images.example.com/image.png" }] }),
  json({ ...result, data: [{ url: "https://user:password@images.example.com/image.png" }] }),
  json({ ...result, data: [{ url: "data:image/png;base64,AAAA" }] }),
  json({ ...result, usage: { ...result.usage, generated_images: 2 } }),
  json({ ...result, usage: { ...result.usage, output_width: 512 } }),
])("invalid result %# means unknown outcome, not permission to generate again", async (body) => {
  const error = await failure(generateMossImage("test-key", input, answer(body)));
  expect(error).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
  expect(shown(error)).not.toContain("private-result");
});

it("oversized response stops reading instead of truncating a result", async () => {
  const generateMossImageFailure = await failure(generateMossImage("test-key", input, answer(" ".repeat((1 << 20) + 1))));
  expect(generateMossImageFailure).toMatchObject({ reason: "TooLarge", outcome: "Unknown" });
});

it("image transport errors are ambiguous and sanitized", async () => {
  let calls = 0;
  const fetcher: typeof fetch = () => {
    calls++;
    return Promise.reject(new Error("test-key private-prompt"));
  };
  const error = await failure(generateMossImage("test-key", input, { fetch: fetcher }));
  expect(error).toMatchObject({ reason: "Network", outcome: "Unknown" });
  expect(shown(error)).not.toMatch(/test-key|private-prompt/u);
  expect(calls).toBe(1);
});

it("an interrupted response body does not leak the upstream exception", async () => {
  const fetch = answering(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("private-body-error"));
          },
        }),
      ),
  );
  const error = await failure(generateMossImage("test-key", input, { fetch }));
  expect(error).toMatchObject({ reason: "Network", outcome: "Unknown" });
  expect(shown(error)).not.toContain("private-body-error");
});

it("image timeout interrupts the transport once and preserves an unknown outcome", async () => {
  const transport = hanging();
  const result = failure(generateMossImage("test-key", input, { fetch: transport.fetch }));
  await transport.started;
  await vi.advanceTimersByTimeAsync(900_000);
  expect(await result).toMatchObject({ reason: "Timeout", outcome: "Unknown" });
  expect(transport.seen.stopped).toBe(true);
  expect(transport.seen.calls).toBe(1);
});

it("image timeout includes reading the response body", async () => {
  const started = Promise.withResolvers<void>();
  let canceled = false;
  const fetcher: typeof fetch = async () => {
    started.resolve();
    return new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          canceled = true;
        },
      }),
    );
  };
  const result = failure(generateMossImage("test-key", input, { fetch: fetcher }));
  await started.promise;
  await vi.advanceTimersByTimeAsync(900_000);
  expect(await result).toMatchObject({ reason: "Timeout", outcome: "Unknown" });
  expect(canceled).toBe(true);
});

it("canceling local generation stops its transport without resubmission", async () => {
  const transport = hanging();
  const stop = new AbortController();
  const result = failure(generateMossImage("test-key", input, { fetch: transport.fetch, signal: stop.signal }));
  await transport.started;
  stop.abort();
  await result;
  expect(transport.seen.stopped).toBe(true);
});
