import { createHash } from "node:crypto";
import { join } from "node:path";

import { Clock, Context, Effect, FileSystem, Layer } from "effect";

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

  return Attachment.of({
    pathOf,
    attach: Effect.fn("Attachment.attach")(function* (upload) {
      const name = upload.name.trim() || "file";
      const bytes = Buffer.from(upload.data, "base64");
      if (bytes.length === 0) return yield* Effect.fail(refused(t("server.attachment.emptyFile")));
      if (bytes.length > attachmentMax) return yield* Effect.fail(refused(t("server.attachment.fileTooBig", { mb: Math.round(attachmentMax / 1024 / 1024) })));
      const id = createHash("sha256").update(bytes).digest("hex");
      yield* writeOnce(pathOf(id), bytes).pipe(
        Effect.mapError((e) => refused(e.message)),
        Effect.provideService(FileSystem.FileSystem, fs),
      );
      const type = upload.type.trim() || "application/octet-stream";
      yield* db.run(q.insertAttachment({ id, name, type, size: bytes.length, created_at: yield* Clock.currentTimeMillis }));
      return { id, name, type, size: bytes.length };
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
