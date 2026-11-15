import type { ChatMessage } from "@vibevalley/protocol";
import { oneLine } from "@vibevalley/protocol/rules";

/** A surrogate standing alone: half of a pair cut at its middle. */
const halfPair = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu;

/** s.slice(start, end), a surrogate pair cut in half made U+FFFD. */
export const slice = (s: string, start: number, end?: number) => s.slice(start, end).replace(halfPair, "\uFFFD");

/** s as it is when it fits in max units; else its first max units and an ellipsis. */
export const cut = (s: string, max: number) => (s.length > max ? slice(s, 0, max) + "…" : s);

export type QuotedBlock = NonNullable<ChatMessage["blocks"]>[number];

export interface CardAttachment {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly readUri: string;
}

export interface ParentPreview {
  readonly id: string;
  readonly from: string;
  readonly preview: string;
  readonly readUri: string;
}

export interface CompactCard {
  readonly summary: string;
  readonly totalChars: number;
  readonly truncated: boolean;
  readonly readUri: string;
  readonly attachments?: readonly CardAttachment[];
  readonly parentPreview?: ParentPreview;
}

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
