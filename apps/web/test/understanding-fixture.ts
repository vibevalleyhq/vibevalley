import { readFileSync } from "node:fs";
import { join } from "node:path";

import { mediaInputContentPath, type VibeValleyApi } from "@vibevalley/protocol";

export const understandingFile = (kind: "image" | "video") => ({
  path: join(import.meta.dirname, "testdata", kind === "image" ? "understanding.png" : "understanding.mp4"),
  mime: kind === "image" ? "image/png" : "video/mp4",
  name: kind === "image" ? "understanding.png" : "understanding.mp4",
});

export async function bindUnderstanding(api: VibeValleyApi) {
  const current = await api.provider.get();
  return api.provider.update({
    revision: current.revision,
    connections: [{ id: "understanding", name: "Understanding test account", adapter: "moss", enabled: true, key: "test-understanding-key" }],
    dictation: null,
    live: null,
    image: null,
    understanding: { connection: "understanding", model: "moss-vl-1.0" },
    speech: null,
    speakers: null,
    voiceDesign: null,
    transcription: null,
    vision: null,
  });
}

export async function localUnderstandingInput(api: VibeValleyApi, kind: "image" | "video") {
  const file = understandingFile(kind);
  const bytes = readFileSync(file.path);
  const input = await api.media.input.create({ kind, name: file.name, mime: file.mime, size: bytes.length });
  const response = await fetch(`${api.base}${mediaInputContentPath(input.id)}`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: bytes,
  });
  if (!response.ok) throw new Error(`Synthetic input upload failed: ${response.status}`);
  return api.media.input.get({ id: input.id });
}

/** The file kept and put in the library, as the page's upload does: understanding starts from it. */
export const libraryUnderstandingFile = (given: { readonly api: VibeValleyApi; readonly kind: "image" | "video" }) => {
  const file = understandingFile(given.kind);
  return given.api.attachment
    .create({ name: file.name, type: file.mime, data: readFileSync(file.path).toString("base64") })
    .then((kept) => given.api.library.item.add({ attachment: kept.id }).then(() => kept));
};
