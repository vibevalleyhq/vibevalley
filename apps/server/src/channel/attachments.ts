import { createHash } from "node:crypto";
import { join } from "node:path";

import { Clock, Effect, FileSystem } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { attachmentMax } from "@vibevalley/protocol";

import { missing, lookIn, refused } from "@/errors.ts";
import { ServerConfig } from "@/infra/config.ts";
import { Db } from "@/infra/db.ts";
import { writeOnce } from "@/infra/files.ts";

import * as qa from "../../db/generated/channel_attachment.sql.ts";
import type { ChannelService } from "./contracts.ts";
export const channelAttachments = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const db = yield* Db;
  const fs = yield* FileSystem.FileSystem;
  const filesDir = join(config.home, "attachments");
  const filesAt = (id: string) => join(filesDir, id);
  const attachmentsOf = Effect.fnUntraced(function* (ids: readonly string[]) {
    const out: T.Attachment[] = [];
    for (const id of new Set(ids)) {
      const a = yield* db.one(qa.attachmentByID({ id }));
      if (!a) return yield* Effect.fail(missing(t("server.channel.noAttachment", { id }), [lookIn.channel]));
      out.push(a);
    }
    return out;
  });

  const methods: Pick<ChannelService, "attach" | "attachment"> = {
    attach: Effect.fn("Channel.attach")(function* (upload) {
      const name = upload.name.trim() || "file";
      const bytes = Buffer.from(upload.data, "base64");
      if (bytes.length === 0) return yield* Effect.fail(refused(t("server.channel.emptyFile")));
      if (bytes.length > attachmentMax) return yield* Effect.fail(refused(t("server.channel.fileTooBig", { mb: Math.round(attachmentMax / 1024 / 1024) })));
      const id = createHash("sha256").update(bytes).digest("hex");
      yield* writeOnce(filesAt(id), bytes).pipe(
        Effect.mapError((e) => refused(e.message)),
        Effect.provideService(FileSystem.FileSystem, fs),
      );
      const type = upload.type.trim() || "application/octet-stream";
      yield* db.run(qa.insertAttachment({ id, name, type, size: bytes.length, created_at: yield* Clock.currentTimeMillis }));
      return { id, name, type, size: bytes.length };
    }),
    attachment: Effect.fn("Channel.attachment")(function* (id) {
      const a = yield* db.one(qa.attachmentByID({ id }));
      return a ? { path: filesAt(a.id), type: a.type, name: a.name } : undefined;
    }),
  };
  return { filesAt, attachmentsOf, ...methods };
});
