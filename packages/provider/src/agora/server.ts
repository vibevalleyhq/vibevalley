import { randomInt } from "node:crypto";

import { AgoraClient, Area as AgoraArea } from "agora-agents";
import agoraToken from "agora-token";
import { Effect, Schedule, Schema } from "effect";
const { RtcRole, RtcTokenBuilder } = agoraToken;
export const tokenSeconds = 3600;
export interface AgoraCredentials {
  readonly appId: string;
  readonly appCertificate: string;
}
export type Area = "US" | "EU" | "AP" | "CN";

const areaOf = (area: Area) => ({ US: AgoraArea.US, EU: AgoraArea.EU, AP: AgoraArea.AP, CN: AgoraArea.CN } as const)[area];

/** As Agora's SDK retries on its own: 408, 429 and 5xx, twice, after what Retry-After says (at most a minute), else 1 s then 2 s. */
const agoraRetries = Schedule.exponential("1 second").pipe(
  Schedule.setInputType<Response>(),
  Schedule.while(({ input, attempt }) => attempt <= 2 && ([408, 429].includes(input.status) || input.status >= 500)),
  Schedule.modifyDelay(({ input, duration }) => {
    const after = Number(input.headers.get("Retry-After"));
    return Effect.succeed(after > 0 ? Math.min(after * 1000, 60_000) : duration);
  }),
  Schedule.passthrough,
);

/** Agora's REST calls retried as its SDK would, but sleeping on the service's Clock: the SDK's own retries wait on real
 * time, out of its reach. */
export const retrying =
  (fetcher: typeof fetch, run: Run): typeof fetch =>
  (input, init) =>
    run(
      Effect.repeat(
        Effect.promise(() => fetcher(input, init)),
        agoraRetries,
      ),
      init?.signal ? { signal: init.signal } : undefined,
    );

/** Runs an Effect for the Promise side (the Agora SDK's fetch) on the service's fibers, so its sleeps are on its Clock. */
export type Run = <A>(effect: Effect.Effect<A>, options?: { readonly signal: AbortSignal }) => Promise<A>;

export const clientOf = (c: AgoraCredentials, area: Area, run: Run, fetcher: typeof fetch = fetch) =>
  new AgoraClient({
    area: areaOf(area),
    appId: c.appId,
    appCertificate: c.appCertificate,
    maxRetries: 0,
    fetch: retrying(fetcher, run),
  });

const AgoraStopError = Schema.Struct({
  statusCode: Schema.optionalKey(Schema.Finite),
  message: Schema.optionalKey(Schema.String),
  body: Schema.optionalKey(
    Schema.Struct({
      detail: Schema.optionalKey(Schema.String),
      reason: Schema.optionalKey(Schema.String),
    }),
  ),
});

/** Already left or leaving counts as success, as the quickstart treats it. */
export function alreadyStopping(e: unknown): boolean {
  const decoded = Schema.decodeUnknownOption(AgoraStopError)(e);
  if (decoded._tag === "None") return false;
  const err = decoded.value;
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

/** now is in milliseconds. */
export const newChannel = (now: number) =>
  `vibevalley-${now}-${Array.from({ length: 6 }, () => "0123456789abcdefghijklmnopqrstuvwxyz"[randomInt(36)]).join("")}`;
export const newUid = () => String(randomInt(9_999_000) + 1000);
