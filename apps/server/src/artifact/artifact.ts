// Artifact (docs/subsystems/artifact.md): what the owner and the agents leave for people to read. A blocks one is written
// together, block by block (blocks.ts); an html one is handed in whole, each version kept once by its sha256 under the
// home directory's artifacts/. A hand-in is announced where it belongs by its maker, with its card; its comments are the
// replies to that message, nothing of their own.

import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { Clock, Context, Effect, FileSystem, Layer, Semaphore } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { ownerId } from "@vibevalley/protocol";

import { newId } from "@/base/ids.ts";
import { Channel } from "@/channel/chat.ts";
import { type ApiError, lookIn, missing, refused } from "@/errors.ts";
import { ServerConfig } from "@/infra/config.ts";
import { Db } from "@/infra/db.ts";
import { writeOnce } from "@/infra/files.ts";

import * as qa from "../../db/generated/artifact.sql.ts";
import * as qv from "../../db/generated/artifact_version.sql.ts";
import { type BlockStoreOptions, makeBlockStore } from "./blocks.ts";
import { artifactProblem } from "./policy.ts";

/** Who makes it. from: who says so in the channel (the owner, a session, an orchestrator); by: who it is kept as made by
 * (the owner, or the profile the session works as), and who writes its blocks. */
export interface Maker {
  readonly from: string;
  readonly by: string;
}

export class Artifact extends Context.Service<
  Artifact,
  {
    readonly list: (q: T.ArtifactListRequest) => Effect.Effect<T.Artifact[]>;
    readonly get: (id: string) => Effect.Effect<T.Artifact, ApiError>;
    /** An html one's version as made; a blocks one's Markdown now, its version its seq. */
    readonly content: (id: string, version?: number) => Effect.Effect<T.ArtifactContent & { readonly body: T.ArtifactBody }, ApiError>;
    /** An html version's file on disk, for the route that serves it; undefined when there is none. */
    readonly file: (id: string, version: number) => Effect.Effect<string | undefined>;
    /** Without content, an empty blocks one, not announced. With content, a hand-in: html kept whole, Markdown read into
     * blocks, announced with its card. issue is the caller's to give (a helper's own issue), never looked up here. */
    readonly create: (maker: Maker, req: T.ArtifactRequest) => Effect.Effect<T.Artifact, ApiError>;
    /** An html one's next version; a blocks one is refused, it is changed block by block. */
    readonly version: (maker: Maker, req: T.ArtifactVersionRequest) => Effect.Effect<T.Artifact, ApiError>;
    readonly rename: (id: string, title: string) => Effect.Effect<T.Artifact, ApiError>;
    readonly previewRemove: (id: string) => Effect.Effect<T.Preview, ApiError>;
    /** It and its versions or blocks go; a content file goes when no other version keeps it. Its cards stay in the channel. */
    readonly remove: (id: string) => Effect.Effect<void, ApiError>;
    readonly blocks: (id: string) => Effect.Effect<T.BlockSnapshot, ApiError>;
    readonly markdown: (id: string) => Effect.Effect<string, ApiError>;
    /** A batch of ops from actor (the owner, or a helper's profile id): blocks.ts. */
    readonly submit: (id: string, actor: string, body: Pick<T.BlockSubmit, "batchId" | "ops">) => Effect.Effect<T.BlockAck, ApiError>;
    readonly appendBlock: (id: string, actor: string, req: T.BlockCreate) => Effect.Effect<T.BlockOpResult, ApiError>;
    readonly updateBlock: (id: string, actor: string, req: T.BlockUpdate) => Effect.Effect<T.BlockOpResult, ApiError>;
    /** Starts the demo and returns at once (blocks.ts). */
    readonly demo: (id: string, helpers: readonly T.Agent[]) => Effect.Effect<void, ApiError>;
  }
>()("vibevalley/Artifact") {
  static readonly layer = (options?: ArtifactOptions) => Layer.effect(Artifact, make(options));
}

export type ArtifactOptions = BlockStoreOptions;

/** How many the farm-wide list shows. */
const listedMax = 200;

const missingArtifact = (id: string) => missing(t("server.artifact.missing", { id }), [lookIn.artifact]);

const make = (options: ArtifactOptions = {}) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const chat = yield* Channel;
    const { run: db, one } = yield* Db;
    const fs = yield* FileSystem.FileSystem;
    // One change of an artifact's row at a time: a version's number is the latest's plus one.
    const lock = yield* Semaphore.make(1);
    const dir = join(config.home, "artifacts");
    const fileOf = (sha: string) => join(dir, sha);

    const keep = (bytes: Buffer) => {
      const sha = createHash("sha256").update(bytes).digest("hex");
      return writeOnce(fileOf(sha), bytes).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.as(sha),
        Effect.mapError((e) => refused(t("server.artifact.notKept", { why: String(e.cause) }))),
      );
    };

    const assemble = Effect.fnUntraced(function* (row: qa.ArtifactsResult) {
      const versions = row.body === "html" ? yield* db(qv.artifactVersions({ artifact_id: row.id })) : [];
      return {
        id: row.id,
        title: row.title,
        body: row.body,
        ...(row.channel_id !== null ? { channel: row.channel_id } : {}),
        ...(row.said_channel !== null && row.said_number !== null ? { said: { channel: row.said_channel, number: row.said_number } } : {}),
        ...(row.issue !== null ? { issue: row.issue } : {}),
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

    const found = Effect.fnUntraced(function* (id: string) {
      const row = yield* one(qa.artifact({ id }));
      if (!row) return yield* Effect.fail(missingArtifact(id));
      return row;
    });

    const foundBlocks = Effect.fnUntraced(function* (id: string) {
      const row = yield* found(id);
      if (row.body !== "blocks") return yield* Effect.fail(refused(t("server.artifact.notBlocks", { title: row.title })));
      return row;
    });

    const blocks = yield* makeBlockStore(foundBlocks, options);

    const words = (base: string, note: string | undefined) => (note ? t("server.artifact.withNote", { said: base, note }) : base);

    /** An empty blocks one the owner starts on the page: nowhere to announce, nothing to read in. */
    const start = Effect.fn("Artifact.start")(function* (maker: Maker, title: string) {
      const id = newId();
      const now = yield* Clock.currentTimeMillis;
      const name = maker.by === ownerId ? t("server.channel.name.owner") : maker.by;
      yield* db(qa.addArtifact({ id, title, body: "blocks", channel_id: null, issue: null, by_id: maker.by, by_name: name, version: 0, created_at: now }));
      return yield* assemble(yield* found(id));
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
      const problem = artifactProblem({ title: req.title, kind, size: bytes.length });
      if (problem) return yield* Effect.fail(refused(problem));
      const body: T.ArtifactBody = kind === "html" ? "html" : "blocks";
      const channel = yield* chat.placeOf(maker.from, req.channel ?? "");
      const sha = body === "html" ? yield* keep(bytes) : "";
      const id = newId();
      const note = req.note?.trim() || undefined;
      const version = body === "html" ? 1 : 0;
      const card: T.ArtifactCard = { id, title, body, version, note: note ?? "" };
      // Said first: the name it goes by is the one the channel knows its maker by.
      const said = yield* chat.announce(maker.from, channel, words(t("server.artifact.made", { title }), note), card);
      const now = yield* Clock.currentTimeMillis;
      yield* db(
        qa.addArtifact({ id, title, body, channel_id: said.channel, issue: req.issue ?? null, by_id: maker.by, by_name: said.name, version, created_at: now }),
      );
      yield* db(qa.artifactSaid({ id, message_id: said.id }));
      if (body === "html") {
        yield* db(
          qv.addArtifactVersion({
            artifact_id: id,
            version: 1,
            sha,
            size: bytes.length,
            note: note ?? null,
            by_id: maker.by,
            by_name: said.name,
            created_at: now,
          }),
        );
        yield* db(qv.artifactVersionAnnounced({ artifact_id: id, version: 1, message_id: said.id }));
      } else yield* blocks.fill(id, req.content, maker.by);
      return yield* assemble(yield* found(id));
    });

    const version = Effect.fn("Artifact.version")(function* (maker: Maker, req: T.ArtifactVersionRequest) {
      const row = yield* found(req.id);
      if (row.body !== "html") return yield* Effect.fail(refused(t("server.artifact.notHtml", { title: row.title })));
      const bytes = Buffer.from(req.content, "utf8");
      const problem = artifactProblem({ size: bytes.length });
      if (problem) return yield* Effect.fail(refused(problem));
      const sha = yield* keep(bytes);
      const next = row.version + 1;
      const note = req.note?.trim() || undefined;
      const card: T.ArtifactCard = { id: row.id, title: row.title, body: "html", version: next, note: note ?? "" };
      // Announced where the first one was: its comments stay in one place.
      const said = yield* chat.announce(
        maker.from,
        row.channel_id ?? "",
        words(t("server.artifact.versioned", { title: row.title, version: next }), note),
        card,
      );
      const now = yield* Clock.currentTimeMillis;
      yield* db(
        qv.addArtifactVersion({
          artifact_id: row.id,
          version: next,
          sha,
          size: bytes.length,
          note: note ?? null,
          by_id: maker.by,
          by_name: said.name,
          created_at: now,
        }),
      );
      yield* db(qv.artifactVersionAnnounced({ artifact_id: row.id, version: next, message_id: said.id }));
      yield* db(qa.artifactVersioned({ id: row.id, version: next, updated_at: now }));
      return yield* assemble(yield* found(row.id));
    });

    const versionOf = Effect.fnUntraced(function* (id: string, version: number | undefined) {
      const row = yield* found(id);
      const n = version ?? row.version;
      const v = yield* one(qv.artifactVersion({ artifact_id: id, version: n }));
      if (!v) return yield* Effect.fail(missing(t("server.artifact.noVersion", { title: row.title, version: n, latest: row.version }), []));
      return { row, v };
    });

    const shape = Artifact.of({
      list: Effect.fn("Artifact.list")(function* (q) {
        const rows = q.issue
          ? yield* db(qa.artifactsForIssue({ issue: q.issue }))
          : q.channel
            ? yield* db(qa.artifactsInChannel({ channel_id: q.channel }))
            : yield* db(qa.artifacts({ limit_n: BigInt(listedMax) }));
        const out: T.Artifact[] = [];
        // Both given: the issue's, in that channel.
        for (const r of rows) if (!q.channel || r.channel_id === q.channel) out.push(yield* assemble(r));
        return out;
      }),
      get: Effect.fn("Artifact.get")(function* (id) {
        return yield* assemble(yield* found(id));
      }),
      content: Effect.fn("Artifact.content")(function* (id, version) {
        const row = yield* found(id);
        if (row.body === "blocks") return { version: row.seq, content: yield* blocks.markdown(id), body: "blocks" as const };
        const { v } = yield* versionOf(id, version);
        const content = yield* Effect.tryPromise({
          try: () => readFile(fileOf(v.sha), "utf8"),
          catch: () => missing(t("server.artifact.noFile", { title: row.title, version: v.version }), []),
        });
        return { version: v.version, content, body: "html" as const };
      }),
      file: Effect.fn("Artifact.file")(function* (id, version) {
        const row = yield* one(qa.artifact({ id }));
        const v = row?.body === "html" ? yield* one(qv.artifactVersion({ artifact_id: id, version })) : undefined;
        return v ? fileOf(v.sha) : undefined;
      }),
      create: Effect.fn("Artifact.create")(function* (maker, req) {
        return yield* create(maker, req);
      }, lock.withPermits(1)),
      version: Effect.fn("Artifact.version")(function* (maker, req) {
        return yield* version(maker, req);
      }, lock.withPermits(1)),
      rename: Effect.fn("Artifact.rename")(function* (id, title) {
        yield* found(id);
        const problem = artifactProblem({ title });
        if (problem) return yield* Effect.fail(refused(problem));
        yield* db(qa.artifactRenamed({ id, title: title.trim(), updated_at: yield* Clock.currentTimeMillis }));
        return yield* assemble(yield* found(id));
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
        const versions = yield* db(qv.artifactVersions({ artifact_id: id }));
        yield* db(qa.deleteArtifact({ id }));
        for (const sha of new Set(versions.map((v) => v.sha))) {
          const users = yield* one(qv.artifactShaUsers({ sha }));
          if ((users?.n ?? 0) === 0) yield* Effect.promise(() => rm(fileOf(sha), { force: true }));
        }
      }, lock.withPermits(1)),
      blocks: Effect.fn("Artifact.blocks")(function* (id) {
        const list = yield* blocks.blocks(id);
        return { artifact: yield* assemble(yield* found(id)), blocks: list };
      }),
      markdown: blocks.markdown,
      submit: blocks.submit,
      appendBlock: blocks.appendBlock,
      updateBlock: blocks.updateBlock,
      demo: blocks.demo,
    });
    return shape;
  });
