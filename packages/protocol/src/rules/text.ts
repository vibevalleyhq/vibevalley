// Text as the farm measures it, which is JavaScript's own: lengths in UTF-16 units, whitespace as \s. A surrogate pair
// cut in half becomes U+FFFD, so what is stored and sent is always valid UTF-8.

const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** s.slice(start, end), a surrogate pair cut in half made U+FFFD. */
export const slice = (s: string, start: number, end?: number) => s.slice(start, end).replace(lone, "�");

/** s as it is when it fits in max units; else its first max units and an ellipsis. */
export const cut = (s: string, max: number) => (s.length > max ? slice(s, 0, max) + "…" : s);

/** Runs of white space are one space. */
export const oneLine = (s: string) => s.replace(/\s+/g, " ");

/** s on one line and trimmed, at most max units with the ellipsis. */
export const clip = (s: string, max: number) => {
  const flat = oneLine(s).trim();
  return flat.length > max ? slice(flat, 0, max - 1) + "…" : flat;
};

/** Go's cmp.Compare for strings: by bytes of UTF-8, which is by code point, not by UTF-16 unit. */
export function compareText(a: string, b: string): number {
  if (a === b) return 0;
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return x.length < y.length ? -1 : x.length > y.length ? 1 : 0;
}

export const compare = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0);

/** cmp.Or: the first that is not 0. */
export const or = (...c: number[]) => c.find((x) => x !== 0) ?? 0;

/** The first n UTF-16 units of s, never half a surrogate pair. */
export function head(s: string, n: number): string {
  let out = "";
  for (const ch of s) {
    if (out.length + ch.length > n) break;
    out += ch;
  }
  return out;
}
