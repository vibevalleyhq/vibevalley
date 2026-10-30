// Text as the farm measures it, which is JavaScript's own: lengths in UTF-16 units, whitespace as \s. A surrogate pair
// cut in half becomes U+FFFD, so what is stored and sent is always valid UTF-8.

/** s.slice(start, end), a surrogate pair cut in half made U+FFFD. */
export const slice = (s: string, start: number, end?: number) => s.slice(start, end).toWellFormed();

/** s as it is when it fits in max units; else its first max units and an ellipsis. */
export const cut = (s: string, max: number) => (s.length > max ? slice(s, 0, max) + "…" : s);

/** Runs of white space are one space. */
export const oneLine = (s: string) => s.replace(/\s+/gu, " ");

/** s on one line and trimmed, at most max units with the ellipsis. */
export const clip = (s: string, max: number) => {
  const flat = oneLine(s).trim();
  return flat.length > max ? slice(flat, 0, max - 1) + "…" : flat;
};

/** The first n UTF-16 units of s, never half a surrogate pair. */
export function head(s: string, n: number): string {
  let out = "";
  for (const ch of s) {
    if (out.length + ch.length > n) break;
    out += ch;
  }
  return out;
}
