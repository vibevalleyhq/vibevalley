import { createHash } from "node:crypto";
import { join } from "node:path";

import { Clock, Context, Effect, FileSystem, Layer, Stream } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { attachmentMax } from "@vibevalley/protocol";
import type { ApiError } from "@vibevalley/protocol/api";

import { missing, refused } from "#/base/errors.ts";
import { ServerConfig } from "#/infra/config.ts";
import { Db } from "#/infra/db.ts";
import { writeOnce } from "#/infra/files.ts";
import * as q from "#db/attachment.sql.ts";

/** A kept file as it is read back: where its bytes are, and what it is. */
export interface KeptFile {
  readonly path: string;
  readonly type: string;
  readonly name: string;
}

/** The files the farm keeps, once each by their sha256 under the home directory's attachments/: what a message says, a
 * media job made and the library holds. */
export class Attachment extends Context.Service<
  Attachment,
  {
    readonly attach: (upload: T.AttachmentUpload) => Effect.Effect<T.Attachment, ApiError>;
    /** Bytes made here (an artifact's version), kept like an upload; the caller holds its own size limit. */
    readonly keep: (bytes: Uint8Array, name: string, type: string) => Effect.Effect<T.Attachment, ApiError>;
    /** A file already written under staging and hashed by its writer (media's streamed inputs and results): moved
     * (or linked, when retain) into place and recorded. No size limit here: media holds its own quota. */
    readonly keepStaged: (
      staged: { readonly path: string; readonly hash: string; readonly size: number; readonly name: string; readonly type: string },
      retain?: boolean,
    ) => Effect.Effect<T.Attachment, ApiError>;
    /** Where streamed writers stage a file before keepStaged: on the same disk as the kept files, so a move is a rename. */
    readonly staging: string;
    readonly get: (id: string) => Effect.Effect<KeptFile | undefined>;
    /** Each id's attachment, once each; one not kept fails Missing. */
    readonly of: (ids: readonly string[]) => Effect.Effect<T.Attachment[], ApiError>;
    /** Where an attachment's bytes are, kept or not. */
    readonly pathOf: (id: string) => string;
  }
>()("@vibevalley/server/attachment/attachment") {
  static readonly layer = Layer.effect(
    Attachment,
    Effect.suspend(() => make),
  );
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const db = yield* Db;
  const fs = yield* FileSystem.FileSystem;
  const filesDir = join(config.home, "attachments");
  const pathOf = (id: string) => join(filesDir, id);
  // Inside attachments/ so a staged file is renamed into place; kept files are named by their sha256, never "staging".
  const staging = join(filesDir, "staging");

  const sha256Of = (path: string) =>
    Effect.map(
      fs.stream(path).pipe(
        Stream.runFold(
          () => createHash("sha256"),
          (hash, chunk) => hash.update(chunk),
        ),
      ),
      (hash) => hash.digest("hex"),
    );

  const record = Effect.fnUntraced(function* (id: string, given: string, givenType: string, size: number) {
    const name = given.trim() || "file";
    const type = givenType.trim() || "application/octet-stream";
    yield* db.run(q.insertAttachment({ id, name, type, size, created_at: yield* Clock.currentTimeMillis }));
    return { id, name, type, size };
  });

  const keep = Effect.fn("Attachment.keep")(function* (bytes: Uint8Array, name: string, type: string) {
    if (bytes.length === 0) return yield* Effect.fail(refused(t("server.attachment.emptyFile")));
    const id = createHash("sha256").update(bytes).digest("hex");
    yield* writeOnce(pathOf(id), bytes).pipe(
      Effect.mapError((e) => refused(e.message)),
      Effect.provideService(FileSystem.FileSystem, fs),
    );
    return yield* record(id, name, type, bytes.length);
  });

  return Attachment.of({
    pathOf,
    staging,
    attach: Effect.fn("Attachment.attach")(function* (upload) {
      const bytes = Buffer.from(upload.data, "base64");
      if (bytes.length > attachmentMax) return yield* Effect.fail(refused(t("server.attachment.fileTooBig", { mb: Math.round(attachmentMax / 1024 / 1024) })));
      return yield* keep(bytes, upload.name, upload.type);
    }),
    keep,
    keepStaged: Effect.fn("Attachment.keepStaged")(function* (staged, retain = false) {
      const target = pathOf(staged.hash);
      yield* Effect.gen(function* () {
        yield* fs.makeDirectory(filesDir, { recursive: true, mode: 0o700 });
        // A kept file whose bytes no longer match its name (changed on disk) is replaced, not trusted.
        if ((yield* fs.exists(target)) && (yield* sha256Of(target)) === staged.hash) return;
        if (retain) {
          yield* fs.remove(target, { force: true });
          yield* fs.link(staged.path, target);
        } else yield* fs.rename(staged.path, target);
      }).pipe(Effect.mapError((e) => refused(e.message)));
      return yield* record(staged.hash, staged.name, staged.type, staged.size);
    }),
    get: Effect.fn("Attachment.get")(function* (id) {
      const a = yield* db.one(q.attachmentByID({ id }));
      return a ? { path: pathOf(a.id), type: a.type, name: a.name } : undefined;
    }),
    of: Effect.fn("Attachment.of")(function* (ids) {
      const out: T.Attachment[] = [];
      for (const id of new Set(ids)) {
        const a = yield* db.one(q.attachmentByID({ id }));
        if (!a) return yield* Effect.fail(missing(t("server.attachment.noAttachment", { id }), []));
        out.push(a);
      }
      return out;
    }),
  });
});
