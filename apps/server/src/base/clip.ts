import { oneLine, slice } from "@vibevalley/protocol/rules";

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
