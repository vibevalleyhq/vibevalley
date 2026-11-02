import type { CompactCard, CardAttachment, ParentPreview } from "@vibevalley/protocol";

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
