import { createHash } from "node:crypto";

import { NodeFileSystem } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, PlatformError, Sink, Stream } from "effect";
import { TestClock } from "effect/testing";

import { inspectAudio } from "./audioMetadata.ts";
import { audioResultMax, stageAudioResult, stageMediaInput } from "./input.ts";
import { mp3, wav } from "./testdata/audio.ts";
import { png } from "./testdata/png.ts";

const bytes = png();
const metadata = { kind: "image", name: "picture.png", mime: "image/png", size: bytes.length };

it.effect("staging streams split headers into a private file and removes it when its scope closes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const path = yield* Effect.gen(function* () {
      const staged = yield* stageMediaInput(
        root,
        metadata,
        Stream.fromIterable([...Array.from(bytes.subarray(0, 16), (byte) => Uint8Array.of(byte)), bytes.subarray(16)]),
      );
      expect(staged.hash).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(Buffer.from(yield* fs.readFile(staged.path))).toEqual(bytes);
      expect((yield* fs.stat(staged.path)).mode & 0o777).toBe(0o600);
      return staged.path;
    }).pipe(Effect.scoped);
    expect(yield* fs.exists(path)).toBe(false);
    expect(yield* fs.readDirectory(root)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect.each([
  { size: 30_000_001 },
  { size: 0 },
  { size: 1.5 },
  { name: "../picture.png" },
  { name: "a\nb" },
  { mime: "text/html" },
  { kind: "image", mime: "video/mp4" },
  { kind: "video", mime: "video/mp4", size: 200_000_001 },
  { path: "/private/file" },
])("invalid input metadata is refused before reading the source %#", (invalid) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const source = Stream.fromEffect(Effect.die("must not read invalid input"));
    expect(yield* Effect.flip(stageMediaInput(root, { ...metadata, ...invalid }, source))).toMatchObject({ reason: "Metadata" });
    expect(yield* fs.readDirectory(root)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect.each([
  { body: bytes.subarray(0, bytes.length - 1), reason: "Size" },
  { body: Buffer.concat([bytes, Uint8Array.of(0)]), reason: "Size" },
  { body: Buffer.alloc(bytes.length, 60), reason: "Format" },
])("size mismatches and disguised content never leave a staged file %#", ({ body, reason }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const error = yield* Effect.flip(stageMediaInput(root, metadata, Stream.make(body)).pipe(Effect.scoped));
    expect(error).toMatchObject({ reason });
    expect(yield* fs.readDirectory(root)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect("regression: canceling an unfinished upload releases its writer and deletes partial bytes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const reading = yield* Deferred.make<void>();
    const source = Stream.concat(
      Stream.make(bytes.subarray(0, 32)),
      Stream.fromEffect(Deferred.succeed(reading, undefined).pipe(Effect.andThen(Effect.never))),
    );
    const fiber = yield* stageMediaInput(root, metadata, source).pipe(Effect.scoped, Effect.forkChild);
    yield* Deferred.await(reading);
    expect(yield* fs.readDirectory(root)).toHaveLength(1);
    yield* Fiber.interrupt(fiber);
    expect(yield* fs.readDirectory(root)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect("a stalled input times out and removes its partial file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const started = yield* Deferred.make<void>();
    const source = Stream.concat(
      Stream.make(bytes.subarray(0, 32)),
      Stream.fromEffect(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))),
    );
    const fiber = yield* stageMediaInput(root, metadata, source).pipe(Effect.scoped, Effect.flip, Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("300 seconds");
    expect(yield* Fiber.join(fiber)).toMatchObject({ _tag: "TimeoutError" });
    expect(yield* fs.readDirectory(root)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect.each([
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
])("container recognition is independent of the filename %#", ({ kind, mime, header }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const content = Buffer.from(header, "hex");
    const staged = yield* stageMediaInput(
      root,
      { kind, mime, name: "not-an-extension", size: content.length },
      Stream.make(content.subarray(0, 2), content.subarray(2)),
    );
    expect(staged.mime).toBe(mime);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect("regression: high-bit bytes cannot impersonate an ASCII container signature", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const disguised = Buffer.from("52494646080000005745425000000000", "hex").map((value) => value | 128);
    expect(
      yield* Effect.flip(
        stageMediaInput(root, { kind: "image", name: "fake.webp", mime: "image/webp", size: disguised.length }, Stream.make(disguised)).pipe(Effect.scoped),
      ),
    ).toMatchObject({ reason: "Format" });
    expect(yield* fs.readDirectory(root)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect("a partial disk write failure removes the staging directory", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const diskFull = PlatformError.systemError({ _tag: "Unknown", module: "FileSystem", method: "write", description: "ENOSPC" });
    const failing = FileSystem.FileSystem.of({
      ...fs,
      sink: (path) => Sink.fromEffect(fs.writeFile(path, bytes.subarray(0, 8)).pipe(Effect.andThen(Effect.fail(diskFull)))),
    });
    expect(
      yield* Effect.flip(stageMediaInput(root, metadata, Stream.make(bytes)).pipe(Effect.provideService(FileSystem.FileSystem, failing), Effect.scoped)),
    ).toBe(diskFull);
    expect(yield* fs.readDirectory(root)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect("source failure keeps its typed error and cleans partial bytes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const source = Stream.concat(Stream.make(bytes.subarray(0, 32)), Stream.fail("source-disconnected"));
    expect(yield* Effect.flip(stageMediaInput(root, metadata, source).pipe(Effect.scoped))).toBe("source-disconnected");
    expect(yield* fs.readDirectory(root)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect.each([
  { mime: "audio/wav", bytes: wav(), format: "wav" },
  { mime: "audio/mpeg", bytes: mp3, format: "mp3" },
])("audio staging inspects the actual %s stream despite a misleading filename", ({ mime, bytes, format }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const staged = yield* stageMediaInput(
      root,
      { kind: "audio", name: "not-a-media-extension", mime, size: bytes.length },
      Stream.fromIterable([...Array.from(bytes.subarray(0, 16), (byte) => Uint8Array.of(byte)), bytes.subarray(16)]),
    );
    expect(staged.size).toBe(bytes.length);
    const metadata = yield* inspectAudio(new Blob([Uint8Array.from(bytes)]));
    expect(metadata.format).toBe(format);
    expect(metadata.duration).toBeGreaterThan(0);
    expect(metadata.sampleRate).toBe(24000);
    expect(metadata.channels).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect("regression: valid RIFF metadata survives audio upload while oversized metadata chunks are rejected", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const pcm = wav(4800);
    const tag = Buffer.alloc(12);
    tag.write("AIGC");
    tag.writeUInt32LE(3, 4);
    tag.write("tag", 8);
    const audio = Buffer.concat([pcm.subarray(0, 36), tag, pcm.subarray(36)]);
    audio.writeUInt32LE(audio.length - 8, 4);
    const input = { kind: "audio", name: "generated.wav", mime: "audio/wav", size: audio.length };
    const staged = yield* stageMediaInput(root, input, Stream.make(audio));
    expect(Buffer.from(yield* fs.readFile(staged.path))).toEqual(audio);
    expect(yield* inspectAudio(new Blob([audio]))).toEqual({ format: "wav", duration: 0.2, sampleRate: 24000, channels: 1, bitDepth: 16 });
    audio.writeUInt32LE(audio.length, 40);
    expect(yield* stageMediaInput(root, input, Stream.make(audio)).pipe(Effect.scoped, Effect.flip)).toMatchObject({ reason: "Format" });
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect.each([
  { mime: "audio/wav", bytes: Buffer.from("RIFF0000WAVE0000", "latin1") },
  { mime: "audio/mpeg", bytes: wav() },
  { mime: "audio/flac", bytes: Buffer.concat([Buffer.from("fLaC"), Buffer.alloc(40)]) },
])("regression: audio container signatures alone cannot authorize a sample %#", ({ mime, bytes }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    expect(
      yield* stageMediaInput(root, { kind: "audio", name: "fake-audio", mime, size: bytes.length }, Stream.make(bytes)).pipe(Effect.scoped, Effect.flip),
    ).toMatchObject({ reason: "Format" });
    expect(yield* fs.readDirectory(root)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect("regression: truncated audio and client-supplied duration are rejected before becoming reusable inputs", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const bytes = wav().subarray(0, 100);
    expect(
      yield* stageMediaInput(root, { kind: "audio", name: "short.wav", mime: "audio/wav", size: bytes.length }, Stream.make(bytes)).pipe(
        Effect.scoped,
        Effect.flip,
      ),
    ).toMatchObject({ reason: "Format" });
    expect(
      yield* stageMediaInput(
        root,
        { kind: "audio", name: "short.wav", mime: "audio/wav", size: bytes.length, duration: 1 },
        Stream.fromEffect(Effect.die("Metadata must be rejected before upload")),
      ).pipe(Effect.scoped, Effect.flip),
    ).toMatchObject({ reason: "Metadata" });
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect("regression: generated streams enforce the actual 512MB cap without relying on Content-Length", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const chunk = new Uint8Array(1024 * 1024);
    let consumed = 0;
    const source = Stream.fromIterable(Array.from({ length: Math.floor(audioResultMax / chunk.length) + 2 }, () => chunk)).pipe(
      Stream.tap(() =>
        Effect.sync(() => {
          consumed++;
        }),
      ),
    );
    const discard = FileSystem.FileSystem.of({ ...fs, sink: () => Sink.drain });
    expect(
      yield* stageAudioResult(root, "large.pcm", "pcm", source).pipe(Effect.provideService(FileSystem.FileSystem, discard), Effect.scoped, Effect.flip),
    ).toMatchObject({ reason: "Size" });
    expect(consumed).toBe(Math.floor(audioResultMax / chunk.length) + 1);
    expect(yield* fs.readDirectory(root)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);

it.effect.each([
  { bytes: wav().subarray(0, 100), format: "wav" as const },
  { bytes: Buffer.from("<html>not audio</html>"), format: "wav" as const },
  { bytes: mp3.subarray(0, mp3.length - 1), format: "mp3" as const },
  { bytes: wav(), format: "mp3" as const },
])("regression: generated invalid, truncated, or mismatched audio cannot be promoted %#", ({ bytes, format }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    expect(yield* stageAudioResult(root, "result", format, Stream.make(bytes)).pipe(Effect.scoped, Effect.flip)).toMatchObject({ reason: "Format" });
    expect(yield* fs.readDirectory(root)).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
);
