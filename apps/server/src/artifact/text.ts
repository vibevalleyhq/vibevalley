// A block's text as spans. Offsets into it count Unicode code points, as the op contract
// says; the client counts UTF-16 units and converts.

import type { SpanMarks, TextSpan } from "@vibevalley/protocol";

const chars = (s: string) => Array.from(s);

export const plain = (spans: readonly TextSpan[]) => spans.map((s) => s.t).join("");

export const runeLen = (spans: readonly TextSpan[]) => spans.reduce((n, s) => n + chars(s.t).length, 0);

/** The marks as the wire has them: only those set. */
export function marksOf(m: SpanMarks | undefined): SpanMarks {
  const out: SpanMarks = {};
  if (m?.bold) out.bold = true;
  if (m?.italic) out.italic = true;
  if (m?.code) out.code = true;
  if (m?.strike) out.strike = true;
  if (m?.link !== undefined) out.link = m.link;
  return out;
}

export const sameMarks = (a: SpanMarks, b: SpanMarks) =>
  !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.code === !!b.code && !!a.strike === !!b.strike && a.link === b.link;

/** Drops empty spans and joins neighbours with the same marks, so one text has one way to be written. */
export function normal(spans: readonly TextSpan[] | undefined): TextSpan[] {
  const out: TextSpan[] = [];
  for (const s of spans ?? []) {
    if (s.t === "") continue;
    const last = out.at(-1);
    if (last && sameMarks(last.marks, s.marks ?? {})) last.t += s.t;
    else out.push({ t: s.t, marks: marksOf(s.marks) });
  }
  return out;
}

export function sameText(a: readonly TextSpan[], b: readonly TextSpan[]): boolean {
  const x = normal(a);
  const y = normal(b);
  return x.length === y.length && x.every((s, i) => s.t === y[i]!.t && sameMarks(s.marks, y[i]!.marks));
}

/** Cuts spans at a code-point offset, 0 ≤ at ≤ runeLen(spans). */
export function splitAt(spans: readonly TextSpan[], at: number): [TextSpan[], TextSpan[]] {
  const left: TextSpan[] = [];
  const right: TextSpan[] = [];
  for (const s of spans) {
    const r = chars(s.t);
    if (at <= 0) right.push(s);
    else if (at >= r.length) left.push(s);
    else {
      left.push({ t: r.slice(0, at).join(""), marks: s.marks });
      right.push({ t: r.slice(at).join(""), marks: s.marks });
    }
    at -= r.length;
  }
  return [normal(left), normal(right)];
}

export const joined = (a: readonly TextSpan[], b: readonly TextSpan[]) => normal([...a, ...b]);

/** Code has no marks. */
export function unmarked(spans: readonly TextSpan[]): TextSpan[] {
  const t = plain(spans);
  return t !== "" ? [{ t, marks: {} }] : [];
}
