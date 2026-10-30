// A blocks artifact's blocks, changed only by batches of ops (ops.ts), from the owner over HTTP and from helpers through
// their tools, all down the same pipeline. One batch at a time for every artifact: an artifact's batches are serial and
// its seq goes up in order. Part of Artifacts (artifact.ts), which owns the artifact's row.

import { Clock, Effect, Option, Schema, Semaphore } from "effect";

import { list, t } from "@vibevalley/i18n";
import type {
  Agent,
  Block,
  BlockAttrs,
  BlockInput,
  BlockType,
  BlockAck,
  BlockCreate,
  BlockUpdate,
  BlockOpResult,
  TextSpan,
  BlockSubmit,
} from "@vibevalley/protocol";
import { keyBetween, isOneOf } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";

import { Db } from "@/base/db.ts";
import { newId } from "@/base/ids.ts";
import { jsonOf } from "@/base/json.ts";
import { type ApiError, lookIn, refused, messageOf } from "@/errors.ts";

import * as qa from "../../db/generated/artifact.sql.ts";
import * as qb from "../../db/generated/artifact_block.sql.ts";
import * as qr from "../../db/generated/artifact_block_revision.sql.ts";
import * as qc from "../../db/generated/artifact_change.sql.ts";
import { demoJitter, demoPieces } from "./demo.ts";
import { blocksOfMarkdown, inlineSpans, markdownOf } from "./markdown.ts";
import { ordered, Page, wire } from "./ops.ts";
import { unmarked } from "./spans.ts";

const attrsOf = jsonOf(S.BlockAttrs);
const storedSpans = jsonOf(Schema.NullOr(Schema.mutable(Schema.Array(S.TextSpan))));
const idsOf = jsonOf(Schema.mutable(Schema.Array(Schema.String)));
const resultsOf = jsonOf(Schema.mutable(Schema.Array(S.BlockOpResult)));

/** The demo's three sections, each a heading and three paragraphs in the catalog. */
const demoSections = [0, 1, 2] as const;
type DemoSection = (typeof demoSections)[number];
const demoParagraphs = (section: DemoSection) => ([0, 1, 2] as const).map((p) => t(`server.artifact.demo.${section}.paragraphs.${p}`));
export interface Blocks {
  /** Every live block (no tombstones), in order. */
  readonly blocks: (id: string) => Effect.Effect<Block[], ApiError>;
  /** Markdown read into blocks, inserted as one batch by actor at the end of what is there. */
  readonly fill: (id: string, markdown: string, actor: string) => Effect.Effect<void, ApiError>;
  readonly markdown: (id: string) => Effect.Effect<string, ApiError>;
  /** A batch of ops from actor (the owner, or a helper's profile id), in order, in one transaction. A batch id seen before is answered as it was, with its blocks as they are now. */
  readonly submit: (id: string, actor: string, body: Pick<BlockSubmit, "batchId" | "ops">) => Effect.Effect<BlockAck, ApiError>;
  /** A new block at the end of the top level, as actor; text is inline Markdown (code takes it as it is). */
  readonly append: (
    id: string,
    actor: string,
    type: BlockType,
    attrs: BlockAttrs,
    text: string,
  ) => Effect.Effect<[Block | undefined, BlockOpResult | undefined], ApiError>;
  /** A block's whole text written against baseRev, as actor; text is inline Markdown (code takes it as it is). */
  readonly updateText: (
    id: string,
    actor: string,
    block: string,
    baseRev: number,
    text: string,
  ) => Effect.Effect<[Block | undefined, BlockOpResult | undefined], ApiError>;
  /** A block of one of the kinds an agent writes appended at the end (artifact.block.create); refused for another kind. */
  readonly appendBlock: (id: string, actor: string, req: BlockCreate) => Effect.Effect<BlockOpResult, ApiError>;
  /** A block's text against the rev it was read at (artifact.block.update): a newer rev comes back as a conflict, not an error. */
  readonly updateBlock: (id: string, actor: string, req: BlockUpdate) => Effect.Effect<BlockOpResult, ApiError>;
  /** Starts the demo and returns at once (demo.ts). */
  readonly demo: (id: string, helpers: readonly Agent[]) => Effect.Effect<void, ApiError>;
  readonly demoRunning: () => boolean;
}

/** The block kinds an agent appends; the editor has more (dividers, images), which an agent does not write. */
const appendTypes: readonly BlockType[] = ["paragraph", "heading", "bulleted", "numbered", "todo", "quote", "code"];
const isAppendType = (type: string): type is BlockType => isOneOf(appendTypes, type);

const blockOf = (r: qb.ArtifactBlocksResult): Block =>
  wire({
    id: r.id,
    artifactId: r.artifact_id,
    ...(r.parent_id !== null ? { parentId: r.parent_id } : {}),
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

const blockIn = (ack: BlockAck, id: string) => ack.blocks.find((b) => b.id === id);

/** How long a demo waits between pieces; tests make it short. */
export interface BlocksOptions {
  readonly tickMs?: number;
}

/** found: the artifact's row, failing when there is none or it is not a blocks one. */
export const makeBlocks = (found: (id: string) => Effect.Effect<qa.ArtifactResult, ApiError>, options: BlocksOptions = {}) =>
  Effect.gen(function* () {
    const { run: db, inTx } = yield* Db;
    const lock = yield* Semaphore.make(1);
    const scope = yield* Effect.scope;
    const tick = options.tickMs ?? 1000;

    const blocksOf = (id: string) => db(Effect.map(qb.artifactBlocks({ artifact_id: id }), (rows) => rows.map(blockOf)));

    const blocks = Effect.fn("Blocks.blocks")(function* (id: string) {
      yield* found(id);
      return ordered(yield* blocksOf(id));
    });

    /** A batch already taken: its results then, its blocks now. */
    const again = Effect.fn("Blocks.again")(function* (id: string, seen: qc.ArtifactChangeByBatchResult) {
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
    const submitLocked = (id: string, actor: string, body: Pick<BlockSubmit, "batchId" | "ops">): Effect.Effect<BlockAck, ApiError> => {
      if (!body.batchId.trim()) return Effect.fail(refused(t("server.artifact.noBatch")));
      return inTx(
        Effect.gen(function* () {
          const row = yield* found(id);
          const seen = yield* db(Effect.catchNoSuchElement(qc.artifactChangeByBatch({ batch_id: body.batchId })));
          if (Option.isSome(seen)) return yield* again(id, seen.value);
          const now = yield* Clock.currentTimeMillis;
          const p = new Page(id, actor, now, yield* blocksOf(id));
          // The page asks synchronously, so what it may ask is read first: the base of each stale edit, the ids each insert makes.
          const revisions = new Map<string, TextSpan[]>();
          for (const op of body.ops) {
            if (op.op !== "update_text" && op.op !== "split_block") continue;
            const b = p.find(op.blockId);
            if (!b || op.baseRev > b.rev || revisions.has(`${b.id}@${op.baseRev}`)) continue;
            // An earlier op in this batch can advance rev without changing this text.
            if (op.baseRev === b.rev) {
              revisions.set(`${b.id}@${op.baseRev}`, b.text);
              continue;
            }
            const raw = yield* db(Effect.catchNoSuchElement(qr.artifactBlockRevision({ block_id: b.id, rev: op.baseRev })));
            if (Option.isSome(raw)) revisions.set(`${b.id}@${op.baseRev}`, storedSpans(raw.value.spans) ?? []);
          }
          const taken = new Set<string>();
          for (const op of body.ops) {
            const fresh = op.op === "insert_block" ? op.block.id : op.op === "split_block" ? op.newBlock.id : undefined;
            if (fresh && Option.isSome(yield* db(Effect.catchNoSuchElement(qb.artifactBlockOwner({ id: fresh }))))) taken.add(fresh);
          }
          p.base = (block, rev) => revisions.get(`${block}@${rev}`);
          p.taken = (block) => taken.has(block);
          const results = body.ops.map((op) => p.apply(op));
          const changed = p.changedBlocks();
          for (const b of changed)
            yield* db(
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
            );
          for (const r of p.revisions)
            yield* db(
              qr.addArtifactBlockRevision({
                id: newId(),
                block_id: r.block,
                rev: r.rev,
                spans: JSON.stringify(r.spans),
                actor,
                kind: r.kind,
                created_at: now,
              }),
            );
          const seq = row.seq + 1;
          yield* db(
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
          yield* db(qa.artifactAccepted({ id, seq, updated_at: now }));
          return { batchId: body.batchId, seq, results, blocks: changed };
        }),
      );
    };

    const submit = Effect.fn("Artifacts.submit")(function* (id: string, actor: string, body: Pick<BlockSubmit, "batchId" | "ops">) {
      return yield* submitLocked(id, actor, body);
    }, lock.withPermits(1));

    const keyOrRefuse = (a: string, b: string) => Effect.try({ try: () => keyBetween(a, b), catch: (e) => refused(messageOf(e)) });

    const one = (ack: BlockAck, id: string): [Block | undefined, BlockOpResult | undefined] => [blockIn(ack, id), ack.results[0]];

    const append = Effect.fn("Blocks.append")(function* (artifact: string, actor: string, type: BlockType, attrs: BlockAttrs, text: string) {
      const last = new Page(artifact, actor, 0, yield* blocksOf(artifact)).children("").at(-1)?.orderKey ?? "";
      const b: BlockInput = { id: newId(), orderKey: yield* keyOrRefuse(last, ""), type, attrs, text: spansOf(type, text) };
      return one(yield* submitLocked(artifact, actor, { batchId: newId(), ops: [{ op: "insert_block", block: b }] }), b.id);
    }, lock.withPermits(1));

    const updateText = Effect.fn("Blocks.updateText")(function* (artifact: string, actor: string, block: string, baseRev: number, text: string) {
      const type = (yield* blocksOf(artifact)).find((b) => b.id === block)?.type ?? "paragraph";
      return one(
        yield* submitLocked(artifact, actor, { batchId: newId(), ops: [{ op: "update_text", blockId: block, baseRev, text: spansOf(type, text) }] }),
        block,
      );
    }, lock.withPermits(1));

    const appendBlock = Effect.fn("Artifacts.appendBlock")(function* (artifact: string, actor: string, req: BlockCreate) {
      const type = (req.type ?? "").trim() || "paragraph";
      if (!isAppendType(type)) return yield* Effect.fail(refused(t("server.artifact.badBlockType", { types: list(appendTypes) })));
      const level = req.level !== undefined && req.level >= 1 && req.level <= 3 ? Math.trunc(req.level) : 2;
      const attrs: BlockAttrs = type === "heading" ? { level } : type === "todo" ? { checked: false } : {};
      const [, r] = yield* append(artifact, actor, type, attrs, req.text);
      return r ?? (yield* Effect.fail(refused(t("server.artifact.notApplied"))));
    });

    const updateBlock = Effect.fn("Artifacts.updateBlock")(function* (artifact: string, actor: string, req: BlockUpdate) {
      const [, r] = yield* updateText(artifact, actor, req.block.trim(), Math.trunc(req.baseRev), req.text);
      return r ?? (yield* Effect.fail(refused(t("server.artifact.notApplied"))));
    });

    const fill = Effect.fn("Blocks.fill")(function* (id: string, markdown: string, actor: string) {
      const parents: string[] = [];
      const last = new Map<string, string>();
      const ops = [];
      for (const b of blocksOfMarkdown(markdown)) {
        parents.length = b.depth;
        const parent = b.depth > 0 ? parents[b.depth - 1]! : "";
        const key = yield* keyOrRefuse(last.get(parent) ?? "", "");
        last.set(parent, key);
        const blockId = newId();
        parents.push(blockId);
        ops.push({
          op: "insert_block" as const,
          block: { id: blockId, ...(parent ? { parentId: parent } : {}), orderKey: key, type: b.type, attrs: b.attrs, text: b.text },
        });
      }
      if (ops.length > 0) yield* submit(id, actor, { batchId: newId(), ops });
    });

    let demoOn = false;
    /** About ticks of the tick, a bit more or less so the writers interleave. */
    const wait = (ticks: number) => Effect.sleep(ticks * (1 + demoJitter * (2 * Math.random() - 1)) * tick);

    /** Inserts b at the end of the top level, or at the end of a section; the key is picked under the batch lock, so two writers cannot pick the same place. */
    const demoInsert = Effect.fn("Blocks.demoInsert")(function* (
      artifact: string,
      writer: string,
      b: Omit<BlockInput, "orderKey">,
      at?: { headings: string[]; section: number },
    ) {
      // Tombstones too: their keys still hold their places.
      const top = new Page(artifact, writer, 0, yield* blocksOf(artifact)).children("");
      let after = top.at(-1)?.orderKey ?? "";
      let before = "";
      if (at && at.section + 1 < at.headings.length) {
        const i = top.findIndex((x) => x.id === at.headings[at.section + 1]);
        if (i >= 0) {
          before = top[i]!.orderKey;
          after = i > 0 ? top[i - 1]!.orderKey : "";
        }
      }
      const block = { ...b, orderKey: yield* keyOrRefuse(after, before) };
      const ack = yield* submitLocked(artifact, writer, { batchId: newId(), ops: [{ op: "insert_block", block }] });
      const r = ack.results[0];
      if (r?.status !== "applied") return yield* Effect.fail(refused(t("server.artifact.demoNotInserted", { status: String(r?.status) })));
      return blockIn(ack, b.id)!.rev;
    }, lock.withPermits(1));

    /** One writer: each paragraph of its section, inserted empty at the section's end, then grown a piece a tick. */
    const demoWrite = Effect.fn("Blocks.demoWrite")(function* (artifact: string, writer: string, headings: string[], section: DemoSection) {
      for (const text of demoParagraphs(section)) {
        const b: Omit<BlockInput, "orderKey"> = { id: newId(), type: "paragraph", attrs: {}, text: [] };
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

    const runDemo = Effect.fn("Blocks.runDemo")(
      function* (artifact: string, writers: readonly { readonly writer: string; readonly section: DemoSection }[]) {
        const headings: string[] = [];
        for (const { writer: w, section } of writers) {
          const b: Omit<BlockInput, "orderKey"> = {
            id: newId(),
            type: "heading",
            attrs: { level: 2 },
            text: spansOf("heading", t(`server.artifact.demo.${section}.heading`)),
          };
          yield* demoInsert(artifact, w, b);
          headings.push(b.id);
          yield* wait(0.5);
        }
        yield* Effect.forEach(writers, ({ writer, section }) => Effect.andThen(wait(section / 3), demoWrite(artifact, writer, headings, section)), {
          concurrency: "unbounded",
          discard: true,
        });
      },
      (e) => e.pipe(Effect.ignore, Effect.ensuring(Effect.sync(() => (demoOn = false)))),
    );

    const demo = Effect.fn("Artifacts.demo")(function* (id: string, helpers: readonly Agent[]) {
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

    const shape: Blocks = {
      demoRunning: () => demoOn,
      blocks,
      fill,
      markdown: Effect.fn("Artifacts.markdown")(function* (id) {
        return markdownOf(yield* blocks(id));
      }),
      submit,
      append,
      updateText,
      appendBlock,
      updateBlock,
      demo,
    };
    return shape;
  });
