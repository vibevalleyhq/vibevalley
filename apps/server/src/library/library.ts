import { Array as Arr, Clock, Context, Effect, Formatter, Layer, Schema, Stream, String as Str } from "effect";

import { t } from "@vibevalley/i18n";
import { attachmentMax } from "@vibevalley/protocol";
import type * as T from "@vibevalley/protocol";
import type { ApiError } from "@vibevalley/protocol/api";
import * as S from "@vibevalley/protocol/schema";

import { Attachment } from "#/attachment/attachment.ts";
import { lookIn, missing, refused } from "#/base/errors.ts";
import { jsonOf } from "#/base/json.ts";
import { Core } from "#/core/core.ts";
import { Db } from "#/infra/db.ts";
import { PublicHttp, publicHttps } from "#/infra/publicHttp.ts";
import { Session } from "#/session/session.ts";
import * as q from "#db/library_item.sql.ts";

/** Who puts a file in: the user, or a profile (with its helper's session when a helper). */
export type AddedBy = { readonly kind: "user" } | { readonly kind: "agent"; readonly agent: string; readonly session?: string };

const listMax = 500;

// A fetched file's type when its source does not say one: what the library sorts by and the page shows it as.
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
const lastOf = (text: string, separator: string) => Arr.lastNonEmpty(Str.split(separator)(text));
const typeOfName = (name: string) => (Str.includes(".")(name) ? typeByExtension[Str.toLowerCase(lastOf(name, "."))] : undefined) ?? "application/octet-stream";
const given = (text: string | undefined): text is string => text !== undefined && Str.trim(text) !== "";

// Its own shape written plainly; originOf reads it back through its Schema.
const originText = (origin: T.LibraryOrigin) => Formatter.formatJson(origin);
const originOf = jsonOf(S.LibraryOrigin);

const itemOf = (row: q.LibraryItemResult): T.LibraryItem => ({
  attachment: { id: row.attachment_id, name: row.name, type: row.type, size: row.size },
  origin: originOf(row.origin),
  addedAt: row.added_at,
  lastAt: row.last_at,
});

/** The jobs whose made file is kept: ready, with an attachment. */
const madeFiles = (jobs: readonly T.MediaJob[]) =>
  Arr.flatMap(jobs, (job) => ("attachment" in job && job.attachment !== undefined && job.phase === "ready" ? [{ job, attachment: job.attachment }] : []));

/** An address's last segment that is not valid percent-encoding. */
class MangledName extends Schema.TaggedError<MangledName, { readonly brand: unique symbol }>()("MangledName", {}) {}

export class Library extends Context.Service<
  Library,
  {
    readonly list: (req: T.LibraryListRequest) => Effect.Effect<T.LibraryItem[]>;
    /** Exactly one of attachment (the user's), url or path (a profile's fetch); the same bytes again only move lastAt. */
    readonly add: (req: T.LibraryAddRequest, by: AddedBy) => Effect.Effect<T.LibraryItem, ApiError>;
    /** The item only: a message that has the file still opens it. */
    readonly remove: (id: string) => Effect.Effect<void, ApiError>;
    readonly previewRemove: (id: string) => Effect.Effect<T.Preview, ApiError>;
  }
>()("@vibevalley/server/library/library") {
  static readonly layer = Layer.effect(
    Library,
    Effect.suspend(() => make),
  );
}

const make = Effect.gen(function* () {
  const db = yield* Db;
  const core = yield* Core;
  const files = yield* Attachment;
  const sessions = yield* Session;
  const http = yield* PublicHttp;

  const found = Effect.fnUntraced(function* (id: string) {
    const row = yield* db.one(q.libraryItem({ id }));
    if (row === undefined) return yield* Effect.fail(missing(t("server.library.noItem", { id }), [lookIn.library]));
    return itemOf(row);
  });

  const keep = (id: string, origin: T.LibraryOrigin, at: number) => db.run(q.addLibraryItem({ id, kind: origin.kind, origin: originText(origin), at }));

  // A job's file goes in once: a later fact repeating the same ready job changes nothing.
  const recordedJobs = new Set<string>();
  const recordMade = Effect.fnUntraced(function* (jobs: readonly T.MediaJob[]) {
    for (const { job, attachment } of madeFiles(jobs)) {
      if (recordedJobs.has(job.id)) continue;
      recordedJobs.add(job.id);
      const origin: T.LibraryOrigin = { kind: "generated", job: job.id, jobKind: job.kind };
      yield* db.run(q.knownLibraryItem({ id: attachment.id, kind: origin.kind, origin: originText(origin), at: job.updatedAt }));
    }
  });
  const recordSaid = (message: T.ChatMessage) =>
    message.fromKind === "user" && message.kind === "chat"
      ? Effect.forEach(message.attachments, (a) => keep(a.id, { kind: "uploaded", channel: message.channel, message: message.id }, message.at), {
          discard: true,
        })
      : Effect.void;

  const [state, transitions] = yield* core.transitions;
  yield* recordMade(state.media ?? []);
  yield* Effect.forkScoped(
    Stream.runForEach(transitions, ({ fact }) =>
      fact.type === "mediaChanged" ? recordMade(fact.jobs) : fact.type === "messageChanged" ? recordSaid(fact.message) : Effect.void,
    ),
  );

  const download = Effect.fn("Library.download")(
    function* (address: string) {
      const url = yield* Schema.decodeEffect(Schema.URLFromString)(address).pipe(Effect.mapError(() => refused(t("server.library.badUrl", { url: address }))));
      if (!publicHttps(url)) return yield* Effect.fail(refused(t("server.library.badUrl", { url: address })));
      const response = yield* http.get(url);
      if (response.status !== 200) return yield* Effect.fail(refused(t("server.library.notFetched", { url: address, why: String(response.status) })));
      let size = 0;
      const chunks = yield* response.stream.pipe(
        Stream.mapEffect((chunk) => {
          size += chunk.byteLength;
          return size > attachmentMax ? Effect.fail(refused(t("server.library.tooBig", { mb: attachmentMax / 1024 / 1024 }))) : Effect.succeed(chunk);
        }),
        Stream.runCollect,
      );
      const header = response.headers["content-type"];
      const type = header === undefined ? "" : Str.trim(Arr.headNonEmpty(Str.split(";")(header)));
      const segment = lastOf(url.pathname, "/");
      // A name the address mangled (a stray %) is kept as it was written.
      const named = yield* Effect.try({ try: () => decodeURIComponent(segment), catch: () => MangledName.make() }).pipe(
        Effect.catchTag("MangledName", () => Effect.succeed(segment)),
      );
      return { bytes: Buffer.concat(chunks), type, name: named === "" ? url.hostname : named };
    },
    Effect.timeout("60 seconds"),
    Effect.catchTags({
      HttpClientError: (e) => Effect.fail(refused(t("server.library.notFetched", { url: "", why: e.message }))),
      TimeoutError: () => Effect.fail(refused(t("server.library.slow"))),
    }),
  );

  const readWorkFile = (session: string | undefined, path: string) =>
    sessions.workFile(session ?? "", path, attachmentMax).pipe(
      Effect.mapError((e) => {
        switch (e.reason) {
          case "noPlace":
            return refused(t("server.library.noPlace"));
          case "outside":
            return refused(t("server.library.outside", { path }));
          case "notFile":
            return refused(t("server.library.notFile", { path }));
          case "tooBig":
            return refused(t("server.library.tooBig", { mb: attachmentMax / 1024 / 1024 }));
          case "unreadable":
            return refused(t("server.library.unreadable", { path, why: e.message }));
        }
      }),
    );

  const stored = (bytes: Uint8Array, name: string, type: string) =>
    files.attach({ name, type: type === "" ? typeOfName(name) : type, data: Buffer.from(bytes).toString("base64") });

  const add = Effect.fn("Library.add")(function* (req: T.LibraryAddRequest, by: AddedBy) {
    if (Arr.filter([req.attachment, req.url, req.path], given).length !== 1) return yield* Effect.fail(refused(t("server.library.oneSource")));
    const at = yield* Clock.currentTimeMillis;
    const name = given(req.name) ? Str.trim(req.name) : "";
    if (given(req.attachment)) {
      if (by.kind !== "user") return yield* Effect.fail(refused(t("server.library.agentAttachment")));
      const kept = yield* files.get(req.attachment);
      if (kept === undefined) return yield* Effect.fail(missing(t("server.attachment.noAttachment", { id: req.attachment }), []));
      yield* keep(req.attachment, { kind: "uploaded" }, at);
      return yield* found(req.attachment);
    }
    if (by.kind !== "agent") return yield* Effect.fail(refused(t("server.library.userFetch")));
    const url = given(req.url) ? Str.trim(req.url) : undefined;
    const path = req.path ?? "";
    const fetched = url === undefined ? yield* readWorkFile(by.session, path) : yield* download(url);
    const attachment = yield* stored(fetched.bytes, name === "" ? fetched.name : name, "type" in fetched ? fetched.type : "");
    const from = url === undefined ? { path } : { url };
    yield* keep(attachment.id, { kind: "fetched", agent: by.agent, ...(by.session === undefined ? {} : { session: by.session }), from }, at);
    return yield* found(attachment.id);
  });

  return Library.of({
    list: Effect.fn("Library.list")(function* (req) {
      const rows = yield* db.run(
        q.libraryItems({ kind: req.origin ?? "", top: req.type ?? "", text: Str.trim(req.text ?? ""), sort: req.sort ?? "recent", n: listMax }),
      );
      return Arr.map(rows, itemOf);
    }),
    add,
    remove: Effect.fn("Library.remove")(function* (id) {
      yield* found(id);
      yield* db.run(q.removeLibraryItem({ id }));
    }),
    previewRemove: Effect.fn("Library.previewRemove")(function* (id) {
      const item = yield* found(id);
      return { does: [t("server.library.preview.remove", { name: item.attachment.name })] };
    }),
  });
});
