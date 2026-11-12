import { createHash } from "node:crypto";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { attachmentMax } from "@vibevalley/protocol";

import { BizCode, messageOf, missing, refuseIn } from "#/base/errors.ts";
import type { ServerConfig } from "#/infra/config.ts";
import type { Db } from "#/infra/db.ts";
import type { Time } from "#/infra/time.ts";
import * as q from "#db/attachment.sql.ts";

import { makeStorage } from "./storage.ts";

const refused = refuseIn(BizCode.AttachmentRefused);

export interface KeptFile {
  readonly path: string;
  readonly type: string;
  readonly name: string;
}

export interface Attachment {
  readonly attach: (upload: T.AttachmentUpload) => Promise<T.Attachment>;
  /** Enforces no size limit; callers enforce their own. */
  readonly keep: (bytes: Uint8Array, name: string, type: string) => Promise<T.Attachment>;
  /** Enforces no size limit; media inputs hold their own streaming quota. */
  readonly keepStaged: (
    staged: { readonly path: string; readonly hash: string; readonly size: number; readonly name: string; readonly type: string },
    retain?: boolean,
  ) => Promise<T.Attachment>;
  readonly staging: string;
  readonly get: (id: string) => Promise<KeptFile | undefined>;
  readonly of: (ids: readonly string[]) => Promise<T.Attachment[]>;
  readonly bytes: (id: string) => Promise<Uint8Array>;
  readonly pathOf: (id: string) => string;
}

export interface AttachmentDeps {
  readonly config: ServerConfig;
  readonly clock: Time;
  readonly db: Db;
}

export async function makeAttachment(deps: AttachmentDeps): Promise<Attachment> {
  const { db } = deps;
  const storage = makeStorage(deps.config);
  /** work, a storage failure refused with its words. */
  const unkept = async <A>(work: () => Promise<A>): Promise<A> => {
    try {
      return await work();
    } catch (e) {
      throw refused(messageOf(e));
    }
  };

  const sha256Of = async (key: string) => {
    const hash = createHash("sha256");
    for await (const chunk of storage.stream(key)) hash.update(chunk);
    return hash.digest("hex");
  };

  const record = async (id: string, given: string, givenType: string, size: number) => {
    const name = given.trim() || "file";
    const type = givenType.trim() || "application/octet-stream";
    await q.insertAttachment(db.sql, { id, name, type, size, created_at: deps.clock.now() });
    return { id, name, type, size };
  };

  const keep = async (bytes: Uint8Array, name: string, type: string) => {
    if (bytes.length === 0) throw refused(t("server.attachment.emptyFile"));
    const id = createHash("sha256").update(bytes).digest("hex");
    await unkept(() => storage.put(id, bytes));
    return record(id, name, type, bytes.length);
  };

  const noAttachment = (id: string) => missing(t("server.attachment.noAttachment", { id }), []);

  return {
    pathOf: storage.pathOf,
    staging: storage.scratch,
    attach: async (upload) => {
      const bytes = Buffer.from(upload.data, "base64");
      if (bytes.length > attachmentMax) throw refused(t("server.attachment.fileTooBig", { mb: Math.round(attachmentMax / 1024 / 1024) }));
      return keep(bytes, upload.name, upload.type);
    },
    keep,
    keepStaged: async (staged, retain = false) => {
      await unkept(async () => {
        // Re-verify existing file hash so corrupted bytes on disk are replaced rather than trusted.
        if ((await storage.exists(staged.hash)) && (await sha256Of(staged.hash)) === staged.hash) return;
        await storage.adopt(staged.hash, staged.path, retain);
      });
      return record(staged.hash, staged.name, staged.type, staged.size);
    },
    get: async (id) => {
      const a = await q.attachmentByID(db.sql, { id });
      return a ? { path: storage.pathOf(a.id), type: a.type, name: a.name } : undefined;
    },
    bytes: async (id) => {
      try {
        const blob = await storage.open(id, "application/octet-stream");
        return new Uint8Array(await blob.arrayBuffer());
      } catch {
        // Not there, or not readable: either way there is no such attachment to give.
        throw noAttachment(id);
      }
    },
    of: async (ids) => {
      const out: T.Attachment[] = [];
      for (const id of new Set(ids)) {
        const a = await q.attachmentByID(db.sql, { id });
        if (!a) throw noAttachment(id);
        out.push(a);
      }
      return out;
    },
  };
}
