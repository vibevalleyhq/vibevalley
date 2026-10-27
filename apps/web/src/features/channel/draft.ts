import { createSignal } from "solid-js";
import type { Attachment, ChatMessage } from "@vibevalley/protocol";
import { api } from "../../base/api";

export interface Draft {
  readonly reply?: ChatMessage;
  readonly files: readonly Attachment[];
}

const none: Draft = { files: [] };
const [all, setAll] = createSignal<Readonly<Record<string, Draft>>>({});

export const draftOf = (channel: string | undefined): Draft => (channel ? all()[channel] : undefined) ?? none;

const put = (channel: string, change: (d: Draft) => Draft) => setAll((a) => ({ ...a, [channel]: change(a[channel] ?? none) }));

export const drafts = {
  reply: (channel: string, m: ChatMessage | undefined) => put(channel, (d) => (m ? { ...d, reply: m } : { files: d.files })),
  add: (channel: string, file: Attachment) => put(channel, (d) => ({ ...d, files: [...d.files.filter((f) => f.id !== file.id), file] })),
  drop: (channel: string, id: string) => put(channel, (d) => ({ ...d, files: d.files.filter((f) => f.id !== id) })),
  clear: (channel: string) => put(channel, () => none),
};

export async function upload(file: File): Promise<Attachment> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  // In pieces: one call with every byte as an argument overflows the stack for a big file.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return api.channel.attachment.create({ name: file.name || "file", type: file.type || "application/octet-stream", data: btoa(binary) });
}
