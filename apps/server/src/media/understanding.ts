import { Clock, Effect, Fiber, FiberMap, Option, Schema, Semaphore } from "effect";
import { HttpClient } from "effect/http";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";
import { prepareMossUnderstanding, understandMossMedia } from "@vibevalley/provider/moss/understanding";

import { type ApiError, refused } from "#/base/errors.ts";
import { Db } from "#/infra/db.ts";
import { bestEffort } from "#/infra/log.ts";
import { Provider } from "#/provider/provider.ts";
import * as q from "#db/media_understanding.sql.ts";

import type { makeInputs } from "./inputs.ts";
import type { makeRemoteFiles } from "./remoteFiles.ts";

interface Ports {
  inputs: Effect.Success<typeof makeInputs>;
  remote: Effect.Success<ReturnType<typeof makeRemoteFiles>>;
  lock: Semaphore.Semaphore;
  slots: Semaphore.Semaphore;
  publish: () => Effect.Effect<void, ApiError>;
  capacity: () => Effect.Effect<void, ApiError>;
  imageExists: (id: string) => Effect.Effect<boolean>;
}

export const makeUnderstanding = Effect.fnUntraced(function* (ports: Ports) {
  const db = yield* Db;
  const provider = yield* Provider;
  const http = yield* HttpClient.HttpClient;
  const fibers = yield* FiberMap.make<string, void, ApiError>();
  const cleanupSlot = yield* Semaphore.make(1);
  const active = (phase: T.MediaUnderstandingPhase) => phase === "queued" || phase === "uploading" || phase === "generating";
  const terminal: readonly T.MediaUnderstandingPhase[] = ["ready", "incomplete", "failed", "unknown", "canceled"];
  const invalid = () => refused(t("server.media.inputInvalid"));
  const request = (row: q.UnderstandingResult) =>
    Schema.decodeEffect(Schema.fromJsonString(S.MediaUnderstandingRequest))(row.request).pipe(Effect.mapError(invalid));
  const found = Effect.fnUntraced(function* (id: string) {
    const row = yield* db.one(q.understanding({ id }));
    if (!row) return yield* Effect.fail(refused(t("server.media.missing")));
    return row;
  });
  const view = Effect.fnUntraced(function* (row: q.UnderstandingResult): Effect.fn.Return<T.MediaUnderstandingJob, ApiError> {
    const input = yield* request(row);
    return {
      kind: "understanding",
      id: row.id,
      prompt: input.prompt,
      inputs: yield* Schema.decodeEffect(Schema.fromJsonString(Schema.mutable(Schema.Array(S.MediaInputReference))))(row.inputs).pipe(Effect.mapError(invalid)),
      model: row.model,
      connection: row.connection,
      revision: row.revision,
      source: { kind: "owner" },
      phase: row.phase,
      phaseText: t(`server.media.understandingPhase.${row.phase}`),
      problem: row.problem,
      result:
        row.result === null ? null : yield* Schema.decodeEffect(Schema.fromJsonString(S.MediaUnderstandingResult))(row.result).pipe(Effect.mapError(invalid)),
      cleanup: row.cleanup,
      cleanupText: t(`server.media.cleanup.${row.cleanup}`),
      canCancel: active(row.phase),
      canCleanup: !active(row.phase) && (row.cleanup === "pending" || row.cleanup === "blocked"),
      canRetryDownload: false,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
  const get = Effect.fn("Media.understandingGet")(function* (id: string) {
    return yield* view(yield* found(id));
  });
  const change = Effect.fnUntraced(
    function* (
      id: string,
      before: readonly T.MediaUnderstandingPhase[],
      patch: Partial<Pick<q.UnderstandingResult, "phase" | "result" | "cleanup" | "problem">>,
    ) {
      const row = yield* found(id);
      if (!before.includes(row.phase)) return false;
      yield* db.run(q.changeUnderstanding({ ...row, ...patch, now: yield* Clock.currentTimeMillis }));
      yield* ports.publish();
      return true;
    },
    ports.lock.withPermits(1),
    Effect.uninterruptible,
  );
  const clean = Effect.fnUntraced(function* (id: string) {
    yield* Effect.gen(function* () {
      const rows = yield* ports.remote.list(id);
      yield* Effect.forEach(
        rows.filter((row) => row.remote_id !== null && row.phase !== "deleted"),
        (row) =>
          Effect.gen(function* () {
            const account = yield* provider.connection(row.connection);
            yield* ports.remote.remove(id, row.input_id, account);
          }),
        { discard: true },
      );
      const unresolved = rows.filter((row) => row.remote_id === null && row.phase !== "rejected" && row.phase !== "deleted");
      yield* ports.inputs.release(id);
      yield* change(id, terminal, {
        cleanup: unresolved.length > 0 ? "unknown" : "done",
        ...(unresolved.length > 0 ? { problem: t("server.media.remoteUnresolved", { files: unresolved.map((row) => row.filename).join(", ") }) } : {}),
      });
    }).pipe(
      Effect.catch(() => change(id, terminal, { cleanup: "blocked" })),
      Effect.onError(() => change(id, terminal, { cleanup: "blocked" }).pipe(bestEffort("Media understanding cleanup interruption could not be recorded"))),
    );
  }, cleanupSlot.withPermits(1));

  return {
    get,
    has: (id: string) => db.one(q.understanding({ id })).pipe(Effect.map((row) => row !== undefined)),
    pending: () => db.run(q.activeUnderstanding()).pipe(Effect.map((rows) => rows.length)),
    list: Effect.fn("Media.understandingList")(function* () {
      return yield* Effect.forEach(yield* db.run(q.recentUnderstanding()), view);
    }),
    create: Effect.fn("Media.createUnderstanding")(function* (given: T.MediaUnderstandingRequest) {
      const input = yield* Schema.decodeEffect(S.MediaUnderstandingRequest)(given).pipe(Effect.mapError(invalid));
      return yield* ports.lock.withPermits(1)(
        Effect.gen(function* () {
          const existing = yield* db.one(q.understanding({ id: input.id }));
          if (existing) {
            if (!same(yield* request(existing), input)) return yield* Effect.fail(refused(t("server.media.reusedId")));
            return yield* view(existing);
          }
          if (yield* ports.imageExists(input.id)) return yield* Effect.fail(refused(t("server.media.reusedId")));
          yield* ports.capacity();
          const account = yield* provider.understanding();
          if (input.connection !== account.connection || input.revision !== account.revision)
            return yield* Effect.fail(refused(t("server.media.consentChanged")));
          const references = yield* Effect.forEach(input.inputs, (id) =>
            ports.inputs.get(id).pipe(Effect.flatMap(Schema.decodeUnknownEffect(S.MediaInputReference)), Effect.mapError(invalid)),
          );
          yield* prepareMossUnderstanding({
            model: account.model,
            text: input.prompt,
            maxOutputTokens: input.maxOutputTokens,
            media: references.map((item) => ({ kind: item.kind, fileId: item.id })),
          }).pipe(Effect.mapError(invalid));
          yield* ports.inputs.pin(
            input.inputs,
            input.id,
            Effect.gen(function* () {
              yield* db.run(
                q.insertUnderstanding({
                  id: input.id,
                  request: JSON.stringify(input),
                  inputs: JSON.stringify(references),
                  connection: account.connection,
                  revision: account.revision,
                  model: account.model,
                  now: yield* Clock.currentTimeMillis,
                }),
              );
            }),
          );
          yield* ports.publish();
          const work = Effect.gen(function* () {
            if (!(yield* change(input.id, ["queued"], { phase: "uploading" }))) return;
            const media = yield* Effect.forEach(references, (item) =>
              Effect.gen(function* () {
                return { kind: item.kind, fileId: yield* ports.remote.upload(input.id, item.id, account) };
              }),
            );
            if (!(yield* change(input.id, ["uploading"], { phase: "generating" }))) return;
            const { id: _responseId, ...result } = yield* understandMossMedia(account.key, {
              model: account.model,
              text: input.prompt,
              media,
              maxOutputTokens: input.maxOutputTokens,
            }).pipe(Effect.provideService(HttpClient.HttpClient, http));
            if (
              yield* change(input.id, ["generating"], {
                phase: result.status === "completed" ? "ready" : "incomplete",
                result: JSON.stringify(result),
                cleanup: "running",
                problem: "",
              })
            )
              yield* clean(input.id);
          }).pipe(
            Effect.catchTag("MossUnderstandingError", (error) =>
              change(input.id, ["generating"], {
                phase: error.outcome === "Unknown" ? "unknown" : "failed",
                problem: error.outcome === "Unknown" ? t("server.media.understandingUnknown") : t("server.media.understandingRejected"),
              }),
            ),
            Effect.catch(() =>
              Effect.gen(function* () {
                const uncertain = (yield* ports.remote.list(input.id)).some((row) => row.phase === "unknown" || row.phase === "uploading");
                yield* change(input.id, ["uploading"], {
                  phase: uncertain ? "unknown" : "failed",
                  problem: uncertain ? t("server.media.remoteUploadUnknown") : t("server.media.remoteUploadRejected"),
                });
              }),
            ),
            Effect.onError(() =>
              change(input.id, ["uploading", "generating"], { phase: "unknown", problem: t("server.media.understandingUnknown") }).pipe(
                bestEffort("Media understanding interruption could not be recorded"),
              ),
            ),
            Effect.asVoid,
          );
          yield* FiberMap.run(fibers, input.id, ports.slots.withPermits(1)(work));
          return yield* get(input.id);
        }).pipe(Effect.uninterruptible),
      );
    }),
    cancel: Effect.fn("Media.understandingCancel")(function* (id: string) {
      const fiber = yield* ports.lock.withPermits(1)(
        Effect.gen(function* () {
          const row = yield* found(id);
          if (!active(row.phase)) return Option.none();
          yield* db.run(q.changeUnderstanding({ ...row, phase: "canceled", problem: t("server.media.canceled"), now: yield* Clock.currentTimeMillis }));
          yield* ports.publish();
          return FiberMap.getUnsafe(fibers, id);
        }).pipe(Effect.uninterruptible),
      );
      if (Option.isSome(fiber)) yield* Fiber.interrupt(fiber.value);
      return yield* get(id);
    }, Effect.uninterruptible),
    previewCleanup: Effect.fn("Media.understandingPreviewCleanup")(function* (id: string): Effect.fn.Return<T.Preview, ApiError> {
      const row = yield* found(id);
      if (active(row.phase) || row.cleanup === "running" || Option.isSome(FiberMap.getUnsafe(fibers, id)))
        return yield* Effect.fail(refused(t("server.media.busy")));
      if (row.cleanup === "done" || row.cleanup === "unknown") return { does: [] };
      const files = yield* ports.remote.list(id);
      return {
        does: [
          t("server.media.cleanupPreview", {
            connection: row.connection,
            count: files.filter((file) => file.remote_id !== null && file.phase !== "deleted").length,
          }),
          t("server.media.cleanupReleasePreview"),
        ],
      };
    }, ports.lock.withPermits(1)),
    cleanup: Effect.fn("Media.understandingCleanup")(function* (id: string) {
      return yield* Effect.uninterruptibleMask((resume) =>
        Effect.gen(function* () {
          const start = yield* ports.lock.withPermits(1)(
            Effect.gen(function* () {
              const row = yield* found(id);
              if (active(row.phase) || row.cleanup === "running" || Option.isSome(FiberMap.getUnsafe(fibers, id)))
                return yield* Effect.fail(refused(t("server.media.busy")));
              if (row.cleanup === "done" || row.cleanup === "unknown") return false;
              yield* ports.capacity();
              yield* db.run(q.changeUnderstanding({ ...row, cleanup: "running", now: yield* Clock.currentTimeMillis }));
              yield* ports.publish();
              return true;
            }),
          );
          if (start)
            yield* resume(clean(id)).pipe(
              Effect.onError(() => change(id, terminal, { cleanup: "blocked" }).pipe(bestEffort("Media understanding cleanup could not be interrupted"))),
            );
          return yield* get(id);
        }),
      );
    }),
    restore: Effect.fn("Media.understandingRestore")(function* () {
      const before = yield* db.run(q.activeUnderstanding());
      yield* db.run(q.interruptUnderstanding({ now: yield* Clock.currentTimeMillis, problem: t("server.media.restarted") }));
      yield* Effect.forEach(
        before.filter((row) => row.phase === "queued"),
        (row) => ports.inputs.release(row.id),
        { discard: true },
      );
    }),
  };
});
