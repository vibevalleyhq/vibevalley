import { withTimeout } from "@vibevalley/async";

import { readBytesUpTo } from "#/base/stream.ts";
import { type PublicFetch, publicHttps } from "#/infra/publicHttp.ts";
import type { Time } from "#/infra/time.ts";
import { attachmentMax } from "#/platform/attachment/attachment.ts";

import { validPng } from "./png.ts";

export class DownloadFailed extends Error {
  override readonly name = "DownloadFailed";
  constructor(options?: ErrorOptions) {
    super("The image could not be downloaded", options);
  }
}

const deadlineMs = 60_000;

/** A generated image's PNG from a public https address: no credentials, no redirects, checked to be the size asked for.
 * Anything else, a deadline passed included, is DownloadFailed; only the caller's own abort goes on as it is. */
export async function downloadImage(
  fetch: PublicFetch,
  address: string,
  width: number,
  height: number,
  deps: { readonly clock: Time },
  signal?: AbortSignal,
): Promise<Buffer> {
  let url: URL;
  try {
    url = new URL(address);
  } catch (e) {
    throw new DownloadFailed({ cause: e });
  }
  if (!publicHttps(url)) throw new DownloadFailed();
  try {
    return await withTimeout(
      async (deadline) => {
        const response = await fetch(url, { method: "GET", headers: { accept: "image/png" }, redirect: "manual", signal: deadline });
        if (response.status !== 200 || response.headers.get("content-type")?.split(";")[0]?.trim() !== "image/png") {
          await response.body?.cancel().catch(() => undefined);
          throw new DownloadFailed();
        }
        const bytes = await readBytesUpTo(response.body, attachmentMax, { signal: deadline });
        if (bytes === undefined || !validPng(bytes, width, height)) throw new DownloadFailed();
        return bytes;
      },
      deadlineMs,
      { clock: deps.clock, ...(signal === undefined ? {} : { signal }), what: "the image download" },
    );
  } catch (e) {
    if (signal?.aborted === true) throw e;
    if (e instanceof DownloadFailed) throw e;
    throw new DownloadFailed({ cause: e });
  }
}
