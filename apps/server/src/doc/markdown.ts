// Markdown is how a document is traded with agents and MEMORY.md, not how it is stored.
// What a block is that Markdown has no word for goes in an HTML comment (<!-- issue:ID -->, <!-- memory:ID -->), an
// image's size in its title ("640x480"). Nesting is two spaces of indent per level. What the export writes, the import
// reads back to the same blocks.

import type { Block, BlockAttrs, DocMarks, DocSpan } from "@vibevalley/protocol";
import { ordered, textFor } from "./ops.ts";
import { normal, plain, unmarked } from "./text.ts";

/** A block as Markdown says it: its place is its depth under the block before it. */
export interface MdBlock {
  readonly depth: number;
  readonly type: string;
  readonly attrs: BlockAttrs;
  readonly text: DocSpan[];
}

const isList = (t: string) => t === "bulleted" || t === "numbered" || t === "todo";

/** The live blocks, in document order. */
export function markdownOf(blocks: readonly Block[]): string {
  const depth = new Map<string, number>();
  let out = "";
  let prev: Block | undefined;
  // parent → the number the run of numbered siblings is at
  const numbers = new Map<string, number>();
  for (const blk of ordered(blocks)) {
    let d = 0;
    if (blk.parentId !== undefined) {
      const pd = depth.get(blk.parentId);
      if (pd !== undefined) d = pd + 1;
    }
    depth.set(blk.id, d);
    const parent = blk.parentId ?? "";
    if (blk.type === "numbered") numbers.set(parent, (numbers.get(parent) ?? 0) + 1);
    else numbers.delete(parent);
    if (prev) out += isList(prev.type) && isList(blk.type) ? "\n" : "\n\n";
    const indent = "  ".repeat(d);
    out += blockLine(blk, numbers.get(parent) ?? 0)
      .split("\n")
      .map((line) => (line !== "" ? indent + line : ""))
      .join("\n");
    prev = blk;
  }
  return out === "" ? "" : out + "\n";
}

function blockLine(b: Block, number: number): string {
  const text = inlineOf(b.text);
  switch (b.type) {
    case "heading":
      return "#".repeat(b.attrs.level !== undefined ? Math.min(Math.max(b.attrs.level, 1), 3) : 1) + " " + text;
    case "bulleted":
      return "- " + text;
    case "numbered":
      return `${number}. ${text}`;
    case "todo":
      return (b.attrs.checked ? "- [x] " : "- [ ] ") + text;
    case "quote":
      return "> " + text.replaceAll("\n", "\n> ");
    case "code":
      return "```" + (b.attrs.language ?? "") + "\n" + plain(b.text) + "\n```";
    case "divider":
      return "---";
    case "image": {
      const title = b.attrs.width !== undefined && b.attrs.height !== undefined ? ` "${b.attrs.width}x${b.attrs.height}"` : "";
      return "![" + escape(b.attrs.alt ?? "") + "](" + (b.attrs.src ?? "") + title + ")";
    }
    case "issue_ref":
      return "<!-- issue:" + (b.attrs.issueId ?? "") + " -->";
    case "memory_item":
      return "<!-- memory:" + (b.attrs.memoryId ?? "") + " --> " + text;
  }
  // A paragraph: a line that would read as another block's start is escaped.
  return text
    .split("\n")
    .map((line) => (line !== "" && (line[0] === " " || classify(line).type !== "paragraph") ? "\\" + line : line))
    .join("\n");
}

const specials = "\\*_`~[]";

const escape = (t: string) => Array.from(t, (c) => (specials.includes(c) ? "\\" + c : c)).join("");

/** An ASCII letter or digit. */
const wordy = (c: string | undefined) => c !== undefined && /^[A-Za-z0-9]$/.test(c);

function inlineOf(spans: readonly DocSpan[]): string {
  const all = normal(spans);
  return all
    .map((s, i) => {
      let t = s.marks.code ? codeSpan(s.t) : escape(s.t);
      if (s.marks.italic) {
        // Against a letter or digit an underscore would read as part of a word: a star does not.
        const mark = (i > 0 && wordy(Array.from(all[i - 1]!.t).at(-1))) || (i + 1 < all.length && wordy(Array.from(all[i + 1]!.t)[0])) ? "*" : "_";
        t = mark + t + mark;
      }
      if (s.marks.bold) t = "**" + t + "**";
      if (s.marks.strike) t = "~~" + t + "~~";
      if (s.marks.link !== undefined) t = "[" + t + "](" + s.marks.link + ")";
      return t;
    })
    .join("");
}

const codeSpan = (t: string) => (t.includes("`") ? "`` " + t + " ``" : "`" + t + "`");

const headingLine = /^(#{1,3}) (.*)$/s;
const todoLine = /^[-*+] \[( |x|X)\] ?(.*)$/s;
const bulletLine = /^[-*+] (.*)$/s;
const numberLine = /^\d+[.)] (.*)$/s;
const dividerLine = /^(-{3,}|\*{3,}|_{3,})$/;
const imageLine = /^!\[((?:\\.|[^\]])*)\]\(([^)\s]*)(?: "(\d+)x(\d+)")?\)$/s;
const issueLine = /^<!-- issue:(\S+) -->$/;
const memoryLine = /^<!-- memory:(\S+) -->(?: (.*))?$/s;
const fenceLine = /^```(\S*)$/;
const quoteLine = /^> ?(.*)$/s;
const indentOf = (s: string) => /^ */.exec(s)![0].length;

/** One line (its indent taken off) read as the start of a block; the text is still Markdown. */
interface LineKind {
  type: string;
  attrs: BlockAttrs;
  rest: string;
}

function classify(line: string): LineKind {
  let m: RegExpExecArray | null;
  if ((m = headingLine.exec(line))) return { type: "heading", attrs: { level: m[1]!.length }, rest: m[2]! };
  if (dividerLine.test(line)) return { type: "divider", attrs: {}, rest: "" };
  if ((m = todoLine.exec(line))) return { type: "todo", attrs: { checked: m[1] !== " " }, rest: m[2]! };
  if ((m = bulletLine.exec(line))) return { type: "bulleted", attrs: {}, rest: m[1]! };
  if ((m = numberLine.exec(line))) return { type: "numbered", attrs: {}, rest: m[1]! };
  if ((m = fenceLine.exec(line))) return { type: "code", attrs: m[1] ? { language: m[1] } : {}, rest: "" };
  if ((m = quoteLine.exec(line))) return { type: "quote", attrs: {}, rest: m[1]! };
  if ((m = imageLine.exec(line))) {
    const attrs: BlockAttrs = { alt: plain(inlineSpans(m[1]!)), src: m[2]! };
    if (m[3]) {
      attrs.width = Number(m[3]);
      attrs.height = Number(m[4]);
    }
    return { type: "image", attrs, rest: "" };
  }
  if ((m = issueLine.exec(line))) return { type: "issue_ref", attrs: { issueId: m[1]! }, rest: "" };
  if ((m = memoryLine.exec(line))) return { type: "memory_item", attrs: { memoryId: m[1]! }, rest: m[2] ?? "" };
  return { type: "paragraph", attrs: {}, rest: line };
}

const blank = (s: string) => s.trim() === "";

/** Reads Markdown into blocks, each with its depth under the block before it. */
export function blocksOfMarkdown(md: string): MdBlock[] {
  const lines = md.replaceAll("\r\n", "\n").split("\n");
  const out: MdBlock[] = [];
  // A deeper line goes under the one before it, never deeper than one past it.
  let open = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (blank(raw)) continue;
    const spaces = indentOf(raw);
    const depth = Math.min(Math.floor(spaces / 2), open);
    const line = raw.slice(spaces);
    const strip = (l: string): [string, boolean] => (indentOf(l) < spaces ? [l.replace(/^ +/, ""), false] : [l.slice(spaces), true]);
    const k = classify(line);
    if (k.type === "code") {
      const body: string[] = [];
      for (i++; i < lines.length; i++) {
        const [l] = strip(lines[i]!);
        if (l === "```") break;
        body.push(l);
      }
      k.rest = body.join("\n");
    } else if (k.type === "quote") {
      const text = [k.rest];
      while (i + 1 < lines.length) {
        const [l, ok] = strip(lines[i + 1]!);
        const m = quoteLine.exec(l);
        if (!ok || !m || blank(lines[i + 1]!)) break;
        text.push(m[1]!);
        i++;
      }
      k.rest = text.join("\n");
    } else if (k.type === "paragraph") {
      const text = [line];
      while (i + 1 < lines.length && !blank(lines[i + 1]!)) {
        const [l, ok] = strip(lines[i + 1]!);
        if (!ok || indentOf(l) > 0 || classify(l).type !== "paragraph") break;
        text.push(l);
        i++;
      }
      k.rest = text.join("\n");
    }
    out.push({ depth, type: k.type, attrs: k.attrs, text: k.type === "code" ? unmarked([{ t: k.rest, marks: {} }]) : textFor(k.type, inlineSpans(k.rest)) });
    open = depth + 1;
  }
  return out;
}

/** Markdown's inline marks: **bold**, _italic_ or *italic*, `code`, ~~strike~~, [text](url), and \ before any character to take it as it is. */
export const inlineSpans = (s: string) => normal(inline(Array.from(s), {}));

function inline(s: readonly string[], m: DocMarks): DocSpan[] {
  const out: DocSpan[] = [];
  let buf = "";
  const flush = () => {
    if (buf !== "") out.push({ t: buf, marks: m });
    buf = "";
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && i + 1 < s.length) {
      i++;
      buf += s[i];
      continue;
    } else if (c === "`") {
      const fence = i + 1 < s.length && s[i + 1] === "`" ? 2 : 1;
      const j = closing(s, i + fence, "`".repeat(fence), false);
      if (j >= 0) {
        flush();
        let body = s.slice(i + fence, j).join("");
        if (fence === 2) {
          if (body.startsWith(" ")) body = body.slice(1);
          if (body.endsWith(" ")) body = body.slice(0, -1);
        }
        out.push({ t: body, marks: { ...m, code: true } });
        i = j + fence - 1;
        continue;
      }
    } else if ((c === "*" || c === "~") && i + 1 < s.length && s[i + 1] === c) {
      const j = closing(s, i + 2, c + c, true);
      if (j >= 0) {
        flush();
        out.push(...inline(s.slice(i + 2, j), c === "*" ? { ...m, bold: true } : { ...m, strike: true }));
        i = j + 1;
        continue;
      }
    } else if (c === "_" && i > 0 && wordy(s[i - 1])) {
      // snake_case: an underscore inside a word is a character, as in CommonMark.
    } else if (c === "_" || c === "*") {
      const j = closing(s, i + 1, c, true);
      if (j >= 0 && (c === "*" || j + 1 >= s.length || !wordy(s[j + 1]))) {
        flush();
        out.push(...inline(s.slice(i + 1, j), { ...m, italic: true }));
        i = j;
        continue;
      }
    } else if (c === "[") {
      const j = closing(s, i + 1, "]", true);
      if (j >= 0 && j + 1 < s.length && s[j + 1] === "(") {
        const k = closing(s, j + 2, ")", false);
        if (k >= 0) {
          flush();
          out.push(...inline(s.slice(i + 1, j), { ...m, link: s.slice(j + 2, k).join("") }));
          i = k;
          continue;
        }
      }
    }
    buf += c;
  }
  flush();
  return out;
}

/**
 * Where mark next starts at or after from, past at least one character when nonEmpty; escapes and code spans are stepped
 * over. -1 when it does not close.
 */
function closing(s: readonly string[], from: number, mark: string, nonEmpty: boolean): number {
  const m = Array.from(mark);
  const start = nonEmpty ? from + 1 : from;
  for (let i = from; i < s.length; i++) {
    if (mark[0] !== "`") {
      if (s[i] === "\\") {
        i++;
        continue;
      }
      if (s[i] === "`") {
        const j = closing(s, i + 1, "`", false);
        if (j >= 0) {
          i = j;
          continue;
        }
      }
    }
    if (i >= start && i + m.length <= s.length && s.slice(i, i + m.length).join("") === mark) return i;
  }
  return -1;
}
