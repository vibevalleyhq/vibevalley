import { Semaphore } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";

import { BizCode, refuseIn } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import type { Db } from "#/infra/db.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Account } from "#/modules/provider/provider.ts";
import { FileFailure } from "#/modules/provider/vendors.ts";
import * as q from "#db/media_remote_file.sql.ts";

import type { Inputs } from "./inputs.ts";

const refused = refuseIn(BizCode.MediaRefused);

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

export interface RemoteFilesDeps {
  readonly db: Db;
  readonly clock: Time;
  readonly log: Logger;
}

export function makeRemoteFiles(deps: RemoteFilesDeps, inputs: Inputs) {
  const { db, clock, log } = deps;
  const lock = new Semaphore(1);
  const changed = () => refused(t("server.media.remoteAccountChanged"));
  const unknown = () => refused(t("server.media.remoteUploadUnknown"));
  const checkAccount = (row: q.RemoteFileResult, account: Account) => {
    if (row.connection !== account.connection || row.credential_hash !== account.fingerprint) throw changed();
  };
  const change = async (row: q.RemoteFileResult, phase: q.RemoteFileResult["phase"], remoteId: string | null = row.remote_id) => {
    await q.changeRemoteFile(db.sql, { id: row.id, phase, remote_id: remoteId, now: clock.now() });
  };

  /** The input uploaded to the vendor under account, once per holder: only reading the input and the upload itself are
   * stopped by the signal, so what was sent is always recorded. */
  const upload = (holder: string, inputId: string, account: Account, signal?: AbortSignal) =>
    lock.with(async (): Promise<string> => {
      const previous = await q.remoteFile(db.sql, { holder, input: inputId });
      if (previous) {
        checkAccount(previous, account);
        if (previous.phase === "ready" && previous.remote_id !== null) return previous.remote_id;
        throw unknown();
      }
      if ((await q.remoteFiles(db.sql, { holder })).length >= 5) throw refused(t("server.media.inputInvalid"));
      const input = await inputs.get(inputId);
      const extension = extensions.get(input.mime);
      if (extension === undefined || input.hash === null) throw refused(t("server.media.inputInvalid"));
      signal?.throwIfAborted();
      const file = await inputs.blob(inputId, holder);
      signal?.throwIfAborted();
      const now = clock.now();
      const id = newId(now);
      // A unique upload name records intent without disclosing the user's original filename.
      const filename = `vv-${id}.${extension}`;
      await q.insertRemoteFile(db.sql, {
        id,
        holder,
        input: inputId,
        connection: account.connection,
        revision: account.revision,
        credential_hash: account.fingerprint,
        filename,
        purpose: input.kind,
        size: input.size,
        content_hash: input.hash,
        now,
      });
      try {
        let result;
        try {
          result = await account.files.upload({ file, filename, purpose: input.kind }, signal);
        } catch (error) {
          if (!(error instanceof FileFailure) || signal?.aborted === true) throw error;
          await q.changeRemoteFile(db.sql, { id, phase: error.outcome === "Unknown" ? "unknown" : "rejected", remote_id: null, now: clock.now() });
          throw error.outcome === "Unknown" ? unknown() : refused(t("server.media.remoteUploadRejected"));
        }
        const phase = result.state;
        await q.changeRemoteFile(db.sql, { id, phase, remote_id: result.id, now: clock.now() });
        if (phase !== "ready") throw phase === "rejected" ? refused(t("server.media.remoteUploadRejected")) : unknown();
        return result.id;
      } catch (e) {
        await bestEffort(log, "Media remote upload interruption could not be recorded", () => q.interruptRemoteFile(db.sql, { id, now: clock.now() }));
        throw e;
      }
    });

  /** The vendor's copy deleted: only the deletion itself is stopped by the signal. */
  const remove = (holder: string, inputId: string, account: Account, signal?: AbortSignal) =>
    lock.with(async () => {
      const row = await q.remoteFile(db.sql, { holder, input: inputId });
      if (!row) return;
      checkAccount(row, account);
      if (row.phase === "deleted") return;
      if (row.phase === "rejected" && row.remote_id === null) {
        await change(row, "deleted");
        return;
      }
      if (row.remote_id === null) throw unknown();
      await change(row, "deleting");
      try {
        await account.files.delete(row.remote_id, signal);
      } catch (e) {
        if (signal?.aborted === true) throw e;
        log.warn(`media: the vendor's copy of ${inputId} could not be deleted`, e);
        throw refused(t("server.media.remoteCleanupFailed"));
      }
      await change(row, "deleted");
    });

  return {
    list: (holder: string) => q.remoteFiles(db.sql, { holder }),
    upload,
    remove,
    restore: () =>
      lock.with(async () => {
        await q.interruptRemoteFiles(db.sql, { now: clock.now() });
      }),
  };
}

export type RemoteFiles = ReturnType<typeof makeRemoteFiles>;
