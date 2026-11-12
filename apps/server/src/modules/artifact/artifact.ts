import { Semaphore } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { ArtifactDisplayValues, userId } from "@vibevalley/protocol";
import { isOneOf } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";

import { head } from "#/base/clip.ts";
import { BizCode, lookIn, missing, refuseIn } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import type { Db } from "#/infra/db.ts";
import type { Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Channel } from "#/modules/channel/channel.ts";
import type { Attachment } from "#/platform/attachment/attachment.ts";
import * as qa from "#db/artifact.sql.ts";
import * as qv from "#db/artifact_version.sql.ts";

import { makeBlockStore } from "./blocks.ts";
import { htmlCheck, htmlProblem } from "./check.ts";
import { htmlEdit } from "./edit.ts";
import { artifactProblem } from "./policy.ts";

const refused = refuseIn(BizCode.ArtifactRefused);

/** Who makes it. from: who says so in the channel (the user, a session, an orchestrator). */
interface Maker {
  readonly from: string;
  readonly by: string;
  /** The run it is made in, if a session's or an orchestrator's. */
  readonly run?: string;
}

export interface Artifact {
  readonly list: (q: T.ArtifactListRequest) => Promise<T.Artifact[]>;
  readonly get: (id: T.ArtifactId) => Promise<T.Artifact>;
  /** An html one's version as made; a blocks one's Markdown now, its version its seq. */
  readonly content: (id: T.ArtifactId, version?: number) => Promise<T.ArtifactContent & { readonly body: T.ArtifactBody }>;
  /** An html version's file on disk, for the route that serves it; undefined when there is none. */
  readonly file: (id: T.ArtifactId, version: number) => Promise<string | undefined>;
  /** Without content, an empty blocks one, not announced. With content, a hand-in: html kept whole, Markdown read into blocks, announced with its card. */
  readonly create: (maker: Maker, req: T.ArtifactRequest) => Promise<T.Artifact>;
  /** An html one's next version; a blocks one is refused, it is changed block by block. */
  readonly version: (maker: Maker, req: T.ArtifactVersionRequest) => Promise<T.Artifact>;
  /** The user's words in place of some in an html one's latest version (edit.ts), kept as its next version. */
  readonly htmlEdit: (maker: Maker, req: T.ArtifactHtmlEdit) => Promise<T.Artifact>;
  /** Its title, or how an html one is shown. */
  readonly update: (req: T.ArtifactUpdateRequest) => Promise<T.Artifact>;
  readonly previewRemove: (id: T.ArtifactId) => Promise<T.Preview>;
  /** It and its versions or blocks go; the versions' attachments stay. */
  readonly remove: (id: T.ArtifactId) => Promise<void>;
  readonly blocks: (id: T.ArtifactId) => Promise<T.BlockSnapshot>;
  readonly markdown: (id: T.ArtifactId) => Promise<string>;
  /** A batch of ops from actor (the user, or a helper's profile id): blocks.ts. */
  readonly submit: (id: T.ArtifactId, actor: string, body: Pick<T.BlockSubmit, "batchId" | "ops">) => Promise<T.BlockAck>;
  readonly insertBlock: (id: T.ArtifactId, actor: string, req: T.BlockCreate) => Promise<T.BlockOpResult>;
  readonly updateBlock: (id: T.ArtifactId, actor: string, req: T.BlockUpdate) => Promise<T.BlockOpResult>;
  readonly deleteBlock: (id: T.ArtifactId, actor: string, req: T.BlockDelete) => Promise<T.BlockOpResult>;
  readonly previewDeleteBlock: (id: T.ArtifactId, req: T.BlockDelete) => Promise<T.Preview>;
  /** Each batch after seq, then each from now on, for a page following an open blocks artifact. */
  readonly follow: (id: T.ArtifactId, after: number, signal?: AbortSignal) => AsyncIterable<T.ArtifactEvent>;
  readonly suggestions: (id: T.ArtifactId) => Promise<T.Suggestion[]>;
  readonly suggest: (id: T.ArtifactId, actor: string, req: T.SuggestionCreate) => Promise<T.Suggestion>;
  readonly acceptSuggestion: (id: T.ArtifactId, suggestion: string, actor: string) => Promise<T.Suggestion>;
  readonly rejectSuggestion: (id: T.ArtifactId, suggestion: string, actor: string) => Promise<T.Suggestion>;
  readonly suggestionStream: (id: T.ArtifactId, signal?: AbortSignal) => AsyncIterable<T.SuggestionEvent>;
  /** Starts the demo and returns at once (blocks.ts). */
  readonly demo: (id: T.ArtifactId, helpers: readonly T.Agent[]) => Promise<void>;
  /** Stops the demo and the daily prune of old batches. */
  readonly close: () => Promise<void>;
}

/** How many the farm-wide list shows. */
const listedMax = 200;

const missingArtifact = (id: T.ArtifactId) => missing(t("server.artifact.missing", { id }), [lookIn.artifact]);

export interface ArtifactDeps {
  readonly db: Db;
  readonly clock: Time;
  readonly log: Logger;
  readonly attachment: Attachment;
  readonly channel: Channel;
}

export async function makeArtifact(deps: ArtifactDeps): Promise<Artifact> {
  const { db, clock, attachment: kept, channel: chat } = deps;
  const log = deps.log.child("artifact");
  // One change of an artifact's row at a time: a version's number is the latest's plus one.
  const lock = new Semaphore(1);
  const locked =
    <A extends unknown[], R>(f: (...a: A) => Promise<R>) =>
    (...a: A) =>
      lock.with(() => f(...a));
  // A version's bytes are an attachment: kept once, whoever else keeps the same page.
  const keep = async (bytes: Buffer, title: string) => (await kept.keep(bytes, `${title}.html`, "text/html")).id;

  const assemble = async (row: qa.ArtifactsResult): Promise<T.Artifact> => {
    const versions = row.body === "html" ? await qv.artifactVersions(db.sql, { artifact_id: row.id }) : [];
    return {
      id: S.artifactId(row.id),
      title: row.title,
      body: row.body,
      ...(row.display !== null && isOneOf(ArtifactDisplayValues, row.display) ? { display: row.display } : {}),
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
    };
  };

  const found = async (id: T.ArtifactId) => {
    const row = await qa.artifact(db.sql, { id });
    if (!row) throw missingArtifact(id);
    return row;
  };

  const foundBlocks = async (id: T.ArtifactId) => {
    const row = await found(id);
    if (row.body !== "blocks") throw refused(t("server.artifact.notBlocks", { title: row.title }));
    return row;
  };

  const blocks = await makeBlockStore({ db, clock, log }, foundBlocks);

  const words = (base: string, note: string | undefined) => (note ? t("server.artifact.withNote", { said: base, note }) : base);

  /** An empty blocks one the user starts on the page: nowhere to announce, nothing to read in. */
  const start = async (maker: Maker, title: string) => {
    const id = S.artifactId(newId());
    const name = maker.by === userId ? t("server.channel.name.user") : maker.by;
    await qa.addArtifact(db.sql, {
      id,
      title,
      body: "blocks",
      display: null,
      channel_id: null,
      issue: null,
      by_id: maker.by,
      by_name: name,
      version: 0,
      created_at: clock.now(),
    });
    return assemble(await found(id));
  };

  const create = async (maker: Maker, req: T.ArtifactRequest) => {
    const title = req.title.trim() || t("server.artifact.untitled");
    if (req.content === undefined) {
      const problem = artifactProblem({ title });
      if (problem) throw refused(problem);
      return start(maker, title);
    }
    const kind = req.kind ?? "markdown";
    const bytes = Buffer.from(req.content, "utf8");
    const problem = artifactProblem({ title: req.title, kind, size: bytes.length }) || (kind === "html" ? htmlProblem(htmlCheck(req.content)) : "");
    if (problem) throw refused(problem);
    const body: T.ArtifactBody = kind === "html" ? "html" : "blocks";
    if (body === "blocks" && req.display !== undefined) throw refused(t("server.artifact.displayHtmlOnly"));
    const display = body === "html" ? (req.display ?? "page") : null;
    const channel = await chat.placeOf(maker.from, req.channel ?? "");
    const file = body === "html" ? await keep(bytes, title) : "";
    const id = S.artifactId(newId());
    const note = req.note?.trim() || undefined;
    const version = body === "html" ? 1 : 0;
    const card: T.ArtifactCard = { id, title, body, version, note: note ?? "", ...(display === null ? {} : { display }) };
    // Said first: the name it goes by is the one the channel knows its maker by.
    const { message: said } = await chat.post({
      from: maker.from,
      channel: channel,
      text: words(t("server.artifact.made", { title }), note),
      made: { card },
      ...(maker.run ? { run: maker.run } : {}),
    });
    const now = clock.now();
    await qa.addArtifact(db.sql, {
      id,
      title,
      body,
      display,
      channel_id: said.channel,
      issue: req.issue ?? null,
      by_id: maker.by,
      by_name: said.name,
      version,
      created_at: now,
    });
    await qa.artifactSaid(db.sql, { id, message_id: said.id });
    if (body === "html") {
      await qv.addArtifactVersion(db.sql, {
        artifact_id: id,
        version: 1,
        attachment_id: file,
        size: bytes.length,
        note: note ?? null,
        by_id: maker.by,
        by_name: said.name,
        created_at: now,
      });
      await qv.artifactVersionAnnounced(db.sql, { artifact_id: id, version: 1, message_id: said.id });
    } else await blocks.fill(id, req.content, maker.by);
    return assemble(await found(id));
  };

  const version = async (maker: Maker, req: T.ArtifactVersionRequest) => {
    const row = await found(req.id);
    if (row.body !== "html") throw refused(t("server.artifact.notHtml", { title: row.title }));
    const bytes = Buffer.from(req.content, "utf8");
    const problem = artifactProblem({ size: bytes.length }) || htmlProblem(htmlCheck(req.content));
    if (problem) throw refused(problem);
    const file = await keep(bytes, row.title);
    const next = row.version + 1;
    const note = req.note?.trim() || undefined;
    const shown = row.display !== null && isOneOf(ArtifactDisplayValues, row.display) ? { display: row.display } : {};
    const card: T.ArtifactCard = { id: S.artifactId(row.id), title: row.title, body: "html", version: next, note: note ?? "", ...shown };
    // Announced where the first one was: its comments stay in one place.
    const { message: said } = await chat.post({
      from: maker.from,
      channel: row.channel_id ?? "",
      text: words(t("server.artifact.versioned", { title: row.title, version: next }), note),
      made: { card },
      ...(maker.run ? { run: maker.run } : {}),
    });
    const now = clock.now();
    await qv.addArtifactVersion(db.sql, {
      artifact_id: row.id,
      version: next,
      attachment_id: file,
      size: bytes.length,
      note: note ?? null,
      by_id: maker.by,
      by_name: said.name,
      created_at: now,
    });
    await qv.artifactVersionAnnounced(db.sql, { artifact_id: row.id, version: next, message_id: said.id });
    await qa.artifactVersioned(db.sql, { id: row.id, version: next, updated_at: now });
    return assemble(await found(S.artifactId(row.id)));
  };

  const versionOf = async (id: T.ArtifactId, version: number | undefined) => {
    const row = await found(id);
    const n = version ?? row.version;
    const v = await qv.artifactVersion(db.sql, { artifact_id: id, version: n });
    if (!v) throw missing(t("server.artifact.noVersion", { title: row.title, version: n, latest: row.version }), [], BizCode.ArtifactNotFound);
    return { row, v };
  };

  /** A version's page as text; a file gone from disk is a version that cannot be read, said as missing. */
  const pageOf = async (row: qa.ArtifactResult, v: { readonly attachment_id: string; readonly version: number }) => {
    let bytes: Uint8Array;
    try {
      bytes = await kept.bytes(v.attachment_id);
    } catch (e) {
      log.warn(`artifact ${row.id} version ${v.version}: its page could not be read`, e);
      throw missing(t("server.artifact.noFile", { title: row.title, version: v.version }), [], BizCode.ArtifactNotFound);
    }
    return new TextDecoder().decode(bytes);
  };

  return {
    list: async (q) => {
      const rows = q.issue
        ? await qa.artifactsForIssue(db.sql, { issue: q.issue })
        : q.channel
          ? await qa.artifactsInChannel(db.sql, { channel_id: q.channel })
          : await qa.artifacts(db.sql, { limit_n: listedMax });
      const out: T.Artifact[] = [];
      // Both given: the issue's, in that channel.
      for (const r of rows) if (!q.channel || r.channel_id === q.channel) out.push(await assemble(r));
      return out;
    },
    get: async (id) => assemble(await found(id)),
    content: async (id, version) => {
      const row = await found(id);
      if (row.body === "blocks") return { version: row.seq, content: await blocks.markdown(id), body: "blocks" as const };
      const { v } = await versionOf(id, version);
      return { version: v.version, content: await pageOf(row, v), body: "html" as const };
    },
    file: async (id, version) => {
      const row = await qa.artifact(db.sql, { id });
      const v = row?.body === "html" ? await qv.artifactVersion(db.sql, { artifact_id: id, version }) : undefined;
      return v ? kept.pathOf(v.attachment_id) : undefined;
    },
    create: locked(create),
    version: locked(version),
    htmlEdit: locked(async (maker: Maker, req: T.ArtifactHtmlEdit) => {
      const { row, v } = await versionOf(req.id, req.version);
      if (row.body !== "html") throw refused(t("server.artifact.notHtml", { title: row.title }));
      // Over the latest only: a later version's changes would be lost under an edit of an older one.
      if (v.version !== row.version) throw refused(t("server.artifact.edit.stale", { version: v.version, latest: row.version }));
      const source = await pageOf(row, v);
      const edited = htmlEdit(source, req.anchor, req.text);
      if (!edited.ok) throw refused(edited.why);
      const note = t("server.artifact.edit.note", { old: head(req.anchor.exact.trim(), 40), new: head(req.text.trim(), 40) });
      return version(maker, { id: req.id, content: edited.source, note });
    }),
    update: locked(async (req: T.ArtifactUpdateRequest) => {
      const row = await found(req.id);
      if (req.title !== undefined) {
        const problem = artifactProblem({ title: req.title });
        if (problem) throw refused(problem);
      }
      if (req.display !== undefined && row.body !== "html") throw refused(t("server.artifact.displayHtmlOnly"));
      const now = clock.now();
      if (req.title !== undefined) await qa.artifactRenamed(db.sql, { id: req.id, title: req.title.trim(), updated_at: now });
      if (req.display !== undefined) await qa.artifactShown(db.sql, { id: req.id, display: req.display, updated_at: now });
      return assemble(await found(req.id));
    }),
    previewRemove: async (id) => {
      const row = await found(id);
      const what =
        row.body === "html"
          ? t("server.artifact.preview.remove", { title: row.title, n: row.version })
          : t("server.artifact.preview.removeBlocks", { title: row.title, n: (await blocks.blocks(id)).length });
      return { does: row.channel_id !== null ? [what, t("server.artifact.preview.cards")] : [what] };
    },
    remove: locked(async (id: T.ArtifactId) => {
      await found(id);
      // Its versions' attachments stay: the same bytes may be a message's file or a library item.
      await qa.deleteArtifact(db.sql, { id });
    }),
    blocks: async (id) => {
      const list = await blocks.blocks(id);
      const artifact = await assemble(await found(id));
      return { artifact, blocks: list };
    },
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
    close: blocks.close,
  };
}
