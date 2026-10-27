// The document being edited: blocks in order, the owner's edits as ops
// waiting to go, one batch on the wire at a time. What comes back replaces the blocks, except the text of a block the
// owner is still typing or composing a word in. The page draws it and calls in; a change notifies the subscribers.

import { pagesWording } from "../../base/words/pages";
import {
  type Block,
  type BlockAttrs,
  type BlockInput,
  blockCode,
  blockParagraph,
  blockTodo,
  blockQuote,
  type DocOp,
  docOwner,
  type DocSnapshot,
  type DocSpan,
  type Document,
  type VibeValleyApi,
} from "@vibevalley/protocol";
import { keyBetween } from "@vibevalley/protocol/rules";
import { reasonOf } from "../../base/api";
import { codePointOffset, editSpans, hasText, knownTypes, listNumbers, listTypes, markdownShortcut, normalSpans, plainOf, splitSpans } from "./blocks";

/** Text edits wait this long after the last key, and no longer than maxWait while typing goes on. */
export const idleWait = 500;
export const maxWait = 2000;

/** How often an open document asks for what others (helpers) wrote while nothing of the owner's waits: every pollFast
 * while another writer was heard in the last busyPolls asks (or the demo was just started), else pollEvery. */
export const pollEvery = 4000;
export const pollFast = 1000;
const busyPolls = 4;

/** A block another writer changed shows as being written for this many asks after the change was heard. */
const writingPolls = 3;

/** A uuid (v4) for a block this client inserts: block ids are the inserter's to make. */
export const newBlockId = () => crypto.randomUUID();

/** One block as the editor holds it: the server's last word on it (rev, who wrote it) and the owner's text as it is now. */
export class EditBlock {
  readonly id: string;
  parentId?: string;
  orderKey: string;
  type: string;
  attrs: BlockAttrs;
  spans: DocSpan[];
  /** Zero is local: edits of a new block wait behind its insertion until the server supplies a revision. */
  rev: number;
  updatedBy: string;
  /** The text in its field. */
  text: string;
  /** The ask that last brought another writer's change to this block (display only: it shows as being written). */
  heardAt?: number;
  /** The text the server has, as far as this client knows: an update is sent only when the owner's differs. */
  sent: DocSpan[];
  /** Set when the server did not take the owner's text. */
  problem?: string;
  composing = false;
  focused = false;
  /** Where the caret goes once the field is drawn again: the editor moved the text under it. */
  caret?: number;

  constructor(b: BlockInput | Block) {
    this.id = b.id;
    this.parentId = b.parentId;
    this.orderKey = b.orderKey;
    this.type = b.type;
    this.attrs = b.attrs;
    this.spans = b.text;
    this.sent = b.text;
    this.rev = "rev" in b ? b.rev : 0;
    this.updatedBy = "updatedBy" in b ? b.updatedBy : docOwner;
    this.text = plainOf(b.text);
  }
}

interface Pending {
  /** The blocks it changes: their text is not replaced by the server's until it has gone. */
  readonly ids: ReadonlySet<string>;
  /** Made when the batch goes: an op written against a rev takes the rev the client knows then. */
  readonly build: () => DocOp;
  /** The block whose rev the op is written against. */
  readonly base?: string;
}

export class DocEditor {
  doc?: Document;
  error?: string;
  blocks: EditBlock[] = [];
  /** The block to focus once drawn. */
  focusId?: string;

  private readonly byId = new Map<string, EditBlock>();
  private seq = 0;
  private readonly queue: Pending[] = [];
  private readonly dirty = new Set<string>();
  // Removed here before the server has heard: an answer about one does not bring it back, but its rev still counts for an
  // op queued against it before it went (the text typed into a block just split off, then joined back).
  private readonly gone = new Map<string, EditBlock>();
  private inflight?: { id: string; ops: DocOp[]; ids: Set<string> };
  private sending = false;
  private idle?: ReturnType<typeof setTimeout>;
  private max?: ReturnType<typeof setTimeout>;
  private poll?: ReturnType<typeof setTimeout>;
  private disposed = false;
  // Questions made for what others wrote, and the one that last brought another writer's change.
  private polls = 0;
  private heardAt?: number;
  // Blocks another writer changed while the owner was in them: not replaced, asked for again once the owner has left.
  private readonly held = new Set<string>();
  private readonly listeners = new Set<() => void>();
  /** Bumped on every change: what useSyncExternalStore reads. */
  version = 0;

  constructor(
    private readonly api: VibeValleyApi,
    readonly docId: string,
  ) {}

  subscribe = (f: () => void) => {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  };

  private changed() {
    if (this.disposed) return;
    this.version++;
    for (const f of this.listeners) f();
  }

  get busy() {
    return this.sending || this.queue.length > 0 || this.dirty.size > 0;
  }

  /** Someone other than the owner changed the document lately (or the demo was just started). */
  get othersWriting() {
    return this.heardAt !== undefined && this.polls - this.heardAt < busyPolls;
  }

  /** A helper is writing it now: its change came in one of the last writingPolls questions. */
  writing(b: EditBlock) {
    return b.updatedBy !== docOwner && b.heardAt !== undefined && this.polls - b.heardAt < writingPolls;
  }

  async load() {
    try {
      this.take(await this.api.doc.get({ id: this.docId }), true);
      this.error = undefined;
    } catch (e) {
      this.error = reasonOf(e);
    }
    this.changed();
    this.recurrence();
  }

  private recurrence() {
    clearTimeout(this.poll);
    if (this.disposed) return;
    this.poll = setTimeout(() => void this.refresh().then(() => this.recurrence()), this.othersWriting ? pollFast : pollEvery);
  }

  private async refresh() {
    if (this.busy || this.disposed) return;
    // Drawn as being written before this ask: it may have stopped since.
    let redraw = this.othersWriting || this.blocks.some((b) => this.writing(b));
    try {
      const snap = await this.api.doc.get({ id: this.docId });
      this.polls++;
      if ((snap.doc.seq !== this.seq || this.held.size > 0) && !this.busy) {
        this.take(snap, true, true);
        redraw = true;
      }
    } catch {
      // The next tick asks again.
    }
    if (redraw) this.changed();
  }

  /** Starts the scripted demo: helpers write their sections at once; asks come every pollFast from now. */
  async demo() {
    try {
      await this.api.doc.demo({ id: this.docId });
      this.error = undefined;
      this.heardAt = this.polls;
      this.recurrence();
    } catch (e) {
      this.error = reasonOf(e);
    }
    this.changed();
  }

  private take(snap: DocSnapshot, replace: boolean, heard = false) {
    this.doc = snap.doc;
    this.seq = snap.doc.seq;
    this.held.clear();
    const seen = new Set<string>();
    for (const b of snap.blocks) {
      seen.add(b.id);
      this.put(b, heard);
    }
    if (replace) for (const id of [...this.byId.keys()]) if (!seen.has(id) && !this.dirty.has(id)) this.byId.delete(id);
    this.reorder();
  }

  /** The server's block over the client's: all of it, but the text of one the owner has unsent words in or is composing
   * in. `heard` is a change asked for, not an answer to the owner's batch: one by another writer marks the block as being
   * written, and the block the owner is in is left as it is until they leave it. */
  private put(b: Block, heard = false) {
    const mine = this.byId.get(b.id);
    const went = this.gone.get(b.id);
    if (went) {
      went.rev = b.rev;
      if (b.deleted) this.gone.delete(b.id);
      return;
    }
    if (b.deleted) {
      this.byId.delete(b.id);
      return;
    }
    const news = heard && b.updatedBy !== docOwner && (!mine || mine.rev !== b.rev);
    if (news) this.heardAt = this.polls;
    if (!mine) {
      const added = new EditBlock(b);
      if (news) added.heardAt = this.polls;
      this.byId.set(b.id, added);
      return;
    }
    if (heard && mine.focused && mine.rev !== b.rev) {
      this.held.add(b.id);
      return;
    }
    if (news) mine.heardAt = this.polls;
    mine.parentId = b.parentId;
    mine.orderKey = b.orderKey;
    mine.type = b.type;
    mine.attrs = b.attrs;
    mine.rev = b.rev;
    mine.updatedBy = b.updatedBy;
    mine.sent = b.text;
    if (this.dirty.has(b.id) || mine.composing || this.queued(b.id)) return;
    mine.spans = b.text;
    mine.text = plainOf(b.text);
  }

  private queued(id: string) {
    return (this.inflight?.ids.has(id) ?? false) || this.queue.some((p) => p.ids.has(id));
  }

  private reorder() {
    const kids = new Map<string | undefined, EditBlock[]>();
    for (const b of this.byId.values()) {
      const parent = b.parentId !== undefined && this.byId.has(b.parentId) ? b.parentId : undefined;
      kids.set(parent, [...(kids.get(parent) ?? []), b]);
    }
    for (const list of kids.values()) list.sort((a, b) => (a.orderKey === b.orderKey ? (a.id < b.id ? -1 : 1) : a.orderKey < b.orderKey ? -1 : 1));
    const out: EditBlock[] = [];
    const walk = (parent: string | undefined) => {
      for (const b of kids.get(parent) ?? []) {
        out.push(b);
        walk(b.id);
      }
    };
    walk(undefined);
    this.blocks = out;
  }

  depthOf(b: EditBlock) {
    let d = 0;
    for (let p = b.parentId; p !== undefined && this.byId.has(p); p = this.byId.get(p)!.parentId) d++;
    return d;
  }

  get numbers() {
    return listNumbers(this.blocks);
  }

  // The owner's edits.

  focus(b: EditBlock, on: boolean) {
    b.focused = on;
    if (!on) this.flush();
  }

  composition(b: EditBlock, on: boolean, text: string) {
    b.composing = on;
    if (!on) this.edited(b, text, text.length);
  }

  /** A field's new value; `caret` where the caret is in it. A line break in a block other than code is Enter: the block
   * splits there. */
  edited(b: EditBlock, text: string, caret: number) {
    const before = plainOf(b.spans);
    b.text = text;
    if (b.composing) {
      // Not sent while composing; the wait is armed so the word goes once it is committed, changed or not.
      b.spans = editSpans(b.spans, text);
      this.dirty.add(b.id);
      this.arm();
      this.changed();
      return;
    }
    if (b.type !== blockCode && text.includes("\n")) {
      const at = text.indexOf("\n");
      const joined = text.slice(0, at) + text.slice(at + 1);
      b.spans = editSpans(b.spans, joined);
      b.text = joined;
      b.caret = at;
      // Pasted lines: each becomes a block.
      const added = this.enter(b, at);
      if (added && added.text.includes("\n")) this.edited(added, added.text, 0);
      return;
    }
    if (b.type === blockParagraph && !markdownShortcut(before)) {
      const shortcut = markdownShortcut(text);
      if (shortcut) {
        const rest = text.slice(shortcut.strip);
        b.spans = editSpans(b.spans, rest);
        b.text = rest;
        b.caret = Math.max(0, caret - shortcut.strip);
        this.setType(b, shortcut.type, shortcut.attrs);
        return;
      }
    }
    if (text === before) return this.changed();
    b.spans = editSpans(b.spans, text);
    this.dirty.add(b.id);
    this.arm();
    this.changed();
  }

  private arm() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.flush(), idleWait);
    this.max ??= setTimeout(() => this.flush(), maxWait);
  }

  /** Enter at `at` (UTF-16) in b: an empty list item leaves the list; otherwise the text after `at` becomes a new block. */
  enter(b: EditBlock, at: number): EditBlock | undefined {
    if (listTypes.has(b.type) && b.text === "") {
      this.setType(b, blockParagraph, {});
      return undefined;
    }
    this.textOp(b);
    const [left, right] = splitSpans(b.spans, at);
    const next = this.nextSibling(b);
    const keepType = listTypes.has(b.type) || b.type === blockQuote;
    const nb: BlockInput = {
      id: newBlockId(),
      ...(b.parentId !== undefined ? { parentId: b.parentId } : {}),
      orderKey: keyBetween(b.orderKey, next?.orderKey ?? ""),
      type: keepType ? b.type : blockParagraph,
      attrs: b.type === blockTodo ? { checked: false } : {},
      text: [],
    };
    const offset = codePointOffset(plainOf(b.spans), at);
    b.spans = left;
    b.text = plainOf(left);
    b.caret = b.text.length;
    const added = new EditBlock(nb);
    added.spans = right;
    added.text = plainOf(right);
    added.caret = 0;
    this.byId.set(nb.id, added);
    this.reorder();
    const base = b;
    this.queue.push({
      ids: new Set([b.id, nb.id]),
      build: () => ({ op: "split_block", blockId: base.id, baseRev: base.rev, offset, newBlock: nb }),
      base: b.id,
    });
    // The split carries none of the text; what the new block has is the server's to give back.
    added.sent = right;
    this.focusId = added.id;
    this.changed();
    void this.send();
    return added;
  }

  /** Backspace at the start of b: a block that is not a paragraph becomes one; a paragraph joins the block before it. */
  backspaceAtStart(b: EditBlock) {
    if (b.type !== blockParagraph && hasText(b.type)) return this.setType(b, blockParagraph, {});
    const i = this.blocks.indexOf(b);
    if (i <= 0) return;
    const prev = this.blocks[i - 1]!;
    if (!knownTypes.has(prev.type)) return;
    if (!hasText(prev.type)) {
      this.byId.delete(prev.id);
      this.gone.set(prev.id, prev);
      this.reorder();
      this.queue.push({ ids: new Set([prev.id]), build: () => ({ op: "delete_block", blockId: prev.id }) });
      this.changed();
      void this.send();
      return;
    }
    this.textOp(prev);
    this.textOp(b);
    const join = prev.text.length;
    prev.spans = normalSpans([...prev.spans, ...b.spans]);
    prev.text = plainOf(prev.spans);
    prev.caret = join;
    for (const c of this.byId.values()) if (c.parentId === b.id) c.parentId = prev.id;
    this.byId.delete(b.id);
    this.gone.set(b.id, b);
    this.reorder();
    this.queue.push({ ids: new Set([prev.id, b.id]), build: () => ({ op: "merge_blocks", targetId: prev.id, sourceId: b.id }) });
    prev.sent = prev.spans;
    this.focusId = prev.id;
    this.changed();
    void this.send();
  }

  toggle(b: EditBlock) {
    const checked = !(b.attrs.checked ?? false);
    b.attrs = { checked };
    this.queue.push({ ids: new Set([b.id]), build: () => ({ op: "set_attrs", blockId: b.id, attrs: { checked } }) });
    this.changed();
    void this.send();
  }

  /** A new paragraph at the end, focused: what a click below the last block does. */
  append() {
    const last = this.blocks.filter((b) => b.parentId === undefined).at(-1);
    const nb: BlockInput = {
      id: newBlockId(),
      orderKey: keyBetween(last?.orderKey ?? "", ""),
      type: blockParagraph,
      attrs: {},
      text: [],
    };
    this.byId.set(nb.id, new EditBlock(nb));
    this.reorder();
    this.queue.push({ ids: new Set([nb.id]), build: () => ({ op: "insert_block", block: nb }) });
    this.focusId = nb.id;
    this.changed();
    void this.send();
  }

  /** The nearest block with text above (-1) or below (1). */
  neighbour(b: EditBlock, step: 1 | -1) {
    for (let j = this.blocks.indexOf(b) + step; j >= 0 && j < this.blocks.length; j += step) if (hasText(this.blocks[j]!.type)) return this.blocks[j];
    return undefined;
  }

  moveTo(b: EditBlock, caret: number) {
    b.caret = caret;
    this.focusId = b.id;
    this.changed();
  }

  private nextSibling(b: EditBlock) {
    const siblings = this.blocks.filter((x) => x.parentId === b.parentId);
    const i = siblings.indexOf(b);
    return i >= 0 && i + 1 < siblings.length ? siblings[i + 1] : undefined;
  }

  private setType(b: EditBlock, type: string, attrs: BlockAttrs) {
    this.textOp(b);
    b.type = type;
    b.attrs = attrs;
    if (b.focused) this.focusId = b.id;
    this.queue.push({ ids: new Set([b.id]), build: () => ({ op: "set_type", blockId: b.id, type, attrs }) });
    this.textOp(b);
    this.changed();
    void this.send();
  }

  /** Queues the block's text when it is not what the server has: written against the rev known when it goes. */
  private textOp(b: EditBlock) {
    this.dirty.delete(b.id);
    if (b.composing || !hasText(b.type)) return;
    const spans = b.spans;
    if (plainOf(spans) === plainOf(b.sent) && spans.length === b.sent.length) return;
    b.sent = spans;
    this.queue.push({ ids: new Set([b.id]), build: () => ({ op: "update_text", blockId: b.id, baseRev: b.rev, text: spans }), base: b.id });
  }

  /** Sends the waiting text now: the field lost focus, or the wait is over. */
  flush() {
    clearTimeout(this.idle);
    clearTimeout(this.max);
    this.idle = this.max = undefined;
    for (const id of [...this.dirty]) {
      const b = this.byId.get(id);
      if (!b) this.dirty.delete(id);
      else if (b.composing) this.arm();
      else this.textOp(b);
    }
    void this.send();
  }

  private async send() {
    if (this.sending || this.disposed) return;
    this.sending = true;
    try {
      while (!this.disposed) {
        let batch = this.inflight;
        if (!batch) {
          if (this.queue.length === 0) break;
          // A batch ends before an op written against a block an earlier op in it changes: that op needs the rev the
          // server gives back.
          const ops: DocOp[] = [];
          const ids = new Set<string>();
          while (this.queue.length > 0 && !(ops.length > 0 && this.queue[0]!.base !== undefined && ids.has(this.queue[0]!.base))) {
            const next = this.queue.shift()!;
            ops.push(next.build());
            for (const id of next.ids) ids.add(id);
          }
          batch = this.inflight = { id: newBlockId(), ops, ids };
        }
        let ack;
        try {
          ack = await this.api.doc.submit({ id: this.docId, body: { batchId: batch.id, lastSeq: this.seq, ops: batch.ops } });
        } catch (e) {
          // Kept with its batch id, so sending it again cannot take it twice.
          this.error = pagesWording().docs.notSaved(reasonOf(e));
          this.changed();
          break;
        }
        this.inflight = undefined;
        this.error = undefined;
        this.seq = ack.seq;
        for (const r of ack.results) {
          const b = this.byId.get(r.blockId);
          if (!b) continue;
          b.problem =
            r.status === "conflict"
              ? pagesWording().docs.conflict(r.reason ?? pagesWording().docs.changed)
              : r.status === "rejected"
                ? pagesWording().docs.notSaved(r.reason ?? "")
                : undefined;
          if (r.status === "conflict") b.sent = [];
        }
        for (const b of ack.blocks) this.put(b);
        for (const r of ack.results.filter((r) => r.status === "conflict")) {
          const b = this.byId.get(r.blockId);
          const server = ack.blocks.find((x) => x.id === r.blockId);
          if (b && server && !b.composing) {
            b.spans = b.sent = server.text;
            b.text = plainOf(server.text);
            b.caret = b.text.length;
          }
        }
        this.reorder();
        this.changed();
      }
    } finally {
      this.sending = false;
    }
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.idle);
    clearTimeout(this.max);
    clearTimeout(this.poll);
    this.listeners.clear();
  }
}
