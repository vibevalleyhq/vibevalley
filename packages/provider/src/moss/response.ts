import { z } from "zod";

import { bodyChunks } from "../base/http.ts";

export const MossErrorReason = z.enum(["Credentials", "InvalidInput", "Network", "Timeout", "HttpStatus", "InvalidResponse", "TooLarge"]);
export type MossErrorReason = z.output<typeof MossErrorReason>;
export const MossErrorOutcome = z.enum(["NotSubmitted", "Rejected", "Unknown"]);
export type MossErrorOutcome = z.output<typeof MossErrorOutcome>;

/** The fields every MOSS error carries: what failed, whether the request may have taken effect, the HTTP status. */
export interface MossErrorFields {
  readonly reason: MossErrorReason;
  readonly outcome: MossErrorOutcome;
  readonly status?: number;
}

export class MossResponseTooLarge extends Error {
  override readonly name = "MossResponseTooLarge";
  constructor() {
    super("The MOSS response is over 1 MiB");
  }
}

/** A key that cannot go into an Authorization header as it is. */
export const badKey = (key: string): boolean => !key.trim() || /\s/u.test(key);

/** The body as text, at most 1 MiB; past that MossResponseTooLarge and the body is canceled. */
export async function readMossResponse(response: Response, signal: AbortSignal): Promise<string> {
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of bodyChunks(response, signal)) {
    bytes += chunk.byteLength;
    if (bytes > 1 << 20) throw new MossResponseTooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Statuses that mean MOSS looked at the request and refused it, so nothing was done. */
export const rejectedStatuses: readonly number[] = [400, 401, 403, 413, 422, 429];
