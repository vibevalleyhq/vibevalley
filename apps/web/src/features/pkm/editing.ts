// The server applies the same ops with the same rule: change packages/protocol/src/rules/pkm.ts and here together.

import type { PkmBlock, PkmBlockOp, PkmMarker } from "@vibevalley/protocol";
import { applyBlockOps, flatBlocks, treeOfBlocks } from "@vibevalley/protocol/rules";

/** Every op the page makes names its new block's id, so the random id here is never used. */
export const applied = (blocks: readonly PkmBlock[], ops: readonly PkmBlockOp[]): PkmBlock[] =>
  flatBlocks(
    applyBlockOps(
      treeOfBlocks(blocks),
      ops,
      (f) => f,
      () => crypto.randomUUID(),
    ),
  );

export interface Keys {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}

export interface Caret {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

/** The blocks around the one being written, as they are shown (a collapsed one's children are not). */
export interface Around {
  readonly previous?: PkmBlock | undefined;
  readonly next?: PkmBlock | undefined;
  /** Whether blocks are under it, shown or not; none means none are. */
  readonly parent?: boolean;
  /** Its first child when it has one and it is shown. */
  readonly firstChild?: PkmBlock | undefined;
}

export interface Focus {
  readonly block: string;
  readonly at: number | "end";
}

/** Ops, with the text typed so far saved first; or leave to selection.ts, extend picking the block above or below. */
export type EditAction =
  | { readonly kind: "ops"; readonly ops: PkmBlockOp[]; readonly focus: Focus }
  | { readonly kind: "leave"; readonly extend?: "up" | "down" };

/** The text typed into block, as an op; none when it is what the block has. */
export const saved = (block: PkmBlock, value: string): PkmBlockOp[] => (value === block.body ? [] : [{ op: "update", block: block.id, body: value }]);

/** What a key in a block's box does; undefined for one the box handles itself (letters, Shift+Enter, ← →). */
export function editAction(e: Keys, block: PkmBlock, caret: Caret, around: Around, newId: () => string): EditAction | undefined {
  const id = block.id;
  const keep = saved(block, caret.value);
  const here: Focus = { block: id, at: caret.start };
  const mod = e.metaKey || e.ctrlKey;
  const collapsed = caret.start === caret.end;
  if (e.key === "Escape") return { kind: "leave" };
  // Past the first or the last of its words, Shift+↑↓ goes on picking blocks, as a selection of text would.
  if (e.shiftKey && collapsed && !mod && !e.altKey) {
    if (e.key === "ArrowUp" && caret.start === 0) return { kind: "leave", extend: "up" };
    if (e.key === "ArrowDown" && caret.end === caret.value.length) return { kind: "leave", extend: "down" };
  }
  if (e.key === "Tab") return { kind: "ops", ops: [...keep, { op: e.shiftKey ? "outdent" : "indent", block: id }], focus: here };
  if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown"))
    return { kind: "ops", ops: [...keep, { op: "move", block: id, direction: e.key === "ArrowUp" ? "up" : "down" }], focus: here };
  if (e.key === "Enter" && mod) return { kind: "ops", ops: [...keep, { op: "toggle_marker", block: id }], focus: here };
  if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
    const before = caret.value.slice(0, caret.start);
    const after = caret.value.slice(caret.end);
    const fresh = newId();
    if (caret.start === 0 && after !== "")
      return { kind: "ops", ops: [...keep, { op: "insert_before", block: id, id: fresh, body: "" }], focus: { block: id, at: 0 } };
    const cut: PkmBlockOp[] = before === block.body ? [] : [{ op: "update", block: id, body: before }];
    // A parent shown open takes the new block as its first child, as an outline is read.
    const place: PkmBlockOp = around.firstChild
      ? { op: "insert_before", block: around.firstChild.id, id: fresh, body: after }
      : { op: "insert_after", block: id, id: fresh, body: after };
    return { kind: "ops", ops: [...cut, place], focus: { block: fresh, at: 0 } };
  }
  if (e.key === "Backspace" && collapsed && caret.start === 0 && !mod && !e.altKey) {
    if (around.parent === true || !around.previous) return undefined;
    const previous = around.previous;
    const joined = previous.body + caret.value;
    const ops: PkmBlockOp[] = [...(caret.value === "" ? [] : [{ op: "update", block: previous.id, body: joined } as const]), { op: "delete", block: id }];
    return { kind: "ops", ops, focus: { block: previous.id, at: previous.body.length } };
  }
  if (collapsed && !mod && !e.altKey && !e.shiftKey) {
    if (e.key === "ArrowUp" && around.previous && !caret.value.slice(0, caret.start).includes("\n"))
      return { kind: "ops", ops: keep, focus: { block: around.previous.id, at: "end" } };
    if (e.key === "ArrowDown" && around.next && !caret.value.slice(caret.end).includes("\n"))
      return { kind: "ops", ops: keep, focus: { block: around.next.id, at: 0 } };
  }
  return undefined;
}

/** undefined for a single line: the box pastes that one itself. */
export function pasteAction(text: string, block: PkmBlock, caret: Caret, newId: () => string): EditAction | undefined {
  const rows = text
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const lead = /^[ \t]*/u.exec(line)?.[0] ?? "";
      const width = [...lead].reduce((n, c) => n + (c === "\t" ? 2 : 1), 0);
      return { width, text: line.slice(lead.length).replace(/^(?:[-*+]|\d+[.)])\s+/u, "") };
    });
  if (rows.length < 2) return undefined;
  const least = Math.min(...rows.map((r) => r.width));
  const before = caret.value.slice(0, caret.start);
  const after = caret.value.slice(caret.end);
  const [first, ...rest] = rows;
  const ops: PkmBlockOp[] = [{ op: "update", block: block.id, body: before + (first?.text ?? "") }];
  // The last block put at each level since a shallower one; level 0 is the written-in block's siblings.
  const lastAt: string[] = [block.id];
  let last = block.id;
  let lastText = before + (first?.text ?? "");
  for (const [i, row] of rest.entries()) {
    const level = Math.min(Math.floor((row.width - least) / 2), lastAt.length);
    const id = newId();
    const body = row.text + (i === rest.length - 1 ? after : "");
    const sibling = lastAt[level];
    const parent = lastAt[level - 1];
    if (sibling !== undefined) ops.push({ op: "insert_after", block: sibling, id, body });
    else if (parent !== undefined) ops.push({ op: "insert_child", block: parent, id, body });
    lastAt.length = level;
    lastAt[level] = id;
    last = id;
    lastText = body;
  }
  return { kind: "ops", ops, focus: { block: last, at: lastText.length - after.length } };
}

export type CompletionKind = "page" | "block" | "tag" | "command";

/** What is being completed at the caret: the words typed after [[, ((, # or a / that starts the block, and where the
 * trigger begins. */
export interface Completion {
  readonly kind: CompletionKind;
  readonly query: string;
  readonly from: number;
}

/** The completion the caret is in; none once a line break comes between. */
export function completionAt(value: string, caret: number): Completion | undefined {
  const before = value.slice(0, caret);
  const open = (opening: string, closing: string, kind: CompletionKind): Completion | undefined => {
    const at = before.lastIndexOf(opening);
    if (at < 0 || before.lastIndexOf(closing) > at) return undefined;
    const query = before.slice(at + opening.length);
    return query.includes("\n") ? undefined : { kind, query, from: at };
  };
  const command = /^\/([\p{L}\p{N}]*)$/u.exec(before);
  if (command) return { kind: "command", query: command[1] ?? "", from: 0 };
  const link = open("[[", "]]", "page") ?? open("((", "))", "block");
  if (link) return link;
  const tag = /(?:^|\s)#([\p{L}\p{N}_/-]*)$/u.exec(before);
  return tag ? { kind: "tag", query: tag[1] ?? "", from: caret - (tag[1] ?? "").length - 1 } : undefined;
}

/** [[title]], ((id)) or #tag : a closer already after the caret is not doubled. */
export function completed(value: string, caret: number, c: Completion, choice: string): { readonly value: string; readonly caret: number } {
  const tail = value.slice(caret);
  const closer = c.kind === "page" ? "]]" : c.kind === "block" ? "))" : "";
  const rest = closer !== "" && tail.startsWith(closer) ? tail.slice(closer.length) : tail;
  const written = c.kind === "page" ? `[[${choice}]]` : c.kind === "block" ? `((${choice}))` : c.kind === "tag" ? `#${choice} ` : choice;
  const head = value.slice(0, c.from) + written;
  return { value: head + rest, caret: head.length };
}

/** The / commands: a marker, a heading, or today's journal as a link. */
export type Command = { readonly key: string; readonly marker: PkmMarker | undefined } | { readonly key: string; readonly text: string };

export function commandAction(block: PkmBlock, caret: Caret, c: Completion, command: Command): EditAction {
  const value = caret.value.slice(0, c.from) + ("text" in command ? command.text : "") + caret.value.slice(caret.start);
  const mark: PkmBlockOp[] =
    "marker" in command ? [command.marker ? { op: "set_marker", block: block.id, marker: command.marker } : { op: "set_marker", block: block.id }] : [];
  const ops: PkmBlockOp[] = [...saved(block, value), ...mark];
  const at = c.from + ("text" in command ? command.text.length : 0);
  return { kind: "ops", ops, focus: { block: block.id, at } };
}
