import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { answering, failure, hanging, unreachable } from "../base/testing.ts";
import { createMossVoice, listMossVoices } from "./voices.ts";

const voice = { id: "voice-one", object: "audio.voice", name: "", created_at: 1 };
const page = { object: "list", data: [voice], first_id: voice.id, last_id: voice.id, has_more: true, next_cursor: "offset:20/+=" };
const answer = (body: unknown) => ({ fetch: answering(() => Response.json(body)) });
const params = (request: Request) => [...new URL(request.url).searchParams.entries()];

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

it("voice pagination preserves names and opaque cursors without guessing readiness or fetching another page", async () => {
  let calls = 0;
  const fetch = answering((request) => {
    calls++;
    const url = new URL(request.url);
    expect(url.origin + url.pathname).toBe("https://api.mosi.cn/v1/audio/voices");
    expect(request.method).toBe("GET");
    expect(request.headers.get("authorization")).toBe("Bearer test-key");
    expect(params(request)).toEqual([
      ["limit", "2"],
      ["after", page.next_cursor],
      ["status", "future-state"],
    ]);
    return Response.json(page);
  });
  const mossVoices = await listMossVoices("test-key", { limit: 2, after: page.next_cursor, status: "future-state" }, { fetch });
  expect(mossVoices).toEqual({
    voices: [{ id: voice.id, name: "", createdAtSeconds: 1 }],
    hasMore: true,
    nextCursor: page.next_cursor,
  });
  expect(calls).toBe(1);
});

it("empty lists and an explicit zero offset are valid", async () => {
  const fetch = answering((request) => {
    expect(params(request)).toEqual([
      ["limit", "20"],
      ["offset", "0"],
    ]);
    return Response.json({ object: "list", data: [], has_more: false });
  });
  const mossVoices = await listMossVoices("test-key", { offset: 0 }, { fetch });
  expect(mossVoices).toEqual({ voices: [], hasMore: false, nextCursor: null });
});

it.for([
  { limit: 0 },
  { limit: 151 },
  { limit: 1.5 },
  { offset: -1 },
  { offset: 100001 },
  { after: "" },
  { after: "x".repeat(8193) },
  { status: "" },
  { offset: 0, after: "next" },
  { url: "https://example.com" },
])("invalid listing input %# never reaches the network", async (input) => {
  const mossVoicesFailure = await failure(listMossVoices("test-key", input, { fetch: unreachable }));
  expect(mossVoicesFailure).toMatchObject({ reason: "InvalidInput", outcome: "NotSubmitted" });
});

it.for([
  { ...page, next_cursor: null },
  { ...page, first_id: "wrong" },
  { ...page, last_id: "wrong" },
  { ...page, data: [voice, voice] },
  { ...page, data: [{ ...voice, created_at: -1 }] },
  { ...page, data: [{ ...voice, object: "file" }] },
  { ...page, data: Array.from({ length: 151 }, (_, n) => ({ ...voice, id: `voice-${n}` })) },
])("invalid voice listing %# is not exposed as usable choices", async (body) => {
  const mossVoicesFailure = await failure(listMossVoices("test-key", {}, answer(body)));
  expect(mossVoicesFailure).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
});

it("voice lists have a byte bound independent of their item bound", async () => {
  const mossVoicesFailure = await failure(listMossVoices("test-key", {}, answer({ ...page, privatePadding: "x".repeat(1 << 20) })));
  expect(mossVoicesFailure).toMatchObject({ reason: "TooLarge", outcome: "Unknown" });
});

it.for(["timeout", "cancel"])("%s stops a pending voice query without retry", async (action) => {
  const transport = hanging();
  const stop = new AbortController();
  const result = failure(listMossVoices("test-key", {}, { fetch: transport.fetch, signal: stop.signal }));
  await transport.started;
  if (action === "cancel") {
    stop.abort();
    await result;
  } else {
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toMatchObject({ reason: "Timeout" });
  }
  expect(transport.seen.stopped).toBe(true);
  expect(transport.seen.calls).toBe(1);
});

const clone = { audio: new Blob(["synthetic-sample"], { type: "audio/wav" }), filename: "sample.wav", durationSeconds: 2 };

it.for([undefined, "", "Narrator"])("voice cloning uploads an explicit Blob and preserves name %#", async (name) => {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls++;
    expect(init?.method).toBe("POST");
    expect(input instanceof Request ? input.url : input.toString()).toBe("https://api.mosi.cn/v1/audio/voices");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer clone-account");
    expect(headers.get("content-type")).toBeNull();
    const form = init?.body;
    if (!(form instanceof FormData)) throw new Error("Expected multipart Blob upload");
    expect(Array.from(form.keys())).toEqual(name === undefined ? ["audio_sample"] : ["audio_sample", "name"]);
    expect(form.get("name")).toBe(name ?? null);
    const sample = form.get("audio_sample");
    expect(sample).toBeInstanceOf(Blob);
    if (!(sample instanceof Blob)) throw new Error("Expected audio Blob");
    expect(sample.size).toBe(clone.audio.size);
    expect(sample.type).toBe("audio/wav");
    return Response.json({ ...voice, name: name ?? "" });
  };
  const mossVoiceCreated = await createMossVoice("clone-account", { ...clone, ...(name !== undefined ? { name } : {}) }, { fetch });
  expect(mossVoiceCreated).toEqual({
    id: voice.id,
    name: name ?? "",
    createdAtSeconds: 1,
  });
  expect(calls).toBe(1);
});

it.for([
  { audio: new Blob([], { type: "audio/wav" }) },
  { audio: new Blob([new Uint8Array(10_000_001)], { type: "audio/wav" }) },
  { audio: new Blob(["sample"], { type: "audio/opus" }), filename: "sample.opus" },
  { audio: "base64" },
  { filename: "../sample.wav" },
  { filename: "sample.mp4" },
  { durationSeconds: 0 },
  { durationSeconds: 30.01 },
  { durationSeconds: Infinity },
  { name: "x".repeat(1001) },
  { url: "https://example.com/sample.wav" },
  { file_id: "file-one" },
])("invalid clone input %# cannot upload or create a voice", async (patch) => {
  const mossVoiceCreatedFailure = await failure(createMossVoice("clone-account", { ...clone, ...patch }, { fetch: unreachable }));
  expect(mossVoiceCreatedFailure).toMatchObject({
    reason: "InvalidInput",
    outcome: "NotSubmitted",
  });
});

it.for([{ ...voice, object: "file" }, { ...voice, id: "../voice" }, { ...voice, created_at: -1 }, { task_id: "task-one" }])(
  "invalid clone receipt %# does not invent a reusable voice",
  async (body) => {
    const mossVoiceCreatedFailure = await failure(createMossVoice("clone-account", clone, answer(body)));
    expect(mossVoiceCreatedFailure).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
  },
);

it("a lost clone response is unknown and never retried", async () => {
  const transport = hanging();
  const result = failure(createMossVoice("clone-account", clone, { fetch: transport.fetch }));
  await transport.started;
  await vi.advanceTimersByTimeAsync(300_000);
  expect(await result).toMatchObject({ reason: "Timeout", outcome: "Unknown" });
  expect(transport.seen.calls).toBe(1);
});
