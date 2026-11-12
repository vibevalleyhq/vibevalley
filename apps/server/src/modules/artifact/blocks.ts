import { z } from "zod";

import { Hub, isAbort, mapConcurrent, Semaphore, TaskGroup } from "@vibevalley/async";
import { list, t } from "@vibevalley/i18n";
import { dayMs, userId } from "@vibevalley/protocol";
import type * as T from "@vibevalley/protocol";
import { keyBetween, isOneOf } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";

import { BizCode, lookIn, messageOf, refuseIn } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import { jsonOf, jsonText } from "#/base/json.ts";
import { bounded } from "#/core/core.ts";
import type { Db } from "#/infra/db.ts";
import type { Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import * as qa from "#db/artifact.sql.ts";
import * as qb from "#db/artifact_block.sql.ts";
import * as qr from "#db/artifact_block_revision.sql.ts";
import * as qc from "#db/artifact_change.sql.ts";
import * as qs from "#db/artifact_suggestion.sql.ts";

import { blocksOfMarkdown, inlineSpans, markdownOf } from "./markdown.ts";
import { ordered, Page, unmarked, wire } from "./ops.ts";
import { demoJitter, demoPieces } from "./policy.ts";

const refused = refuseIn(BizCode.ArtifactRefused);

const attrsOf = jsonOf(S.BlockAttrs, "artifact_block.attrs");
const storedSpans = jsonOf(z.array(S.TextSpan).nullable(), "artifact_block.spans");
const idsOf = jsonOf(z.array(z.string()), "artifact_change.block_ids");
const resultsOf = jsonOf(z.array(S.BlockOpResult), "artifact_change.results");
const changeOf = jsonOf(S.SuggestionChange, "artifact_suggestion.change");

const demoSections = [0, 1, 2] as const;
type DemoSection = (typeof demoSections)[number];
const demoParagraphs = (section: DemoSection) => ([0, 1, 2] as const).map((p) => t(`server.artifact.demo.${section}.paragraphs.${p}`));

interface BlockStore {
  readonly blocks: (id: T.ArtifactId) => Promise<T.Block[]>;
  readonly fill: (id: T.ArtifactId, markdown: string, actor: string) => Promise<void>;
  readonly markdown: (id: T.ArtifactId) => Promise<string>;
  readonly submit: (id: T.ArtifactId, actor: string, body: Pick<T.BlockSubmit, "batchId" | "ops">) => Promise<T.BlockAck>;
  readonly append: (
    id: T.ArtifactId,
    actor: string,
    type: T.BlockType,
    attrs: T.BlockAttrs,
    text: string,
  ) => Promise<[T.Block | undefined, T.BlockOpResult | undefined]>;
  readonly updateText: (
    id: T.ArtifactId,
    actor: string,
    block: T.BlockId,
    baseRev: number,
    text: string,
  ) => Promise<[T.Block | undefined, T.BlockOpResult | undefined]>;
  readonly insertBlock: (id: T.ArtifactId, actor: string, req: T.BlockCreate) => Promise<T.BlockOpResult>;
  readonly updateBlock: (id: T.ArtifactId, actor: string, req: T.BlockUpdate) => Promise<T.BlockOpResult>;
  readonly deleteBlock: (id: T.ArtifactId, actor: string, req: T.BlockDelete) => Promise<T.BlockOpResult>;
  readonly previewDeleteBlock: (id: T.ArtifactId, req: T.BlockDelete) => Promise<T.Preview>;
  readonly follow: (id: T.ArtifactId, after: number, signal?: AbortSignal) => AsyncIterable<T.ArtifactEvent>;
  readonly suggestions: (id: T.ArtifactId) => Promise<T.Suggestion[]>;
  readonly suggest: (id: T.ArtifactId, actor: string, req: T.SuggestionCreate) => Promise<T.Suggestion>;
  readonly acceptSuggestion: (id: T.ArtifactId, suggestion: string, actor: string) => Promise<T.Suggestion>;
  readonly rejectSuggestion: (id: T.ArtifactId, suggestion: string, actor: string) => Promise<T.Suggestion>;
  readonly suggestionStream: (id: T.ArtifactId, signal?: AbortSignal) => AsyncIterable<T.SuggestionEvent>;
  readonly demo: (id: T.ArtifactId, helpers: readonly T.Agent[]) => Promise<void>;
  readonly demoRunning: () => boolean;
  /** Stops the demo and the daily prune. */
  readonly close: () => Promise<void>;
}

const appendTypes: readonly T.BlockType[] = ["paragraph", "heading", "bulleted", "numbered", "todo", "quote", "code"];
const isAppendType = (type: string): type is T.BlockType => isOneOf(appendTypes, type);

const blockOf = (r: qb.ArtifactBlocksResult): T.Block =>
  wire({
    id: S.blockId(r.id),
    artifactId: S.artifactId(r.artifact_id),
    ...(r.parent_id !== null ? { parentId: S.blockId(r.parent_id) } : {}),
    orderKey: r.order_key,
    type: r.type,
    attrs: attrsOf(r.attrs),
    text: storedSpans(r.spans) ?? [],
    rev: r.rev,
    deleted: r.deleted,
    updatedBy: r.updated_by,
    updated: r.updated_at,
  });

const spansOf = (type: string, text: string) => (type === "code" ? unmarked([{ t: text, marks: {} }]) : inlineSpans(text));

const blockIn = (ack: T.BlockAck, id: string) => ack.blocks.find((b) => b.id === id);

/** How long a batch is kept to answer it again, and a block's text to merge a stale update against. */
const keptDays = 30;
const demoTickMs = 1000;

export interface BlockStoreDeps {
  readonly db: Db;
  readonly clock: Time;
  readonly log: Logger;
}

export async function makeBlockStore(deps: BlockStoreDeps, found: (id: T.ArtifactId) => Promise<qa.ArtifactResult>): Promise<BlockStore> {
  const { db, clock } = deps;
  const log = deps.log.child("artifact/blocks");
  const lock = new Semaphore(1);
  const tasks = new TaskGroup({ name: "artifact.blocks", onError: (task, e) => log.warn(`${task} failed`, e) });
  const changes = new Hub<{ readonly artifact: T.ArtifactId; readonly ack: T.BlockAck }>();
  const suggestionChanges = new Hub<{ readonly artifactId: T.ArtifactId; readonly suggestions: T.Suggestion[] }>();
  tasks.run("artifact.prune", async (signal) => {
    for (;;) {
      const before = clock.now() - keptDays * dayMs;
      await qc.pruneArtifactChanges(db.sql, { before });
      await qr.pruneArtifactBlockRevisions(db.sql, { before });
      await clock.sleep(dayMs, signal);
    }
  });

  const blocksOf = async (id: T.ArtifactId) => (await qb.artifactBlocks(db.sql, { artifact_id: id })).map(blockOf);

  const blocks = async (id: T.ArtifactId) => {
    await found(id);
    return ordered(await blocksOf(id));
  };

  const again = async (id: T.ArtifactId, seen: qc.ArtifactChangeByBatchResult): Promise<T.BlockAck> => {
    if (seen.artifact_id !== id) throw refused(t("server.artifact.otherArtifact", { batch: seen.batch_id }));
    const ids = idsOf(seen.block_ids);
    const all = await blocksOf(id);
    return {
      batchId: seen.batch_id,
      seq: seen.seq,
      results: resultsOf(seen.results),
      blocks: ids.flatMap((id) => all.filter((b) => b.id === id)),
    };
  };

  /** One batch, under the lock the caller holds. */
  const submitLocked = async (id: T.ArtifactId, actor: string, body: Pick<T.BlockSubmit, "batchId" | "ops">): Promise<T.BlockAck> => {
    if (!body.batchId.trim()) throw refused(t("server.artifact.noBatch"));
    const ack = await db.tx(async (): Promise<T.BlockAck> => {
      const row = await found(id);
      const seen = await qc.artifactChangeByBatch(db.sql, { batch_id: body.batchId });
      if (seen !== undefined) return again(id, seen);
      const now = clock.now();
      const p = new Page(id, actor, now, await blocksOf(id));
      // Preload base revisions and existing block ids into maps because `Page.apply` runs synchronously.
      const revisions = new Map<string, T.TextSpan[]>();
      for (const op of body.ops) {
        if (op.op !== "update_text" && op.op !== "split_block") continue;
        const b = p.find(op.blockId);
        if (!b || op.baseRev > b.rev || revisions.has(`${b.id}@${op.baseRev}`)) continue;
        // Earlier ops in the same batch may advance `rev` without altering spans.
        if (op.baseRev === b.rev) {
          revisions.set(`${b.id}@${op.baseRev}`, b.text);
          continue;
        }
        const raw = await qr.artifactBlockRevision(db.sql, { block_id: b.id, rev: op.baseRev });
        if (raw !== undefined) revisions.set(`${b.id}@${op.baseRev}`, storedSpans(raw.spans) ?? []);
      }
      const taken = new Set<string>();
      for (const op of body.ops) {
        const fresh = op.op === "insert_block" ? op.block.id : op.op === "split_block" ? op.newBlock.id : undefined;
        if (fresh && (await qb.artifactBlockOwner(db.sql, { id: fresh })) !== undefined) taken.add(fresh);
      }
      p.base = (block, rev) => revisions.get(`${block}@${rev}`);
      p.taken = (block) => taken.has(block);
      const results = body.ops.map((op) => p.apply(op));
      const changed = p.changedBlocks();
      for (const b of changed) {
        await qb.putArtifactBlock(db.sql, {
          id: b.id,
          artifact_id: id,
          parent_id: b.parentId ?? null,
          order_key: b.orderKey,
          type: b.type,
          attrs: jsonText(b.attrs),
          spans: jsonText(b.text),
          rev: b.rev,
          deleted: b.deleted === true,
          updated_by: b.updatedBy,
          updated_at: b.updated,
        });
      }
      for (const r of p.revisions) {
        await qr.addArtifactBlockRevision(db.sql, {
          id: newId(),
          block_id: r.block,
          rev: r.rev,
          spans: jsonText(r.spans),
          actor,
          kind: r.kind,
          created_at: now,
        });
      }
      const seq = row.seq + 1;
      await qc.addArtifactChange(db.sql, {
        artifact_id: id,
        seq,
        batch_id: body.batchId,
        actor,
        block_ids: jsonText(p.changed),
        results: jsonText(results),
        created_at: now,
      });
      await qa.artifactAccepted(db.sql, { id, seq, updated_at: now });
      return { batchId: body.batchId, seq, results, blocks: changed };
    });
    changes.publish({ artifact: id, ack });
    return ack;
  };

  const submit = (id: T.ArtifactId, actor: string, body: Pick<T.BlockSubmit, "batchId" | "ops">) => lock.with(() => submitLocked(id, actor, body));

  const keyOrRefuse = (a: string, b: string) => {
    try {
      return keyBetween(a, b);
    } catch (e) {
      throw refused(messageOf(e));
    }
  };

  const one = (ack: T.BlockAck, id: string): [T.Block | undefined, T.BlockOpResult | undefined] => [blockIn(ack, id), ack.results[0]];

  const append = (artifact: T.ArtifactId, actor: string, type: T.BlockType, attrs: T.BlockAttrs, text: string) =>
    lock.with(async () => {
      const last = new Page(artifact, actor, 0, await blocksOf(artifact)).children("").at(-1)?.orderKey ?? "";
      const b: T.BlockInput = { id: S.blockId(newId()), orderKey: keyOrRefuse(last, ""), type, attrs, text: spansOf(type, text) };
      return one(await submitLocked(artifact, actor, { batchId: newId(), ops: [{ op: "insert_block", block: b }] }), b.id);
    });

  const updateText = (artifact: T.ArtifactId, actor: string, block: T.BlockId, baseRev: number, text: string) =>
    lock.with(async () => {
      const type = (await blocksOf(artifact)).find((b) => b.id === block)?.type ?? "paragraph";
      const submitted = await submitLocked(artifact, actor, {
        batchId: newId(),
        ops: [{ op: "update_text", blockId: block, baseRev, text: spansOf(type, text) }],
      });
      return one(submitted, block);
    });

  const attrsFor = (type: T.BlockType, req: Pick<T.BlockCreate, "level" | "checked" | "language">): T.BlockAttrs => {
    if (type === "heading") return { level: req.level !== undefined && req.level >= 1 && req.level <= 3 ? Math.trunc(req.level) : 2 };
    if (type === "todo") return { checked: req.checked ?? false };
    if (type === "code") return req.language?.trim() ? { language: req.language.trim() } : {};
    return {};
  };

  const attrProblem = (type: T.BlockType, req: Pick<T.BlockCreate, "level" | "checked" | "language">): string | undefined => {
    if (req.level !== undefined && type !== "heading") return t("server.artifact.attrNotForType", { attr: "level", type });
    if (req.checked !== undefined && type !== "todo") return t("server.artifact.attrNotForType", { attr: "checked", type });
    if (req.language !== undefined && type !== "code") return t("server.artifact.attrNotForType", { attr: "language", type });
    return undefined;
  };

  const insertBlock = async (artifact: T.ArtifactId, actor: string, req: T.BlockCreate): Promise<T.BlockOpResult> => {
    await found(artifact);
    const type = (req.type ?? "").trim() || "paragraph";
    if (!isAppendType(type)) throw refused(t("server.artifact.badBlockType", { types: list(appendTypes) }));
    const problem = attrProblem(type, req);
    if (problem) throw refused(problem);
    const page = new Page(artifact, actor, 0, await blocksOf(artifact));
    const parent = req.parentId?.trim() ?? "";
    if (parent !== "") {
      const block = page.find(parent);
      if (!block) throw refused(t("server.artifact.op.noBlock", { id: parent }));
      if (block.deleted === true) throw refused(t("server.artifact.parentDeleted", { id: parent }));
    }
    const siblings = page.children(parent);
    let afterKey = "";
    let beforeKey = "";
    if (req.afterBlock === undefined) {
      afterKey = siblings.at(-1)?.orderKey ?? "";
    } else if (req.afterBlock === "") {
      beforeKey = siblings[0]?.orderKey ?? "";
    } else {
      const at = siblings.findIndex((b) => b.id === req.afterBlock);
      const sibling = siblings[at];
      if (at < 0 || !sibling) throw refused(t("server.artifact.afterNotSibling", { id: req.afterBlock }));
      afterKey = sibling.orderKey;
      beforeKey = siblings[at + 1]?.orderKey ?? "";
    }
    const block: T.BlockInput = {
      id: S.blockId(newId()),
      ...(parent !== "" ? { parentId: S.blockId(parent) } : {}),
      orderKey: keyOrRefuse(afterKey, beforeKey),
      type,
      attrs: attrsFor(type, req),
      text: spansOf(type, req.text),
    };
    const ack = await submitLocked(artifact, actor, { batchId: newId(), ops: [{ op: "insert_block", block }] });
    const r = ack.results[0];
    if (r === undefined) throw refused(t("server.artifact.notApplied"));
    return r;
  };

  const updateBlock = async (artifact: T.ArtifactId, actor: string, req: T.BlockUpdate): Promise<T.BlockOpResult> => {
    const block = S.blockId(req.block.trim());
    const now = (await blocksOf(artifact)).find((b) => b.id === block);
    if (!now) throw refused(t("server.artifact.op.noBlock", { id: block }));
    if (actor !== userId && now.updatedBy === userId) {
      const wanted = req.type?.trim();
      if (wanted !== undefined && !isAppendType(wanted)) throw refused(t("server.artifact.badBlockType", { types: list(appendTypes) }));
      const attrs: T.BlockAttrs = {};
      if (req.level !== undefined) attrs.level = req.level;
      if (req.checked !== undefined) attrs.checked = req.checked;
      if (req.language !== undefined) attrs.language = req.language;
      const change: T.Suggestion["change"] = {
        ...(req.text !== undefined ? { text: spansOf(wanted ?? now.type, req.text) } : {}),
        ...(wanted !== undefined && isAppendType(wanted) ? { type: wanted } : {}),
        ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
      };
      const made = await suggest(artifact, actor, { block, baseRev: req.baseRev, change });
      return {
        status: "rejected",
        blockId: block,
        rev: now.rev,
        reason: t("server.artifact.suggestion.suggested", { id: made.id }),
        suggestion: made.id,
      };
    }
    const ops: T.BlockOp[] = [];
    let type = now.type;
    if (req.type !== undefined) {
      const asked = req.type.trim();
      if (!isAppendType(asked)) throw refused(t("server.artifact.badBlockType", { types: list(appendTypes) }));
      const problem = attrProblem(asked, req);
      if (problem) throw refused(problem);
      type = asked;
      ops.push({ op: "set_type", blockId: block, type, attrs: attrsFor(type, req) });
    } else if (req.level !== undefined || req.checked !== undefined || req.language !== undefined) {
      const problem = attrProblem(now.type, req);
      if (problem) throw refused(problem);
      ops.push({ op: "set_attrs", blockId: block, attrs: attrsFor(now.type, req) });
    }
    if (req.text !== undefined) ops.push({ op: "update_text", blockId: block, baseRev: Math.trunc(req.baseRev), text: spansOf(type, req.text) });
    if (ops.length === 0) throw refused(t("server.artifact.nothingToChange"));
    const ack = await submitLocked(artifact, actor, { batchId: newId(), ops });
    const r = ack.results.at(-1);
    if (r === undefined) throw refused(t("server.artifact.notApplied"));
    return r;
  };

  const deleteBlock = async (artifact: T.ArtifactId, actor: string, req: T.BlockDelete): Promise<T.BlockOpResult> => {
    const block = S.blockId(req.block.trim());
    const now = (await blocksOf(artifact)).find((b) => b.id === block);
    if (now && actor !== userId && now.updatedBy === userId) {
      const made = await suggest(artifact, actor, { block, baseRev: now.rev, change: { delete: true } });
      return {
        status: "rejected",
        blockId: block,
        rev: now.rev,
        reason: t("server.artifact.suggestion.suggested", { id: made.id }),
        suggestion: made.id,
      };
    }
    const ack = await submitLocked(artifact, actor, { batchId: newId(), ops: [{ op: "delete_block", blockId: block }] });
    const r = ack.results[0];
    if (r === undefined) throw refused(t("server.artifact.notApplied"));
    return r;
  };

  const previewDeleteBlock = async (artifact: T.ArtifactId, req: T.BlockDelete): Promise<T.Preview> => {
    const all = await blocksOf(artifact);
    const block = all.find((b) => b.id === req.block);
    if (!block) throw refused(t("server.artifact.op.noBlock", { id: req.block }));
    const children = all.filter((b) => b.parentId === block.id).length;
    return {
      does: [
        t("server.artifact.preview.removeBlock", { id: block.id }),
        ...(children > 0 ? [t("server.artifact.preview.removeChildren", { n: children })] : []),
      ],
    };
  };

  const catchUpMax = 200;
  // A missing artifact throws on the first next(), before anything is streamed: the gateway answers it as JSON.
  async function* follow(id: T.ArtifactId, after: number, signal?: AbortSignal): AsyncGenerator<T.ArtifactEvent> {
    await found(id);
    // Subscribe before reading the DB catch-up window, then deduplicate live events by `seq`.
    const live = changes.subscribe();
    try {
      const missed = await qc.artifactChangesAfter(db.sql, { artifact_id: id, seq: after, n: catchUpMax + 1 });
      if (missed.length > catchUpMax) {
        yield { _tag: "Reset" };
        return;
      }
      const upto = missed.at(-1)?.seq ?? after;
      const current = await blocksOf(id);
      for (const change of missed) {
        yield { _tag: "Blocks", seq: change.seq, blocks: idsOf(change.block_ids).flatMap((block) => current.filter((b) => b.id === block)) };
      }
      for await (const change of bounded(live, "artifact.follow", log, 64, signal)) {
        if (change.artifact === id && change.ack.seq > upto) yield { _tag: "Blocks", seq: change.ack.seq, blocks: change.ack.blocks };
      }
    } finally {
      live.close();
    }
  }

  const suggestionOf = (r: qs.ArtifactSuggestionByIDResult): T.Suggestion => ({
    id: S.suggestionId(r.id),
    artifactId: S.artifactId(r.artifact_id),
    blockId: S.blockId(r.block_id),
    author: r.author,
    baseRev: r.at_rev,
    change: changeOf(r.change),
    status: r.status,
    createdAt: r.created_at,
    ...(r.resolved_at !== null ? { resolvedAt: r.resolved_at } : {}),
    ...(r.resolved_by !== null ? { resolvedBy: r.resolved_by } : {}),
  });

  const suggestionList = async (id: T.ArtifactId) => {
    await found(id);
    return (await qs.artifactSuggestions(db.sql, { artifact_id: id, n: 500 })).map(suggestionOf);
  };

  const publishSuggestions = async (id: T.ArtifactId) => {
    const suggestions = await suggestionList(id);
    suggestionChanges.publish({ artifactId: id, suggestions });
    return suggestions;
  };

  const changeProblem = (change: T.Suggestion["change"]): string | undefined => {
    const set = change.text !== undefined || change.type !== undefined || change.attrs !== undefined || change.unset !== undefined || change.delete === true;
    if (!set) return t("server.artifact.suggestion.empty");
    if (change.delete === true && (change.text !== undefined || change.type !== undefined || change.attrs !== undefined || change.unset !== undefined)) {
      return t("server.artifact.suggestion.deleteAlone");
    }
    if (change.type !== undefined && !isAppendType(change.type)) return t("server.artifact.badBlockType", { types: list(appendTypes) });
    return undefined;
  };

  const suggest = async (artifact: T.ArtifactId, actor: string, req: T.SuggestionCreate): Promise<T.Suggestion> => {
    await found(artifact);
    const block = (await blocksOf(artifact)).find((b) => b.id === req.block);
    if (!block || block.deleted === true) throw refused(t("server.artifact.suggestion.noBlock", { id: req.block }));
    const problem = changeProblem(req.change);
    if (problem) throw refused(problem);
    if (req.baseRev > block.rev) throw refused(t("server.artifact.suggestion.beyond", { rev: req.baseRev, now: block.rev }));
    const id = newId();
    await qs.addArtifactSuggestion(db.sql, {
      id,
      artifact_id: artifact,
      block_id: req.block,
      author: actor,
      at_rev: Math.trunc(req.baseRev),
      change: jsonText(req.change),
      created_at: clock.now(),
    });
    const made = await qs.artifactSuggestionByID(db.sql, { id });
    if (!made) throw refused(t("server.artifact.suggestion.missing", { id }));
    await publishSuggestions(artifact);
    return suggestionOf(made);
  };

  const acceptSuggestion = (artifact: T.ArtifactId, suggestion: string, actor: string) =>
    lock.with(async (): Promise<T.Suggestion> => {
      const row = await qs.artifactSuggestionByID(db.sql, { id: suggestion });
      if (!row || row.artifact_id !== artifact) throw refused(t("server.artifact.suggestion.missing", { id: suggestion }));
      if (row.status !== "open") return suggestionOf(row);
      const block = (await blocksOf(artifact)).find((b) => b.id === row.block_id);
      if (!block || block.deleted === true) throw refused(t("server.artifact.suggestion.noBlock", { id: row.block_id }));
      if (block.rev !== row.at_rev) throw refused(t("server.artifact.suggestion.stale", { rev: row.at_rev, now: block.rev }));
      const change = changeOf(row.change);
      const ops: T.BlockOp[] = [];
      if (change.delete === true) ops.push({ op: "delete_block", blockId: block.id });
      else {
        if (change.type !== undefined) ops.push({ op: "set_type", blockId: block.id, type: change.type, attrs: change.attrs ?? {} });
        else if (change.attrs !== undefined || change.unset !== undefined) {
          ops.push({ op: "set_attrs", blockId: block.id, attrs: change.attrs ?? {}, ...(change.unset ? { unset: change.unset } : {}) });
        }
        if (change.text !== undefined) ops.push({ op: "update_text", blockId: block.id, baseRev: row.at_rev, text: change.text });
      }
      const ack = await submitLocked(artifact, actor, { batchId: `suggestion:${suggestion}`, ops });
      const bad = ack.results.find((r) => r.status !== "applied" && r.status !== "noop");
      if (bad) throw refused(bad.reason ?? t("server.artifact.notApplied"));
      await qs.resolveArtifactSuggestion(db.sql, { id: suggestion, status: "accepted", resolved_at: clock.now(), resolved_by: actor });
      const updated = await qs.artifactSuggestionByID(db.sql, { id: suggestion });
      await publishSuggestions(artifact);
      return suggestionOf(updated ?? row);
    });

  const rejectSuggestion = (artifact: T.ArtifactId, suggestion: string, actor: string) =>
    lock.with(async (): Promise<T.Suggestion> => {
      const row = await qs.artifactSuggestionByID(db.sql, { id: suggestion });
      if (!row || row.artifact_id !== artifact) throw refused(t("server.artifact.suggestion.missing", { id: suggestion }));
      if (row.status !== "open") return suggestionOf(row);
      await qs.resolveArtifactSuggestion(db.sql, { id: suggestion, status: "rejected", resolved_at: clock.now(), resolved_by: actor });
      const updated = await qs.artifactSuggestionByID(db.sql, { id: suggestion });
      await publishSuggestions(artifact);
      return suggestionOf(updated ?? row);
    });

  // A missing artifact throws on the first next(), before anything is streamed.
  async function* suggestionStream(id: T.ArtifactId, signal?: AbortSignal): AsyncGenerator<T.SuggestionEvent> {
    await found(id);
    const live = suggestionChanges.subscribe();
    try {
      yield { _tag: "Suggestions", suggestions: await suggestionList(id) };
      for await (const change of bounded(live, "artifact.suggestion.follow", log, 64, signal)) {
        if (change.artifactId === id) yield { _tag: "Suggestions", suggestions: change.suggestions };
      }
    } finally {
      live.close();
    }
  }

  const fill = async (id: T.ArtifactId, markdown: string, actor: string) => {
    const parents: T.BlockId[] = [];
    const last = new Map<string, string>();
    const ops = blocksOfMarkdown(markdown).map((b) => {
      parents.length = b.depth;
      const parent = b.depth > 0 ? parents[b.depth - 1] : undefined;
      const key = keyOrRefuse(last.get(parent ?? "") ?? "", "");
      last.set(parent ?? "", key);
      const id = S.blockId(newId());
      parents.push(id);
      return {
        op: "insert_block" as const,
        block: { id, ...(parent ? { parentId: parent } : {}), orderKey: key, type: b.type, attrs: b.attrs, text: b.text },
      };
    });
    if (ops.length > 0) await submit(id, actor, { batchId: newId(), ops });
  };

  let demoOn = false;
  const wait = (ticks: number, signal: AbortSignal) => clock.sleep(ticks * (1 + demoJitter * (2 * Math.random() - 1)) * demoTickMs, signal);

  /** Inserts b at the end of the top level, or at the end of a section; the key is picked under the batch lock, so two writers cannot pick the same place. */
  const demoInsert = (artifact: T.ArtifactId, writer: string, b: Omit<T.BlockInput, "orderKey">, at?: { headings: string[]; section: number }) =>
    lock.with(async () => {
      // Include tombstones so new `orderKey`s do not collide with soft-deleted siblings.
      const top = new Page(artifact, writer, 0, await blocksOf(artifact)).children("");
      let after = top.at(-1)?.orderKey ?? "";
      let before = "";
      if (at && at.section + 1 < at.headings.length) {
        const i = top.findIndex((x) => x.id === at.headings[at.section + 1]);
        const here = top[i];
        if (here) {
          before = here.orderKey;
          const prev = i > 0 ? top[i - 1] : undefined;
          after = prev?.orderKey ?? "";
        }
      }
      const block = { ...b, orderKey: keyOrRefuse(after, before) };
      const ack = await submitLocked(artifact, writer, { batchId: newId(), ops: [{ op: "insert_block", block }] });
      const r = ack.results[0];
      if (r?.status !== "applied") throw refused(t("server.artifact.demoNotInserted", { status: r?.status ?? "missing" }));
      const inserted = blockIn(ack, b.id);
      if (!inserted) throw refused(t("server.artifact.demoNotInserted", { status: r.status }));
      return inserted.rev;
    });

  const demoWrite = async (artifact: T.ArtifactId, writer: string, headings: string[], section: DemoSection, signal: AbortSignal) => {
    for (const text of demoParagraphs(section)) {
      const b: Omit<T.BlockInput, "orderKey"> = { id: S.blockId(newId()), type: "paragraph", attrs: {}, text: [] };
      let rev = await demoInsert(artifact, writer, b, { headings, section });
      const chars = Array.from(text);
      for (let n = 1; n <= demoPieces; n++) {
        await wait(1, signal);
        const [, r] = await updateText(artifact, writer, b.id, rev, chars.slice(0, Math.floor((chars.length * n) / demoPieces)).join(""));
        if (r?.status !== "applied") break;
        rev = r.rev ?? rev;
      }
      await wait(0.8, signal);
    }
  };

  const runDemo = async (artifact: T.ArtifactId, writers: readonly { readonly writer: string; readonly section: DemoSection }[], signal: AbortSignal) => {
    try {
      const headings: string[] = [];
      for (const { writer: w, section } of writers) {
        const b: Omit<T.BlockInput, "orderKey"> = {
          id: S.blockId(newId()),
          type: "heading",
          attrs: { level: 2 },
          text: spansOf("heading", t(`server.artifact.demo.${section}.heading`)),
        };
        await demoInsert(artifact, w, b);
        headings.push(b.id);
        await wait(0.5, signal);
      }
      await mapConcurrent(writers, 4, async ({ writer, section }) => {
        await wait(section / 3, signal);
        await demoWrite(artifact, writer, headings, section, signal);
      });
    } catch (e) {
      // A demo that stops part way (a block it could not place) only leaves fewer blocks: said, not raised. Stopped with
      // the server, it says nothing.
      if (!isAbort(e, signal)) log.warn("the demo stopped", e);
    } finally {
      demoOn = false;
    }
  };

  const demo = async (id: T.ArtifactId, helpers: readonly T.Agent[]) => {
    await found(id);
    const enabled = helpers.filter((a) => a.enabled);
    const writers = demoSections.flatMap((section) => {
      const writer = enabled[section]?.id;
      return writer === undefined ? [] : [{ writer, section }];
    });
    if (writers.length === 0) throw refused(t("server.artifact.noWriter"), [lookIn.agent]);
    if (demoOn) throw refused(t("server.artifact.demoRunning"));
    demoOn = true;
    tasks.run("artifact.demo", (signal) => runDemo(id, writers, signal));
  };

  return {
    demoRunning: () => demoOn,
    blocks,
    fill,
    markdown: async (id) => markdownOf(await blocks(id)),
    submit,
    append,
    updateText,
    insertBlock,
    updateBlock,
    deleteBlock,
    previewDeleteBlock,
    follow,
    suggestions: suggestionList,
    suggest,
    acceptSuggestion,
    rejectSuggestion,
    suggestionStream,
    demo,
    close: async () => {
      await tasks.close();
      changes.end();
      suggestionChanges.end();
    },
  };
}
