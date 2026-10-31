// What the owner is writing in each channel, kept on this machine (state/stored.ts) so a reload finds it. The message
// answered is kept by its id and place, not as a copy: what the box shows is the message as it is now, and one deleted
// meanwhile is answered no more.

import { Schema } from "effect";
import { type Accessor, createMemo } from "solid-js";

import { t } from "@vibevalley/i18n";
import { type Attachment, type ChatMessage, VibeValleyApi } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { reasonOf } from "@/infra/api";
import { defineAtom } from "@/state/atom";
import { defineStored, orFallback } from "@/state/stored";

import { useMessage } from "./follow";

const DraftSchema = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  reply: Schema.optionalKey(Schema.Struct({ id: Schema.String, number: Schema.Int })),
  files: orFallback(Schema.Array(S.Attachment), []),
});

export type Draft = typeof DraftSchema.Type;

const none: Draft = { files: [] };

const all = defineStored("chat.drafts", Schema.Record(Schema.String, DraftSchema), {});

const empty = (d: Draft) => !d.text && !d.reply && d.files.length === 0;

export const draftOf = (channel: string | undefined): Draft => (channel ? all.get()[channel] : undefined) ?? none;

const put = (channel: string, change: (d: Draft) => Draft) =>
  all.update((a) => {
    const { [channel]: was, ...rest } = a;
    const next = change(was ?? none);
    return empty(next) ? rest : { ...rest, [channel]: next };
  });

export const drafts = {
  text: (channel: string, text: string) => put(channel, (d) => ({ ...d, text })),
  reply: (channel: string, m: ChatMessage | undefined) => put(channel, ({ reply: _, ...d }) => (m ? { ...d, reply: { id: m.id, number: m.number } } : d)),
  add: (channel: string, file: Attachment) => put(channel, (d) => ({ ...d, files: [...d.files.filter((f) => f.id !== file.id), file] })),
  drop: (channel: string, id: string) => put(channel, (d) => ({ ...d, files: d.files.filter((f) => f.id !== id) })),
  clear: (channel: string) => put(channel, () => none),
};

/** The message a channel's draft answers, as it is now; undefined when there is none, or it was deleted. */
export function useReplying(channel: Accessor<string | undefined>): Accessor<ChatMessage | undefined> {
  const at = createMemo(
    () => {
      const id = channel();
      const reply = draftOf(id).reply;
      return id && reply ? { channel: id, ...reply } : undefined;
    },
    { equals: (a, b) => a?.channel === b?.channel && a?.id === b?.id && a?.number === b?.number },
  );
  const message = useMessage(at);
  return () => {
    const m = message();
    return m && m.id === at()?.id && m.deleted === undefined ? m : undefined;
  };
}

/** The message the owner is changing in place, one at a time across the page (↑ in an empty box picks the last). */
const editing = defineAtom<string | undefined>(undefined);
export const editingId = editing.get;
export const setEditingId = editing.set;

/** fetch over XMLHttpRequest, which tells how much of the body has gone up. */
const sending =
  (progress: (sent: number, total: number) => void): typeof fetch =>
  (url, init) =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(init?.method ?? "GET", url instanceof Request ? url.url : url.toString());
      for (const [k, v] of new Headers(init?.headers).entries()) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => e.lengthComputable && progress(e.loaded, e.total);
      xhr.onload = () =>
        resolve(new Response(xhr.responseText, { status: xhr.status, headers: { "content-type": xhr.getResponseHeader("content-type") ?? "" } }));
      xhr.onerror = () => reject(new Error(t("web.base.unreachable")));
      const body = init?.body;
      if (body instanceof ReadableStream) throw new TypeError("a streamed body has no upload progress");
      xhr.send(body);
    });

/** A file uploaded for a message; progress is told in whole percents as it goes up. */
async function upload(file: File, progress: (percent: number) => void = () => {}): Promise<Attachment> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  // In pieces: one call with every byte as an argument overflows the stack for a big file.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const api = new VibeValleyApi(
    "",
    sending((sent, total) => progress(Math.min(100, Math.round((sent / total) * 100)))),
  );
  return api.channel.attachment.create({ name: file.name || "file", type: file.type || "application/octet-stream", data: btoa(binary) });
}

export interface Upload {
  readonly key: number;
  readonly channel: string;
  readonly name: string;
  readonly percent: number;
}

const uploads = defineAtom<readonly Upload[]>([]);
let lastUpload = 0;

export const uploadsIn = (channel: string | undefined) => uploads.get().filter((u) => u.channel === channel);

/** Files picked, pasted or dropped: each goes up in turn and joins the channel's draft. */
export async function attachFiles(channel: string, files: readonly File[], failed: (reason: string) => void) {
  for (const file of files) {
    const key = ++lastUpload;
    uploads.update((u) => [...u, { key, channel, name: file.name || "file", percent: 0 }]);
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one upload at a time, in the order picked: the drafts keep the files' order
      drafts.add(channel, await upload(file, (percent) => uploads.update((u) => u.map((x) => (x.key === key ? { ...x, percent } : x)))));
    } catch (e) {
      failed(reasonOf(e));
    } finally {
      uploads.update((u) => u.filter((x) => x.key !== key));
    }
  }
}
