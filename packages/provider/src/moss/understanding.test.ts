import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { answering, failure, json, shown, unreachable } from "../base/testing.ts";
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
const answer = (body: string, status = 200) => ({ fetch: answering(() => new Response(body, { status })) });

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

it.for(mossUnderstandingModels)("%s submits exactly once with explicit credentials and no redirects", async (model) => {
  const sent: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher: typeof fetch = (url, init) => {
    sent.push({ url: url instanceof Request ? url.url : String(url), init });
    return Promise.resolve(new Response(json(result)));
  };
  const understood = await understandMossMedia("test-key", { ...input, model, maxOutputTokens: 8192 }, { fetch: fetcher });
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
  const json2: unknown = await new Response(init?.body).json();
  expect(json2).toEqual({
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
});

it.for([
  { media: Array.from({ length: 5 }, (_, i) => ({ kind: "image", fileId: `file-${i}` })), expected: { type: "input_image", file_id: "file-0" } },
  {
    media: [{ kind: "image", url: "https://images.example.com/a.png?signature=private" }],
    expected: { type: "input_image", image_url: "https://images.example.com/a.png?signature=private" },
  },
  { media: [{ kind: "video", fileId: "file-video" }], expected: { type: "input_video", file_id: "file-video" } },
  { media: [{ kind: "video", url: "https://video.example.com/a.mp4" }], expected: { type: "input_video", video_url: "https://video.example.com/a.mp4" } },
])("one image group or one video is encoded without inline media %#", async ({ media, expected }) => {
  const request = await prepareMossUnderstanding({ ...input, media });
  expect(request.input[0]?.content[1]).toEqual(expected);
  expect(request).not.toHaveProperty("max_output_tokens");
});

it.for([
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
])("invalid understanding input is refused before any transport %#", async (invalid) => {
  let calls = 0;
  const fetcher: typeof fetch = () => {
    calls++;
    return new Promise<Response>(() => undefined);
  };
  const understandMossMediaFailure = await failure(understandMossMedia("test-key", { ...input, ...invalid }, { fetch: fetcher }));
  expect(understandMossMediaFailure).toMatchObject({ reason: "InvalidInput", outcome: "NotSubmitted" });
  expect(calls).toBe(0);
});

it.for(["", " ", "key\nheader", "key with spaces"])("invalid credentials never submit %#", async (key) => {
  const understandMossMediaFailure = await failure(understandMossMedia(key, input, { fetch: unreachable }));
  expect(understandMossMediaFailure).toMatchObject({ reason: "Credentials", outcome: "NotSubmitted" });
});

it.for(["max_output_tokens", "private-upstream-details", null])(
  "incomplete text and reported usage survive without leaking arbitrary reasons %#",
  async (reason) => {
    const understood = await understandMossMedia(
      "test-key",
      input,
      answer(
        json({
          ...result,
          status: "incomplete",
          incomplete_details: { reason },
          output: [...result.output, { content: [{ type: "output_text", text: "A partial sentence" }] }],
        }),
      ),
    );
    expect(understood.status).toBe("incomplete");
    expect(understood.text).toBe("A farm.\nA partial sentence");
    expect(understood.incompleteReason).toBe(reason === "max_output_tokens" ? reason : null);
    expect(understood.usage.totalTokens).toBe(124);
    expect(json(understood)).not.toContain("private-upstream-details");
  },
);

it.for([400, 401, 403, 413, 422, 429, 302, 404, 408, 500, 503])("HTTP %s is sanitized and never retried", async (status) => {
  let calls = 0;
  const fetch = answering(() => {
    calls++;
    return new Response("test-key private-url", { status });
  });
  const error = await failure(understandMossMedia("test-key", input, { fetch }));
  expect(error).toMatchObject({ reason: "HttpStatus", status, outcome: [400, 401, 403, 413, 422, 429].includes(status) ? "Rejected" : "Unknown" });
  expect(shown(error)).not.toMatch(/test-key|private-url/u);
  expect(calls).toBe(1);
});

it.for([
  "not JSON",
  json({ ...result, status: "queued" }),
  json({ ...result, output: [] }),
  json({ ...result, usage: { input_tokens: -1, output_tokens: 1, total_tokens: 0 } }),
])("invalid responses remain unknown %#", async (body) => {
  const understandMossMediaFailure = await failure(understandMossMedia("test-key", input, answer(body)));
  expect(understandMossMediaFailure).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
});

it("understanding bounds response bytes", async () => {
  const understandMossMediaFailure = await failure(understandMossMedia("test-key", input, answer("x".repeat((1 << 20) + 1))));
  expect(understandMossMediaFailure).toMatchObject({ reason: "TooLarge", outcome: "Unknown" });
});

it("understanding's deadline includes body reading and aborts without resubmitting", async () => {
  const started = Promise.withResolvers<void>();
  let canceled = false;
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    started.resolve();
    return new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          canceled = true;
        },
      }),
    );
  };
  const result = failure(understandMossMedia("test-key", input, { fetch: fetcher }));
  await started.promise;
  await vi.advanceTimersByTimeAsync(180_000);
  expect(await result).toMatchObject({ reason: "Timeout", outcome: "Unknown" });
  expect(canceled).toBe(true);
  expect(calls).toBe(1);
});
