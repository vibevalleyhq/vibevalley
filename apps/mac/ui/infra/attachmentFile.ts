// The way to an attachment's bytes: the server answers attachment.file (a
// native-only op) with where it keeps the file, which the views show (Image, file: URL) and the
// host opens in the system's app (host.openFile) or plays (host.playAudio).
// A refusal (a file gone) leaves the tiles with their icons.
import { z } from "zod";

import { VibeValleyApiError, type Attachment } from "@vibevalley/protocol";
import { BizCode } from "@vibevalley/protocol/api";
import * as S from "@vibevalley/protocol/schema";

import { api } from "./api";
import { readConnectionMode } from "./hostParams";
import { defineQuery, ready, useQuery } from "./query";
import { transport } from "./transport";

/** A call through the transport (the bridge in the app, a fixture in stories), its data or a throw. */
async function callData(op: string, payload: unknown): Promise<unknown> {
  const envelope = await transport().call(op, payload);
  if (envelope.bizCode !== 0) throw new Error(envelope.message);
  return envelope.data;
}

const AttachmentFile = z.object({ path: z.string(), type: z.string(), name: z.exactOptional(z.string()) });
const SavedResult = z.object({ saved: z.boolean() });
const ReadFileData = z.object({ data: z.string(), type: z.string(), name: z.string() });

const attachmentFileQuery = defineQuery({
  schema: AttachmentFile,
  key: (id: string) => ["attachment", "file", id],
  fetch: (id: string) => callData("attachment.file", { id }),
  staleTime: Infinity,
  // A refusal is a file gone: asked once, not retried.
  retry: 0,
});

export const fileUrl = (path: string) => `file://${encodeURI(path)}`;

/** Where the server keeps the file (path, type), once it said. */
export function useAttachmentFile(id: () => string) {
  const query = useQuery(() => attachmentFileQuery(id()), { enabled: () => id() !== "" });
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
  const file = AttachmentFile.parse(await callData("attachment.file", { id }));
  await callData("host.openFile", { path: file.path });
}

/** Plays a sound file through the host (nsh has no audio on GPUI); one at a time, host.stopAudio stops it. */
export const playAudio = async (path: string, position = 0): Promise<void> => {
  await callData("host.playAudio", { path, position });
};
export const saveFile = async (path: string, name?: string) => SavedResult.parse(await callData("host.saveFile", { path, name }));

const LocalFile = z.object({ path: z.string(), name: z.string(), type: z.string(), size: z.number().int().nonnegative() });
export type LocalFile = z.infer<typeof LocalFile>;
export const pickFile = async () => LocalFile.nullable().parse(await callData("host.pickFile", {}));

export async function uploadAudio(file: LocalFile) {
  const reserved = await api.media.input.create({ kind: "audio", name: file.name, mime: file.type, size: file.size });
  try {
    return S.MediaInput.parse(await callData("media.input.uploadFile", { id: reserved.id, path: file.path }));
  } catch (error) {
    await api.media.input.delete({ id: reserved.id });
    throw error;
  }
}

export async function playInput(id: string, position = 0) {
  const file = AttachmentFile.parse(await callData("media.input.file", { id }));
  await playAudio(file.path, position);
}

const inputFileQuery = defineQuery({
  schema: AttachmentFile,
  key: (id: string) => ["media", "input", "file", id],
  fetch: (id: string) => callData("media.input.file", { id }),
  staleTime: Infinity,
  retry: 0,
});

export function useInputFile(id: () => string) {
  const query = useQuery(() => inputFileQuery(id()), { enabled: () => id() !== "" });
  return () => ready(query, undefined);
}

/** Extracts an absolute local filesystem path from a POSIX path or `file:` URL. */
export function localPathFromUri(uriOrPath: string): string | undefined {
  const trimmed = uriOrPath.trim();
  if (trimmed === "") return undefined;
  if (trimmed.startsWith("/")) return trimmed;
  if (!/^file:\/\//iu.test(trimmed)) return undefined;
  const withoutScheme = trimmed.slice("file://".length);
  const slash = withoutScheme.indexOf("/");
  if (slash < 0) return undefined;
  const hostPart = withoutScheme.slice(0, slash);
  if (hostPart !== "" && hostPart.toLowerCase() !== "localhost") return undefined;
  const rawPath = withoutScheme.slice(slash);
  try {
    const decoded = decodeURIComponent(rawPath);
    return decoded.startsWith("/") ? decoded : undefined;
  } catch {
    return rawPath.startsWith("/") ? rawPath : undefined;
  }
}

/** True when desktop is connected to the local embedded server and can stream disk files straight into CAS. */
function isLocalAttachmentImportAvailable(): boolean {
  return readConnectionMode() === "embedded";
}

/**
 * Imports a dropped or picked local file into CAS.
 * Uses zero-Base64 `attachment.importPath` against the local embedded server and falls back to
 * `host.readFile` + `attachment.create` when connected remotely or when the server does not allow local path import.
 */
export async function importLocalAttachment(uriOrPath: string, hints?: { name?: string; mime?: string }): Promise<Attachment> {
  const localPath = localPathFromUri(uriOrPath);
  if (isLocalAttachmentImportAvailable() && localPath !== undefined) {
    try {
      return await api.attachment.importPath({
        path: localPath,
        ...(hints?.name !== undefined && hints.name !== "" ? { name: hints.name } : {}),
        ...(hints?.mime !== undefined && hints.mime !== "" ? { mime: hints.mime } : {}),
      });
    } catch (error) {
      if (!(error instanceof VibeValleyApiError) || (error.bizCode !== BizCode.RouteNotFound && error.bizCode !== BizCode.Forbidden)) {
        throw error;
      }
    }
  }
  const file = ReadFileData.parse(await callData("host.readFile", { path: uriOrPath }));
  const name = hints?.name !== undefined && hints.name !== "" ? hints.name : file.name || "file";
  const type = hints?.mime !== undefined && hints.mime !== "" ? hints.mime : file.type || "application/octet-stream";
  return api.attachment.create({ name, type, data: file.data });
}
