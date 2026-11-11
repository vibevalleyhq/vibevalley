import { Array as Arr, Clock, Effect, FileSystem, Option, Path, Schema, Semaphore, type Scope, Stream, String as Str } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { type ApiError, BizCode, refuseIn } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import { Db } from "#/infra/db.ts";
import { fileBlob } from "#/infra/files.ts";
import { Attachment } from "#/modules/attachment/attachment.ts";
import * as q from "#db/media_input.sql.ts";
import * as pins from "#db/media_input_pin.sql.ts";

import { type MediaInputStorage, stageAudioResult, stageMediaInput, type StagedAudioResult, verifyMediaInput } from "./input.ts";

const refused = refuseIn(BizCode.MediaRefused);

const lifetime = 24 * 60 * 60 * 1000;
const quota = 2 * 1024 * 1024 * 1024;

const storedMetadata = Schema.Struct({ kind: Schema.Literals(["image", "video", "audio"]), name: Schema.String, mime: Schema.String, size: Schema.Int });
const metadataJson = Schema.encodeEffect(Schema.fromJsonString(storedMetadata));

export const makeInputs = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const storage: MediaInputStorage = { fs, path };
  const { join } = path;
  const db = yield* Db;
  const kept = yield* Attachment;
  // An input's bytes are an attachment (its hash is the attachment's id); media keeps only its own staging under the
  // attachments' one, so a staged file is renamed into place.
  const staging = join(kept.staging, "media");
  const contentOf = (hash: string) => kept.pathOf(hash);
  const lock = yield* Semaphore.make(1);
  const uploading = new Set<string>();
  const resultReservations = new Map<string, number>();
  const reservedBytes = () => {
    let bytes = 0;
    for (const size of resultReservations.values()) bytes += size;
    return bytes;
  };
  const storageError = () => refused(t("server.media.inputStorage"));
  const persist = (query: ReturnType<typeof q.insertInput>) => db.attempt(query).pipe(Effect.mapError(storageError));
  const found = Effect.fnUntraced(function* (id: string) {
    const row = yield* db.one(q.input({ id }));
    if (!row) return yield* refused(t("server.media.inputMissing"));
    return row;
  });
  const metadata = (row: q.InputResult) => Schema.decodeEffect(Schema.fromJsonString(storedMetadata))(row.metadata).pipe(Effect.mapError(storageError));
  const canDelete = (row: q.InputResult) => row.pinned === 0 && !uploading.has(row.id);
  const view = Effect.fnUntraced(function* (row: q.InputResult): Effect.fn.Return<T.MediaInput, ApiError> {
    return {
      ...(yield* metadata(row)),
      id: row.id,
      phase: row.phase,
      hash: row.hash,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      canDelete: canDelete(row),
    };
  });
  const get = Effect.fn("Media.inputGet")(function* (id: string) {
    const found2 = yield* found(id);
    return yield* view(found2);
  });
  const list = Effect.fn("Media.inputList")(function* () {
    const inputs2 = yield* db.run(q.inputs());
    return yield* Effect.forEach(inputs2, view);
  });
  const change = (row: q.InputResult, phase: T.MediaInput["phase"], hash = row.hash, expires = row.expires_at) =>
    persist(q.changeInput({ id: row.id, phase, hash, expires }));
  const remove = Effect.fnUntraced(function* (row: q.InputResult) {
    if (!canDelete(row)) return yield* refused(t("server.media.inputBusy"));
    yield* change(row, "deleting");
    yield* fs.remove(join(staging, row.id), { recursive: true, force: true }).pipe(Effect.mapError(storageError));
    // Its bytes stay: an attachment may be a message's file or a library item too.
    // The tombstone survives failed unlink or commit, so cleanup can be resumed without reviving the input.
    yield* persist(q.deleteInput({ id: row.id }));
  });
  const sweep = Effect.fn("Media.inputSweep")(
    function* () {
      const now = yield* Clock.currentTimeMillis;
      const expiredInputs2 = yield* db.run(q.expiredInputs({ now }));
      yield* Effect.forEach(
        expiredInputs2,
        (row) =>
          !uploading.has(row.id) ? remove(row).pipe(Effect.catch(() => Effect.logWarning("Media input cleanup is pending", { input: row.id }))) : Effect.void,
        { discard: true },
      );
    },
    lock.withPermits(1),
    Effect.uninterruptible,
  );

  // Scoped quota reservation for generated audio: tracks streaming bytes and rekeys onto the staged path until storeResult or scope exit.
  const acquireResultReservation = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    let key = newId(now);
    yield* Effect.acquireRelease(
      lock.withPermits(1)(
        Effect.gen(function* () {
          const capacity = yield* db.run(q.inputCapacity());
          if (capacity.count + resultReservations.size >= 256) return yield* refused(t("server.media.inputQuota"));
          resultReservations.set(key, 0);
        }),
      ),
      () =>
        lock.withPermits(1)(
          Effect.sync(() => {
            resultReservations.delete(key);
          }),
        ),
    );
    return {
      reserveChunk: (chunk: Uint8Array) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const capacity = yield* db.run(q.inputCapacity());
            if (capacity.bytes + reservedBytes() + chunk.byteLength > quota) return yield* refused(t("server.media.inputQuota"));
            resultReservations.set(key, (resultReservations.get(key) ?? 0) + chunk.byteLength);
            return chunk;
          }),
        ),
      bindStaged: (staged: StagedAudioResult) =>
        Effect.sync(() => {
          resultReservations.delete(key);
          key = staged.path;
          resultReservations.set(key, staged.size);
        }),
    };
  });

  // Scoped upload slot: enforces the 8-stream cap, wipes prior partial files on entry, and cleans staging + records failure on abort.
  const acquireUploadLease = (id: string) =>
    Effect.acquireRelease(
      lock.withPermits(1)(
        Effect.gen(function* () {
          const row = yield* found(id);
          if (row.phase === "ready") return { kind: "ready" as const, row };
          if (row.phase === "deleting" || uploading.has(id) || row.expires_at <= (yield* Clock.currentTimeMillis))
            return yield* refused(t("server.media.inputBusy"));
          if (uploading.size >= 8) return yield* refused(t("server.media.inputBusy"));
          yield* fs.remove(join(staging, id), { recursive: true, force: true }).pipe(Effect.mapError(storageError));
          yield* change(row, "uploading");
          uploading.add(id);
          const lease = {
            kind: "active" as const,
            row,
            committed: false,
            commit: () => {
              lease.committed = true;
            },
          };
          return lease;
        }),
      ),
      (lease) =>
        lease.kind === "ready"
          ? Effect.void
          : fs.remove(join(staging, id), { recursive: true, force: true }).pipe(
              Effect.mapError(storageError),
              Effect.ensuring(
                lock
                  .withPermits(1)(
                    Effect.gen(function* () {
                      uploading.delete(id);
                      if (!lease.committed) {
                        const latest = yield* found(id);
                        if (latest.phase === "uploading") yield* change(latest, "failed");
                      }
                    }),
                  )
                  .pipe(Effect.catch(() => Effect.logError("Media input interruption could not be recorded"))),
              ),
              Effect.catch(() => Effect.logError("Media input cleanup is pending")),
            ),
    );

  const service = {
    get,
    list,
    sweep,
    stageResult: Effect.fn("Media.inputStageResult")(function* (
      name: string,
      format: T.MediaAudioFormat,
      source: Stream.Stream<Uint8Array, ApiError>,
    ): Effect.fn.Return<StagedAudioResult, ApiError, Scope.Scope> {
      const reservation = yield* acquireResultReservation;
      const capped = source.pipe(Stream.mapEffect(reservation.reserveChunk));
      return yield* stageAudioResult(storage, staging, name, format, capped).pipe(
        Effect.catchTags({
          MediaInputRejected: () => Effect.fail(refused(t("server.media.inputInvalid"))),
          PlatformError: () => Effect.fail(storageError()),
          TimeoutError: () => Effect.fail(refused(t("server.media.inputTimeout"))),
        }),
        Effect.tap(reservation.bindStaged),
      );
    }),
    storeResult: Effect.fn("Media.inputStoreResult")(
      function* (staged: StagedAudioResult, holder: string, retainSource: boolean = false): Effect.fn.Return<T.MediaInputReference, ApiError> {
        const capacity = yield* db.run(q.inputCapacity());
        const reserved = resultReservations.get(staged.path) ?? 0;
        if (capacity.count + resultReservations.size - Number(reserved > 0) >= 256 || capacity.bytes + reservedBytes() - reserved + staged.size > quota)
          return yield* refused(t("server.media.inputQuota"));
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const promoted = yield* Effect.acquireRelease(
              Effect.gen(function* () {
                const now = yield* Clock.currentTimeMillis;
                const id = newId(now);
                const input = { kind: "audio" as const, name: staged.name, mime: staged.mime, size: staged.size };
                yield* persist(
                  q.insertInput({
                    id,
                    metadata: yield* metadataJson(input).pipe(Effect.mapError(storageError)),
                    size: staged.size,
                    now,
                    expires: now + lifetime,
                  }),
                );
                const row = yield* found(id);
                return { id, row, input, committed: false };
              }),
              (entry) =>
                entry.committed
                  ? Effect.void
                  : Effect.gen(function* () {
                      const latest = yield* found(entry.id);
                      yield* remove(latest);
                    }).pipe(Effect.catch(() => Effect.logError("Media result rollback is pending"))),
            );
            yield* change(promoted.row, "uploading", staged.hash);
            yield* kept
              .keepStaged({ path: staged.path, hash: staged.hash, size: staged.size, name: staged.name, type: staged.mime }, retainSource)
              .pipe(Effect.mapError((e) => refused(e.message)));
            yield* db.inTx(
              Effect.gen(function* () {
                yield* change(promoted.row, "ready", staged.hash);
                yield* persist(pins.pinInput({ id: promoted.id, holder }));
              }),
            );
            promoted.committed = true;
            resultReservations.delete(staged.path);
            return { id: promoted.id, hash: staged.hash, ...promoted.input };
          }),
        );
      },
      lock.withPermits(1),
      Effect.uninterruptible,
    ),
    create: Effect.fn("Media.inputCreate")(function* (given: T.MediaInputRequest) {
      const decoded = yield* Schema.decodeUnknownEffect(S.MediaInputRequest)(given, { onExcessProperty: "error" }).pipe(
        Effect.mapError(() => refused(t("server.media.inputInvalid"))),
      );
      const input = { ...decoded };
      yield* sweep();
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const capacity = yield* db.run(q.inputCapacity());
          if (capacity.count + resultReservations.size >= 256 || capacity.bytes + reservedBytes() + input.size > quota)
            return yield* refused(t("server.media.inputQuota"));
          const now = yield* Clock.currentTimeMillis;
          const id = newId(now);
          yield* persist(
            q.insertInput({ id, metadata: yield* metadataJson(input).pipe(Effect.mapError(storageError)), size: input.size, now, expires: now + lifetime }),
          );
          return yield* get(id);
        }).pipe(Effect.uninterruptible),
      );
    }),
    upload: Effect.fn("Media.inputUpload")(function* (id: string, source: Stream.Stream<Uint8Array, ApiError>) {
      const alreadyReady = yield* Effect.scoped(
        Effect.gen(function* () {
          const lease = yield* acquireUploadLease(id);
          if (lease.kind === "ready") return yield* view(lease.row);
          const declared = yield* metadata(lease.row);
          const staged = yield* stageMediaInput(storage, join(staging, id), declared, source).pipe(
            Effect.catchTags({
              MediaInputRejected: () => Effect.fail(refused(t("server.media.inputInvalid"))),
              PlatformError: () => Effect.fail(storageError()),
              TimeoutError: () => Effect.fail(refused(t("server.media.inputTimeout"))),
            }),
          );
          yield* lock.withPermits(1)(
            Effect.gen(function* () {
              if (lease.row.hash !== null && staged.hash !== lease.row.hash) return yield* refused(t("server.media.inputChanged"));
              // Record the intended hash before publishing, so a failed commit still has a user and consumes quota.
              yield* change(lease.row, "uploading", staged.hash);
              yield* kept.keepStaged({ path: staged.path, hash: staged.hash, size: staged.size, name: declared.name, type: declared.mime });
              yield* change(lease.row, "ready", staged.hash, (yield* Clock.currentTimeMillis) + lifetime);
              lease.commit();
            }).pipe(Effect.uninterruptible),
          );
          return undefined;
        }),
      );
      return alreadyReady ?? (yield* get(id));
    }),
    previewDelete: Effect.fn("Media.inputPreviewDelete")(function* (id: string): Effect.fn.Return<T.Preview, ApiError> {
      const row = yield* db.one(q.input({ id }));
      if (!row) return { does: [] };
      if (!canDelete(row)) return yield* refused(t("server.media.inputBusy"));
      return { does: [t("server.media.inputDeletePreview", { name: (yield* metadata(row)).name })] };
    }, lock.withPermits(1)),
    delete: Effect.fn("Media.inputDelete")(
      function* (id: string) {
        const row = yield* db.one(q.input({ id }));
        if (row) yield* remove(row);
      },
      lock.withPermits(1),
      Effect.uninterruptible,
    ),
    pin: Effect.fn("Media.inputPin")(
      function* (ids: readonly string[], holder: string, admit: Effect.Effect<void, ApiError>) {
        if (ids.length === 0 || ids.length > 5) return yield* refused(t("server.media.inputInvalid"));
        return yield* db.inTx(
          Effect.gen(function* () {
            const inputs: T.MediaInput[] = [];
            for (const id of new Set(ids)) {
              const row = yield* found(id);
              if (
                row.phase !== "ready" ||
                (row.pinned === 0 && row.expires_at <= (yield* Clock.currentTimeMillis)) ||
                !row.hash ||
                !(yield* fs.exists(contentOf(row.hash)).pipe(Effect.mapError(storageError)))
              )
                return yield* refused(t("server.media.inputMissing"));
              yield* persist(pins.pinInput({ id, holder }));
              const found2 = yield* view({ ...row, pinned: 1 });
              inputs.push(found2);
            }
            yield* admit;
            return inputs;
          }),
        );
      },
      lock.withPermits(1),
      Effect.uninterruptible,
    ),
    blob: Effect.fn("Media.inputBlob")(function* (id: string, holder: string) {
      const row = yield* found(id);
      if (row.phase !== "ready" || !row.hash || (yield* db.run(pins.inputPinnedBy({ id, holder }))).pinned === 0)
        return yield* refused(t("server.media.inputMissing"));
      const savedHash = row.hash;
      const path = contentOf(savedHash);
      return yield* Effect.gen(function* () {
        const input = yield* metadata(row);
        yield* verifyMediaInput(fs, path, input.size, savedHash).pipe(
          Effect.catchTags({
            PlatformError: () => Effect.fail(storageError()),
            MediaInputRejected: () => Effect.fail(refused(t("server.media.inputChanged"))),
          }),
        );
        const blob = yield* fileBlob(path, input.mime).pipe(Effect.mapError(storageError));
        if (blob.size !== input.size) return yield* refused(t("server.media.inputChanged"));
        return blob;
      }).pipe(
        Effect.tapError(() =>
          lock
            .withPermits(1)(
              Effect.gen(function* () {
                const latest = yield* db.one(q.input({ id }));
                if (latest?.phase === "ready" && latest.hash === savedHash) yield* change(latest, "failed");
              }),
            )
            .pipe(Effect.catch(() => Effect.logError("Media input corruption could not be recorded"))),
        ),
      );
    }),
    content: Effect.fn("Media.inputContent")(function* (id: string) {
      const row = yield* found(id);
      if (row.phase !== "ready" || !row.hash || (row.pinned === 0 && row.expires_at <= (yield* Clock.currentTimeMillis)))
        return yield* refused(t("server.media.inputMissing"));
      const input = yield* metadata(row);
      const path = contentOf(row.hash);
      yield* verifyMediaInput(fs, path, input.size, row.hash).pipe(Effect.mapError(() => refused(t("server.media.inputChanged"))));
      return { path, mime: input.mime, size: input.size, name: input.name };
    }),
    release: Effect.fn("Media.inputRelease")(
      function* (holder: string) {
        yield* persist(pins.unpinInputs({ holder }));
      },
      lock.withPermits(1),
      Effect.uninterruptible,
    ),
    releaseAssets: Effect.fn("Media.inputReleaseAssets")(
      function* (ids: readonly string[], holders: readonly string[], clear: Effect.Effect<void, ApiError>) {
        const deleting = yield* db.inTx(
          Effect.gen(function* () {
            yield* clear;
            yield* Effect.forEach(holders, (holder) => persist(pins.unpinInputs({ holder })), { discard: true });
            const rows: q.InputResult[] = [];
            for (const id of new Set(ids)) {
              const row = yield* db.one(q.input({ id }));
              if (!row || !canDelete(row)) continue;
              yield* change(row, "deleting");
              rows.push(row);
            }
            return rows;
          }),
        );
        yield* Effect.forEach(deleting, remove, { discard: true });
      },
      lock.withPermits(1),
      Effect.uninterruptible,
    ),
    restore: Effect.fn("Media.inputRestore")(
      function* () {
        if (uploading.size > 0 || resultReservations.size > 0) return yield* refused(t("server.media.inputBusy"));
        yield* fs.remove(staging, { recursive: true, force: true }).pipe(Effect.mapError(storageError));
        yield* persist(q.interruptInputs());
        const rows = yield* db.run(q.inputs());
        yield* Effect.forEach(
          rows,
          (row) =>
            Effect.gen(function* () {
              if (row.phase === "ready" && row.hash && !(yield* fs.exists(contentOf(row.hash)).pipe(Effect.mapError(storageError))))
                yield* change(row, "failed");
            }),
          { discard: true },
        );
      },
      lock.withPermits(1),
      Effect.uninterruptible,
    ),
  };
  /** A kept attachment taken as an input: its bytes go through the same checks an upload does, and land on the same id. */
  const adopt = Effect.fn("Media.inputAdopt")(function* (attachment: string) {
    const [file] = yield* kept.of([attachment]);
    if (file === undefined) return yield* refused(t("server.media.inputInvalid"));
    const kind = Arr.findFirst(["image", "video", "audio"] as const, (k) => Str.startsWith(`${k}/`)(file.type));
    if (Option.isNone(kind)) return yield* refused(t("server.media.inputInvalid"));
    const input = yield* service.create({ kind: kind.value, name: file.name, mime: file.type, size: file.size });
    return yield* service.upload(input.id, fs.stream(kept.pathOf(file.id)).pipe(Stream.mapError(storageError)));
  });
  return { ...service, adopt };
});
