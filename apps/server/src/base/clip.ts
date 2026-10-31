// The server's cuts of text, on the shared measure (packages/protocol/src/rules/cut.ts).

import { oneLine, slice } from "@vibevalley/protocol/rules";

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
