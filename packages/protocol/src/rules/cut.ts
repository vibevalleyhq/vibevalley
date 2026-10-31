// Text as the farm measures it, on the server and the page alike, which is JavaScript's own: lengths in UTF-16 units,
// whitespace as \s. A surrogate pair cut in half becomes U+FFFD, so what is stored and sent is always valid UTF-8. The
// server's own cuts (clip, head) are apps/server/src/base/clip.ts, on these.

/** A surrogate standing alone: half of a pair cut at its middle. */
const halfPair = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu;

/** s.slice(start, end), a surrogate pair cut in half made U+FFFD (what String.prototype.toWellFormed does, which the
 * page's and the phone's targets do not all have). */
export const slice = (s: string, start: number, end?: number) => s.slice(start, end).replace(halfPair, "\uFFFD");

/** s as it is when it fits in max units; else its first max units and an ellipsis. */
export const cut = (s: string, max: number) => (s.length > max ? slice(s, 0, max) + "…" : s);

/** Runs of white space are one space. */
export const oneLine = (s: string) => s.replace(/\s+/gu, " ");
