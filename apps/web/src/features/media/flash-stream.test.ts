import { describe, expect, it } from "vite-plus/test";

import type { MediaSpeechEvent } from "@vibevalley/protocol";

import { flashEvents, flashPcm } from "./flash-stream.ts";

const format: MediaSpeechEvent = { type: "format", sampleRate: 48000, channels: 2, bitDepth: 16 };
const audio: MediaSpeechEvent = { type: "audio", sequence: 0, audio: "AACA/w==" };
const done: MediaSpeechEvent = { type: "done" };

function body(text: string, fragment = 7) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + fragment));
      offset += fragment;
    },
  });
}

async function collect(text: string, signal = new AbortController().signal) {
  const events: MediaSpeechEvent[] = [];
  for await (const event of flashEvents(body(text), signal)) events.push(event);
  return events;
}

const lines = (events: MediaSpeechEvent[]) => events.map((event) => JSON.stringify(event)).join("\n");

describe("Flash NDJSON stream", () => {
  it("decodes fragmented reads and a terminal line without a trailing newline", async () => {
    expect(await collect(lines([format, audio, done]))).toEqual([format, audio, done]);
    expect(await collect(`\n${lines([format, audio, done]).replaceAll("\n", "\r\n")}\r\n`)).toEqual([format, audio, done]);
  });

  it.each([
    [audio, done],
    [format, format, audio, done],
    [format, { ...audio, sequence: 1 }, done],
    [format, audio, audio, done],
    [format, done],
    [format, audio, { type: "failed" }],
    [format, audio],
    [format, audio, done, audio],
  ] satisfies MediaSpeechEvent[][])("rejects incomplete or out-of-order stream %#", async (...events) => {
    await expect(collect(lines(events))).rejects.toThrow();
  });

  it("rejects malformed JSON, unsupported formats and oversized unterminated lines", async () => {
    await expect(collect("{invalid}\n")).rejects.toThrow();
    await expect(collect(JSON.stringify({ ...format, bitDepth: 24 }) + "\n")).rejects.toThrow();
    const stream = body("x".repeat(2 * 1024 * 1024 + 1), 1024 * 1024);
    await expect(
      (async () => {
        for await (const event of flashEvents(stream, new AbortController().signal)) void event;
      })(),
    ).rejects.toThrow();
  });

  it("honors cancellation before consuming input", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(collect(lines([format, audio, done]), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("Flash PCM16 little-endian frames", () => {
  it("preserves channel-interleaved signed samples without native-endian assumptions", () => {
    const bytes = new Uint8Array([0, 128, 255, 127, 0, 0, 0, 192]);
    const pcm = flashPcm(btoa(String.fromCharCode(...bytes)), 2);
    expect([pcm.getInt16(0, true), pcm.getInt16(2, true), pcm.getInt16(4, true), pcm.getInt16(6, true)]).toEqual([-32768, 32767, 0, -16384]);
  });

  it("accepts 32 KiB chunks and rejects larger Base64 messages", () => {
    const chunk = btoa("\0".repeat(32 * 1024));
    expect(flashPcm(chunk, 2).byteLength).toBe(32 * 1024);
    expect(() => flashPcm(btoa("\0".repeat(32 * 1024 + 2)), 1)).toThrow();
  });

  it("rejects empty, malformed and non-frame-aligned chunks", () => {
    expect(() => flashPcm("", 1)).toThrow();
    expect(() => flashPcm("!", 1)).toThrow();
    expect(() => flashPcm("AA==", 1)).toThrow();
    expect(() => flashPcm("AAA=", 2)).toThrow();
  });
});
