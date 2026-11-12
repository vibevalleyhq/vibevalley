import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";

import { expect, test } from "vite-plus/test";

import { tempDir } from "@vibevalley/testkit/temp";

import { wallTime } from "#/infra/time.ts";
import { mp3, wav } from "#/modules/media/testdata/audio.ts";
import { png } from "#/modules/media/testdata/png.ts";

import { inspectAudio } from "./audioMetadata.ts";
import { audioResultMax, diskStorage, type MediaInputStorage, stageAudioResult, stageMediaInput } from "./input.ts";

const bytes = png();
const metadata = { kind: "image", name: "picture.png", mime: "image/png", size: bytes.length };

async function* chunks(...parts: readonly Uint8Array[]) {
  for (const part of parts) yield part;
}

/** A source that must never be read. */
const unread = (): AsyncIterable<Uint8Array> => ({
  [Symbol.asyncIterator]: () => {
    throw new Error("must not read invalid input");
  },
});

/** Its first part, then nothing ever again; reading says so. */
const stalled = (first: Uint8Array) => {
  const { promise: reading, resolve } = Promise.withResolvers<void>();
  async function* source() {
    yield first;
    resolve();
    await new Promise<never>(() => undefined);
  }
  return { reading, source: source() };
};

/** A clock whose waits end only when the test says. */
const heldClock = () => {
  const waits: (() => void)[] = [];
  return {
    clock: {
      ...wallTime,
      sleep: (_ms: number, signal?: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
          waits.push(resolve);
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    },
    pass: () => {
      for (const wake of waits.splice(0)) wake();
    },
  };
};

const failure = (p: Promise<unknown>) =>
  p.then(
    () => new Error("it did not fail"),
    (e: unknown) => e,
  );

test("staging streams split headers into a private file and removes it when its scope closes", async () => {
  const root = tempDir("vibevalley-media-");
  let path = "";
  {
    await using staged = await stageMediaInput(
      diskStorage,
      root,
      metadata,
      chunks(...Array.from(bytes.subarray(0, 16), (byte) => Uint8Array.of(byte)), bytes.subarray(16)),
    );
    expect(staged.hash).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(readFileSync(staged.path)).toEqual(bytes);
    expect(statSync(staged.path).mode & 0o777).toBe(0o600);
    path = staged.path;
  }
  expect(() => statSync(path)).toThrow();
  expect(readdirSync(root)).toEqual([]);
});

test.each([
  { size: 30_000_001 },
  { size: 0 },
  { size: 1.5 },
  { name: "../picture.png" },
  { name: "a\nb" },
  { mime: "text/html" },
  { kind: "image", mime: "video/mp4" },
  { kind: "video", mime: "video/mp4", size: 200_000_001 },
  { path: "/private/file" },
])("invalid input metadata is refused before reading the source %#", async (invalid) => {
  const root = tempDir("vibevalley-media-");
  const mediaInputStagedFailure = await failure(stageMediaInput(diskStorage, root, { ...metadata, ...invalid }, unread()));
  expect(mediaInputStagedFailure).toMatchObject({ reason: "Metadata" });
  expect(readdirSync(root)).toEqual([]);
});

test.each([
  { body: bytes.subarray(0, bytes.length - 1), reason: "Size" },
  { body: Buffer.concat([bytes, Uint8Array.of(0)]), reason: "Size" },
  { body: Buffer.alloc(bytes.length, 60), reason: "Format" },
])("size mismatches and disguised content never leave a staged file %#", async ({ body, reason }) => {
  const root = tempDir("vibevalley-media-");
  const error = await failure(stageMediaInput(diskStorage, root, metadata, chunks(body)));
  expect(error).toMatchObject({ reason });
  expect(readdirSync(root)).toEqual([]);
});

test("regression: canceling an unfinished upload releases its writer and deletes partial bytes", async () => {
  const root = tempDir("vibevalley-media-");
  const { reading, source } = stalled(bytes.subarray(0, 32));
  const stop = new AbortController();
  const staging = failure(stageMediaInput(diskStorage, root, metadata, source, { signal: stop.signal }));
  await reading;
  expect(readdirSync(root)).toHaveLength(1);
  stop.abort();
  await staging;
  expect(readdirSync(root)).toEqual([]);
});

test("a stalled input times out and removes its partial file", async () => {
  const root = tempDir("vibevalley-media-");
  const { reading, source } = stalled(bytes.subarray(0, 32));
  const held = heldClock();
  const staging = failure(stageMediaInput(diskStorage, root, metadata, source, { clock: held.clock }));
  await reading;
  held.pass();
  expect(await staging).toMatchObject({ name: "TimeoutError" });
  expect(readdirSync(root)).toEqual([]);
});

test.each([
  { kind: "image", mime: "image/jpeg", header: "ffd8ffe000104a46494600010100000000" },
  { kind: "image", mime: "image/webp", header: "52494646080000005745425000000000" },
  { kind: "image", mime: "image/gif", header: "47494638396101000100000000000000" },
  { kind: "image", mime: "image/bmp", header: "424d0000000000000000000000000000" },
  { kind: "image", mime: "image/tiff", header: "49492a00080000000000000000000000" },
  { kind: "video", mime: "video/mp4", header: "000000106674797069736f6d00000000" },
  { kind: "video", mime: "video/x-m4v", header: "00000010667479704d34562000000000" },
  { kind: "video", mime: "video/quicktime", header: "00000010667479707174202000000000" },
  { kind: "video", mime: "video/x-msvideo", header: "52494646080000004156492000000000" },
  { kind: "video", mime: "video/webm", header: "1a45dfa3000000000000000000000000" },
  { kind: "video", mime: "video/x-matroska", header: "1a45dfa3000000000000000000000000" },
])("container recognition is independent of the filename %#", async ({ kind, mime, header }) => {
  const root = tempDir("vibevalley-media-");
  const content = Buffer.from(header, "hex");
  await using staged = await stageMediaInput(
    diskStorage,
    root,
    { kind, mime, name: "not-an-extension", size: content.length },
    chunks(content.subarray(0, 2), content.subarray(2)),
  );
  expect(staged.mime).toBe(mime);
});

test("regression: high-bit bytes cannot impersonate an ASCII container signature", async () => {
  const root = tempDir("vibevalley-media-");
  const disguised = Buffer.from("52494646080000005745425000000000", "hex").map((value) => value | 128);
  const mediaInputStagedFailure = await failure(
    stageMediaInput(diskStorage, root, { kind: "image", name: "fake.webp", mime: "image/webp", size: disguised.length }, chunks(disguised)),
  );
  expect(mediaInputStagedFailure).toMatchObject({ reason: "Format" });
  expect(readdirSync(root)).toEqual([]);
});

test("a partial disk write failure removes the staging directory", async () => {
  const root = tempDir("vibevalley-media-");
  const diskFull = new Error("ENOSPC");
  const failing: MediaInputStorage = {
    ...diskStorage,
    create: async (target) => ({
      write: async () => {
        await writeFile(target, bytes.subarray(0, 8));
        throw diskFull;
      },
      close: async () => undefined,
    }),
  };
  const mediaInputStagedFailure = await failure(stageMediaInput(failing, root, metadata, chunks(bytes)));
  expect(mediaInputStagedFailure).toBe(diskFull);
  expect(readdirSync(root)).toEqual([]);
});

test("source failure keeps its typed error and cleans partial bytes", async () => {
  const root = tempDir("vibevalley-media-");
  const disconnected = new Error("source-disconnected");
  async function* source() {
    yield bytes.subarray(0, 32);
    throw disconnected;
  }
  const mediaInputStagedFailure = await failure(stageMediaInput(diskStorage, root, metadata, source()));
  expect(mediaInputStagedFailure).toBe(disconnected);
  expect(readdirSync(root)).toEqual([]);
});

test.each([
  { mime: "audio/wav", bytes: wav(), format: "wav" },
  { mime: "audio/mpeg", bytes: mp3, format: "mp3" },
])("audio staging inspects the actual %s stream despite a misleading filename", async ({ mime, bytes, format }) => {
  const root = tempDir("vibevalley-media-");
  await using staged = await stageMediaInput(
    diskStorage,
    root,
    { kind: "audio", name: "not-a-media-extension", mime, size: bytes.length },
    chunks(...Array.from(bytes.subarray(0, 16), (byte) => Uint8Array.of(byte)), bytes.subarray(16)),
  );
  expect(staged.size).toBe(bytes.length);
  const metadata = await inspectAudio(new Blob([Uint8Array.from(bytes)]));
  expect(metadata.format).toBe(format);
  expect(metadata.duration).toBeGreaterThan(0);
  expect(metadata.sampleRate).toBe(24000);
  expect(metadata.channels).toBe(1);
});

test("regression: valid RIFF metadata survives audio upload while oversized metadata chunks are rejected", async () => {
  const root = tempDir("vibevalley-media-");
  const pcm = wav(4800);
  const tag = Buffer.alloc(12);
  tag.write("AIGC");
  tag.writeUInt32LE(3, 4);
  tag.write("tag", 8);
  const audio = Buffer.concat([pcm.subarray(0, 36), tag, pcm.subarray(36)]);
  audio.writeUInt32LE(audio.length - 8, 4);
  const input = { kind: "audio", name: "generated.wav", mime: "audio/wav", size: audio.length };
  await using staged = await stageMediaInput(diskStorage, root, input, chunks(audio));
  expect(readFileSync(staged.path)).toEqual(audio);
  const inspectAudio2 = await inspectAudio(new Blob([audio]));
  expect(inspectAudio2).toEqual({ format: "wav", duration: 0.2, sampleRate: 24000, channels: 1, bitDepth: 16 });
  audio.writeUInt32LE(audio.length, 40);
  const mediaInputStagedFailure = await failure(stageMediaInput(diskStorage, root, input, chunks(audio)));
  expect(mediaInputStagedFailure).toMatchObject({ reason: "Format" });
});

test.each([
  { mime: "audio/wav", bytes: Buffer.from("RIFF0000WAVE0000", "latin1") },
  { mime: "audio/mpeg", bytes: wav() },
  { mime: "audio/flac", bytes: Buffer.concat([Buffer.from("fLaC"), Buffer.alloc(40)]) },
])("regression: audio container signatures alone cannot authorize a sample %#", async ({ mime, bytes }) => {
  const root = tempDir("vibevalley-media-");
  const mediaInputStagedFailure = await failure(
    stageMediaInput(diskStorage, root, { kind: "audio", name: "fake-audio", mime, size: bytes.length }, chunks(bytes)),
  );
  expect(mediaInputStagedFailure).toMatchObject({ reason: "Format" });
  expect(readdirSync(root)).toEqual([]);
});

test("regression: truncated audio and client-supplied duration are rejected before becoming reusable inputs", async () => {
  const root = tempDir("vibevalley-media-");
  const bytes = wav().subarray(0, 100);
  const mediaInputStagedFailure = await failure(
    stageMediaInput(diskStorage, root, { kind: "audio", name: "short.wav", mime: "audio/wav", size: bytes.length }, chunks(bytes)),
  );
  expect(mediaInputStagedFailure).toMatchObject({ reason: "Format" });
  const mediaInputStagedFailure2 = await failure(
    stageMediaInput(diskStorage, root, { kind: "audio", name: "short.wav", mime: "audio/wav", size: bytes.length, duration: 1 }, unread()),
  );
  expect(mediaInputStagedFailure2).toMatchObject({ reason: "Metadata" });
});

test("regression: generated streams enforce the actual 512MB cap without relying on Content-Length", async () => {
  const root = tempDir("vibevalley-media-");
  const chunk = new Uint8Array(1024 * 1024);
  let consumed = 0;
  async function* source() {
    for (let n = 0; n < Math.floor(audioResultMax / chunk.length) + 2; n++) {
      consumed++;
      yield chunk;
    }
  }
  const discard: MediaInputStorage = { ...diskStorage, create: async () => ({ write: async () => undefined, close: async () => undefined }) };
  const audioResultStagedFailure = await failure(stageAudioResult(discard, root, "large.pcm", "pcm", source()));
  expect(audioResultStagedFailure).toMatchObject({ reason: "Size" });
  expect(consumed).toBe(Math.floor(audioResultMax / chunk.length) + 1);
  expect(readdirSync(root)).toEqual([]);
});

test.each([
  { bytes: wav().subarray(0, 100), format: "wav" as const },
  { bytes: Buffer.from("<html>not audio</html>"), format: "wav" as const },
  { bytes: mp3.subarray(0, mp3.length - 1), format: "mp3" as const },
  { bytes: wav(), format: "mp3" as const },
])("regression: generated invalid, truncated, or mismatched audio cannot be promoted %#", async ({ bytes, format }) => {
  const root = tempDir("vibevalley-media-");
  const audioResultStagedFailure = await failure(stageAudioResult(diskStorage, root, "result", format, chunks(bytes)));
  expect(audioResultStagedFailure).toMatchObject({ reason: "Format" });
  expect(readdirSync(root)).toEqual([]);
});
