// The way to an attachment's bytes: the server answers attachment.file (a
// native-only op) with where it keeps the file, which the views show (Image, file: URL) and the
// host opens in the system's app (host.openFile) or plays (host.playAudio).
// A refusal (a file gone) leaves the tiles with their icons.
import { z } from "zod";

import { defineQuery, ready, useQuery } from "./query";
import { transport } from "./transport";

/** A call through the transport (the bridge in the app, a fixture in stories), its data or a throw. */
async function data<T>(op: string, payload: unknown): Promise<T> {
  const envelope = await transport().call(op, payload);
  if (envelope.bizCode !== 0) throw new Error(envelope.message);
  return envelope.data as T;
}

const AttachmentFile = z.object({ path: z.string(), type: z.string(), name: z.exactOptional(z.string()) });

const attachmentFileQuery = defineQuery({
  schema: AttachmentFile,
  key: (id: string) => ["attachment", "file", id],
  fetch: (id: string) => data<unknown>("attachment.file", { id }),
  staleTime: Infinity,
  // A refusal is a file gone: asked once, not retried.
  retry: 0,
});

export const fileUrl = (path: string) => `file://${encodeURI(path)}`;

/** Where the server keeps the file (path, type), once it said. */
export function useAttachmentFile(id: () => string) {
  const query = useQuery(() => attachmentFileQuery(id()));
  return () => ready(query, undefined);
}

/** The file's `file:` URL once the server said where it is. */
export function useAttachmentUrl(id: () => string) {
  const file = useAttachmentFile(id);
  return () => {
    const f = file();
    return f ? fileUrl(f.path) : undefined;
  };
}

/** Opens the attachment in the system's app for its kind (VibeValley opens it in a browser tab). */
export async function openAttachment(id: string) {
  const file = await data<{ path: string; type: string }>("attachment.file", { id });
  await data("host.openFile", { path: file.path });
}

/** Plays a sound file through the host (nsh has no audio on GPUI); one at a time, host.stopAudio stops it. */
export const playAudio = (path: string) => data<void>("host.playAudio", { path });
