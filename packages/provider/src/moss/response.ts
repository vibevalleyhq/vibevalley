import { bodyChunks } from "../base/http.ts";
import { MossError } from "./error.ts";

/** A key that cannot go into an Authorization header as it is. */
export const badKey = (key: string): boolean => !key.trim() || /\s/u.test(key);

/** The body as text, at most 1 MiB; past that MossError("TooLarge") and the body is canceled. */
export async function readMossResponse(response: Response, signal: AbortSignal): Promise<string> {
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of bodyChunks(response, signal)) {
    bytes += chunk.byteLength;
    if (bytes > 1 << 20) throw new MossError({ reason: "TooLarge", outcome: "Unknown" });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Statuses that mean MOSS looked at the request and refused it, so nothing was done. */
export const rejectedStatuses: readonly number[] = [400, 401, 403, 413, 422, 429];
