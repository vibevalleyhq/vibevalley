import { Clock, Context, Effect, Layer, Semaphore, type Stream } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { userId } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { Attachment } from "#/attachment/attachment.ts";
import { head } from "#/base/clip.ts";
import { type ApiError, lookIn, missing, refused } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import { Channel } from "#/channel/channel.ts";
import { Db } from "#/infra/db.ts";
import * as qa from "#db/artifact.sql.ts";
import * as qv from "#db/artifact_version.sql.ts";

import { makeBlockStore } from "./blocks.ts";
import { htmlCheck, htmlProblem } from "./check.ts";
import { htmlEdit } from "./edit.ts";
import { artifactProblem } from "./policy.ts";

/** Who makes it. from: who says so in the channel (the user, a session, an orchestrator). */
interface Maker {
  readonly from: string;
  readonly by: string;
}

export class Artifact extends Context.Service<
  Artifact,
  {
    readonly list: (q: T.ArtifactListRequest) => Effect.Effect<T.Artifact[]>;
    readonly get: (id: T.ArtifactId) => Effect.Effect<T.Artifact, ApiError>;
    /** An html one's version as made; a blocks one's Markdown now, its version its seq. */
    readonly content: (id: T.ArtifactId, version?: number) => Effect.Effect<T.ArtifactContent & { readonly body: T.ArtifactBody }, ApiError>;
    /** An html version's file on disk, for the route that serves it; undefined when there is none. */
    readonly file: (id: T.ArtifactId, version: number) => Effect.Effect<string | undefined>;
    /** Without content, an empty blocks one, not announced. With content, a hand-in: html kept whole, Markdown read into blocks, announced with its card. */
    readonly create: (maker: Maker, req: T.ArtifactRequest) => Effect.Effect<T.Artifact, ApiError>;
    /** An html one's next version; a blocks one is refused, it is changed block by block. */
    readonly version: (maker: Maker, req: T.ArtifactVersionRequest) => Effect.Effect<T.Artifact, ApiError>;
    /** The user's words in place of some in an html one's latest version (edit.ts), kept as its next version. */
    readonly htmlEdit: (maker: Maker, req: T.ArtifactHtmlEdit) => Effect.Effect<T.Artifact, ApiError>;
    readonly rename: (id: T.ArtifactId, title: string) => Effect.Effect<T.Artifact, ApiError>;
    readonly previewRemove: (id: T.ArtifactId) => Effect.Effect<T.Preview, ApiError>;
    /** It and its versions or blocks go; the versions' attachments stay. */
    readonly remove: (id: T.ArtifactId) => Effect.Effect<void, ApiError>;
    readonly blocks: (id: T.ArtifactId) => Effect.Effect<T.BlockSnapshot, ApiError>;
    readonly markdown: (id: T.ArtifactId) => Effect.Effect<string, ApiError>;
    /** A batch of ops from actor (the user, or a helper's profile id): blocks.ts. */
    readonly submit: (id: T.ArtifactId, actor: string, body: Pick<T.BlockSubmit, "batchId" | "ops">) => Effect.Effect<T.BlockAck, ApiError>;
    readonly insertBlock: (id: T.ArtifactId, actor: string, req: T.BlockCreate) => Effect.Effect<T.BlockOpResult, ApiError>;
    readonly updateBlock: (id: T.ArtifactId, actor: string, req: T.BlockUpdate) => Effect.Effect<T.BlockOpResult, ApiError>;
    readonly deleteBlock: (id: T.ArtifactId, actor: string, req: T.BlockDelete) => Effect.Effect<T.BlockOpResult, ApiError>;
    readonly previewDeleteBlock: (id: T.ArtifactId, req: T.BlockDelete) => Effect.Effect<T.Preview, ApiError>;
    /** Each batch after seq, then each from now on, for a page following an open blocks artifact. */
    readonly follow: (id: T.ArtifactId, after: number) => Stream.Stream<T.ArtifactEvent, ApiError>;
    readonly suggestions: (id: T.ArtifactId) => Effect.Effect<T.Suggestion[], ApiError>;
    readonly suggest: (id: T.ArtifactId, actor: string, req: T.SuggestionCreate) => Effect.Effect<T.Suggestion, ApiError>;
    readonly acceptSuggestion: (id: T.ArtifactId, suggestion: string, actor: string) => Effect.Effect<T.Suggestion, ApiError>;
    readonly rejectSuggestion: (id: T.ArtifactId, suggestion: string, actor: string) => Effect.Effect<T.Suggestion, ApiError>;
    readonly suggestionStream: (id: T.ArtifactId) => Stream.Stream<T.SuggestionEvent, ApiError>;
    /** Starts the demo and returns at once (blocks.ts). */
    readonly demo: (id: T.ArtifactId, helpers: readonly T.Agent[]) => Effect.Effect<void, ApiError>;
  }
>()("@vibevalley/server/artifact/artifact") {
  static readonly layer = Layer.effect(
    Artifact,
    Effect.suspend(() => make()),
  );
}

/** How many the farm-wide list shows. */
const listedMax = 200;

const missingArtifact = (id: T.ArtifactId) => missing(t("server.artifact.missing", { id }), [lookIn.artifact]);

const make = () =>
  Effect.gen(function* () {
    const chat = yield* Channel;
    const db = yield* Db;
    const kept = yield* Attachment;
    // One change of an artifact's row at a time: a version's number is the latest's plus one.
    const lock = yield* Semaphore.make(1);
    // A version's bytes are an attachment: kept once, whoever else keeps the same page.
    const keep = (bytes: Buffer, title: string) => Effect.map(kept.keep(bytes, `${title}.html`, "text/html"), (a) => a.id);

    const assemble = Effect.fnUntraced(function* (row: qa.ArtifactsResult) {
      const versions = row.body === "html" ? yield* db.run(qv.artifactVersions({ artifact_id: row.id })) : [];
      return {
        id: S.artifactId(row.id),
        title: row.title,
        body: row.body,
        ...(row.channel_id !== null ? { channel: row.channel_id } : {}),
        ...(row.said_channel !== null && row.said_number !== null ? { said: { channel: row.said_channel, number: row.said_number } } : {}),
        ...(row.issue !== null ? { issue: S.issueId(row.issue) } : {}),
        by: row.by_id,
        byName: row.by_name,
        version: row.version,
        seq: row.seq,
        versions: versions.map((v) => ({
          version: v.version,
          size: v.size,
          note: v.note ?? "",
          by: v.by_id,
          byName: v.by_name,
          at: v.created_at,
          channel: v.message_channel ?? row.channel_id ?? "",
          ...(v.message_number !== null ? { number: v.message_number } : {}),
        })),
        at: row.created_at,
        updated: row.updated_at,
      } satisfies T.Artifact;
    });

    const found = Effect.fnUntraced(function* (id: T.ArtifactId) {
      const row = yield* db.one(qa.artifact({ id }));
      if (!row) return yield* Effect.fail(missingArtifact(id));
      return row;
    });

    const foundBlocks = Effect.fnUntraced(function* (id: T.ArtifactId) {
      const row = yield* found(id);
      if (row.body !== "blocks") return yield* Effect.fail(refused(t("server.artifact.notBlocks", { title: row.title })));
      return row;
    });

    const blocks = yield* makeBlockStore(foundBlocks);

    const words = (base: string, note: string | undefined) => (note ? t("server.artifact.withNote", { said: base, note }) : base);

    /** An empty blocks one the user starts on the page: nowhere to announce, nothing to read in. */
    const start = Effect.fn("Artifact.start")(function* (maker: Maker, title: string) {
      const id = S.artifactId(newId());
      const now = yield* Clock.currentTimeMillis;
      const name = maker.by === userId ? t("server.channel.name.user") : maker.by;
      yield* db.run(qa.addArtifact({ id, title, body: "blocks", channel_id: null, issue: null, by_id: maker.by, by_name: name, version: 0, created_at: now }));
      const found2 = yield* found(id);
      return yield* assemble(found2);
    });

    const create = Effect.fn("Artifact.create")(function* (maker: Maker, req: T.ArtifactRequest) {
      const title = req.title.trim() || t("server.artifact.untitled");
      if (req.content === undefined) {
        const problem = artifactProblem({ title });
        if (problem) return yield* Effect.fail(refused(problem));
        return yield* start(maker, title);
      }
      const kind = req.kind ?? "markdown";
      const bytes = Buffer.from(req.content, "utf8");
      const problem = artifactProblem({ title: req.title, kind, size: bytes.length }) || (kind === "html" ? htmlProblem(htmlCheck(req.content)) : "");
      if (problem) return yield* Effect.fail(refused(problem));
      const body: T.ArtifactBody = kind === "html" ? "html" : "blocks";
      const channel = yield* chat.placeOf(maker.from, req.channel ?? "");
      const file = body === "html" ? yield* keep(bytes, title) : "";
      const id = S.artifactId(newId());
      const note = req.note?.trim() || undefined;
      const version = body === "html" ? 1 : 0;
      const card: T.ArtifactCard = { id, title, body, version, note: note ?? "" };
      // Said first: the name it goes by is the one the channel knows its maker by.
      const said = yield* chat.post({
        _tag: "Announce",
        from: maker.from,
        channel: channel,
        text: words(t("server.artifact.made", { title }), note),
        made: { card },
      });
      const now = yield* Clock.currentTimeMillis;
      yield* db.run(
        qa.addArtifact({ id, title, body, channel_id: said.channel, issue: req.issue ?? null, by_id: maker.by, by_name: said.name, version, created_at: now }),
      );
      yield* db.run(qa.artifactSaid({ id, message_id: said.id }));
      if (body === "html") {
        yield* db.run(
          qv.addArtifactVersion({
            artifact_id: id,
            version: 1,
            attachment_id: file,
            size: bytes.length,
            note: note ?? null,
            by_id: maker.by,
            by_name: said.name,
            created_at: now,
          }),
        );
        yield* db.run(qv.artifactVersionAnnounced({ artifact_id: id, version: 1, message_id: said.id }));
      } else yield* blocks.fill(id, req.content, maker.by);
      const found2 = yield* found(id);
      return yield* assemble(found2);
    });

    const version = Effect.fn("Artifact.version")(function* (maker: Maker, req: T.ArtifactVersionRequest) {
      const row = yield* found(req.id);
      if (row.body !== "html") return yield* Effect.fail(refused(t("server.artifact.notHtml", { title: row.title })));
      const bytes = Buffer.from(req.content, "utf8");
      const problem = artifactProblem({ size: bytes.length }) || htmlProblem(htmlCheck(req.content));
      if (problem) return yield* Effect.fail(refused(problem));
      const file = yield* keep(bytes, row.title);
      const next = row.version + 1;
      const note = req.note?.trim() || undefined;
      const card: T.ArtifactCard = { id: S.artifactId(row.id), title: row.title, body: "html", version: next, note: note ?? "" };
      // Announced where the first one was: its comments stay in one place.
      const said = yield* chat.post({
        _tag: "Announce",
        from: maker.from,
        channel: row.channel_id ?? "",
        text: words(t("server.artifact.versioned", { title: row.title, version: next }), note),
        made: {
          card,
        },
      });
      const now = yield* Clock.currentTimeMillis;
      yield* db.run(
        qv.addArtifactVersion({
          artifact_id: row.id,
          version: next,
          attachment_id: file,
          size: bytes.length,
          note: note ?? null,
          by_id: maker.by,
          by_name: said.name,
          created_at: now,
        }),
      );
      yield* db.run(qv.artifactVersionAnnounced({ artifact_id: row.id, version: next, message_id: said.id }));
      yield* db.run(qa.artifactVersioned({ id: row.id, version: next, updated_at: now }));
      const found2 = yield* found(S.artifactId(row.id));
      return yield* assemble(found2);
    });

    const versionOf = Effect.fnUntraced(function* (id: T.ArtifactId, version: number | undefined) {
      const row = yield* found(id);
      const n = version ?? row.version;
      const v = yield* db.one(qv.artifactVersion({ artifact_id: id, version: n }));
      if (!v) return yield* Effect.fail(missing(t("server.artifact.noVersion", { title: row.title, version: n, latest: row.version }), []));
      return { row, v };
    });

    const shape = Artifact.of({
      list: Effect.fn("Artifact.list")(function* (q) {
        const rows = q.issue
          ? yield* db.run(qa.artifactsForIssue({ issue: q.issue }))
          : q.channel
            ? yield* db.run(qa.artifactsInChannel({ channel_id: q.channel }))
            : yield* db.run(qa.artifacts({ limit_n: listedMax }));
        const out: T.Artifact[] = [];
        // Both given: the issue's, in that channel.
        yield* Effect.forEach(
          rows,
          (r) =>
            Effect.gen(function* () {
              if (!q.channel || r.channel_id === q.channel) {
                const artifact = yield* assemble(r);
                out.push(artifact);
              }
            }),
          { discard: true },
        );
        return out;
      }),
      get: Effect.fn("Artifact.get")(function* (id) {
        const found2 = yield* found(id);
        return yield* assemble(found2);
      }),
      content: Effect.fn("Artifact.content")(function* (id, version) {
        const row = yield* found(id);
        if (row.body === "blocks") return { version: row.seq, content: yield* blocks.markdown(id), body: "blocks" as const };
        const { v } = yield* versionOf(id, version);
        const content = yield* kept.bytes(v.attachment_id).pipe(
          Effect.mapBoth({
            onSuccess: (bytes) => new TextDecoder().decode(bytes),
            onFailure: () => missing(t("server.artifact.noFile", { title: row.title, version: v.version }), []),
          }),
        );
        return { version: v.version, content, body: "html" as const };
      }),
      file: Effect.fn("Artifact.file")(function* (id, version) {
        const row = yield* db.one(qa.artifact({ id }));
        const v = row?.body === "html" ? yield* db.one(qv.artifactVersion({ artifact_id: id, version })) : undefined;
        return v ? kept.pathOf(v.attachment_id) : undefined;
      }),
      create: Effect.fn("Artifact.create")(function* (maker, req) {
        return yield* create(maker, req);
      }, lock.withPermits(1)),
      version: Effect.fn("Artifact.version")(function* (maker, req) {
        return yield* version(maker, req);
      }, lock.withPermits(1)),
      htmlEdit: Effect.fn("Artifact.htmlEdit")(function* (maker, req) {
        const { row, v } = yield* versionOf(req.id, req.version);
        if (row.body !== "html") return yield* Effect.fail(refused(t("server.artifact.notHtml", { title: row.title })));
        // Over the latest only: a later version's changes would be lost under an edit of an older one.
        if (v.version !== row.version) return yield* Effect.fail(refused(t("server.artifact.edit.stale", { version: v.version, latest: row.version })));
        const source = yield* kept.bytes(v.attachment_id).pipe(
          Effect.mapBoth({
            onSuccess: (bytes) => new TextDecoder().decode(bytes),
            onFailure: () => missing(t("server.artifact.noFile", { title: row.title, version: v.version }), []),
          }),
        );
        const edited = htmlEdit(source, req.anchor, req.text);
        if (!edited.ok) return yield* Effect.fail(refused(edited.why));
        const note = t("server.artifact.edit.note", { old: head(req.anchor.exact.trim(), 40), new: head(req.text.trim(), 40) });
        return yield* version(maker, { id: req.id, content: edited.source, note });
      }, lock.withPermits(1)),
      rename: Effect.fn("Artifact.rename")(function* (id, title) {
        yield* found(id);
        const problem = artifactProblem({ title });
        if (problem) return yield* Effect.fail(refused(problem));
        yield* db.run(qa.artifactRenamed({ id, title: title.trim(), updated_at: yield* Clock.currentTimeMillis }));
        const found2 = yield* found(id);
        return yield* assemble(found2);
      }, lock.withPermits(1)),
      previewRemove: Effect.fn("Artifact.previewRemove")(function* (id) {
        const row = yield* found(id);
        const what =
          row.body === "html"
            ? t("server.artifact.preview.remove", { title: row.title, n: row.version })
            : t("server.artifact.preview.removeBlocks", { title: row.title, n: (yield* blocks.blocks(id)).length });
        return { does: row.channel_id !== null ? [what, t("server.artifact.preview.cards")] : [what] };
      }),
      remove: Effect.fn("Artifact.remove")(function* (id) {
        yield* found(id);
        // Its versions' attachments stay: the same bytes may be a message's file or a library item.
        yield* db.run(qa.deleteArtifact({ id }));
      }, lock.withPermits(1)),
      blocks: Effect.fn("Artifact.blocks")(function* (id) {
        const list = yield* blocks.blocks(id);
        const row = yield* found(id);
        const artifact = yield* assemble(row);
        return { artifact, blocks: list };
      }),
      markdown: blocks.markdown,
      submit: blocks.submit,
      insertBlock: blocks.insertBlock,
      updateBlock: blocks.updateBlock,
      deleteBlock: blocks.deleteBlock,
      previewDeleteBlock: blocks.previewDeleteBlock,
      follow: blocks.follow,
      suggestions: blocks.suggestions,
      suggest: blocks.suggest,
      acceptSuggestion: blocks.acceptSuggestion,
      rejectSuggestion: blocks.rejectSuggestion,
      suggestionStream: blocks.suggestionStream,
      demo: blocks.demo,
    });
    return shape;
  });
