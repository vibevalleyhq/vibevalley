import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";

import { type Clock, systemClock, timeoutError } from "@vibevalley/async";
import type * as T from "@vibevalley/protocol";
import { MediaInputRequest } from "@vibevalley/protocol/schema";

import { fileBlob } from "#/infra/files.ts";

import { inspectAudio, inspectWave } from "./audioMetadata.ts";
import { inTime, untilAborted } from "./job.ts";
import { mp3Structure } from "./validateSpeechBytes.ts";

/** Where staged bytes are written and removed: the disk, or what a test puts in its place. */
export interface MediaInputStorage {
  /** A new file at path (it must not exist yet), private to this user: each chunk in order, then closed. */
  readonly create: (path: string) => Promise<{ readonly write: (chunk: Uint8Array) => Promise<void>; readonly close: () => Promise<void> }>;
  /** path and all under it gone; nothing there is no failure. */
  readonly remove: (path: string) => Promise<void>;
}

export const diskStorage: MediaInputStorage = {
  remove: (path) => rm(path, { recursive: true, force: true }),
  create: async (path) => {
    const file = await open(path, "wx", 0o600);
    return {
      write: async (chunk) => {
        await file.write(chunk);
      },
      close: () => file.close(),
    };
  },
};

export interface StageOptions {
  /** Times the 300-second deadline; default the wall clock. */
  readonly clock?: Clock;
  readonly signal?: AbortSignal;
}

export class MediaInputRejected extends Error {
  override readonly name = "MediaInputRejected";
  readonly reason: "Metadata" | "Size" | "Format" | "Changed";
  constructor(fields: { readonly reason: MediaInputRejected["reason"]; readonly cause?: unknown }) {
    super(`media input rejected: ${fields.reason}`, "cause" in fields ? { cause: fields.cause } : undefined);
    this.reason = fields.reason;
  }
}

const stageMs = 300_000;

/** work under the staging deadline: past it, work's signal aborts, and once work has cleaned up it rejects with a TimeoutError. */
const inStageTime = <A>(work: (signal: AbortSignal) => Promise<A>, what: string, options: StageOptions) =>
  inTime(work, stageMs, { clock: options.clock ?? systemClock, signal: options.signal, timedOut: () => timeoutError(stageMs, what) });

// Container signatures reject disguised uploads; they do not prove a codec can decode the whole file.
const matchesContainer = (mime: string, prefix: Uint8Array) => {
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
    default:
      return false;
  }
};

/** The file at path is the size and hash it was kept as; throws MediaInputRejected("Changed") when it is not, and a read error as it is. */
export async function verifyMediaInput(path: string, size: number, expectedHash: string): Promise<void> {
  const hash = createHash("sha256");
  let received = 0;
  const stream = createReadStream(path);
  try {
    for await (const chunk of stream) {
      if (!(chunk instanceof Uint8Array)) throw new MediaInputRejected({ reason: "Changed" });
      received += chunk.byteLength;
      if (received > size) throw new MediaInputRejected({ reason: "Changed" });
      hash.update(chunk);
    }
  } finally {
    stream.destroy();
  }
  if (received !== size || hash.digest("hex") !== expectedHash) throw new MediaInputRejected({ reason: "Changed" });
}

/** A private temporary directory under directory, removed (with whatever is in it) when the work fails or the result is disposed. */
async function stagedIn<A extends object>(
  storage: MediaInputStorage,
  directory: string,
  prefix: string,
  work: (temporary: string) => Promise<A>,
): Promise<A & AsyncDisposable> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(directory, prefix));
  const remove = () => storage.remove(temporary);
  try {
    const a = await work(temporary);
    return { ...a, [Symbol.asyncDispose]: remove };
  } catch (e) {
    await remove();
    throw e;
  }
}

/** source written to path through storage, each chunk first seen by look (which may refuse it); the file is closed however it ends. */
async function written(
  storage: MediaInputStorage,
  path: string,
  source: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
  look: (chunk: Uint8Array) => Promise<void> | void,
) {
  const file = await storage.create(path);
  try {
    for await (const chunk of untilAborted(source, signal)) {
      await look(chunk);
      await file.write(chunk);
    }
  } finally {
    await file.close();
  }
}

const inputKeys: ReadonlySet<string> = new Set(["kind", "name", "mime", "size"]);

/** What an upload says it is: exactly the four fields, within the limits for its kind. */
export const declared = (metadata: unknown): T.MediaInputRequest => {
  if (typeof metadata !== "object" || metadata === null || Object.keys(metadata).some((key) => !inputKeys.has(key))) {
    throw new MediaInputRejected({ reason: "Metadata" });
  }
  const got = MediaInputRequest.safeParse(metadata);
  if (!got.success) throw new MediaInputRejected({ reason: "Metadata" });
  return got.data;
};

export type StagedInput = T.MediaInputRequest & { readonly path: string; readonly hash: string };

// The complete file is promoted before the caller disposes of it; its temporary path is never a public asset ID.
export async function stageMediaInput(
  storage: MediaInputStorage,
  directory: string,
  metadata: unknown,
  source: AsyncIterable<Uint8Array>,
  options: StageOptions = {},
): Promise<StagedInput & AsyncDisposable> {
  const input = declared(metadata);
  return inStageTime(
    (signal) =>
      stagedIn(storage, directory, ".input-", async (temporary) => {
        const path = join(temporary, "content");
        const hash = createHash("sha256");
        const prefix = new Uint8Array(16);
        let received = 0;
        let prefixLength = 0;
        let checked = false;
        await written(storage, path, source, signal, (chunk) => {
          if (chunk.byteLength > input.size - received) throw new MediaInputRejected({ reason: "Size" });
          received += chunk.byteLength;
          const take = Math.min(prefix.length - prefixLength, chunk.byteLength);
          prefix.set(chunk.subarray(0, take), prefixLength);
          prefixLength += take;
          if (!checked && prefixLength === prefix.length) {
            if (!matchesContainer(input.mime, prefix)) throw new MediaInputRejected({ reason: "Format" });
            checked = true;
          }
          hash.update(chunk);
        });
        if (received !== input.size) throw new MediaInputRejected({ reason: "Size" });
        if (input.kind === "audio") {
          const audio = await inspectAudio(await fileBlob(path, input.mime)).catch((e: unknown) => {
            throw new MediaInputRejected({ reason: "Format", cause: e });
          });
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
          if (audio.duration > 3600 || mime[audio.format] !== input.mime) throw new MediaInputRejected({ reason: "Format" });
        }
        return { ...input, path, hash: hash.digest("hex") };
      }),
    "staging a media input",
    options,
  );
}

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

const audioBytes = async (blob: Blob, start: number, end: number) => {
  try {
    return Buffer.from(await blob.slice(start, end).arrayBuffer());
  } catch {
    // Unreadable bytes are not the audio they claim to be.
    throw new MediaInputRejected({ reason: "Format" });
  }
};

/** Generated audio staged from source, at most audioResultMax bytes, checked to be the format asked for; removed when disposed. */
export async function stageAudioResult(
  storage: MediaInputStorage,
  directory: string,
  name: string,
  format: T.MediaAudioFormat,
  source: AsyncIterable<Uint8Array>,
  options: StageOptions = {},
): Promise<StagedAudioResult & AsyncDisposable> {
  return inStageTime(
    (signal) =>
      stagedIn(storage, directory, ".result-", async (temporary): Promise<StagedAudioResult> => {
        const path = join(temporary, "content");
        const hash = createHash("sha256");
        let size = 0;
        await written(storage, path, source, signal, (chunk) => {
          if (chunk.byteLength > audioResultMax - size) throw new MediaInputRejected({ reason: "Size" });
          size += chunk.byteLength;
          hash.update(chunk);
        });
        if (size === 0) throw new MediaInputRejected({ reason: "Size" });
        const mime = audioResultMime[format];
        const blob = await fileBlob(path, mime);
        if (format === "mp3") {
          const ranges = mp3Structure(size);
          let next = ranges.next();
          let cached = Buffer.alloc(0);
          let start = 0;
          while (next.done !== true) {
            const range = next.value;
            if (range.offset < start || range.offset + range.length > start + cached.length) {
              start = range.offset;
              cached = await audioBytes(blob, start, Math.min(size, start + 64 * 1024));
            }
            next = ranges.next(cached.subarray(range.offset - start, range.offset - start + range.length));
          }
          if (!next.value) throw new MediaInputRejected({ reason: "Format" });
        }
        const audio =
          format === "pcm"
            ? undefined
            : await (format === "wav" ? inspectWave(blob) : inspectAudio(blob)).catch(() => {
                throw new MediaInputRejected({ reason: "Format" });
              });
        if (audio && audio.format !== format) throw new MediaInputRejected({ reason: "Format" });
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
      }),
    "staging generated audio",
    options,
  );
}
