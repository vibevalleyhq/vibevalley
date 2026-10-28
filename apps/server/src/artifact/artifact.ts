import { t } from "@vibevalley/i18n";
// Artifacts (docs/subsystems/artifact.md): pages an agent or the owner made, each version kept once by its sha256 under the
// home directory's artifacts/, and announced where it belongs by its maker, with its card. Their comments are the replies
// to those messages: nothing of their own.

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Artifact,
  ArtifactCard,
  ArtifactContent,
  ArtifactKind,
  ArtifactListRequest,
  ArtifactRequest,
  ArtifactVersionRequest,
  Preview,
} from "@vibevalley/protocol";
import { Clock, Context, Effect, Layer, Semaphore } from "effect";
import { Settings } from "../base/config.ts";
import { Db } from "../base/db.ts";
import { newId } from "../base/ids.ts";
import { Channels } from "../channel/chat.ts";
import { type ApiError, lookIn, missing, refused } from "../errors.ts";
import * as qa from "../../db/generated/artifact.sql.ts";
import * as qv from "../../db/generated/artifact_version.sql.ts";
import { artifactProblem } from "./rules.ts";

/** Who makes it. from: who says so in the channel (the owner, a session, an orchestrator); by: who it is kept as made by
 * (the owner, or the profile the session works as). */
export interface Maker {
  readonly from: string;
  readonly by: string;
}

export interface ArtifactShape {
  readonly list: (q: ArtifactListRequest) => Effect.Effect<Artifact[]>;
  readonly get: (id: string) => Effect.Effect<Artifact, ApiError>;
  readonly content: (id: string, version?: number) => Effect.Effect<ArtifactContent & { readonly kind: ArtifactKind }, ApiError>;
  /** A version's file on disk, for the route that serves it; undefined when there is none. */
  readonly file: (id: string, version: number) => Effect.Effect<{ readonly path: string; readonly kind: ArtifactKind } | undefined>;
  /** issue is the issue it is for, if any: the caller's to give (a helper's own issue), never looked up here. */
  readonly create: (maker: Maker, req: ArtifactRequest) => Effect.Effect<Artifact, ApiError>;
  readonly version: (maker: Maker, req: ArtifactVersionRequest) => Effect.Effect<Artifact, ApiError>;
  readonly previewRemove: (id: string) => Effect.Effect<Preview, ApiError>;
  /** It and its versions go; a content file goes when no other version keeps it. Its cards stay in the channel. */
  readonly remove: (id: string) => Effect.Effect<void, ApiError>;
}

export class Artifacts extends Context.Service<Artifacts, ArtifactShape>()("vibevalley/Artifact") {}

/** How many the farm-wide list shows. */
const listedMax = 200;

const missingArtifact = (id: string) => missing(t("server.artifact.missing", { id }), [lookIn.artifact]);

export const make = Effect.gen(function* () {
  const config = yield* Settings;
  const chat = yield* Channels;
  const { run: db, one } = yield* Db;
  // One change at a time: a version's number is the latest's plus one.
  const lock = yield* Semaphore.make(1);
  const dir = join(config.home, "artifacts");
  const fileOf = (sha: string) => join(dir, sha);

  const keep = (bytes: Buffer) =>
    Effect.tryPromise({
      try: async () => {
        const sha = createHash("sha256").update(bytes).digest("hex");
        await mkdir(dir, { recursive: true });
        // The same bytes are the same file: a second one leaves the first.
        await writeFile(fileOf(sha), bytes, { flag: "wx" }).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== "EEXIST") throw e;
        });
        return sha;
      },
      catch: (e) => refused(t("server.artifact.notKept", { why: String(e) })),
    });

  const assemble = Effect.fnUntraced(function* (row: qa.ArtifactResult) {
    const versions = yield* db(qv.artifactVersions({ artifact_id: row.id }));
    return {
      id: row.id,
      title: row.title,
      kind: row.kind as ArtifactKind,
      channel: row.channel_id,
      ...(row.issue !== null ? { issue: row.issue } : {}),
      by: row.by_id,
      byName: row.by_name,
      version: row.version,
      versions: versions.map((v) => ({
        version: v.version,
        size: v.size,
        ...(v.note !== null ? { note: v.note } : {}),
        by: v.by_id,
        byName: v.by_name,
        at: v.created_at,
        channel: v.message_channel ?? row.channel_id,
        ...(v.message_number !== null ? { number: v.message_number } : {}),
      })),
      at: row.created_at,
      updated: row.updated_at,
    } satisfies Artifact;
  });

  const found = Effect.fnUntraced(function* (id: string) {
    const row = yield* one(qa.artifact({ id }));
    if (!row) return yield* Effect.fail(missingArtifact(id));
    return row;
  });

  const words = (base: string, note: string | undefined) => (note ? t("server.artifact.withNote", { said: base, note }) : base);

  const create = Effect.fn("Artifacts.create")(function* (maker: Maker, req: ArtifactRequest) {
    const bytes = Buffer.from(req.content, "utf8");
    const problem = artifactProblem({ title: req.title, kind: req.kind, size: bytes.length });
    if (problem) return yield* Effect.fail(refused(problem));
    const channel = yield* chat.placeOf(maker.from, req.channel ?? "");
    const sha = yield* keep(bytes);
    const id = newId();
    const title = req.title.trim();
    const note = req.note?.trim() || undefined;
    const card: ArtifactCard = { id, title, kind: req.kind, version: 1, ...(note ? { note } : {}) };
    // Said first: the name it goes by is the one the channel knows its maker by.
    const said = yield* chat.announce(maker.from, channel, words(t("server.artifact.made", { title }), note), card);
    const now = yield* Clock.currentTimeMillis;
    yield* db(
      qa.addArtifact({
        id,
        title,
        kind: req.kind,
        channel_id: said.channel,
        issue: req.issue ?? null,
        by_id: maker.by,
        by_name: said.name,
        created_at: now,
      }),
    );
    yield* db(
      qv.addArtifactVersion({ artifact_id: id, version: 1, sha, size: bytes.length, note: note ?? null, by_id: maker.by, by_name: said.name, created_at: now }),
    );
    yield* db(qv.artifactVersionAnnounced({ artifact_id: id, version: 1, message_id: said.id }));
    return yield* assemble(yield* found(id));
  });

  const version = Effect.fn("Artifacts.version")(function* (maker: Maker, req: ArtifactVersionRequest) {
    const row = yield* found(req.id);
    const bytes = Buffer.from(req.content, "utf8");
    const problem = artifactProblem({ size: bytes.length });
    if (problem) return yield* Effect.fail(refused(problem));
    const sha = yield* keep(bytes);
    const next = row.version + 1;
    const note = req.note?.trim() || undefined;
    const card: ArtifactCard = { id: row.id, title: row.title, kind: row.kind as ArtifactKind, version: next, ...(note ? { note } : {}) };
    // Announced where the first one was: its comments stay in one place.
    const said = yield* chat.announce(maker.from, row.channel_id, words(t("server.artifact.versioned", { title: row.title, version: next }), note), card);
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

  const shape: ArtifactShape = {
    list: (q) =>
      Effect.gen(function* () {
        const rows = q.issue
          ? yield* db(qa.artifactsForIssue({ issue: q.issue }))
          : q.channel
            ? yield* db(qa.artifactsInChannel({ channel_id: q.channel }))
            : yield* db(qa.artifacts({ limit_n: BigInt(listedMax) }));
        const out: Artifact[] = [];
        // Both given: the issue's, in that channel.
        for (const r of rows) if (!q.channel || r.channel_id === q.channel) out.push(yield* assemble(r));
        return out;
      }),
    get: (id) => Effect.flatMap(found(id), assemble),
    content: (id, version) =>
      Effect.gen(function* () {
        const { row, v } = yield* versionOf(id, version);
        const content = yield* Effect.tryPromise({
          try: () => readFile(fileOf(v.sha), "utf8"),
          catch: () => missing(t("server.artifact.noFile", { title: row.title, version: v.version }), []),
        });
        return { version: v.version, content, kind: row.kind as ArtifactKind };
      }),
    file: (id, version) =>
      Effect.gen(function* () {
        const row = yield* one(qa.artifact({ id }));
        const v = row ? yield* one(qv.artifactVersion({ artifact_id: id, version })) : undefined;
        return row && v ? { path: fileOf(v.sha), kind: row.kind as ArtifactKind } : undefined;
      }),
    create: (maker, req) => lock.withPermits(1)(create(maker, req)),
    version: (maker, req) => lock.withPermits(1)(version(maker, req)),
    previewRemove: (id) =>
      Effect.map(found(id), (row) => ({
        does: [t("server.artifact.preview.remove", { title: row.title, n: row.version }), t("server.artifact.preview.cards")],
      })),
    remove: (id) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          yield* found(id);
          const versions = yield* db(qv.artifactVersions({ artifact_id: id }));
          yield* db(qa.deleteArtifact({ id }));
          for (const sha of new Set(versions.map((v) => v.sha))) {
            const users = yield* one(qv.artifactShaUsers({ sha }));
            if ((users?.n ?? 0) === 0) yield* Effect.promise(() => rm(fileOf(sha), { force: true }));
          }
        }),
      ),
  };
  return shape;
});

export const layer = Layer.effect(Artifacts, make);
