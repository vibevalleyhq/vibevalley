import { AgoraClient, Area as AgoraArea } from "agora-agents";
import agoraToken from "agora-token";
import { z } from "zod";

import type { Clock } from "@vibevalley/async";
const { RtcRole, RtcTokenBuilder } = agoraToken;
export const tokenSeconds = 3600;
export interface AgoraCredentials {
  readonly appId: string;
  readonly appCertificate: string;
}
export type Area = "US" | "EU" | "AP" | "CN";

const areaOf = (area: Area) => ({ US: AgoraArea.US, EU: AgoraArea.EU, AP: AgoraArea.AP, CN: AgoraArea.CN } as const)[area];

/** What Agora's retries wait on: the service's clock, so a test holding time still holds them too. */
export type Run = Pick<Clock, "sleep">;

const retryable = (response: Response) => [408, 429].includes(response.status) || response.status >= 500;

/** Agora's REST calls retried as its SDK would: 408, 429 and 5xx, twice, after what Retry-After says (at most a minute),
 * else 1 s then 2 s. The waits are on run's clock: the SDK's own retries wait on real time, out of its reach. */
export const retrying =
  (fetcher: typeof fetch, run: Run): typeof fetch =>
  async (input, init) => {
    for (let attempt = 1; ; attempt++) {
      const response = await fetcher(input, init);
      if (attempt > 2 || !retryable(response)) return response;
      const after = Number(response.headers.get("Retry-After"));
      await run.sleep(after > 0 ? Math.min(after * 1000, 60_000) : 1000 * 2 ** (attempt - 1), init?.signal ?? undefined);
    }
  };

export const clientOf = (c: AgoraCredentials, area: Area, run: Run, fetcher: typeof fetch = fetch) =>
  new AgoraClient({
    area: areaOf(area),
    appId: c.appId,
    appCertificate: c.appCertificate,
    maxRetries: 0,
    fetch: retrying(fetcher, run),
  });

const AgoraStopError = z.object({
  statusCode: z.exactOptional(z.number()),
  message: z.exactOptional(z.string()),
  body: z.exactOptional(
    z.object({
      detail: z.exactOptional(z.string()),
      reason: z.exactOptional(z.string()),
    }),
  ),
});

/** Already left or leaving counts as success, as the quickstart treats it. */
export function alreadyStopping(e: unknown): boolean {
  const decoded = AgoraStopError.safeParse(e);
  if (!decoded.success) return false;
  const err = decoded.data;
  if (err.statusCode === 404) return true;
  const said = [err.body?.detail, err.body?.reason, err.message];
  return said.some((s) => s !== undefined && s.toLowerCase().includes("already in the process of shutting down"));
}

export const sign = (c: AgoraCredentials, channel: string, uid: string) => ({
  appId: c.appId,
  channel,
  uid,
  token: RtcTokenBuilder.buildTokenWithRtm(c.appId, c.appCertificate, channel, uid, RtcRole.PUBLISHER, tokenSeconds, tokenSeconds),
});

/** A uniform integer in [0, n) for n up to 2^32: a draw at or past the last whole multiple of n is drawn again. */
const randomBelow = (n: number): number => {
  const limit = 2 ** 32 - (2 ** 32 % n);
  for (;;) {
    const value = crypto.getRandomValues(new Uint32Array(1))[0]!;
    if (value < limit) return value % n;
  }
};

/** now is in milliseconds. */
export const newChannel = (now: number) =>
  `vibevalley-${now}-${Array.from({ length: 6 }, () => "0123456789abcdefghijklmnopqrstuvwxyz"[randomBelow(36)]).join("")}`;
export const newUid = () => String(randomBelow(9_999_000) + 1000);
