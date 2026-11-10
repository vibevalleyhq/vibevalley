import { createHash } from "node:crypto";

import { Clock, Context, Effect, Layer, Stream } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { attachmentMax } from "@vibevalley/protocol";
import type { ApiError } from "@vibevalley/protocol/api";

import { missing, refused } from "#/base/errors.ts";
import { Db } from "#/infra/db.ts";
import { Storage } from "#/storage/storage.ts";
import * as q from "#db/attachment.sql.ts";

export interface KeptFile {
  readonly path: string;
  readonly type: string;
  readonly name: string;
}

export class Attachment extends Context.Service<
  Attachment,
  {
    readonly attach: (upload: T.AttachmentUpload) => Effect.Effect<T.Attachment, ApiError>;
    /** Enforces no size limit; callers enforce their own. */
    readonly keep: (bytes: Uint8Array, name: string, type: string) => Effect.Effect<T.Attachment, ApiError>;
    /** Enforces no size limit; media inputs hold their own streaming quota. */
    readonly keepStaged: (
      staged: { readonly path: string; readonly hash: string; readonly size: number; readonly name: string; readonly type: string },
      retain?: boolean,
    ) => Effect.Effect<T.Attachment, ApiError>;
    readonly staging: string;
    readonly get: (id: string) => Effect.Effect<KeptFile | undefined>;
    readonly of: (ids: readonly string[]) => Effect.Effect<T.Attachment[], ApiError>;
    readonly bytes: (id: string) => Effect.Effect<Uint8Array, ApiError>;
    readonly pathOf: (id: string) => string;
  }
>()("@vibevalley/server/attachment/attachment") {
  static readonly layer = Layer.effect(
    Attachment,
    Effect.suspend(() => make),
  );
}

const make = Effect.gen(function* () {
  const db = yield* Db;
  const storage = yield* Storage;
  const unkept = (e: { readonly message: string }) => refused(e.message);

  const sha256Of = (key: string) =>
    Effect.map(
      storage.stream(key).pipe(
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
    yield* storage.put(id, bytes).pipe(Effect.mapError(unkept));
    return yield* record(id, name, type, bytes.length);
  });

  return Attachment.of({
    pathOf: storage.pathOf,
    staging: storage.scratch,
    attach: Effect.fn("Attachment.attach")(function* (upload) {
      const bytes = Buffer.from(upload.data, "base64");
      if (bytes.length > attachmentMax) return yield* Effect.fail(refused(t("server.attachment.fileTooBig", { mb: Math.round(attachmentMax / 1024 / 1024) })));
      return yield* keep(bytes, upload.name, upload.type);
    }),
    keep,
    keepStaged: Effect.fn("Attachment.keepStaged")(function* (staged, retain = false) {
      yield* Effect.gen(function* () {
        // Re-verify existing file hash so corrupted bytes on disk are replaced rather than trusted.
        if ((yield* storage.exists(staged.hash)) && (yield* sha256Of(staged.hash)) === staged.hash) return;
        yield* storage.adopt(staged.hash, staged.path, retain);
      }).pipe(Effect.mapError(unkept));
      return yield* record(staged.hash, staged.name, staged.type, staged.size);
    }),
    get: Effect.fn("Attachment.get")(function* (id) {
      const a = yield* db.one(q.attachmentByID({ id }));
      return a ? { path: storage.pathOf(a.id), type: a.type, name: a.name } : undefined;
    }),
    bytes: Effect.fn("Attachment.bytes")(function* (id) {
      const blob = yield* storage.open(id, "application/octet-stream").pipe(Effect.mapError(() => missing(t("server.attachment.noAttachment", { id }), [])));
      const buffer = yield* Effect.tryPromise({ try: () => blob.arrayBuffer(), catch: () => missing(t("server.attachment.noAttachment", { id }), []) });
      return new Uint8Array(buffer);
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
