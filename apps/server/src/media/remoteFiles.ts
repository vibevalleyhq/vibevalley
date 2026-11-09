import { createHash } from "node:crypto";

import { Clock, Effect, Semaphore } from "effect";
import { HttpClient } from "effect/http";

import { t } from "@vibevalley/i18n";
import { deleteMossFile, uploadMossFile } from "@vibevalley/provider/moss/files";

import { refused } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import { Db } from "#/infra/db.ts";
import { bestEffort } from "#/infra/log.ts";
import type { Provider } from "#/provider/provider.ts";
import * as q from "#db/media_remote_file.sql.ts";

import type { makeInputs } from "./inputs.ts";

type Account = Effect.Success<ReturnType<Provider["Service"]["connection"]>>;
const fingerprint = (key: string) => createHash("sha256").update(key).digest("hex");
const extensions = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["image/bmp", "bmp"],
  ["image/tiff", "tiff"],
  ["video/mp4", "mp4"],
  ["video/x-m4v", "m4v"],
  ["video/quicktime", "mov"],
  ["video/x-msvideo", "avi"],
  ["video/webm", "webm"],
  ["video/x-matroska", "mkv"],
  ["audio/wav", "wav"],
  ["audio/mpeg", "mp3"],
  ["audio/mp4", "m4a"],
  ["audio/flac", "flac"],
  ["audio/ogg", "ogg"],
  ["audio/webm", "webm"],
]);

export const makeRemoteFiles = Effect.fnUntraced(function* (inputs: Effect.Success<typeof makeInputs>) {
  const db = yield* Db;
  const http = yield* HttpClient.HttpClient;
  const lock = yield* Semaphore.make(1);
  const changed = () => refused(t("server.media.remoteAccountChanged"));
  const unknown = () => refused(t("server.media.remoteUploadUnknown"));
  const checkAccount = (row: q.RemoteFileResult, account: Account) =>
    row.connection === account.connection && row.credential_hash === fingerprint(account.key) ? Effect.void : Effect.fail(changed());
  const change = Effect.fnUntraced(function* (row: q.RemoteFileResult, phase: q.RemoteFileResult["phase"], remoteId: string | null = row.remote_id) {
    yield* db.run(q.changeRemoteFile({ id: row.id, phase, remote_id: remoteId, now: yield* Clock.currentTimeMillis }));
  });

  return {
    list: Effect.fn("Media.remoteFileList")((holder: string) => db.run(q.remoteFiles({ holder }))),
    upload: Effect.fn("Media.remoteFileUpload")(
      (holder: string, inputId: string, account: Account) =>
        Effect.uninterruptibleMask((resume) =>
          Effect.gen(function* () {
            if (!account.key.trim() || /\s/u.test(account.key)) return yield* Effect.fail(changed());
            const previous = yield* db.one(q.remoteFile({ holder, input: inputId }));
            if (previous) {
              yield* checkAccount(previous, account);
              if (previous.phase === "ready" && previous.remote_id !== null) return previous.remote_id;
              return yield* Effect.fail(unknown());
            }
            if ((yield* db.run(q.remoteFiles({ holder }))).length >= 5) return yield* Effect.fail(refused(t("server.media.inputInvalid")));
            const input = yield* inputs.get(inputId);
            const extension = extensions.get(input.mime);
            if (extension === undefined || input.hash === null) return yield* Effect.fail(refused(t("server.media.inputInvalid")));
            const file = yield* resume(inputs.blob(inputId, holder));
            const now = yield* Clock.currentTimeMillis;
            const id = newId(now);
            // A unique upload name records intent without disclosing the owner's original filename.
            const filename = `vv-${id}.${extension}`;
            yield* db.run(
              q.insertRemoteFile({
                id,
                holder,
                input: inputId,
                connection: account.connection,
                revision: account.revision,
                credential_hash: fingerprint(account.key),
                filename,
                purpose: input.kind,
                size: input.size,
                content_hash: input.hash,
                now,
              }),
            );
            return yield* resume(
              uploadMossFile(account.key, { file, filename, purpose: input.kind }).pipe(Effect.provideService(HttpClient.HttpClient, http)),
            ).pipe(
              Effect.flatMap((result) =>
                Effect.gen(function* () {
                  const phase = result.status === "processed" || result.status === "active" ? "ready" : result.status === "failed" ? "rejected" : "unknown";
                  yield* db.run(q.changeRemoteFile({ id, phase, remote_id: result.id, now: yield* Clock.currentTimeMillis }));
                  if (phase !== "ready") return yield* Effect.fail(phase === "rejected" ? refused(t("server.media.remoteUploadRejected")) : unknown());
                  return result.id;
                }),
              ),
              Effect.catchTag("MossFileError", (error) =>
                Effect.gen(function* () {
                  yield* db.run(
                    q.changeRemoteFile({
                      id,
                      phase: error.outcome === "Unknown" ? "unknown" : "rejected",
                      remote_id: null,
                      now: yield* Clock.currentTimeMillis,
                    }),
                  );
                  return yield* Effect.fail(error.outcome === "Unknown" ? unknown() : refused(t("server.media.remoteUploadRejected")));
                }),
              ),
              Effect.onError(() =>
                Effect.gen(function* () {
                  yield* db.run(q.interruptRemoteFile({ id, now: yield* Clock.currentTimeMillis }));
                }).pipe(bestEffort("Media remote upload interruption could not be recorded")),
              ),
            );
          }),
        ),
      lock.withPermits(1),
    ),
    remove: Effect.fn("Media.remoteFileRemove")(
      (holder: string, inputId: string, account: Account) =>
        Effect.uninterruptibleMask((resume) =>
          Effect.gen(function* () {
            const row = yield* db.one(q.remoteFile({ holder, input: inputId }));
            if (!row) return;
            yield* checkAccount(row, account);
            if (row.phase === "deleted") return;
            if (row.phase === "rejected" && row.remote_id === null) {
              yield* change(row, "deleted");
              return;
            }
            if (row.remote_id === null) return yield* Effect.fail(unknown());
            yield* change(row, "deleting");
            yield* resume(
              deleteMossFile(account.key, row.remote_id).pipe(
                Effect.provideService(HttpClient.HttpClient, http),
                Effect.asVoid,
                Effect.catchTag("MossFileError", (error) => (error.status === 404 ? Effect.void : Effect.fail(refused(t("server.media.remoteCleanupFailed"))))),
              ),
            );
            yield* change(row, "deleted");
          }),
        ),
      lock.withPermits(1),
    ),
    restore: Effect.fn("Media.remoteFileRestore")(
      function* () {
        yield* db.run(q.interruptRemoteFiles({ now: yield* Clock.currentTimeMillis }));
      },
      lock.withPermits(1),
      Effect.uninterruptible,
    ),
  };
});
