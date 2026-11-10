import { Clock, Effect, Exit, FileSystem, Path, Schema, Semaphore, type Scope, Stream } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { type ApiError, refused } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import { ServerConfig } from "#/infra/config.ts";
import { Db } from "#/infra/db.ts";
import { fileBlob } from "#/infra/files.ts";
import * as q from "#db/media_input.sql.ts";
import * as pins from "#db/media_input_pin.sql.ts";

import { stageAudioResult, stageMediaInput, type StagedAudioResult, verifyMediaInput } from "./input.ts";

const lifetime = 24 * 60 * 60 * 1000;
const quota = 2 * 1024 * 1024 * 1024;

const storedMetadata = Schema.Struct({ kind: Schema.Literals(["image", "video", "audio"]), name: Schema.String, mime: Schema.String, size: Schema.Int });
const metadataJson = Schema.encodeEffect(Schema.fromJsonString(storedMetadata));

export const makeInputs = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { join } = path;
  const db = yield* Db;
  const config = yield* ServerConfig;
  const directory = join(config.home, "media-inputs");
  const staging = join(directory, "staging");
  const content = join(directory, "content");
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
    if (!row) return yield* Effect.fail(refused(t("server.media.inputMissing")));
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
  const change = (row: q.InputResult, phase: T.MediaInputPhase, hash = row.hash, expires = row.expires_at) =>
    persist(q.changeInput({ id: row.id, phase, hash, expires }));
  const remove = Effect.fnUntraced(function* (row: q.InputResult) {
    if (!canDelete(row)) return yield* Effect.fail(refused(t("server.media.inputBusy")));
    yield* change(row, "deleting");
    yield* fs.remove(join(staging, row.id), { recursive: true, force: true }).pipe(Effect.mapError(storageError));
    if (row.hash && (yield* db.run(q.otherInputHash({ id: row.id, hash: row.hash }))).count === 0)
      yield* fs.remove(join(content, row.hash), { force: true }).pipe(Effect.mapError(storageError));
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

  return {
    get,
    list,
    sweep,
    stageResult: Effect.fn("Media.inputStageResult")(function* (
      name: string,
      format: T.MediaAudioFormat,
      source: Stream.Stream<Uint8Array, ApiError>,
    ): Effect.fn.Return<StagedAudioResult, ApiError, Scope.Scope> {
      const now = yield* Clock.currentTimeMillis;
      let reservation = newId(now);
      yield* Effect.acquireRelease(
        lock.withPermits(1)(
          Effect.gen(function* () {
            const capacity = yield* db.run(q.inputCapacity());
            if (capacity.count + resultReservations.size >= 256) return yield* Effect.fail(refused(t("server.media.inputQuota")));
            resultReservations.set(reservation, 0);
          }),
        ),
        () =>
          lock.withPermits(1)(
            Effect.sync(() => {
              resultReservations.delete(reservation);
            }),
          ),
      );
      const capped = source.pipe(
        Stream.mapEffect((chunk) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              const capacity = yield* db.run(q.inputCapacity());
              if (capacity.bytes + reservedBytes() + chunk.byteLength > quota) return yield* Effect.fail(refused(t("server.media.inputQuota")));
              resultReservations.set(reservation, (resultReservations.get(reservation) ?? 0) + chunk.byteLength);
              return chunk;
            }),
          ),
        ),
      );
      return yield* stageAudioResult(staging, name, format, capped).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.catchTags({
          MediaInputRejected: () => Effect.fail(refused(t("server.media.inputInvalid"))),
          PlatformError: () => Effect.fail(storageError()),
          TimeoutError: () => Effect.fail(refused(t("server.media.inputTimeout"))),
        }),
        Effect.tap((staged) =>
          Effect.sync(() => {
            resultReservations.delete(reservation);
            resultReservations.set(staged.path, staged.size);
            reservation = staged.path;
          }),
        ),
      );
    }),
    storeResult: Effect.fn("Media.inputStoreResult")(
      function* (staged: StagedAudioResult, holder: string, retainSource: boolean = false): Effect.fn.Return<T.MediaInputReference, ApiError> {
        const capacity = yield* db.run(q.inputCapacity());
        const reserved = resultReservations.get(staged.path) ?? 0;
        if (capacity.count + resultReservations.size - Number(reserved > 0) >= 256 || capacity.bytes + reservedBytes() - reserved + staged.size > quota)
          return yield* Effect.fail(refused(t("server.media.inputQuota")));
        const now = yield* Clock.currentTimeMillis;
        const id = newId(now);
        const input = { kind: "audio" as const, name: staged.name, mime: staged.mime, size: staged.size };
        yield* persist(
          q.insertInput({ id, metadata: yield* metadataJson(input).pipe(Effect.mapError(storageError)), size: staged.size, now, expires: now + lifetime }),
        );
        const row = yield* found(id);
        yield* Effect.gen(function* () {
          yield* fs.makeDirectory(content, { recursive: true, mode: 0o700 });
          yield* change(row, "uploading", staged.hash);
          const target = join(content, staged.hash);
          const exists = yield* fs.exists(target);
          if (exists) yield* verifyMediaInput(target, staged.size, staged.hash).pipe(Effect.provideService(FileSystem.FileSystem, fs));
          else if (retainSource) yield* fs.link(staged.path, target);
          else yield* fs.rename(staged.path, target);
          yield* db.inTx(
            Effect.gen(function* () {
              yield* change(row, "ready", staged.hash);
              yield* persist(pins.pinInput({ id, holder }));
            }),
          );
          resultReservations.delete(staged.path);
        }).pipe(
          Effect.catchTags({
            PlatformError: () => Effect.fail(storageError()),
            MediaInputRejected: () => Effect.fail(refused(t("server.media.inputChanged"))),
          }),
          Effect.onError(() =>
            Effect.gen(function* () {
              const latest = yield* found(id);
              yield* remove(latest);
            }).pipe(Effect.catch(() => Effect.logError("Media result rollback is pending"))),
          ),
        );
        return { id, hash: staged.hash, ...input };
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
            return yield* Effect.fail(refused(t("server.media.inputQuota")));
          const now = yield* Clock.currentTimeMillis;
          const id = newId(now);
          yield* persist(
            q.insertInput({ id, metadata: yield* metadataJson(input).pipe(Effect.mapError(storageError)), size: input.size, now, expires: now + lifetime }),
          );
          return yield* get(id);
        }).pipe(Effect.uninterruptible),
      );
    }),
    upload: Effect.fn("Media.inputUpload")((id: string, source: Stream.Stream<Uint8Array, ApiError>) =>
      Effect.uninterruptibleMask((resume) =>
        Effect.gen(function* () {
          const row = yield* lock.withPermits(1)(
            Effect.gen(function* () {
              const row = yield* found(id);
              if (row.phase === "ready") return row;
              if (row.phase === "deleting" || uploading.has(id) || row.expires_at <= (yield* Clock.currentTimeMillis))
                return yield* Effect.fail(refused(t("server.media.inputBusy")));
              if (uploading.size >= 8) return yield* Effect.fail(refused(t("server.media.inputBusy")));
              yield* fs.remove(join(staging, id), { recursive: true, force: true }).pipe(Effect.mapError(storageError));
              yield* change(row, "uploading");
              uploading.add(id);
              return row;
            }).pipe(Effect.uninterruptible),
          );
          if (row.phase === "ready") return yield* view(row);
          yield* resume(
            Effect.gen(function* () {
              const declared = yield* metadata(row);
              const staged = yield* stageMediaInput(join(staging, id), declared, source).pipe(Effect.provideService(FileSystem.FileSystem, fs));
              return yield* lock.withPermits(1)(
                Effect.gen(function* () {
                  if (row.hash !== null && staged.hash !== row.hash) return yield* Effect.fail(refused(t("server.media.inputChanged")));
                  yield* fs.makeDirectory(content, { recursive: true, mode: 0o700 });
                  const target = join(content, staged.hash);
                  // Record the intended hash before publishing, so failed rollback still has a user and consumes quota.
                  yield* change(row, "uploading", staged.hash);
                  const linked = yield* fs.link(staged.path, target).pipe(
                    Effect.as(true),
                    Effect.catchIf(
                      (error) => error.reason._tag === "AlreadyExists",
                      () => Effect.succeed(false),
                    ),
                  );
                  if (!linked)
                    yield* verifyMediaInput(target, staged.size, staged.hash).pipe(
                      Effect.provideService(FileSystem.FileSystem, fs),
                      Effect.catch(() => fs.rename(staged.path, target)),
                    );
                  yield* change(row, "ready", staged.hash, (yield* Clock.currentTimeMillis) + lifetime).pipe(
                    Effect.onError(() =>
                      linked
                        ? fs.remove(target, { force: true }).pipe(Effect.catch(() => Effect.logError("Media input rollback could not remove its file")))
                        : Effect.void,
                    ),
                  );
                }).pipe(Effect.uninterruptible),
              );
            }),
          ).pipe(
            Effect.scoped,
            Effect.catchTags({
              MediaInputRejected: () => Effect.fail(refused(t("server.media.inputInvalid"))),
              PlatformError: () => Effect.fail(storageError()),
              TimeoutError: () => Effect.fail(refused(t("server.media.inputTimeout"))),
            }),
            Effect.onExit((exit) =>
              fs.remove(join(staging, id), { recursive: true, force: true }).pipe(
                Effect.mapError(storageError),
                Effect.ensuring(
                  lock
                    .withPermits(1)(
                      Effect.gen(function* () {
                        uploading.delete(id);
                        if (Exit.isFailure(exit)) {
                          const latest = yield* found(id);
                          if (latest.phase === "uploading") yield* change(latest, "failed");
                        }
                      }),
                    )
                    .pipe(Effect.catch(() => Effect.logError("Media input interruption could not be recorded"))),
                ),
                Effect.catch(() => Effect.logError("Media input cleanup is pending")),
              ),
            ),
          );
          return yield* get(id);
        }),
      ),
    ),
    previewDelete: Effect.fn("Media.inputPreviewDelete")(function* (id: string): Effect.fn.Return<T.Preview, ApiError> {
      const row = yield* db.one(q.input({ id }));
      if (!row) return { does: [] };
      if (!canDelete(row)) return yield* Effect.fail(refused(t("server.media.inputBusy")));
      const does = [t("server.media.inputDeletePreview", { name: (yield* metadata(row)).name })];
      if (row.hash && (yield* db.run(q.otherInputHash({ id, hash: row.hash }))).count === 0) does.push(t("server.media.inputDeleteBytes"));
      return { does };
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
        if (ids.length === 0 || ids.length > 5) return yield* Effect.fail(refused(t("server.media.inputInvalid")));
        return yield* db.inTx(
          Effect.gen(function* () {
            const inputs: T.MediaInput[] = [];
            for (const id of new Set(ids)) {
              const row = yield* found(id);
              if (
                row.phase !== "ready" ||
                (row.pinned === 0 && row.expires_at <= (yield* Clock.currentTimeMillis)) ||
                !row.hash ||
                !(yield* fs.exists(join(content, row.hash)).pipe(Effect.mapError(storageError)))
              )
                return yield* Effect.fail(refused(t("server.media.inputMissing")));
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
        return yield* Effect.fail(refused(t("server.media.inputMissing")));
      const savedHash = row.hash;
      const path = join(content, savedHash);
      return yield* Effect.gen(function* () {
        const input = yield* metadata(row);
        yield* verifyMediaInput(path, input.size, savedHash).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.catchTags({
            PlatformError: () => Effect.fail(storageError()),
            MediaInputRejected: () => Effect.fail(refused(t("server.media.inputChanged"))),
          }),
        );
        const blob = yield* fileBlob(path, input.mime).pipe(Effect.mapError(storageError));
        if (blob.size !== input.size) return yield* Effect.fail(refused(t("server.media.inputChanged")));
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
        return yield* Effect.fail(refused(t("server.media.inputMissing")));
      const input = yield* metadata(row);
      const path = join(content, row.hash);
      yield* verifyMediaInput(path, input.size, row.hash).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.mapError(() => refused(t("server.media.inputChanged"))),
      );
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
        if (uploading.size > 0 || resultReservations.size > 0) return yield* Effect.fail(refused(t("server.media.inputBusy")));
        yield* fs.remove(staging, { recursive: true, force: true }).pipe(Effect.mapError(storageError));
        yield* persist(q.interruptInputs());
        yield* fs.makeDirectory(content, { recursive: true, mode: 0o700 }).pipe(Effect.mapError(storageError));
        const rows = yield* db.run(q.inputs());
        const hashes = new Set(rows.flatMap((row) => (row.hash ? [row.hash] : [])));
        const directory2 = yield* fs.readDirectory(content).pipe(Effect.mapError(storageError));
        yield* Effect.forEach(
          directory2,
          (name) =>
            /^[0-9a-f]{64}$/u.test(name) && !hashes.has(name)
              ? fs.remove(join(content, name), { force: true }).pipe(Effect.mapError(storageError))
              : Effect.void,
          { discard: true },
        );
        yield* Effect.forEach(
          rows,
          (row) =>
            Effect.gen(function* () {
              if (row.phase === "ready" && row.hash && !(yield* fs.exists(join(content, row.hash)).pipe(Effect.mapError(storageError))))
                yield* change(row, "failed");
            }),
          { discard: true },
        );
      },
      lock.withPermits(1),
      Effect.uninterruptible,
    ),
  };
});
