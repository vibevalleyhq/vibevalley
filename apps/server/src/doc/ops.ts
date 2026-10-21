// The op rules, over one document held in memory: Submit loads the page in a transaction,
// applies a batch's ops in order and writes back what changed. A stale update (baseRev behind) is taken only when the
// block's text has not changed since baseRev; otherwise it is a conflict and the block keeps what it has.

import type {
  Block,
  BlockAttrs,
  DocOp,
  DocOpMoveBlock,
  DocOpMergeBlocks,
  DocOpResult,
  DocOpSplitBlock,
  DocOpStatus,
  DocOpUpdateText,
  DocSpan,
} from "@vibevalley/protocol";
import { keyBetween, validKey } from "@vibevalley/protocol/rules";
import { joined, normal, runeLen, sameText, splitAt, unmarked } from "./text.ts";

const withText: Readonly<Record<string, boolean>> = {
  paragraph: true,
  heading: true,
  bulleted: true,
  numbered: true,
  todo: true,
  quote: true,
  code: true,
  memory_item: true,
  divider: false,
  image: false,
  issue_ref: false,
};

export const knownType = (t: string) => t in withText;

export interface Revision {
  readonly block: string;
  readonly rev: number;
  readonly spans: DocSpan[];
  readonly kind: "normal" | "conflict";
}

/** A result as the wire has it: rev 0, no reason and no texts are left out. */
export function result(status: DocOpStatus, blockId: string, rev = 0, more: { yours?: DocSpan[]; reason?: string } = {}): DocOpResult {
  return { status, blockId, ...(rev ? { rev } : {}), ...(more.yours ? { yours: more.yours } : {}), ...(more.reason ? { reason: more.reason } : {}) };
}

const applied = (b: Block) => result("applied", b.id, b.rev);
const rejected = (id: string, reason: string) => result("rejected", id, 0, { reason });
const gone = (b: Block) => result("conflict", b.id, b.rev, { reason: "这一块已经删掉了" });

export const parentOf = (b: Block) => b.parentId ?? "";

export function textFor(type: string, spans: readonly DocSpan[] | undefined): DocSpan[] {
  if (!withText[type]) return [];
  if (type === "code") return unmarked(spans ?? []);
  return normal(spans);
}

/** The attributes as the wire has them: only those set. */
export const attrsOf = (a: BlockAttrs | undefined): BlockAttrs =>
  Object.fromEntries(Object.entries(a ?? {}).filter(([, v]) => v !== undefined && v !== null)) as BlockAttrs;

const attrNames = ["level", "checked", "language", "src", "width", "height", "alt", "issueId", "memoryId"] as const;

/** Lays a set_attrs patch over attrs: what the patch sets is written, the names in unset removed. */
export function patched(attrs: BlockAttrs, patch: BlockAttrs, unset: readonly string[] = []): BlockAttrs {
  const out: Record<string, unknown> = { ...attrs };
  for (const name of attrNames) if (patch[name] !== undefined && patch[name] !== null) out[name] = patch[name];
  for (const name of unset) {
    if (!(attrNames as readonly string[]).includes(name)) throw new Error(`没有属性 ${name}`);
    delete out[name];
  }
  return out as BlockAttrs;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A block as the wire has it: no parent, and not deleted, are left out. */
export function wire(b: Block): Block {
  const { parentId, deleted, ...rest } = b;
  return { ...rest, ...(parentId !== undefined ? { parentId } : {}), ...(deleted ? { deleted: true } : {}) };
}

export class Page {
  readonly blocks = new Map<string, Block>();
  readonly changed: string[] = [];
  readonly revisions: Revision[] = [];
  /** The block's text at a rev, from its revisions; undefined when there is none. */
  base: (block: string, rev: number) => DocSpan[] | undefined = () => undefined;
  /** A block id another document has. */
  taken: (id: string) => boolean = () => false;

  constructor(
    readonly doc: string,
    readonly actor: string,
    readonly now: number,
    blocks: readonly Block[],
  ) {
    for (const b of blocks) this.blocks.set(b.id, { ...b });
  }

  /** The changed blocks, in the order they were first changed. */
  changedBlocks(): Block[] {
    return this.changed.map((id) => wire(this.blocks.get(id)!));
  }

  /** Marks a block changed by this op: one more rev, and its text at that rev kept. */
  private touch(b: Block) {
    b.rev++;
    b.updatedBy = this.actor;
    b.updated = this.now;
    if (!this.changed.includes(b.id)) this.changed.push(b.id);
    this.revisions.push({ block: b.id, rev: b.rev, spans: b.text, kind: "normal" });
  }

  find(id: string) {
    return this.blocks.get(id);
  }

  /** The children of parent ("" is the top), tombstones included, in order. */
  children(parent: string): Block[] {
    return [...this.blocks.values()].filter((b) => parentOf(b) === parent).sort((a, b) => compare(a.orderKey, b.orderKey) || compare(a.id, b.id));
  }

  /** Where a block goes under parent: a deleted parent hands it to the level that parent was at. */
  private liveParent(parent: string): string | undefined {
    while (parent !== "") {
      const b = this.find(parent);
      if (!b) throw new Error(`没有块 ${parent}`);
      if (!b.deleted) return b.id;
      parent = parentOf(b);
    }
    return undefined;
  }

  /** Checks a block the client made, and fills in what the server decides; a string is why it cannot be. */
  private fresh(b: Block): Block | string {
    if (!b.id) return "新块没有 id";
    if (this.find(b.id) || this.taken(b.id)) return "块 " + b.id + " 已经有了";
    if (!knownType(b.type)) return "不认识的块类型 " + b.type;
    if (!validKey(b.orderKey)) return "不是有效的顺序键：" + b.orderKey;
    let parent: string | undefined;
    try {
      parent = this.liveParent(b.parentId ?? "");
    } catch (e) {
      return (e as Error).message;
    }
    const { parentId: _, deleted: __, ...rest } = b;
    return {
      ...rest,
      ...(parent !== undefined ? { parentId: parent } : {}),
      docId: this.doc,
      rev: 0,
      attrs: attrsOf(b.attrs),
      text: textFor(b.type, b.text),
      updatedBy: "",
      updated: 0,
    };
  }

  /** The block's text now is what it was at rev, so an edit made against rev loses nothing of anyone's. */
  private unchangedSince(b: Block, rev: number) {
    if (rev === b.rev) return true;
    const base = this.base(b.id, rev);
    return base !== undefined && sameText(base, b.text);
  }

  apply(op: DocOp): DocOpResult {
    switch (op.op) {
      case "insert_block": {
        const b = this.fresh(op.block);
        if (typeof b === "string") return rejected(op.block.id, b);
        this.blocks.set(b.id, b);
        this.touch(b);
        return applied(b);
      }
      case "update_text":
        return this.updateText(op);
      case "set_attrs": {
        const b = this.find(op.blockId);
        if (!b) return rejected(op.blockId, "没有这一块");
        if (b.deleted) return gone(b);
        try {
          b.attrs = patched(b.attrs, op.attrs ?? {}, op.unset);
        } catch (e) {
          return rejected(b.id, (e as Error).message);
        }
        this.touch(b);
        return applied(b);
      }
      case "set_type": {
        const b = this.find(op.blockId);
        if (!b) return rejected(op.blockId, "没有这一块");
        if (b.deleted) return gone(b);
        if (!knownType(op.type)) return rejected(b.id, "不认识的块类型 " + op.type);
        b.type = op.type;
        b.attrs = attrsOf(op.attrs);
        b.text = textFor(op.type, b.text);
        this.touch(b);
        return applied(b);
      }
      case "move_block":
        return this.move(op);
      case "delete_block": {
        const b = this.find(op.blockId);
        if (!b) return rejected(op.blockId, "没有这一块");
        if (b.deleted) return result("noop", b.id, b.rev);
        this.setDeleted(b, true);
        return applied(b);
      }
      case "restore_block": {
        const b = this.find(op.blockId);
        if (!b) return rejected(op.blockId, "没有这一块");
        if (!b.deleted) return result("noop", b.id, b.rev);
        try {
          const parent = this.liveParent(parentOf(b));
          if (parent === undefined) delete b.parentId;
          else b.parentId = parent;
        } catch (e) {
          return rejected(b.id, (e as Error).message);
        }
        this.setDeleted(b, false);
        return applied(b);
      }
      case "split_block":
        return this.split(op);
      case "merge_blocks":
        return this.merge(op);
    }
    return rejected("", `不认识的改动 ${(op as { op: string }).op}`);
  }

  private updateText(o: DocOpUpdateText): DocOpResult {
    const b = this.find(o.blockId);
    if (!b) return rejected(o.blockId, "没有这一块");
    if (!withText[b.type]) return rejected(b.id, "这一块没有字");
    if (o.baseRev > b.rev || o.baseRev < 1) return rejected(b.id, `没有第 ${o.baseRev} 版`);
    const yours = textFor(b.type, o.text);
    if (b.deleted) {
      this.lost(b, yours);
      return gone(b);
    }
    if (!this.unchangedSince(b, o.baseRev)) {
      this.lost(b, yours);
      return result("conflict", b.id, b.rev, { yours, reason: "这一块刚被别人改过" });
    }
    if (sameText(yours, b.text)) return applied(b);
    b.text = yours;
    this.touch(b);
    return applied(b);
  }

  /** Keeps a text that was not taken, at the rev it lost to. */
  private lost(b: Block, yours: DocSpan[]) {
    this.revisions.push({ block: b.id, rev: b.rev, spans: yours, kind: "conflict" });
  }

  private setDeleted(b: Block, deleted: boolean) {
    b.deleted = deleted;
    this.touch(b);
    for (const c of this.children(b.id)) if (!!c.deleted !== deleted) this.setDeleted(c, deleted);
  }

  private move(o: DocOpMoveBlock): DocOpResult {
    const b = this.find(o.blockId);
    if (!b) return rejected(o.blockId, "没有这一块");
    if (b.deleted) return gone(b);
    if (!validKey(o.orderKey)) return rejected(b.id, "不是有效的顺序键：" + o.orderKey);
    let parent: string | undefined;
    try {
      parent = this.liveParent(o.parentId ?? "");
    } catch (e) {
      return rejected(b.id, (e as Error).message);
    }
    for (let at = parent ?? ""; at !== ""; at = parentOf(this.find(at)!)) if (at === b.id) return rejected(b.id, "不能挪到自己下面");
    if (parent === undefined) delete b.parentId;
    else b.parentId = parent;
    b.orderKey = o.orderKey;
    this.touch(b);
    return applied(b);
  }

  private split(o: DocOpSplitBlock): DocOpResult {
    const b = this.find(o.blockId);
    if (!b) return rejected(o.blockId, "没有这一块");
    if (!withText[b.type]) return rejected(b.id, "这一块没有字");
    if (o.baseRev > b.rev || o.baseRev < 1) return rejected(b.id, `没有第 ${o.baseRev} 版`);
    if (b.deleted) return gone(b);
    const nb = this.fresh(o.newBlock);
    if (typeof nb === "string") return rejected(b.id, nb);
    let status: DocOpStatus = "applied";
    let reason: string | undefined;
    let at = o.offset;
    if (!this.unchangedSince(b, o.baseRev)) {
      // The offset was into a text that is no longer there: the block keeps all of its text and the new one starts empty.
      at = runeLen(b.text);
      status = "conflict";
      reason = "这一块刚被别人改过，从末尾拆开了";
    } else if (at < 0 || at > runeLen(b.text)) return rejected(b.id, `拆分位置 ${at} 不在字里（${runeLen(b.text)} 个字）`);
    const [left, right] = splitAt(b.text, at);
    b.text = left;
    nb.text = textFor(nb.type, right);
    this.blocks.set(nb.id, nb);
    this.touch(b);
    this.touch(nb);
    return result(status, b.id, b.rev, { reason });
  }

  private merge(o: DocOpMergeBlocks): DocOpResult {
    const target = this.find(o.targetId);
    const source = this.find(o.sourceId);
    if (!target) return rejected(o.targetId, "没有这一块");
    if (!source) return rejected(o.sourceId, "没有这一块");
    if (target.id === source.id) return rejected(target.id, "不能并进自己");
    if (source.deleted) return result("noop", target.id, target.rev);
    if (target.deleted) return gone(target);
    if (!withText[target.type]) return rejected(target.id, "这一块没有字");
    // Both texts as they are now: there is nothing stale to conflict with.
    target.text = textFor(target.type, joined(target.text, source.text));
    let last = this.children(target.id).at(-1)?.orderKey ?? "";
    for (const c of this.children(source.id)) {
      let key: string;
      try {
        key = keyBetween(last, "");
      } catch (e) {
        return rejected(c.id, (e as Error).message);
      }
      c.parentId = target.id;
      c.orderKey = key;
      last = key;
      this.touch(c);
    }
    this.touch(target);
    source.deleted = true;
    this.touch(source);
    return applied(target);
  }
}

/** The live blocks in document order: each block, then its children. */
export function ordered(blocks: readonly Block[]): Block[] {
  const p = new Page("", "", 0, blocks);
  const out: Block[] = [];
  const walk = (parent: string) => {
    for (const b of p.children(parent)) {
      if (b.deleted) continue;
      out.push(b);
      walk(b.id);
    }
  };
  walk("");
  // A live block under a missing parent still shows, at the end.
  for (const b of blocks) if (!b.deleted && b.parentId !== undefined && !p.find(b.parentId)) out.push(b);
  return out.map(wire);
}
