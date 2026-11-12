import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { Semaphore } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { ApiError, BizCode, errnoOf, messageOf, refuseIn } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import { jsonOf, jsonText } from "#/base/json.ts";
import { type Db, SqlError } from "#/infra/db.ts";
import { fileBlob } from "#/infra/files.ts";
import type { Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Attachment } from "#/modules/attachment/attachment.ts";
import * as q from "#db/media_input.sql.ts";
import * as pins from "#db/media_input_pin.sql.ts";

import {
  declared,
  diskStorage,
  MediaInputRejected,
  type MediaInputStorage,
  stageAudioResult,
  stageMediaInput,
  type StagedAudioResult,
  verifyMediaInput,
} from "./input.ts";

const refused = refuseIn(BizCode.MediaRefused);

const lifetime = 24 * 60 * 60 * 1000;
const quota = 2 * 1024 * 1024 * 1024;

const storedMetadata = z.object({ kind: z.enum(["image", "video", "audio"]), name: z.string(), mime: z.string(), size: z.number().int() });
const metadataOf = jsonOf(storedMetadata);

export interface InputsDeps {
  readonly db: Db;
  readonly clock: Time;
  readonly log: Logger;
  readonly attachment: Attachment;
}

const isTimeout = (e: unknown) => e instanceof DOMException && e.name === "TimeoutError";

/** storage is where staged bytes go: the disk, or a test's stand-in that fails where it is told to. */
export function makeInputs(deps: InputsDeps, storage: MediaInputStorage = diskStorage) {
  const { db, clock, attachment: kept } = deps;
  const log = deps.log.child("media/inputs");
  // An input's bytes are an attachment (its hash is the attachment's id); media keeps only its own staging under the
  // attachments' one, so a staged file is renamed into place.
  const staging = join(kept.staging, "media");
  const contentOf = (hash: string) => kept.pathOf(hash);
  const lock = new Semaphore(1);
  const uploading = new Set<string>();
  const resultReservations = new Map<string, number>();
  const reservedBytes = () => {
    let bytes = 0;
    for (const size of resultReservations.values()) bytes += size;
    return bytes;
  };
  const storageError = () => refused(t("server.media.inputStorage"));
  /** A write whose failure is the input store's: said as a refusal, not a defect. */
  const persist = async (write: () => Promise<unknown>): Promise<void> => {
    try {
      await write();
    } catch (e) {
      if (!(e instanceof SqlError)) throw e;
      log.warn("media input write failed", e);
      throw storageError();
    }
  };
  /** A file-system step: its failure is the input store's too. */
  const onDisk = async <A>(step: () => Promise<A>): Promise<A> => {
    try {
      return await step();
    } catch (e) {
      log.warn("media input storage failed", e);
      throw storageError();
    }
  };
  const exists = (path: string) =>
    onDisk(async () => {
      try {
        await stat(path);
        return true;
      } catch (e) {
        if (errnoOf(e) === "ENOENT") return false;
        throw e;
      }
    });
  const removeDir = (path: string) => onDisk(() => storage.remove(path));
  const capacityNow = async () => (await q.inputCapacity(db.sql)) ?? { bytes: 0, count: 0 };
  const found = async (id: string) => {
    const row = await q.input(db.sql, { id });
    if (!row) throw refused(t("server.media.inputMissing"));
    return row;
  };
  const metadata = (row: q.InputResult) => {
    try {
      return metadataOf(row.metadata);
    } catch (e) {
      log.warn(`media input ${row.id}: its metadata cannot be read`, e);
      throw storageError();
    }
  };
  const canDelete = (row: q.InputResult) => row.pinned === 0 && !uploading.has(row.id);
  const view = (row: q.InputResult): T.MediaInput => ({
    ...metadata(row),
    id: row.id,
    phase: row.phase,
    hash: row.hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    canDelete: canDelete(row),
  });
  const get = async (id: string) => view(await found(id));
  const list = async () => (await q.inputs(db.sql)).map(view);
  const change = (row: q.InputResult, phase: T.MediaInput["phase"], hash = row.hash, expires = row.expires_at) =>
    persist(() => q.changeInput(db.sql, { id: row.id, phase, hash, expires }));
  const remove = async (row: q.InputResult) => {
    if (!canDelete(row)) throw refused(t("server.media.inputBusy"));
    await change(row, "deleting");
    await removeDir(join(staging, row.id));
    // Its bytes stay: an attachment may be a message's file or a library item too.
    // The tombstone survives failed unlink or commit, so cleanup can be resumed without reviving the input.
    await persist(() => q.deleteInput(db.sql, { id: row.id }));
  };
  // Takes no signal: a sweep once begun goes through each expired input.
  const sweep = () =>
    lock.with(async () => {
      for (const row of await q.expiredInputs(db.sql, { now: clock.now() })) {
        if (uploading.has(row.id)) continue;
        try {
          await remove(row);
        } catch (e) {
          log.warn(`media input cleanup is pending: ${row.id}`, e);
        }
      }
    });

  /** A staged file removed; one that cannot be is left for the next restart's sweep of the staging directory, and said. */
  const letGo = async (staged: AsyncDisposable) => {
    try {
      await staged[Symbol.asyncDispose]();
    } catch (e) {
      log.warn("media staging cleanup is pending", e);
    }
  };
  /** staged, its removal never failing what used it. */
  const keptBy = <A extends AsyncDisposable>(staged: A): A => ({ ...staged, [Symbol.asyncDispose]: () => letGo(staged) });

  /** A staging failure in the words the caller is answered with; an abort or the source's own failure goes on as it is. */
  const stagingRefusal = (e: unknown, signal?: AbortSignal): unknown => {
    if (signal?.aborted === true) return e;
    if (e instanceof MediaInputRejected) return refused(t("server.media.inputInvalid"));
    if (isTimeout(e)) return refused(t("server.media.inputTimeout"));
    if (errnoOf(e) !== undefined) {
      log.warn("media input staging failed", e);
      return storageError();
    }
    return e;
  };

  /** Each chunk of source, counted against the quota under the reservation's key before it is written. */
  async function* reserved(source: AsyncIterable<Uint8Array>, key: () => string): AsyncGenerator<Uint8Array> {
    for await (const chunk of source) {
      await lock.with(async () => {
        const capacity = await capacityNow();
        if (capacity.bytes + reservedBytes() + chunk.byteLength > quota) throw refused(t("server.media.inputQuota"));
        resultReservations.set(key(), (resultReservations.get(key()) ?? 0) + chunk.byteLength);
      });
      yield chunk;
    }
  }

  /** A file's bytes as an upload's source; a read failure is the input store's. */
  async function* fileChunks(path: string): AsyncGenerator<Uint8Array> {
    const stream = createReadStream(path);
    try {
      for await (const chunk of stream) {
        if (!(chunk instanceof Uint8Array)) throw storageError();
        yield chunk;
      }
    } catch (e) {
      if (e instanceof ApiError) throw e;
      log.warn(`media input could not be read from ${path}`, e);
      throw storageError();
    } finally {
      stream.destroy();
    }
  }

  /** Generated audio staged against the quota: the reservation tracks its bytes as they stream, then follows the staged
   * file until storeResult takes it or the caller disposes of it. */
  const stageResult = async (
    name: string,
    format: T.MediaAudioFormat,
    source: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<StagedAudioResult & AsyncDisposable> => {
    let key = newId(clock.now());
    await lock.with(async () => {
      const capacity = await capacityNow();
      if (capacity.count + resultReservations.size >= 256) throw refused(t("server.media.inputQuota"));
      resultReservations.set(key, 0);
    });
    const release = () =>
      lock.with(async () => {
        resultReservations.delete(key);
      });
    try {
      const staged = await stageAudioResult(
        storage,
        staging,
        name,
        format,
        reserved(source, () => key),
        {
          clock,
          ...(signal === undefined ? {} : { signal }),
        },
      ).catch((e: unknown) => {
        throw stagingRefusal(e, signal);
      });
      resultReservations.delete(key);
      key = staged.path;
      resultReservations.set(key, staged.size);
      return {
        ...staged,
        [Symbol.asyncDispose]: async () => {
          await letGo(staged);
          await release();
        },
      };
    } catch (e) {
      await release();
      throw e;
    }
  };

  // Not stopped by a caller: a result once being kept is kept, or its row rolled back.
  const storeResult = (staged: StagedAudioResult, holder: string, retainSource = false): Promise<T.MediaInputReference> =>
    lock.with(async () => {
      const capacity = await capacityNow();
      const reservedHere = resultReservations.get(staged.path) ?? 0;
      if (capacity.count + resultReservations.size - Number(reservedHere > 0) >= 256 || capacity.bytes + reservedBytes() - reservedHere + staged.size > quota)
        throw refused(t("server.media.inputQuota"));
      const now = clock.now();
      const id = newId(now);
      const input = { kind: "audio" as const, name: staged.name, mime: staged.mime, size: staged.size };
      await persist(() => q.insertInput(db.sql, { id, metadata: jsonText(input), size: staged.size, now, expires: now + lifetime }));
      const row = await found(id);
      let committed = false;
      try {
        await change(row, "uploading", staged.hash);
        try {
          await kept.keepStaged({ path: staged.path, hash: staged.hash, size: staged.size, name: staged.name, type: staged.mime }, retainSource);
        } catch (e) {
          throw refused(messageOf(e));
        }
        await db.tx(async () => {
          await change(row, "ready", staged.hash);
          await persist(() => pins.pinInput(db.sql, { id, holder }));
        });
        committed = true;
        resultReservations.delete(staged.path);
        return { id, hash: staged.hash, ...input };
      } finally {
        if (!committed) {
          try {
            await remove(await found(id));
          } catch (e) {
            log.error("media result rollback is pending", e);
          }
        }
      }
    });

  const create = async (given: T.MediaInputRequest) => {
    let input: T.MediaInputRequest;
    try {
      input = declared(given);
    } catch {
      // What the request says is not an input: answered as such, nothing to log.
      throw refused(t("server.media.inputInvalid"));
    }
    await sweep();
    return lock.with(async () => {
      const capacity = await capacityNow();
      if (capacity.count + resultReservations.size >= 256 || capacity.bytes + reservedBytes() + input.size > quota) throw refused(t("server.media.inputQuota"));
      const now = clock.now();
      const id = newId(now);
      await persist(() => q.insertInput(db.sql, { id, metadata: jsonText(input), size: input.size, now, expires: now + lifetime }));
      return get(id);
    });
  };

  /** One upload slot: at most 8 at once; an earlier partial file goes on entry. undefined when the input is ready already. */
  const lease = (id: string) =>
    lock.with(async () => {
      const row = await found(id);
      if (row.phase === "ready") return { kind: "ready" as const, row };
      if (row.phase === "deleting" || uploading.has(id) || row.expires_at <= clock.now()) throw refused(t("server.media.inputBusy"));
      if (uploading.size >= 8) throw refused(t("server.media.inputBusy"));
      await removeDir(join(staging, id));
      await change(row, "uploading");
      uploading.add(id);
      return { kind: "active" as const, row };
    });

  /** The slot given back: its staging goes, and an upload that did not commit is recorded as failed. */
  const unlease = async (id: string, committed: boolean) => {
    try {
      await removeDir(join(staging, id));
    } catch (e) {
      log.error("media input cleanup is pending", e);
    }
    try {
      await lock.with(async () => {
        uploading.delete(id);
        if (!committed) {
          const latest = await found(id);
          if (latest.phase === "uploading") await change(latest, "failed");
        }
      });
    } catch (e) {
      log.error("media input interruption could not be recorded", e);
    }
  };

  const upload = async (id: string, source: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<T.MediaInput> => {
    const slot = await lease(id);
    if (slot.kind === "ready") return view(slot.row);
    let committed = false;
    try {
      const input = metadata(slot.row);
      await using staged = keptBy(
        await stageMediaInput(storage, join(staging, id), input, source, {
          clock,
          ...(signal === undefined ? {} : { signal }),
        }).catch((e: unknown) => {
          throw stagingRefusal(e, signal);
        }),
      );
      // Not stopped by the caller from here: the staged file is kept and recorded, or not at all.
      await lock.with(async () => {
        if (slot.row.hash !== null && staged.hash !== slot.row.hash) throw refused(t("server.media.inputChanged"));
        // Record the intended hash before publishing, so a failed commit still has a user and consumes quota.
        await change(slot.row, "uploading", staged.hash);
        await kept.keepStaged({ path: staged.path, hash: staged.hash, size: staged.size, name: input.name, type: input.mime });
        await change(slot.row, "ready", staged.hash, clock.now() + lifetime);
        committed = true;
      });
    } finally {
      await unlease(id, committed);
    }
    return get(id);
  };

  const previewDelete = (id: string): Promise<T.Preview> =>
    lock.with(async () => {
      const row = await q.input(db.sql, { id });
      if (!row) return { does: [] };
      if (!canDelete(row)) throw refused(t("server.media.inputBusy"));
      return { does: [t("server.media.inputDeletePreview", { name: metadata(row).name })] };
    });

  const remove1 = (id: string) =>
    lock.with(async () => {
      const row = await q.input(db.sql, { id });
      if (row) await remove(row);
    });

  // Pinned inside one transaction with admit: a job that is not admitted holds none of them.
  const pin = (ids: readonly string[], holder: string, admit: () => Promise<void>) =>
    lock.with(async () => {
      if (ids.length === 0 || ids.length > 5) throw refused(t("server.media.inputInvalid"));
      return db.tx(async () => {
        const inputs: T.MediaInput[] = [];
        for (const id of new Set(ids)) {
          const row = await found(id);
          if (row.phase !== "ready" || (row.pinned === 0 && row.expires_at <= clock.now()) || !row.hash || !(await exists(contentOf(row.hash))))
            throw refused(t("server.media.inputMissing"));
          await persist(() => pins.pinInput(db.sql, { id, holder }));
          inputs.push(view({ ...row, pinned: 1 }));
        }
        await admit();
        return inputs;
      });
    });

  const blob = async (id: string, holder: string): Promise<Blob> => {
    const row = await found(id);
    if (row.phase !== "ready" || !row.hash || ((await pins.inputPinnedBy(db.sql, { id, holder }))?.pinned ?? 0) === 0)
      throw refused(t("server.media.inputMissing"));
    const savedHash = row.hash;
    const path = contentOf(savedHash);
    try {
      const input = metadata(row);
      try {
        await verifyMediaInput(path, input.size, savedHash);
      } catch (e) {
        if (e instanceof MediaInputRejected) throw refused(t("server.media.inputChanged"));
        log.warn(`media input ${id} could not be read`, e);
        throw storageError();
      }
      const file = await onDisk(() => fileBlob(path, input.mime));
      if (file.size !== input.size) throw refused(t("server.media.inputChanged"));
      return file;
    } catch (e) {
      try {
        await lock.with(async () => {
          const latest = await q.input(db.sql, { id });
          if (latest?.phase === "ready" && latest.hash === savedHash) await change(latest, "failed");
        });
      } catch (recording) {
        log.error("media input corruption could not be recorded", recording);
      }
      throw e;
    }
  };

  const content = async (id: string) => {
    const row = await found(id);
    if (row.phase !== "ready" || !row.hash || (row.pinned === 0 && row.expires_at <= clock.now())) throw refused(t("server.media.inputMissing"));
    const input = metadata(row);
    const path = contentOf(row.hash);
    try {
      await verifyMediaInput(path, input.size, row.hash);
    } catch (e) {
      log.warn(`media input ${id} does not match what was kept`, e);
      throw refused(t("server.media.inputChanged"));
    }
    return { path, mime: input.mime, size: input.size, name: input.name };
  };

  const release = (holder: string) =>
    lock.with(async () => {
      await persist(() => pins.unpinInputs(db.sql, { holder }));
    });

  const releaseAssets = (ids: readonly string[], holders: readonly string[], clear: () => Promise<void>) =>
    lock.with(async () => {
      const deleting = await db.tx(async () => {
        await clear();
        for (const holder of holders) await persist(() => pins.unpinInputs(db.sql, { holder }));
        const rows: q.InputResult[] = [];
        for (const id of new Set(ids)) {
          const row = await q.input(db.sql, { id });
          if (!row || !canDelete(row)) continue;
          await change(row, "deleting");
          rows.push(row);
        }
        return rows;
      });
      for (const row of deleting) await remove(row);
    });

  const restore = () =>
    lock.with(async () => {
      if (uploading.size > 0 || resultReservations.size > 0) throw refused(t("server.media.inputBusy"));
      await removeDir(staging);
      await persist(() => q.interruptInputs(db.sql));
      for (const row of await q.inputs(db.sql)) {
        if (row.phase === "ready" && row.hash && !(await exists(contentOf(row.hash)))) await change(row, "failed");
      }
    });

  /** A kept attachment taken as an input: its bytes go through the same checks an upload does, and land on the same id. */
  const adopt = async (attachment: string) => {
    const [file] = await kept.of([attachment]);
    if (file === undefined) throw refused(t("server.media.inputInvalid"));
    const kind = (["image", "video", "audio"] as const).find((k) => file.type.startsWith(`${k}/`));
    if (kind === undefined) throw refused(t("server.media.inputInvalid"));
    const input = await create({ kind, name: file.name, mime: file.type, size: file.size });
    return upload(input.id, fileChunks(kept.pathOf(file.id)));
  };

  return {
    get,
    list,
    sweep,
    stageResult,
    storeResult,
    create,
    upload,
    previewDelete,
    delete: remove1,
    pin,
    blob,
    content,
    release,
    releaseAssets,
    restore,
    adopt,
  };
}

export type Inputs = ReturnType<typeof makeInputs>;
