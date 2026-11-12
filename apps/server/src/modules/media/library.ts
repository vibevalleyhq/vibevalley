import { TaskGroup, withTimeout } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import { attachmentMax } from "@vibevalley/protocol";
import type * as T from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { ApiError, BizCode, lookIn, messageOf, missing, refuseIn } from "#/base/errors.ts";
import { jsonOf } from "#/base/json.ts";
import { publicHttps } from "#/infra/publicHttp.ts";
import { NotWorkFile } from "#/modules/session/session.ts";
import * as q from "#db/media_library_item.sql.ts";

import type { MediaDeps } from "./media.ts";

const refused = refuseIn(BizCode.LibraryRefused);

export type AddedBy = { readonly kind: "user" } | { readonly kind: "agent"; readonly agent: string; readonly session?: T.SessionId };

const listMax = 500;

const typeByExtension: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  flac: "audio/flac",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
};
const lastOf = (text: string, separator: string) => text.split(separator).at(-1) ?? "";
const typeOfName = (name: string) => (name.includes(".") ? typeByExtension[lastOf(name, ".").toLowerCase()] : undefined) ?? "application/octet-stream";
const given = (text: string | undefined): text is string => text !== undefined && text.trim() !== "";

const originText = (origin: T.LibraryOrigin) => JSON.stringify(origin);
const originOf = jsonOf(S.LibraryOrigin);

const itemOf = (row: q.LibraryItemResult): T.LibraryItem => ({
  attachment: { id: row.attachment_id, name: row.name, type: row.type, size: row.size },
  origin: originOf(row.origin),
  addedAt: row.added_at,
  lastAt: row.last_at,
});

const madeFiles = (jobs: readonly T.MediaJob[]) =>
  jobs.flatMap((job) => ("attachment" in job && job.attachment !== undefined && job.phase === "ready" ? [{ job, attachment: job.attachment }] : []));

/** The library: the attachments kept as material, what media made and what the user or a helper brought in. */
interface Library {
  readonly list: (req: T.LibraryListRequest) => Promise<T.LibraryItem[]>;
  readonly add: (req: T.LibraryAddRequest, by: AddedBy, signal?: AbortSignal) => Promise<T.LibraryItem>;
  readonly remove: (id: string) => Promise<void>;
  readonly previewRemove: (id: string) => Promise<T.Preview>;
  /** Stops recording what the farm hears. */
  readonly close: () => Promise<void>;
}

const downloadMs = 60_000;

export async function makeLibrary(deps: Pick<MediaDeps, "db" | "core" | "clock" | "log" | "attachment" | "session" | "publicFetch">): Promise<Library> {
  const { db, core, clock } = deps;
  const files = deps.attachment;
  const sessions = deps.session;
  const log = deps.log.child("library");
  const tasks = new TaskGroup({ name: "library", onError: (task, e) => log.error(`library: ${task} failed`, e) });

  const found = async (id: string) => {
    const row = await q.libraryItem(db.sql, { id });
    if (row === undefined) throw missing(t("server.library.noItem", { id }), [lookIn.library]);
    return itemOf(row);
  };

  const keep = (id: string, origin: T.LibraryOrigin, at: number) => q.addLibraryItem(db.sql, { id, kind: origin.kind, origin: originText(origin), at });

  // Deduplicate across repeated mediaChanged facts for already-ready jobs.
  const recordedJobs = new Set<string>();
  const recordMade = async (jobs: readonly T.MediaJob[]) => {
    for (const { job, attachment } of madeFiles(jobs)) {
      if (recordedJobs.has(job.id)) continue;
      recordedJobs.add(job.id);
      const origin: T.LibraryOrigin = { kind: "generated", job: job.id, jobKind: job.kind };
      await q.knownLibraryItem(db.sql, { id: attachment.id, kind: origin.kind, origin: originText(origin), at: job.updatedAt });
    }
  };
  const recordSaid = async (message: T.ChatMessage) => {
    if (message.actor.kind !== "user" || message.kind !== "chat") return;
    for (const a of message.attachments) await keep(a.id, { kind: "uploaded", channel: message.channel, message: message.id }, message.at);
  };

  const { state, changes } = core.transitions();
  try {
    await recordMade(state.media ?? []);
  } catch (e) {
    changes.close();
    throw e;
  }
  tasks.run("record", async (signal) => {
    try {
      for (;;) {
        const next = await changes.next(signal);
        if (next.done === true) return;
        const { fact } = next.value;
        if (fact.type === "mediaChanged") await recordMade(fact.jobs);
        else if (fact.type === "messageChanged") await recordSaid(fact.message);
      }
    } finally {
      changes.close();
    }
  });

  const tooBig = () => refused(t("server.library.tooBig", { mb: attachmentMax / 1024 / 1024 }));

  const fetchFile = async (address: string, url: URL, signal: AbortSignal) => {
    const response = await deps.publicFetch(url, { signal, redirect: "manual" });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw refused(t("server.library.notFetched", { url: address, why: String(response.status) }));
    }
    let size = 0;
    const chunks: Uint8Array[] = [];
    const reader = response.body?.getReader();
    if (reader !== undefined)
      try {
        for (let read = await reader.read(); !read.done; read = await reader.read()) {
          const chunk: unknown = read.value;
          if (!(chunk instanceof Uint8Array)) throw new TypeError("a response body gave something other than bytes");
          size += chunk.byteLength;
          if (size > attachmentMax) throw tooBig();
          chunks.push(chunk);
        }
      } finally {
        // Cut short (too big, aborted): the rest of the body is not wanted.
        await reader.cancel().catch((e: unknown) => log.debug("library: the download's body did not cancel", e));
      }
    const header = response.headers.get("content-type");
    const type = header === null ? "" : (header.split(";")[0] ?? "").trim();
    const segment = lastOf(url.pathname, "/");
    const named = (() => {
      try {
        return decodeURIComponent(segment);
      } catch {
        // A mangled escape in the address: the segment as it is still names the file.
        return segment;
      }
    })();
    return { bytes: Buffer.concat(chunks), type, name: named === "" ? url.hostname : named };
  };

  const download = async (address: string, signal?: AbortSignal) => {
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      throw refused(t("server.library.badUrl", { url: address }));
    }
    if (!publicHttps(url)) throw refused(t("server.library.badUrl", { url: address }));
    try {
      return await withTimeout((bounded) => fetchFile(address, url, bounded), downloadMs, {
        clock,
        ...(signal !== undefined ? { signal } : {}),
        what: "the download",
      });
    } catch (e) {
      if (e instanceof ApiError || signal?.aborted === true) throw e;
      if (e instanceof DOMException && e.name === "TimeoutError") throw refused(t("server.library.slow"));
      throw refused(t("server.library.notFetched", { url: "", why: messageOf(e) }));
    }
  };

  const readWorkFile = async (session: string | undefined, path: string) => {
    try {
      return await sessions.workFile(session ?? "", path, attachmentMax);
    } catch (e) {
      if (!(e instanceof NotWorkFile)) throw e;
      switch (e.reason) {
        case "noPlace":
          throw refused(t("server.library.noPlace"));
        case "outside":
          throw refused(t("server.library.outside", { path }));
        case "notFile":
          throw refused(t("server.library.notFile", { path }));
        case "tooBig":
          throw tooBig();
        case "unreadable":
          throw refused(t("server.library.unreadable", { path, why: e.message }));
      }
    }
  };

  const stored = (bytes: Uint8Array, name: string, type: string) =>
    files.attach({ name, type: type === "" ? typeOfName(name) : type, data: Buffer.from(bytes).toString("base64") });

  const add = async (req: T.LibraryAddRequest, by: AddedBy, signal?: AbortSignal) => {
    if ([req.attachment, req.url, req.path].filter(given).length !== 1) throw refused(t("server.library.oneSource"));
    const at = clock.now();
    const name = given(req.name) ? req.name.trim() : "";
    if (given(req.attachment)) {
      if (by.kind !== "user") throw refused(t("server.library.agentAttachment"));
      const kept = await files.get(req.attachment);
      if (kept === undefined) throw missing(t("server.attachment.noAttachment", { id: req.attachment }), []);
      await keep(req.attachment, { kind: "uploaded" }, at);
      return found(req.attachment);
    }
    if (by.kind !== "agent") throw refused(t("server.library.userFetch"));
    const url = given(req.url) ? req.url.trim() : undefined;
    const path = req.path ?? "";
    const fetched = url === undefined ? await readWorkFile(by.session, path) : await download(url, signal);
    const attachment = await stored(fetched.bytes, name === "" ? fetched.name : name, "type" in fetched ? fetched.type : "");
    const from = url === undefined ? { path } : { url };
    await keep(attachment.id, { kind: "fetched", agent: by.agent, ...(by.session === undefined ? {} : { session: by.session }), from }, at);
    return found(attachment.id);
  };

  return {
    list: async (req) => {
      const rows = await q.libraryItems(db.sql, {
        kind: req.origin ?? "",
        top: req.type ?? "",
        text: (req.text ?? "").trim(),
        sort: req.sort ?? "recent",
        n: listMax,
      });
      return rows.map(itemOf);
    },
    add,
    remove: async (id) => {
      await found(id);
      await q.removeLibraryItem(db.sql, { id });
    },
    previewRemove: async (id) => {
      const item = await found(id);
      return { does: [t("server.library.preview.remove", { name: item.attachment.name })] };
    },
    close: () => tasks.close(),
  };
}
