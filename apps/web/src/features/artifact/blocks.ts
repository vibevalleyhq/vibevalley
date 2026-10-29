// What the blocks editor computes on its own: offsets in the server's unit, marks kept
// through an edit, list numbers and the line-start shortcuts. Order keys are the shared rule (keyBetween); the ops' rules
// stay the server's.

import {
  blockBulleted,
  blockCode,
  blockDivider,
  blockHeading,
  blockImage,
  blockIssueRef,
  blockMemoryItem,
  blockNumbered,
  blockParagraph,
  blockQuote,
  blockTodo,
  type BlockAttrs,
  type SpanMarks,
  type TextSpan,
} from "@vibevalley/protocol";

/** The server counts offsets in code points; a string's index is in UTF-16 units. */
export const codePointOffset = (text: string, utf16: number) => [...text.slice(0, Math.min(Math.max(0, utf16), text.length))].length;

export const plainOf = (spans: readonly TextSpan[]) => spans.map((s) => s.t).join("");

export const sameMarks = (a: SpanMarks, b: SpanMarks) =>
  (a.bold ?? false) === (b.bold ?? false) &&
  (a.italic ?? false) === (b.italic ?? false) &&
  (a.code ?? false) === (b.code ?? false) &&
  (a.strike ?? false) === (b.strike ?? false) &&
  a.link === b.link;

export function normalSpans(spans: Iterable<TextSpan>): TextSpan[] {
  const out: TextSpan[] = [];
  for (const s of spans) {
    if (!s.t) continue;
    const last = out.at(-1);
    if (last && sameMarks(last.marks, s.marks)) out[out.length - 1] = { t: last.t + s.t, marks: s.marks };
    else out.push(s);
  }
  return out;
}

/** Spans cut at a UTF-16 index of their text. */
export function splitSpans(spans: readonly TextSpan[], at: number): [TextSpan[], TextSpan[]] {
  const left: TextSpan[] = [];
  const right: TextSpan[] = [];
  for (const s of spans) {
    if (at <= 0) right.push(s);
    else if (at >= s.t.length) left.push(s);
    else {
      left.push({ t: s.t.slice(0, at), marks: s.marks });
      right.push({ t: s.t.slice(at), marks: s.marks });
    }
    at -= s.t.length;
  }
  return [normalSpans(left), normalSpans(right)];
}

const low = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

/** The spans after the text became `text`: what is the same at both ends keeps its marks; what was typed takes the marks
 * of the character before it, a link's excepted. */
export function editSpans(old: readonly TextSpan[], text: string): TextSpan[] {
  const before = plainOf(old);
  if (before === text) return [...old];
  let p = 0;
  while (p < before.length && p < text.length && before.charCodeAt(p) === text.charCodeAt(p)) p++;
  if (p > 0 && p < text.length && low(text.charCodeAt(p))) p--;
  let s = 0;
  while (s < before.length - p && s < text.length - p && before.charCodeAt(before.length - 1 - s) === text.charCodeAt(text.length - 1 - s)) s++;
  if (s > 0 && low(text.charCodeAt(text.length - s))) s--;
  const [head, rest] = splitSpans(old, p);
  const [, tail] = splitSpans(rest, before.length - p - s);
  const typed = text.slice(p, text.length - s);
  const m = head.at(-1)?.marks;
  const marks: SpanMarks = m
    ? {
        ...(m.bold ? { bold: m.bold } : {}),
        ...(m.italic ? { italic: m.italic } : {}),
        ...(m.code ? { code: m.code } : {}),
        ...(m.strike ? { strike: m.strike } : {}),
      }
    : {};
  return normalSpans([...head, { t: typed, marks }, ...tail]);
}

export const textTypes: ReadonlySet<string> = new Set([
  blockParagraph,
  blockHeading,
  blockBulleted,
  blockNumbered,
  blockTodo,
  blockQuote,
  blockCode,
  blockMemoryItem,
]);
export const knownTypes: ReadonlySet<string> = new Set([...textTypes, blockDivider, blockImage, blockIssueRef]);
export const listTypes: ReadonlySet<string> = new Set([blockBulleted, blockNumbered, blockTodo]);

export const hasText = (type: string) => textTypes.has(type);

/** A paragraph that starts with Markdown for another block: its type, its attrs, and how much of the start to drop. */
export function markdownShortcut(text: string): { type: string; attrs: BlockAttrs; strip: number } | undefined {
  const heading = /^(#{1,3}) /.exec(text);
  if (heading) return { type: blockHeading, attrs: { level: heading[1]!.length }, strip: heading[0].length };
  const todo = /^\[( |x)?\] /.exec(text);
  if (todo) return { type: blockTodo, attrs: { checked: todo[1] === "x" }, strip: todo[0].length };
  const bullet = /^[-*] /.exec(text);
  if (bullet) return { type: blockBulleted, attrs: {}, strip: bullet[0].length };
  const number = /^\d+[.)] /.exec(text);
  if (number) return { type: blockNumbered, attrs: {}, strip: number[0].length };
  if (text.startsWith("> ")) return { type: blockQuote, attrs: {}, strip: 2 };
  if (text.startsWith("```")) return { type: blockCode, attrs: {}, strip: text.startsWith("``` ") ? 4 : 3 };
  return undefined;
}

/** Each numbered block's number: its place in the run of numbered siblings it is in. `ordered` is the artifact's order,
 * each block followed by its children. */
export function listNumbers(ordered: readonly { id: string; parentId?: string; type: string }[]): Map<string, number> {
  const last = new Map<string | undefined, [string, number]>();
  const out = new Map<string, number>();
  for (const b of ordered) {
    const before = last.get(b.parentId);
    const n = b.type === blockNumbered ? (before && before[0] === blockNumbered ? before[1] + 1 : 1) : 0;
    last.set(b.parentId, [b.type, n]);
    if (b.type === blockNumbered) out.set(b.id, n);
  }
  return out;
}
