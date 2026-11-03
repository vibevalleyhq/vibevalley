// The server's cuts of text, on the shared measure (packages/protocol/src/rules/cut.ts).

import type { CardAttachment, CompactCard, ParentPreview } from "@vibevalley/protocol";
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

export function compactCard(
  text: string,
  readUri: string,
  limit: number,
  more: { readonly attachments?: readonly CardAttachment[]; readonly parentPreview?: ParentPreview } = {},
): CompactCard {
  const bounded = Math.max(0, Math.floor(limit));
  return {
    summary: text.slice(0, bounded),
    totalChars: text.length,
    truncated: text.length > bounded,
    readUri,
    ...(more.attachments === undefined ? {} : { attachments: more.attachments }),
    ...(more.parentPreview === undefined ? {} : { parentPreview: more.parentPreview }),
  };
}
