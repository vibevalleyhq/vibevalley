import { createHash } from "node:crypto";

import { Effect, type FileSystem, type Path, type PlatformError, Schema, type Scope, Stream } from "effect";

import type * as T from "@vibevalley/protocol";
import { MediaInputRequest } from "@vibevalley/protocol/schema";

import type { ApiError } from "#/base/errors.ts";
import { fileBlob } from "#/infra/files.ts";

import { inspectAudio, inspectWave } from "./audioMetadata.ts";
import { mp3Structure } from "./validateSpeechBytes.ts";

export interface MediaInputStorage {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
}

class MediaInputRejected extends Schema.TaggedError<MediaInputRejected, { readonly brand: unique symbol }>()("MediaInputRejected", {
  reason: Schema.Literals(["Metadata", "Size", "Format", "Changed"]),
}) {}

// Container signatures reject disguised uploads; they do not prove a codec can decode the whole file.
const matchesContainer = (mime: (typeof MediaInputRequest.Type)["mime"], prefix: Uint8Array) => {
  const bytes = Buffer.from(prefix);
  const head = bytes.toString("hex");
  switch (mime) {
    case "image/png":
      return head.startsWith("89504e470d0a1a0a");
    case "image/jpeg":
      return head.startsWith("ffd8ff");
    case "image/webp":
      return bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP";
    case "image/gif":
      return ["GIF87a", "GIF89a"].includes(bytes.toString("latin1", 0, 6));
    case "image/bmp":
      return head.startsWith("424d");
    case "image/tiff":
      return head.startsWith("49492a00") || head.startsWith("4d4d002a");
    case "video/mp4":
    case "video/x-m4v":
      return bytes.toString("latin1", 4, 8) === "ftyp";
    case "video/quicktime":
      return ["ftyp", "moov", "mdat", "wide", "free"].includes(bytes.toString("latin1", 4, 8));
    case "video/x-msvideo":
      return bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "AVI ";
    case "video/webm":
    case "video/x-matroska":
      return head.startsWith("1a45dfa3");
    case "audio/wav":
      return bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WAVE";
    case "audio/mpeg":
      return bytes.toString("latin1", 0, 3) === "ID3" || (bytes[0] === 255 && ((bytes[1] ?? 0) & 0xe0) === 0xe0);
    case "audio/mp4":
      return bytes.toString("latin1", 4, 8) === "ftyp";
    case "audio/flac":
      return bytes.toString("latin1", 0, 4) === "fLaC";
    case "audio/ogg":
      return bytes.toString("latin1", 0, 4) === "OggS";
    case "audio/webm":
      return head.startsWith("1a45dfa3");
  }
};

export const verifyMediaInput = Effect.fn("Media.verifyInput")(function* (fs: FileSystem.FileSystem, path: string, size: number, expectedHash: string) {
  const hash = createHash("sha256");
  let received = 0;
  yield* fs.stream(path).pipe(
    Stream.runForEach((chunk) =>
      Effect.gen(function* () {
        received += chunk.byteLength;
        if (received > size) return yield* MediaInputRejected.make({ reason: "Changed" });
        hash.update(chunk);
      }),
    ),
  );
  if (received !== size || hash.digest("hex") !== expectedHash) return yield* MediaInputRejected.make({ reason: "Changed" });
});

// Promote the complete file before closing this caller-owned scope; its temporary path is never a public asset ID.
export const stageMediaInput = Effect.fn("Media.stageInput")(function* <E, R>(
  storage: MediaInputStorage,
  directory: string,
  metadata: unknown,
  source: Stream.Stream<Uint8Array, E, R>,
) {
  const input = yield* Schema.decodeUnknownEffect(MediaInputRequest)(metadata, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => MediaInputRejected.make({ reason: "Metadata" })),
  );
  const { fs, path: paths } = storage;
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  const temporary = yield* fs.makeTempDirectoryScoped({ directory, prefix: ".input-" });
  const path = paths.join(temporary, "content");
  const hash = createHash("sha256");
  const prefix = new Uint8Array(16);
  let received = 0;
  let prefixLength = 0;
  let checked = false;
  yield* source.pipe(
    Stream.mapEffect((chunk) =>
      Effect.gen(function* () {
        if (chunk.byteLength > input.size - received) return yield* MediaInputRejected.make({ reason: "Size" });
        received += chunk.byteLength;
        const take = Math.min(prefix.length - prefixLength, chunk.byteLength);
        prefix.set(chunk.subarray(0, take), prefixLength);
        prefixLength += take;
        if (!checked && prefixLength === prefix.length) {
          if (!matchesContainer(input.mime, prefix)) return yield* MediaInputRejected.make({ reason: "Format" });
          checked = true;
        }
        hash.update(chunk);
        return chunk;
      }),
    ),
    Stream.run(fs.sink(path, { flag: "wx", mode: 0o600 })),
  );
  if (received !== input.size) return yield* MediaInputRejected.make({ reason: "Size" });
  if (input.kind === "audio") {
    const fileBlob2 = yield* fileBlob(path, input.mime);
    const audio = yield* inspectAudio(fileBlob2).pipe(Effect.mapError(() => MediaInputRejected.make({ reason: "Format" })));
    const mime = {
      wav: "audio/wav",
      mp3: "audio/mpeg",
      m4a: "audio/mp4",
      flac: "audio/flac",
      aac: "audio/aac",
      opus: "audio/ogg",
      ogg: "audio/ogg",
      webm: "audio/webm",
    };
    if (audio.duration > 3600 || mime[audio.format] !== input.mime) return yield* MediaInputRejected.make({ reason: "Format" });
  }
  return { ...input, path, hash: hash.digest("hex") };
}, Effect.timeout("300 seconds"));

export const audioResultMax = 512_000_000;
const audioResultMime: Record<T.MediaAudioFormat, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  flac: "audio/flac",
  pcm: "audio/pcm",
  aac: "audio/aac",
  opus: "audio/ogg",
};

export interface StagedAudioResult {
  readonly path: string;
  readonly hash: string;
  readonly size: number;
  readonly mime: string;
  readonly name: string;
  readonly metadata?: NonNullable<T.MediaSpeechJob["metadata"]>;
}

const audioBytes = (blob: Blob, start: number, end: number) =>
  Effect.tryPromise({
    try: () => blob.slice(start, end).arrayBuffer(),
    catch: () => MediaInputRejected.make({ reason: "Format" }),
  }).pipe(Effect.map((bytes) => Buffer.from(bytes)));

export const stageAudioResult = Effect.fn("Media.stageAudioResult")(function* (
  storage: MediaInputStorage,
  directory: string,
  name: string,
  format: T.MediaAudioFormat,
  source: Stream.Stream<Uint8Array, ApiError>,
): Effect.fn.Return<StagedAudioResult, ApiError | MediaInputRejected | PlatformError.PlatformError, Scope.Scope> {
  const { fs, path: paths } = storage;
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  const temporary = yield* fs.makeTempDirectoryScoped({ directory, prefix: ".result-" });
  const path = paths.join(temporary, "content");
  const hash = createHash("sha256");
  let size = 0;
  yield* source.pipe(
    Stream.mapEffect((chunk) => {
      if (chunk.byteLength > audioResultMax - size) return Effect.fail(MediaInputRejected.make({ reason: "Size" }));
      size += chunk.byteLength;
      hash.update(chunk);
      return Effect.succeed(chunk);
    }),
    Stream.run(fs.sink(path, { flag: "wx", mode: 0o600 })),
  );
  if (size === 0) return yield* MediaInputRejected.make({ reason: "Size" });
  const mime = audioResultMime[format];
  const blob = yield* fileBlob(path, mime);
  if (format === "mp3") {
    const ranges = mp3Structure(size);
    let next = ranges.next();
    let cached = Buffer.alloc(0);
    let start = 0;
    while (next.done !== true) {
      const range = next.value;
      if (range.offset < start || range.offset + range.length > start + cached.length) {
        start = range.offset;
        cached = yield* audioBytes(blob, start, Math.min(size, start + 64 * 1024));
      }
      next = ranges.next(cached.subarray(range.offset - start, range.offset - start + range.length));
    }
    if (!next.value) return yield* MediaInputRejected.make({ reason: "Format" });
  }
  const audio =
    format === "pcm"
      ? undefined
      : yield* (format === "wav" ? inspectWave(blob) : inspectAudio(blob)).pipe(Effect.mapError(() => MediaInputRejected.make({ reason: "Format" })));
  if (audio && audio.format !== format) return yield* MediaInputRejected.make({ reason: "Format" });
  return {
    path,
    hash: hash.digest("hex"),
    size,
    mime,
    name,
    ...(audio
      ? {
          metadata: {
            source: "file" as const,
            duration: audio.duration,
            sampleRate: audio.sampleRate,
            channels: audio.channels,
            ...(audio.bitDepth === undefined ? {} : { bitDepth: audio.bitDepth }),
          },
        }
      : {}),
  };
}, Effect.timeout("300 seconds"));
