import { t } from "@vibevalley/i18n";
import { mediaInputContentPath } from "@vibevalley/protocol";

import { api } from "./api.ts";

export async function uploadMediaInput(id: string, file: File, signal: AbortSignal) {
  const response = await fetch(mediaInputContentPath(id), { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: file, signal });
  if (!response.ok) throw new Error(t("web.media.understanding.uploadFailed"));
  return api.media.input.get({ id }, { signal });
}
