// What the owner is writing in each channel: the words, the message it answers and the files uploaded for it. Kept on
// this device (localStorage), so a reload finds it; without storage it lasts until the page closes.

import { createSignal } from "solid-js";
import { type Attachment, type ChatMessage, VibeValleyApi } from "@vibevalley/protocol";
import { appWording } from "../../base/words";
import { reasonOf } from "../../base/api";

export interface Draft {
  readonly text?: string;
  readonly reply?: ChatMessage;
  readonly files: readonly Attachment[];
}

const none: Draft = { files: [] };
const key = "vibevalley.chat.drafts";

function load(): Record<string, Draft> {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, Partial<Draft>>;
    return Object.fromEntries(
      Object.entries(raw).flatMap(([channel, d]) =>
        d && typeof d === "object"
          ? [
              [
                channel,
                {
                  ...(typeof d.text === "string" ? { text: d.text } : {}),
                  ...(d.reply ? { reply: d.reply } : {}),
                  files: Array.isArray(d.files) ? d.files : [],
                },
              ],
            ]
          : [],
      ),
    );
  } catch {
    return {};
  }
}

const [all, setAll] = createSignal<Readonly<Record<string, Draft>>>(load());

const empty = (d: Draft) => !d.text && !d.reply && d.files.length === 0;

function save(next: Readonly<Record<string, Draft>>) {
  try {
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(Object.entries(next).filter(([, d]) => !empty(d)))));
  } catch {
    // No storage, or it is full: the draft lasts until the page closes.
  }
}

export const draftOf = (channel: string | undefined): Draft => (channel ? all()[channel] : undefined) ?? none;

const put = (channel: string, change: (d: Draft) => Draft) =>
  setAll((a) => {
    const next = { ...a, [channel]: change(a[channel] ?? none) };
    save(next);
    return next;
  });

export const drafts = {
  text: (channel: string, text: string) => put(channel, (d) => ({ ...d, text })),
  reply: (channel: string, m: ChatMessage | undefined) => put(channel, ({ reply: _, ...d }) => (m ? { ...d, reply: m } : d)),
  add: (channel: string, file: Attachment) => put(channel, (d) => ({ ...d, files: [...d.files.filter((f) => f.id !== file.id), file] })),
  drop: (channel: string, id: string) => put(channel, (d) => ({ ...d, files: d.files.filter((f) => f.id !== id) })),
  clear: (channel: string) => put(channel, () => none),
};

/** The message the owner is changing in place, one at a time across the page (↑ in an empty box picks the last). */
const [editingId, setEditingId] = createSignal<string>();
export { editingId, setEditingId };

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
      xhr.onerror = () => reject(new Error(appWording().unreachable));
      xhr.send(init?.body as XMLHttpRequestBodyInit | null | undefined);
    });

/** A file uploaded for a message; progress is told in whole percents as it goes up. */
export async function upload(file: File, progress: (percent: number) => void = () => {}): Promise<Attachment> {
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

const [uploads, setUploads] = createSignal<readonly Upload[]>([]);
let lastUpload = 0;

export const uploadsIn = (channel: string | undefined) => uploads().filter((u) => u.channel === channel);

/** Files picked, pasted or dropped: each goes up in turn and joins the channel's draft. */
export async function attachFiles(channel: string, files: readonly File[], failed: (reason: string) => void) {
  for (const file of files) {
    const key = ++lastUpload;
    setUploads((u) => [...u, { key, channel, name: file.name || "file", percent: 0 }]);
    try {
      drafts.add(channel, await upload(file, (percent) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, percent } : x)))));
    } catch (e) {
      failed(reasonOf(e));
    } finally {
      setUploads((u) => u.filter((x) => x.key !== key));
    }
  }
}
