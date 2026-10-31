// A blocks artifact's blocks, changed only by batches of ops (ops.ts), from the owner over HTTP and from helpers through
// their tools, all down the same pipeline. One batch at a time for every artifact: an artifact's batches are serial and
// its seq goes up in order. Part of the Artifact service (artifact.ts), which owns the artifact's row.

import { Clock, Duration, Effect, Option, PubSub, Schedule, Schema, Semaphore, Stream } from "effect";

import { list, t } from "@vibevalley/i18n";
import { dayMs, ownerId } from "@vibevalley/protocol";
import type * as T from "@vibevalley/protocol";
import { keyBetween, isOneOf } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";

import { newId } from "@/base/ids.ts";
import { jsonOf } from "@/base/json.ts";
import { scopedPubSub } from "@/base/pubsub.ts";
import { bounded } from "@/core/bounded.ts";
import { type ApiError, lookIn, refused, messageOf } from "@/errors.ts";
import { Db } from "@/infra/db.ts";

import * as qa from "../../db/generated/artifact.sql.ts";
import * as qb from "../../db/generated/artifact_block.sql.ts";
import * as qr from "../../db/generated/artifact_block_revision.sql.ts";
import * as qc from "../../db/generated/artifact_change.sql.ts";
import * as qs from "../../db/generated/artifact_suggestion.sql.ts";
import { demoJitter, demoPieces } from "./demo.ts";
import { blocksOfMarkdown, inlineSpans, markdownOf } from "./markdown.ts";
import { ordered, Page, wire } from "./ops.ts";
import { unmarked } from "./spans.ts";

const attrsOf = jsonOf(S.BlockAttrs);
const storedSpans = jsonOf(Schema.NullOr(Schema.mutable(Schema.Array(S.TextSpan))));
const idsOf = jsonOf(Schema.mutable(Schema.Array(Schema.String)));
const resultsOf = jsonOf(Schema.mutable(Schema.Array(S.BlockOpResult)));
const changeOf = jsonOf(S.SuggestionChange);

/** The demo's three sections, each a heading and three paragraphs in the catalog. */
const demoSections = [0, 1, 2] as const;
type DemoSection = (typeof demoSections)[number];
const demoParagraphs = (section: DemoSection) => ([0, 1, 2] as const).map((p) => t(`server.artifact.demo.${section}.paragraphs.${p}`));
export interface BlockStore {
  /** Every live block (no tombstones), in order. */
  readonly blocks: (id: T.ArtifactId) => Effect.Effect<T.Block[], ApiError>;
  /** Markdown read into blocks, inserted as one batch by actor at the end of what is there. */
  readonly fill: (id: T.ArtifactId, markdown: string, actor: string) => Effect.Effect<void, ApiError>;
  readonly markdown: (id: T.ArtifactId) => Effect.Effect<string, ApiError>;
  /** A batch of ops from actor (the owner, or a helper's profile id), in order, in one transaction. A batch id seen before is answered as it was, with its blocks as they are now. */
  readonly submit: (id: T.ArtifactId, actor: string, body: Pick<T.BlockSubmit, "batchId" | "ops">) => Effect.Effect<T.BlockAck, ApiError>;
  /** A new block at the end of the top level, as actor; text is inline Markdown (code takes it as it is). */
  readonly append: (
    id: T.ArtifactId,
    actor: string,
    type: T.BlockType,
    attrs: T.BlockAttrs,
    text: string,
  ) => Effect.Effect<[T.Block | undefined, T.BlockOpResult | undefined], ApiError>;
  /** A block's whole text written against baseRev, as actor; text is inline Markdown (code takes it as it is). */
  readonly updateText: (
    id: T.ArtifactId,
    actor: string,
    block: T.BlockId,
    baseRev: number,
    text: string,
  ) => Effect.Effect<[T.Block | undefined, T.BlockOpResult | undefined], ApiError>;
  /** A block of one of the kinds an agent writes, inserted where the caller says (artifact.block.create); refused for another kind. */
  readonly insertBlock: (id: T.ArtifactId, actor: string, req: T.BlockCreate) => Effect.Effect<T.BlockOpResult, ApiError>;
  /** A block's words, type or attrs against the rev it was read at (artifact.block.update): a newer rev on changed words comes back as a conflict, not an error. */
  readonly updateBlock: (id: T.ArtifactId, actor: string, req: T.BlockUpdate) => Effect.Effect<T.BlockOpResult, ApiError>;
  /** A block and its children put in their tombstones (artifact.block.delete). */
  readonly deleteBlock: (id: T.ArtifactId, actor: string, req: T.BlockDelete) => Effect.Effect<T.BlockOpResult, ApiError>;
  /** What deleting a block would do, for a dry run. */
  readonly previewDeleteBlock: (id: T.ArtifactId, req: T.BlockDelete) => Effect.Effect<T.Preview, ApiError>;
  /** Each batch after seq, then each from now on (artifact.follow). */
  readonly follow: (id: T.ArtifactId, after: number) => Stream.Stream<T.ArtifactEvent, ApiError>;
  /** An artifact's suggestions, oldest first. */
  readonly suggestions: (id: T.ArtifactId) => Effect.Effect<T.Suggestion[], ApiError>;
  /** An agent proposes a change to a block the owner wrote. */
  readonly suggest: (id: T.ArtifactId, actor: string, req: T.SuggestionCreate) => Effect.Effect<T.Suggestion, ApiError>;
  /** The owner takes a suggestion, if the block still stands at the rev it was read at. */
  readonly acceptSuggestion: (id: T.ArtifactId, suggestion: string, actor: string) => Effect.Effect<T.Suggestion, ApiError>;
  readonly rejectSuggestion: (id: T.ArtifactId, suggestion: string, actor: string) => Effect.Effect<T.Suggestion, ApiError>;
  /** The whole list now, then after each change (artifact.suggestion.follow). */
  readonly suggestionStream: (id: T.ArtifactId) => Stream.Stream<T.SuggestionEvent, ApiError>;
  /** Starts the demo and returns at once (demo.ts). */
  readonly demo: (id: T.ArtifactId, helpers: readonly T.Agent[]) => Effect.Effect<void, ApiError>;
  readonly demoRunning: () => boolean;
}

/** The block kinds an agent appends; the editor has more (dividers, images), which an agent does not write. */
const appendTypes: readonly T.BlockType[] = ["paragraph", "heading", "bulleted", "numbered", "todo", "quote", "code"];
const isAppendType = (type: string): type is T.BlockType => isOneOf(appendTypes, type);

const blockOf = (r: qb.ArtifactBlocksResult): T.Block =>
  wire({
    id: S.blockId(r.id),
    artifactId: S.artifactId(r.artifact_id),
    ...(r.parent_id !== null ? { parentId: S.blockId(r.parent_id) } : {}),
    orderKey: r.order_key,
    // Written only through BlockOp, whose type the wire decodes as a BlockType.
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

/** How long a demo waits between pieces; tests make it short. */
export interface BlockStoreOptions {
  readonly tickMs?: number;
}

/** found: the artifact's row, failing when there is none or it is not a blocks one. */
export const makeBlockStore = (found: (id: T.ArtifactId) => Effect.Effect<qa.ArtifactResult, ApiError>, options: BlockStoreOptions = {}) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const lock = yield* Semaphore.make(1);
    const scope = yield* Effect.scope;
    const tick = options.tickMs ?? 1000;
    // Every batch that commits, for pages following an artifact; the database is the catch-up, this is only the live tail.
    const changes = yield* scopedPubSub<{ readonly artifact: T.ArtifactId; readonly ack: T.BlockAck }>();
    const suggestionChanges = yield* scopedPubSub<{ readonly artifactId: T.ArtifactId; readonly suggestions: T.Suggestion[] }>();
    yield* Effect.forkScoped(
      Effect.repeat(
        Effect.gen(function* () {
          const before = (yield* Clock.currentTimeMillis) - keptDays * dayMs;
          yield* db.run(qc.pruneArtifactChanges({ before }));
          yield* db.run(qr.pruneArtifactBlockRevisions({ before }));
        }),
        Schedule.spaced(Duration.days(1)),
      ),
    );

    const blocksOf = (id: T.ArtifactId) => db.run(Effect.map(qb.artifactBlocks({ artifact_id: id }), (rows) => rows.map(blockOf)));

    const blocks = Effect.fn("BlockStore.blocks")(function* (id: T.ArtifactId) {
      yield* found(id);
      return ordered(yield* blocksOf(id));
    });

    /** A batch already taken: its results then, its blocks now. */
    const again = Effect.fn("BlockStore.again")(function* (id: T.ArtifactId, seen: qc.ArtifactChangeByBatchResult) {
      if (seen.artifact_id !== id) return yield* Effect.fail(refused(t("server.artifact.otherArtifact", { batch: seen.batch_id })));
      const ids = idsOf(seen.block_ids);
      const all = yield* blocksOf(id);
      return {
        batchId: seen.batch_id,
        seq: seen.seq,
        results: resultsOf(seen.results),
        blocks: ids.flatMap((id) => all.filter((b) => b.id === id)),
      };
    });

    /** One batch, under the lock the caller holds. */
    const submitLocked = (id: T.ArtifactId, actor: string, body: Pick<T.BlockSubmit, "batchId" | "ops">): Effect.Effect<T.BlockAck, ApiError> =>
      Effect.gen(function* () {
        if (!body.batchId.trim()) return yield* Effect.fail(refused(t("server.artifact.noBatch")));
        const ack = yield* db.inTx(
          Effect.gen(function* () {
            const row = yield* found(id);
            const seen = yield* db.run(Effect.catchNoSuchElement(qc.artifactChangeByBatch({ batch_id: body.batchId })));
            if (Option.isSome(seen)) return yield* again(id, seen.value);
            const now = yield* Clock.currentTimeMillis;
            const p = new Page(id, actor, now, yield* blocksOf(id));
            // The page asks synchronously, so what it may ask is read first: the base of each stale edit, the ids each insert makes.
            const revisions = new Map<string, T.TextSpan[]>();
            for (const op of body.ops) {
              if (op.op !== "update_text" && op.op !== "split_block") continue;
              const b = p.find(op.blockId);
              if (!b || op.baseRev > b.rev || revisions.has(`${b.id}@${op.baseRev}`)) continue;
              // An earlier op in this batch can advance rev without changing this text.
              if (op.baseRev === b.rev) {
                revisions.set(`${b.id}@${op.baseRev}`, b.text);
                continue;
              }
              const raw = yield* db.run(Effect.catchNoSuchElement(qr.artifactBlockRevision({ block_id: b.id, rev: op.baseRev })));
              if (Option.isSome(raw)) revisions.set(`${b.id}@${op.baseRev}`, storedSpans(raw.value.spans) ?? []);
            }
            const taken = new Set<string>();
            yield* Effect.forEach(
              body.ops,
              (op) =>
                Effect.gen(function* () {
                  const fresh = op.op === "insert_block" ? op.block.id : op.op === "split_block" ? op.newBlock.id : undefined;
                  if (fresh && Option.isSome(yield* db.run(Effect.catchNoSuchElement(qb.artifactBlockOwner({ id: fresh }))))) taken.add(fresh);
                }),
              { discard: true },
            );
            p.base = (block, rev) => revisions.get(`${block}@${rev}`);
            p.taken = (block) => taken.has(block);
            const results = body.ops.map((op) => p.apply(op));
            const changed = p.changedBlocks();
            yield* Effect.forEach(
              changed,
              (b) =>
                db.run(
                  qb.putArtifactBlock({
                    id: b.id,
                    artifact_id: id,
                    parent_id: b.parentId ?? null,
                    order_key: b.orderKey,
                    type: b.type,
                    attrs: JSON.stringify(b.attrs),
                    spans: JSON.stringify(b.text),
                    rev: b.rev,
                    deleted: !(b.deleted !== true),
                    updated_by: b.updatedBy,
                    updated_at: b.updated,
                  }),
                ),
              { discard: true },
            );
            yield* Effect.forEach(
              p.revisions,
              (r) =>
                db.run(
                  qr.addArtifactBlockRevision({
                    id: newId(),
                    block_id: r.block,
                    rev: r.rev,
                    spans: JSON.stringify(r.spans),
                    actor,
                    kind: r.kind,
                    created_at: now,
                  }),
                ),
              { discard: true },
            );
            const seq = row.seq + 1;
            yield* db.run(
              qc.addArtifactChange({
                artifact_id: id,
                seq,
                batch_id: body.batchId,
                actor,
                block_ids: JSON.stringify(p.changed),
                results: JSON.stringify(results),
                created_at: now,
              }),
            );
            yield* db.run(qa.artifactAccepted({ id, seq, updated_at: now }));
            return { batchId: body.batchId, seq, results, blocks: changed };
          }),
        );
        yield* PubSub.publish(changes, { artifact: id, ack });
        return ack;
      });

    const submit = Effect.fn("Artifact.submit")(function* (id: T.ArtifactId, actor: string, body: Pick<T.BlockSubmit, "batchId" | "ops">) {
      return yield* submitLocked(id, actor, body);
    }, lock.withPermits(1));

    const keyOrRefuse = (a: string, b: string) => Effect.try({ try: () => keyBetween(a, b), catch: (e) => refused(messageOf(e)) });

    const one = (ack: T.BlockAck, id: string): [T.Block | undefined, T.BlockOpResult | undefined] => [blockIn(ack, id), ack.results[0]];

    const append = Effect.fn("BlockStore.append")(function* (artifact: T.ArtifactId, actor: string, type: T.BlockType, attrs: T.BlockAttrs, text: string) {
      const last = new Page(artifact, actor, 0, yield* blocksOf(artifact)).children("").at(-1)?.orderKey ?? "";
      const b: T.BlockInput = { id: S.blockId(newId()), orderKey: yield* keyOrRefuse(last, ""), type, attrs, text: spansOf(type, text) };
      return one(yield* submitLocked(artifact, actor, { batchId: newId(), ops: [{ op: "insert_block", block: b }] }), b.id);
    }, lock.withPermits(1));

    const updateText = Effect.fn("BlockStore.updateText")(function* (artifact: T.ArtifactId, actor: string, block: T.BlockId, baseRev: number, text: string) {
      const type = (yield* blocksOf(artifact)).find((b) => b.id === block)?.type ?? "paragraph";
      return one(
        yield* submitLocked(artifact, actor, { batchId: newId(), ops: [{ op: "update_text", blockId: block, baseRev, text: spansOf(type, text) }] }),
        block,
      );
    }, lock.withPermits(1));

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

    const insertBlock = Effect.fn("Artifact.insertBlock")(function* (artifact: T.ArtifactId, actor: string, req: T.BlockCreate) {
      yield* found(artifact);
      const type = (req.type ?? "").trim() || "paragraph";
      if (!isAppendType(type)) return yield* Effect.fail(refused(t("server.artifact.badBlockType", { types: list(appendTypes) })));
      const problem = attrProblem(type, req);
      if (problem) return yield* Effect.fail(refused(problem));
      const page = new Page(artifact, actor, 0, yield* blocksOf(artifact));
      const parent = req.parentId?.trim() ?? "";
      if (parent !== "") {
        const block = page.find(parent);
        if (!block) return yield* Effect.fail(refused(t("server.artifact.op.noBlock", { id: parent })));
        if (block.deleted === true) return yield* Effect.fail(refused(t("server.artifact.parentDeleted", { id: parent })));
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
        if (at < 0) return yield* Effect.fail(refused(t("server.artifact.afterNotSibling", { id: req.afterBlock })));
        const sibling = siblings[at];
        if (!sibling) return yield* Effect.fail(refused(t("server.artifact.afterNotSibling", { id: req.afterBlock })));
        afterKey = sibling.orderKey;
        beforeKey = siblings[at + 1]?.orderKey ?? "";
      }
      const block: T.BlockInput = {
        id: S.blockId(newId()),
        ...(parent !== "" ? { parentId: S.blockId(parent) } : {}),
        orderKey: yield* keyOrRefuse(afterKey, beforeKey),
        type,
        attrs: attrsFor(type, req),
        text: spansOf(type, req.text),
      };
      const ack = yield* submitLocked(artifact, actor, { batchId: newId(), ops: [{ op: "insert_block", block }] });
      return ack.results[0] ?? (yield* Effect.fail(refused(t("server.artifact.notApplied"))));
    });

    const updateBlock = Effect.fn("Artifact.updateBlock")(function* (artifact: T.ArtifactId, actor: string, req: T.BlockUpdate) {
      const block = S.blockId(req.block.trim());
      const now = (yield* blocksOf(artifact)).find((b) => b.id === block);
      if (!now) return yield* Effect.fail(refused(t("server.artifact.op.noBlock", { id: block })));
      if (actor !== ownerId && now.updatedBy === ownerId) {
        const wanted = req.type?.trim();
        if (wanted !== undefined && !isAppendType(wanted)) return yield* Effect.fail(refused(t("server.artifact.badBlockType", { types: list(appendTypes) })));
        const attrs: T.BlockAttrs = {};
        if (req.level !== undefined) attrs.level = req.level;
        if (req.checked !== undefined) attrs.checked = req.checked;
        if (req.language !== undefined) attrs.language = req.language;
        const change: T.SuggestionChange = {
          ...(req.text !== undefined ? { text: spansOf(wanted ?? now.type, req.text) } : {}),
          ...(wanted !== undefined && isAppendType(wanted) ? { type: wanted } : {}),
          ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
        };
        const made = yield* suggest(artifact, actor, { block, baseRev: req.baseRev, change });
        return {
          status: "rejected" as const,
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
        if (!isAppendType(asked)) return yield* Effect.fail(refused(t("server.artifact.badBlockType", { types: list(appendTypes) })));
        const problem = attrProblem(asked, req);
        if (problem) return yield* Effect.fail(refused(problem));
        type = asked;
        ops.push({ op: "set_type", blockId: block, type, attrs: attrsFor(type, req) });
      } else if (req.level !== undefined || req.checked !== undefined || req.language !== undefined) {
        const problem = attrProblem(now.type, req);
        if (problem) return yield* Effect.fail(refused(problem));
        ops.push({ op: "set_attrs", blockId: block, attrs: attrsFor(now.type, req) });
      }
      if (req.text !== undefined) ops.push({ op: "update_text", blockId: block, baseRev: Math.trunc(req.baseRev), text: spansOf(type, req.text) });
      if (ops.length === 0) return yield* Effect.fail(refused(t("server.artifact.nothingToChange")));
      const ack = yield* submitLocked(artifact, actor, { batchId: newId(), ops });
      return ack.results.at(-1) ?? (yield* Effect.fail(refused(t("server.artifact.notApplied"))));
    });

    const deleteBlock = Effect.fn("Artifact.deleteBlock")(function* (artifact: T.ArtifactId, actor: string, req: T.BlockDelete) {
      const block = S.blockId(req.block.trim());
      const now = (yield* blocksOf(artifact)).find((b) => b.id === block);
      if (now && actor !== ownerId && now.updatedBy === ownerId) {
        const made = yield* suggest(artifact, actor, { block, baseRev: now.rev, change: { delete: true } });
        return {
          status: "rejected" as const,
          blockId: block,
          rev: now.rev,
          reason: t("server.artifact.suggestion.suggested", { id: made.id }),
          suggestion: made.id,
        };
      }
      const ack = yield* submitLocked(artifact, actor, { batchId: newId(), ops: [{ op: "delete_block", blockId: block }] });
      return ack.results[0] ?? (yield* Effect.fail(refused(t("server.artifact.notApplied"))));
    });

    const previewDeleteBlock = Effect.fn("Artifact.previewDeleteBlock")(function* (artifact: T.ArtifactId, req: T.BlockDelete) {
      const all = yield* blocksOf(artifact);
      const block = all.find((b) => b.id === req.block);
      if (!block) return yield* Effect.fail(refused(t("server.artifact.op.noBlock", { id: req.block })));
      const children = all.filter((b) => b.parentId === block.id).length;
      return {
        does: [
          t("server.artifact.preview.removeBlock", { id: block.id }),
          ...(children > 0 ? [t("server.artifact.preview.removeChildren", { n: children })] : []),
        ],
      };
    });

    const catchUpMax = 200;
    const follow = (id: T.ArtifactId, after: number): Stream.Stream<T.ArtifactEvent, ApiError> =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* found(id);
          // Subscribed before the missed batches are read, so nothing that commits in between is lost; anything both have
          // is dropped by seq.
          const live = yield* PubSub.subscribe(changes);
          const missed = yield* db.run(qc.artifactChangesAfter({ artifact_id: id, seq: after, n: BigInt(catchUpMax + 1) }));
          if (missed.length > catchUpMax) return Stream.succeed<T.ArtifactEvent>({ _tag: "Reset" });
          const upto = missed.at(-1)?.seq ?? after;
          const current = yield* blocksOf(id);
          const caughtUp = missed.map((change): T.ArtifactEvent => ({
            _tag: "Blocks",
            seq: change.seq,
            blocks: idsOf(change.block_ids).flatMap((block) => current.filter((b) => b.id === block)),
          }));
          const here = bounded(
            Stream.fromSubscription(live).pipe(
              Stream.filter((change) => change.artifact === id && change.ack.seq > upto),
              Stream.map((change): T.ArtifactEvent => ({ _tag: "Blocks", seq: change.ack.seq, blocks: change.ack.blocks })),
            ),
            "artifact.follow",
          );
          return Stream.concat(Stream.fromIterable(caughtUp), here);
        }),
      );

    const suggestionOf = (r: qs.ArtifactSuggestionByIDResult): T.Suggestion => ({
      id: S.suggestionId(r.id),
      artifactId: S.artifactId(r.artifact_id),
      blockId: S.blockId(r.block_id),
      author: r.author,
      baseRev: r.at_rev,
      change: changeOf(r.change) ?? {},
      status: r?.status ?? "missing",
      createdAt: r.created_at,
      ...(r.resolved_at !== null ? { resolvedAt: r.resolved_at } : {}),
      ...(r.resolved_by !== null ? { resolvedBy: r.resolved_by } : {}),
    });

    const suggestionList = Effect.fn("Artifact.suggestions")(function* (id: T.ArtifactId) {
      yield* found(id);
      return (yield* db.run(qs.artifactSuggestions({ artifact_id: id, n: 500n }))).map(suggestionOf);
    });

    const publishSuggestions = Effect.fnUntraced(function* (id: T.ArtifactId) {
      const suggestions = yield* suggestionList(id);
      yield* PubSub.publish(suggestionChanges, { artifactId: id, suggestions });
      return suggestions;
    });

    const changeProblem = (change: T.SuggestionChange): string | undefined => {
      const set = change.text !== undefined || change.type !== undefined || change.attrs !== undefined || change.unset !== undefined || change.delete === true;
      if (!set) return t("server.artifact.suggestion.empty");
      if (change.delete === true && (change.text !== undefined || change.type !== undefined || change.attrs !== undefined || change.unset !== undefined)) {
        return t("server.artifact.suggestion.deleteAlone");
      }
      if (change.type !== undefined && !isAppendType(change.type)) return t("server.artifact.badBlockType", { types: list(appendTypes) });
      return undefined;
    };

    const suggest = Effect.fn("Artifact.suggest")(function* (artifact: T.ArtifactId, actor: string, req: T.SuggestionCreate) {
      yield* found(artifact);
      const block = (yield* blocksOf(artifact)).find((b) => b.id === req.block);
      if (!block || block.deleted === true) return yield* Effect.fail(refused(t("server.artifact.suggestion.noBlock", { id: req.block })));
      const problem = changeProblem(req.change);
      if (problem) return yield* Effect.fail(refused(problem));
      if (req.baseRev > block.rev) return yield* Effect.fail(refused(t("server.artifact.suggestion.beyond", { rev: req.baseRev, now: block.rev })));
      const now = yield* Clock.currentTimeMillis;
      const id = newId();
      yield* db.run(
        qs.addArtifactSuggestion({
          id,
          artifact_id: artifact,
          block_id: req.block,
          author: actor,
          at_rev: Math.trunc(req.baseRev),
          change: JSON.stringify(req.change),
          created_at: now,
        }),
      );
      const made = yield* db.one(qs.artifactSuggestionByID({ id }));
      if (!made) return yield* Effect.fail(refused(t("server.artifact.suggestion.missing", { id })));
      yield* publishSuggestions(artifact);
      return suggestionOf(made);
    });

    const acceptSuggestion = Effect.fn("Artifact.acceptSuggestion")(function* (artifact: T.ArtifactId, suggestion: string, actor: string) {
      const row = yield* db.one(qs.artifactSuggestionByID({ id: suggestion }));
      if (!row || row.artifact_id !== artifact) return yield* Effect.fail(refused(t("server.artifact.suggestion.missing", { id: suggestion })));
      if (row.status !== "open") return suggestionOf(row);
      const block = (yield* blocksOf(artifact)).find((b) => b.id === row.block_id);
      if (!block || block.deleted === true) return yield* Effect.fail(refused(t("server.artifact.suggestion.noBlock", { id: row.block_id })));
      if (block.rev !== row.at_rev) return yield* Effect.fail(refused(t("server.artifact.suggestion.stale", { rev: row.at_rev, now: block.rev })));
      const change = changeOf(row.change) ?? {};
      const ops: T.BlockOp[] = [];
      if (change.delete === true) ops.push({ op: "delete_block", blockId: block.id });
      else {
        if (change.type !== undefined) ops.push({ op: "set_type", blockId: block.id, type: change.type, attrs: change.attrs ?? {} });
        else if (change.attrs !== undefined || change.unset !== undefined) {
          ops.push({ op: "set_attrs", blockId: block.id, attrs: change.attrs ?? {}, ...(change.unset ? { unset: change.unset } : {}) });
        }
        if (change.text !== undefined) ops.push({ op: "update_text", blockId: block.id, baseRev: row.at_rev, text: change.text });
      }
      const ack = yield* submitLocked(artifact, actor, { batchId: `suggestion:${suggestion}`, ops });
      const bad = ack.results.find((r) => r.status !== "applied" && r.status !== "noop");
      if (bad) return yield* Effect.fail(refused(bad.reason ?? t("server.artifact.notApplied")));
      yield* db.run(qs.resolveArtifactSuggestion({ id: suggestion, status: "accepted", resolved_at: yield* Clock.currentTimeMillis, resolved_by: actor }));
      const updated = yield* db.one(qs.artifactSuggestionByID({ id: suggestion }));
      yield* publishSuggestions(artifact);
      return suggestionOf(updated!);
    }, lock.withPermits(1));

    const rejectSuggestion = Effect.fn("Artifact.rejectSuggestion")(function* (artifact: T.ArtifactId, suggestion: string, actor: string) {
      const row = yield* db.one(qs.artifactSuggestionByID({ id: suggestion }));
      if (!row || row.artifact_id !== artifact) return yield* Effect.fail(refused(t("server.artifact.suggestion.missing", { id: suggestion })));
      if (row.status !== "open") return suggestionOf(row);
      yield* db.run(qs.resolveArtifactSuggestion({ id: suggestion, status: "rejected", resolved_at: yield* Clock.currentTimeMillis, resolved_by: actor }));
      const updated = yield* db.one(qs.artifactSuggestionByID({ id: suggestion }));
      yield* publishSuggestions(artifact);
      return suggestionOf(updated!);
    }, lock.withPermits(1));

    const suggestionStream = (id: T.ArtifactId): Stream.Stream<T.SuggestionEvent, ApiError> =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* found(id);
          const live = yield* PubSub.subscribe(suggestionChanges);
          const now = yield* suggestionList(id);
          const here = bounded(
            Stream.fromSubscription(live).pipe(
              Stream.filter((change) => change.artifactId === id),
              Stream.map((change): T.SuggestionEvent => ({ _tag: "Suggestions", suggestions: change.suggestions })),
            ),
            "artifact.suggestion.follow",
          );
          return Stream.concat(Stream.succeed<T.SuggestionEvent>({ _tag: "Suggestions", suggestions: now }), here);
        }),
      );

    const fill = Effect.fn("BlockStore.fill")(function* (id: T.ArtifactId, markdown: string, actor: string) {
      const parents: T.BlockId[] = [];
      const last = new Map<string, string>();
      const ops = yield* Effect.forEach(blocksOfMarkdown(markdown), (b) =>
        Effect.gen(function* () {
          parents.length = b.depth;
          const parent = b.depth > 0 ? parents[b.depth - 1] : undefined;
          const key = yield* keyOrRefuse(last.get(parent ?? "") ?? "", "");
          last.set(parent ?? "", key);
          const id = S.blockId(newId());
          parents.push(id);
          return {
            op: "insert_block" as const,
            block: { id, ...(parent ? { parentId: parent } : {}), orderKey: key, type: b.type, attrs: b.attrs, text: b.text },
          };
        }),
      );
      if (ops.length > 0) yield* submit(id, actor, { batchId: newId(), ops });
    });

    let demoOn = false;
    /** About ticks of the tick, a bit more or less so the writers interleave. */
    const wait = (ticks: number) => Effect.sleep(ticks * (1 + demoJitter * (2 * Math.random() - 1)) * tick);

    /** Inserts b at the end of the top level, or at the end of a section; the key is picked under the batch lock, so two writers cannot pick the same place. */
    const demoInsert = Effect.fn("BlockStore.demoInsert")(function* (
      artifact: T.ArtifactId,
      writer: string,
      b: Omit<T.BlockInput, "orderKey">,
      at?: { headings: string[]; section: number },
    ) {
      // Tombstones too: their keys still hold their places.
      const top = new Page(artifact, writer, 0, yield* blocksOf(artifact)).children("");
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
      const block = { ...b, orderKey: yield* keyOrRefuse(after, before) };
      const ack = yield* submitLocked(artifact, writer, { batchId: newId(), ops: [{ op: "insert_block", block }] });
      const r = ack.results[0];
      if (r?.status !== "applied") return yield* Effect.fail(refused(t("server.artifact.demoNotInserted", { status: r?.status ?? "missing" })));
      const inserted = blockIn(ack, b.id);
      if (!inserted) return yield* Effect.fail(refused(t("server.artifact.demoNotInserted", { status: r?.status ?? "missing" })));
      return inserted.rev;
    }, lock.withPermits(1));

    /** One writer: each paragraph of its section, inserted empty at the section's end, then grown a piece a tick. */
    const demoWrite = Effect.fn("BlockStore.demoWrite")(function* (artifact: T.ArtifactId, writer: string, headings: string[], section: DemoSection) {
      for (const text of demoParagraphs(section)) {
        const b: Omit<T.BlockInput, "orderKey"> = { id: S.blockId(newId()), type: "paragraph", attrs: {}, text: [] };
        let rev = yield* demoInsert(artifact, writer, b, { headings, section });
        const chars = Array.from(text);
        for (let n = 1; n <= demoPieces; n++) {
          yield* wait(1);
          const [, r] = yield* updateText(artifact, writer, b.id, rev, chars.slice(0, Math.floor((chars.length * n) / demoPieces)).join(""));
          // The owner wrote in it (or removed it): the block is theirs now, the writer goes on to its next paragraph.
          if (r?.status !== "applied") break;
          rev = r.rev ?? rev;
        }
        yield* wait(0.8);
      }
    });

    const runDemo = Effect.fn("BlockStore.runDemo")(
      function* (artifact: T.ArtifactId, writers: readonly { readonly writer: string; readonly section: DemoSection }[]) {
        const headings: string[] = [];
        yield* Effect.forEach(
          writers,
          ({ writer: w, section }) =>
            Effect.gen(function* () {
              const b: Omit<T.BlockInput, "orderKey"> = {
                id: S.blockId(newId()),
                type: "heading",
                attrs: { level: 2 },
                text: spansOf("heading", t(`server.artifact.demo.${section}.heading`)),
              };
              yield* demoInsert(artifact, w, b);
              headings.push(b.id);
              yield* wait(0.5);
            }),
          { discard: true },
        );
        yield* Effect.forEach(writers, ({ writer, section }) => Effect.andThen(wait(section / 3), demoWrite(artifact, writer, headings, section)), {
          concurrency: "unbounded",
          discard: true,
        });
      },
      (e) => e.pipe(Effect.ignore, Effect.ensuring(Effect.sync(() => (demoOn = false)))),
    );

    const demo = Effect.fn("Artifact.demo")(function* (id: T.ArtifactId, helpers: readonly T.Agent[]) {
      yield* found(id);
      const enabled = helpers.filter((a) => a.enabled);
      const writers = demoSections.flatMap((section) => {
        const writer = enabled[section]?.id;
        return writer === undefined ? [] : [{ writer, section }];
      });
      if (writers.length === 0) return yield* Effect.fail(refused(t("server.artifact.noWriter"), [lookIn.agent]));
      if (demoOn) return yield* Effect.fail(refused(t("server.artifact.demoRunning")));
      demoOn = true;
      // The demo lives as long as the service: stopping the farm stops it.
      yield* Effect.forkIn(runDemo(id, writers), scope);
    });

    const shape: BlockStore = {
      demoRunning: () => demoOn,
      blocks,
      fill,
      markdown: Effect.fn("Artifact.markdown")(function* (id) {
        return markdownOf(yield* blocks(id));
      }),
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
    };
    return shape;
  });
