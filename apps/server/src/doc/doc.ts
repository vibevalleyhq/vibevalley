// Documents, changed only by batches of ops (ops.ts), from the owner over HTTP and from helpers
// through their tools, all down the same pipeline. One batch at a time for every document: a document's batches are
// serial and its seq goes up in order.

import { docWording } from "./words.ts";
import type {
  Agent,
  Block,
  BlockAttrs,
  BlockInput,
  DocAck,
  DocBlockCreate,
  DocBlockUpdate,
  DocOpResult,
  DocSnapshot,
  DocSpan,
  DocSubmit,
  Document,
} from "@vibevalley/protocol";
import { Clock, Context, Effect, Layer, Option, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/sql";
import { Db } from "../base/db.ts";
import { newId } from "../base/ids.ts";
import { type ApiError, missing, lookIn, refused } from "../errors.ts";
import { blocksOfMarkdown, inlineSpans, markdownOf } from "./markdown.ts";
import { keyBetween } from "@vibevalley/protocol/rules";
import { ordered, Page, wire } from "./ops.ts";
import { unmarked } from "./text.ts";
import { demoJitter, demoPieces } from "./demo.ts";
import * as qb from "../../db/generated/doc_block.sql.ts";
import * as qr from "../../db/generated/doc_block_revision.sql.ts";
import * as qc from "../../db/generated/doc_change.sql.ts";
import * as qd from "../../db/generated/doc.sql.ts";
import { jsonOf } from "../base/json.ts";
import * as S from "@vibevalley/protocol/schema";

const attrsOf = jsonOf(S.BlockAttrs);
const storedSpans = jsonOf(Schema.NullOr(Schema.mutable(Schema.Array(S.DocSpan))));
const idsOf = jsonOf(Schema.mutable(Schema.Array(Schema.String)));
const resultsOf = jsonOf(Schema.mutable(Schema.Array(S.DocOpResult)));

export interface DocShape {
  readonly list: () => Effect.Effect<Document[]>;
  readonly create: (title: string) => Effect.Effect<DocSnapshot, ApiError>;
  /** A document made from Markdown, its blocks inserted as one batch by actor. */
  readonly importMarkdown: (title: string, markdown: string, actor: string) => Effect.Effect<DocSnapshot, ApiError>;
  readonly get: (id: string) => Effect.Effect<DocSnapshot, ApiError>;
  readonly markdown: (id: string) => Effect.Effect<string, ApiError>;
  /** A batch of ops from actor (the owner, or a helper's profile id), in order, in one transaction. A batch id seen before is answered as it was, with its blocks as they are now. */
  readonly submit: (id: string, actor: string, body: Pick<DocSubmit, "batchId" | "ops">) => Effect.Effect<DocAck, ApiError>;
  /** A new block at the end of the document's top level, as actor; text is inline Markdown (code takes it as it is). */
  readonly append: (
    doc: string,
    actor: string,
    type: string,
    attrs: BlockAttrs,
    text: string,
  ) => Effect.Effect<[Block | undefined, DocOpResult | undefined], ApiError>;
  /** A block's whole text written against baseRev, as actor; text is inline Markdown (code takes it as it is). */
  readonly updateText: (
    doc: string,
    actor: string,
    block: string,
    baseRev: number,
    text: string,
  ) => Effect.Effect<[Block | undefined, DocOpResult | undefined], ApiError>;
  /** A block of one of the kinds an agent writes appended at the end (doc.block.create); refused for another kind. */
  readonly appendBlock: (doc: string, actor: string, req: DocBlockCreate) => Effect.Effect<DocOpResult, ApiError>;
  /** A block's text against the rev it was read at (doc.block.update): a newer rev comes back as a conflict, not an error. */
  readonly updateBlock: (doc: string, actor: string, req: DocBlockUpdate) => Effect.Effect<DocOpResult, ApiError>;
  /** Starts the demo and returns at once (demo.ts). */
  readonly demo: (id: string, helpers: readonly Agent[]) => Effect.Effect<void, ApiError>;
}

export class Docs extends Context.Service<Docs, DocShape>()("vibevalley/Doc") {}

/** The block kinds an agent appends; the editor has more (dividers, images), which an agent does not write. */
const appendTypes = ["paragraph", "heading", "bulleted", "numbered", "todo", "quote", "code"];

const missingDoc = (id: string) => missing(docWording().doc(id), [lookIn.doc]);

const titleOf = (title: string) => title.trim() || docWording().untitled;

const document = (d: qd.DocResult): Document => ({ id: d.id, title: d.title, seq: d.seq, created: d.created_at, updated: d.updated_at });

const blockOf = (r: qb.DocBlocksResult): Block =>
  wire({
    id: r.id,
    docId: r.doc_id,
    ...(r.parent_id !== null ? { parentId: r.parent_id } : {}),
    orderKey: r.order_key,
    type: r.type,
    attrs: attrsOf(r.attrs),
    text: storedSpans(r.spans) ?? [],
    rev: r.rev,
    deleted: r.deleted,
    updatedBy: r.updated_by,
    updated: r.updated_at,
  });

export const spansOf = (type: string, text: string) => (type === "code" ? unmarked([{ t: text, marks: {} }]) : inlineSpans(text));

const blockIn = (ack: DocAck, id: string) => ack.blocks.find((b) => b.id === id);

/** How long a demo waits between pieces; tests make it short. */
export interface DocOptions {
  readonly tickMs?: number;
}

export const make = (options: DocOptions = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { run: db } = yield* Db;
    const lock = yield* Semaphore.make(1);
    const scope = yield* Effect.scope;
    const tick = options.tickMs ?? 1000;

    const findDoc = (id: string) => db(Effect.catchNoSuchElement(qd.doc({ id })));
    const blocksOf = (doc: string) => db(Effect.map(qb.docBlocks({ doc_id: doc }), (rows) => rows.map(blockOf)));

    const get = Effect.fn("Docs.get")(function* (id: string) {
      const d = yield* findDoc(id);
      if (Option.isNone(d)) return yield* Effect.fail(missingDoc(id));
      return { doc: document(d.value), blocks: ordered(yield* blocksOf(id)) };
    });

    const create = Effect.fn("Docs.create")(function* (title: string) {
      const now = yield* Clock.currentTimeMillis;
      const id = newId();
      yield* db(qd.addDoc({ id, title: titleOf(title), created_at: now, updated_at: now }));
      return yield* get(id);
    });

    /** A batch already taken: its results then, its blocks now. */
    const again = Effect.fn("Docs.again")(function* (doc: string, seen: qc.DocChangeByBatchResult) {
      if (seen.doc_id !== doc) return yield* Effect.fail(refused(docWording().otherDoc(seen.batch_id)));
      const ids = idsOf(seen.block_ids);
      const all = yield* blocksOf(doc);
      return {
        batchId: seen.batch_id,
        seq: seen.seq,
        results: resultsOf(seen.results),
        blocks: ids.flatMap((id) => all.filter((b) => b.id === id)),
      };
    });

    /** One batch, under the lock the caller holds. */
    const submitLocked = (id: string, actor: string, body: Pick<DocSubmit, "batchId" | "ops">): Effect.Effect<DocAck, ApiError> => {
      if (!body.batchId?.trim()) return Effect.fail(refused(docWording().noBatch));
      return sql
        .withTransaction(
          Effect.gen(function* () {
            const d = yield* findDoc(id);
            if (Option.isNone(d)) return yield* Effect.fail(missingDoc(id));
            const seen = yield* db(Effect.catchNoSuchElement(qc.docChangeByBatch({ batch_id: body.batchId })));
            if (Option.isSome(seen)) return yield* again(id, seen.value);
            const now = yield* Clock.currentTimeMillis;
            const p = new Page(id, actor, now, yield* blocksOf(id));
            // The page asks synchronously, so what it may ask is read first: the base of each stale edit, the ids each insert makes.
            const revisions = new Map<string, DocSpan[]>();
            for (const op of body.ops ?? []) {
              if (op.op !== "update_text" && op.op !== "split_block") continue;
              const b = p.find(op.blockId);
              if (!b || op.baseRev > b.rev || revisions.has(`${b.id}@${op.baseRev}`)) continue;
              // An earlier op in this batch can advance rev without changing this text.
              if (op.baseRev === b.rev) {
                revisions.set(`${b.id}@${op.baseRev}`, b.text);
                continue;
              }
              const raw = yield* db(Effect.catchNoSuchElement(qr.docBlockRevision({ block_id: b.id, rev: op.baseRev })));
              if (Option.isSome(raw)) revisions.set(`${b.id}@${op.baseRev}`, storedSpans(raw.value.spans) ?? []);
            }
            const taken = new Set<string>();
            for (const op of body.ops ?? []) {
              const fresh = op.op === "insert_block" ? op.block.id : op.op === "split_block" ? op.newBlock.id : undefined;
              if (fresh && Option.isSome(yield* db(Effect.catchNoSuchElement(qb.docBlockDoc({ id: fresh }))))) taken.add(fresh);
            }
            p.base = (block, rev) => revisions.get(`${block}@${rev}`);
            p.taken = (block) => taken.has(block);
            const results = (body.ops ?? []).map((op) => p.apply(op));
            const changed = p.changedBlocks();
            for (const b of changed)
              yield* db(
                qb.putDocBlock({
                  id: b.id,
                  doc_id: id,
                  parent_id: b.parentId ?? null,
                  order_key: b.orderKey,
                  type: b.type,
                  attrs: JSON.stringify(b.attrs),
                  spans: JSON.stringify(b.text),
                  rev: b.rev,
                  deleted: !!b.deleted,
                  updated_by: b.updatedBy,
                  updated_at: b.updated,
                }),
              );
            for (const r of p.revisions)
              yield* db(
                qr.addDocBlockRevision({ id: newId(), block_id: r.block, rev: r.rev, spans: JSON.stringify(r.spans), actor, kind: r.kind, created_at: now }),
              );
            const seq = d.value.seq + 1;
            yield* db(
              qc.addDocChange({
                doc_id: id,
                seq,
                batch_id: body.batchId,
                actor,
                block_ids: JSON.stringify(p.changed),
                results: JSON.stringify(results),
                created_at: now,
              }),
            );
            yield* db(qd.docAccepted({ id, seq, updated_at: now }));
            return { batchId: body.batchId, seq, results, blocks: changed };
          }),
        )
        .pipe(Effect.catchTag("SqlError", Effect.die));
    };

    const submit = (id: string, actor: string, body: Pick<DocSubmit, "batchId" | "ops">) => lock.withPermits(1)(submitLocked(id, actor, body));

    const keyOrRefuse = (a: string, b: string) => Effect.try({ try: () => keyBetween(a, b), catch: (e) => refused((e as Error).message) });

    const one = (ack: DocAck, id: string): [Block | undefined, DocOpResult | undefined] => [blockIn(ack, id), ack.results[0]];

    const append = Effect.fn("Docs.append")(function* (doc: string, actor: string, type: string, attrs: BlockAttrs, text: string) {
      const last = new Page(doc, actor, 0, yield* blocksOf(doc)).children("").at(-1)?.orderKey ?? "";
      const b: BlockInput = { id: newId(), orderKey: yield* keyOrRefuse(last, ""), type, attrs, text: spansOf(type, text) };
      return one(yield* submitLocked(doc, actor, { batchId: newId(), ops: [{ op: "insert_block", block: b }] }), b.id);
    }, lock.withPermits(1));

    const updateText = Effect.fn("Docs.updateText")(function* (doc: string, actor: string, block: string, baseRev: number, text: string) {
      const type = (yield* blocksOf(doc)).find((b) => b.id === block)?.type ?? "paragraph";
      return one(
        yield* submitLocked(doc, actor, { batchId: newId(), ops: [{ op: "update_text", blockId: block, baseRev, text: spansOf(type, text) }] }),
        block,
      );
    }, lock.withPermits(1));

    const appendBlock = Effect.fn("Docs.appendBlock")(function* (doc: string, actor: string, req: DocBlockCreate) {
      const type = (req.type ?? "").trim() || "paragraph";
      if (!appendTypes.includes(type)) return yield* Effect.fail(refused(docWording().badBlockType(appendTypes)));
      const level = req.level !== undefined && req.level >= 1 && req.level <= 3 ? Math.trunc(req.level) : 2;
      const attrs: BlockAttrs = type === "heading" ? { level } : type === "todo" ? { checked: false } : {};
      const [, r] = yield* append(doc, actor, type, attrs, req.text);
      return r ?? (yield* Effect.fail(refused(docWording().notApplied)));
    });

    const updateBlock = Effect.fn("Docs.updateBlock")(function* (doc: string, actor: string, req: DocBlockUpdate) {
      const [, r] = yield* updateText(doc, actor, req.block.trim(), Math.trunc(req.baseRev), req.text);
      return r ?? (yield* Effect.fail(refused(docWording().notApplied)));
    });

    const importMarkdown = Effect.fn("Docs.importMarkdown")(function* (title: string, markdown: string, actor: string) {
      const created = yield* create(title);
      const parents: string[] = [];
      const last = new Map<string, string>();
      const ops = [];
      for (const b of blocksOfMarkdown(markdown)) {
        parents.length = b.depth;
        const parent = b.depth > 0 ? parents[b.depth - 1]! : "";
        const key = yield* keyOrRefuse(last.get(parent) ?? "", "");
        last.set(parent, key);
        const id = newId();
        parents.push(id);
        ops.push({
          op: "insert_block" as const,
          block: { id, ...(parent ? { parentId: parent } : {}), orderKey: key, type: b.type, attrs: b.attrs, text: b.text },
        });
      }
      if (ops.length > 0) yield* submit(created.doc.id, actor, { batchId: newId(), ops });
      return yield* get(created.doc.id);
    });

    let demoOn = false;
    /** About ticks of the tick, a bit more or less so the writers interleave. */
    const wait = (ticks: number) => Effect.sleep(ticks * (1 + demoJitter * (2 * Math.random() - 1)) * tick);

    /** Inserts b at the end of the top level, or at the end of a section; the key is picked under the batch lock, so two writers cannot pick the same place. */
    const demoInsert = Effect.fn("Docs.demoInsert")(function* (
      doc: string,
      writer: string,
      b: Omit<BlockInput, "orderKey">,
      at?: { headings: string[]; section: number },
    ) {
      // Tombstones too: their keys still hold their places.
      const top = new Page(doc, writer, 0, yield* blocksOf(doc)).children("");
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
      const ack = yield* submitLocked(doc, writer, { batchId: newId(), ops: [{ op: "insert_block", block }] });
      const r = ack.results[0];
      if (r?.status !== "applied") return yield* Effect.fail(refused(docWording().demoNotInserted(String(r?.status))));
      return blockIn(ack, b.id)!.rev;
    }, lock.withPermits(1));

    /** One writer: each paragraph of its section, inserted empty at the section's end, then grown a piece a tick. */
    const demoWrite = Effect.fn("Docs.demoWrite")(function* (doc: string, writer: string, headings: string[], section: number) {
      for (const text of docWording().demo[section]!.paragraphs) {
        const b = { id: newId(), type: "paragraph", attrs: {}, text: [] };
        let rev = yield* demoInsert(doc, writer, b, { headings, section });
        const chars = Array.from(text);
        for (let n = 1; n <= demoPieces; n++) {
          yield* wait(1);
          const [, r] = yield* updateText(doc, writer, b.id, rev, chars.slice(0, Math.floor((chars.length * n) / demoPieces)).join(""));
          // The owner wrote in it (or removed it): the block is theirs now, the writer goes on to its next paragraph.
          if (r?.status !== "applied") break;
          rev = r.rev ?? rev;
        }
        yield* wait(0.8);
      }
    });

    const runDemo = Effect.fn("Docs.runDemo")(
      function* (doc: string, writers: string[]) {
        const headings: string[] = [];
        for (const [i, w] of writers.entries()) {
          const b = { id: newId(), type: "heading", attrs: { level: 2 }, text: spansOf("heading", docWording().demo[i]!.heading) };
          yield* demoInsert(doc, w, b);
          headings.push(b.id);
          yield* wait(0.5);
        }
        yield* Effect.forEach(writers, (w, i) => Effect.andThen(wait(i / 3), demoWrite(doc, w, headings, i)), { concurrency: "unbounded", discard: true });
      },
      (e) => e.pipe(Effect.ignore, Effect.ensuring(Effect.sync(() => (demoOn = false)))),
    );

    const demo = Effect.fn("Docs.demo")(function* (id: string, helpers: readonly Agent[]) {
      if (Option.isNone(yield* findDoc(id))) return yield* Effect.fail(missingDoc(id));
      const writers = helpers
        .filter((a) => a.enabled)
        .slice(0, docWording().demo.length)
        .map((a) => a.id);
      if (writers.length === 0) return yield* Effect.fail(refused(docWording().noWriter, [lookIn.agent]));
      if (demoOn) return yield* Effect.fail(refused(docWording().demoRunning));
      demoOn = true;
      // The demo lives as long as the service: stopping the farm stops it.
      yield* Effect.forkIn(runDemo(id, writers), scope);
    });

    const shape: DocShape & { readonly demoRunning: () => boolean } = {
      demoRunning: () => demoOn,
      list: () => db(Effect.map(qd.docs(), (rows) => rows.map(document))),
      create,
      importMarkdown,
      get,
      markdown: (id) => Effect.map(get(id), (s) => markdownOf(s.blocks)),
      submit,
      append,
      updateText,
      appendBlock,
      updateBlock,
      demo,
    };
    return shape;
  });

export const layer = (options?: DocOptions) => Layer.effect(Docs, make(options));
