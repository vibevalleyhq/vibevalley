import { createHash } from "node:crypto";
import { join } from "node:path";

import { Effect, FileSystem, Schema, Stream } from "effect";

import { MediaInputRequest } from "@vibevalley/protocol/schema";

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
  }
};

export const verifyMediaInput = Effect.fn("Media.verifyInput")(function* (path: string, size: number, expectedHash: string) {
  const fs = yield* FileSystem.FileSystem;
  const hash = createHash("sha256");
  let received = 0;
  yield* fs.stream(path).pipe(
    Stream.runForEach((chunk) =>
      Effect.gen(function* () {
        received += chunk.byteLength;
        if (received > size) return yield* new MediaInputRejected({ reason: "Changed" });
        hash.update(chunk);
      }),
    ),
  );
  if (received !== size || hash.digest("hex") !== expectedHash) return yield* new MediaInputRejected({ reason: "Changed" });
});

// Promote the complete file before closing this caller-owned scope; its temporary path is never a public asset ID.
export const stageMediaInput = Effect.fn("Media.stageInput")(function* <E, R>(directory: string, metadata: unknown, source: Stream.Stream<Uint8Array, E, R>) {
  const input = yield* Schema.decodeUnknownEffect(MediaInputRequest)(metadata, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => new MediaInputRejected({ reason: "Metadata" })),
  );
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  const temporary = yield* fs.makeTempDirectoryScoped({ directory, prefix: ".input-" });
  const path = join(temporary, "content");
  const hash = createHash("sha256");
  const prefix = new Uint8Array(16);
  let received = 0;
  let prefixLength = 0;
  let checked = false;
  yield* source.pipe(
    Stream.mapEffect((chunk) =>
      Effect.gen(function* () {
        if (chunk.byteLength > input.size - received) return yield* new MediaInputRejected({ reason: "Size" });
        received += chunk.byteLength;
        const take = Math.min(prefix.length - prefixLength, chunk.byteLength);
        prefix.set(chunk.subarray(0, take), prefixLength);
        prefixLength += take;
        if (!checked && prefixLength === prefix.length) {
          if (!matchesContainer(input.mime, prefix)) return yield* new MediaInputRejected({ reason: "Format" });
          checked = true;
        }
        hash.update(chunk);
        return chunk;
      }),
    ),
    Stream.run(fs.sink(path, { flag: "wx", mode: 0o600 })),
  );
  if (received !== input.size) return yield* new MediaInputRejected({ reason: "Size" });
  return { ...input, path, hash: hash.digest("hex") };
}, Effect.timeout("300 seconds"));
