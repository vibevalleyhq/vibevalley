import type { SpanMarks, TextSpan } from "../shapes";

/** The marks as the wire has them: only those set. */
function marksOf(m: SpanMarks | undefined): SpanMarks {
  const out: SpanMarks = {};
  if (m?.bold === true) out.bold = true;
  if (m?.italic === true) out.italic = true;
  if (m?.code === true) out.code = true;
  if (m?.strike === true) out.strike = true;
  if (m?.link !== undefined) out.link = m.link;
  return out;
}

/** A mark not set and a mark set false are the same. */
export const sameMarks = (a: SpanMarks, b: SpanMarks) =>
  (a.bold === true) === (b.bold === true) &&
  (a.italic === true) === (b.italic === true) &&
  (a.code === true) === (b.code === true) &&
  (a.strike === true) === (b.strike === true) &&
  a.link === b.link;

/** Drops empty spans and joins neighbours with the same marks, so one text has one way to be written. */
export function normalSpans(spans: Iterable<TextSpan> | undefined): TextSpan[] {
  const out: TextSpan[] = [];
  for (const s of spans ?? []) {
    if (s.t === "") continue;
    const last = out.at(-1);
    if (last && sameMarks(last.marks, s.marks)) out[out.length - 1] = { t: last.t + s.t, marks: last.marks };
    else out.push({ t: s.t, marks: marksOf(s.marks) });
  }
  return out;
}
