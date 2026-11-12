import { Hono } from "hono";

import { ApiError, BizCode } from "@vibevalley/protocol/api";
import { subscriptionPath, type SubscriptionName, subscriptions as contracts } from "@vibevalley/protocol/rpc";
import * as S from "@vibevalley/protocol/schema";

import { bizError, messageOf } from "#/base/errors.ts";
import { problemOf } from "#/base/json.ts";
import { sameOrigin } from "#/gateway/lan/lan.ts";
import { withinRealTime } from "#/infra/time.ts";
import type { Artifact } from "#/modules/artifact/artifact.ts";
import type { Channel } from "#/modules/channel/channel.ts";

import { replyError } from "./respond.ts";
import { type SseDeps, sse } from "./streams.ts";

const loopback = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/u;

/** Any page the user opens could send a simple request or read a stream it does not need to see, so only the farm's own
 * page may: a loopback host, and an origin (when the browser says one) that is that host. */
export const fromTheFarm = (headers: Headers): boolean => {
  const host = headers.get("host") ?? "";
  const origin = headers.get("origin");
  const site = headers.get("sec-fetch-site");
  return loopback.test(host) && sameOrigin({ host, ...(origin === null ? {} : { origin }), ...(site === null ? {} : { "sec-fetch-site": site }) });
};

type Open = (payload: unknown, signal: AbortSignal) => AsyncIterable<unknown>;

/** How long the first event may take before the stream starts without it: a refusal (no such channel…) comes within
 * the service's first reads, and a subscription with nothing missed waits for the next change. */
const firstWithinMs = 1_000;

export function subscriptions(deps: SseDeps & { readonly channel: Channel; readonly artifact: Artifact }): Hono {
  const { channel, artifact } = deps;
  const opens: { readonly [K in SubscriptionName]: Open } = {
    "channel.follow": (p, signal) => {
      const { id, after } = contracts["channel.follow"].payload.parse(p);
      return channel.follow(id, after, signal);
    },
    "channel.reports": (p, signal) => channel.reports(contracts["channel.reports"].payload.parse(p).after, signal),
    "artifact.follow": (p, signal) => {
      const { id, after } = contracts["artifact.follow"].payload.parse(p);
      return artifact.follow(S.artifactId(id), after, signal);
    },
    "artifact.suggestion.follow": (p, signal) => artifact.suggestionStream(S.artifactId(contracts["artifact.suggestion.follow"].payload.parse(p).id), signal),
  };
  const isName = (name: string): name is SubscriptionName => Object.hasOwn(contracts, name);

  const app = new Hono();
  app.get(`${subscriptionPath}/:name`, async (c) => {
    if (!fromTheFarm(c.req.raw.headers)) return replyError(bizError(BizCode.Forbidden, "forbidden"));
    const name = c.req.param("name");
    if (!isName(name)) return replyError(bizError(BizCode.RouteNotFound, `no subscription ${name}`));
    let payload: unknown;
    try {
      payload = JSON.parse(c.req.query("payload") ?? "{}");
    } catch (e) {
      return replyError(bizError(BizCode.InvalidInput, messageOf(e)));
    }
    const parsed = contracts[name].payload.safeParse(payload);
    if (!parsed.success) return replyError(bizError(BizCode.InvalidInput, problemOf(parsed.error)));

    const stop = new AbortController();
    const events = opens[name](parsed.data, stop.signal)[Symbol.asyncIterator]();
    const first = events.next();
    // Read here, not by the stream, so a refusal before the first event is answered as any route's is.
    first.catch(() => {});
    type Early =
      | { readonly kind: "event"; readonly r: IteratorResult<unknown> }
      | { readonly kind: "failed"; readonly e: unknown }
      | { readonly kind: "waiting" };
    const early = await withinRealTime<Early>(
      first.then(
        (r) => ({ kind: "event", r }),
        (e: unknown) => ({ kind: "failed", e }),
      ),
      firstWithinMs,
      { kind: "waiting" },
    );
    if (early.kind === "failed") {
      stop.abort();
      if (early.e instanceof ApiError) return replyError(early.e);
      throw early.e;
    }
    async function* rest(signal: AbortSignal): AsyncGenerator {
      const onAbort = () => stop.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const r = early.kind === "event" ? early.r : await first;
        if (r.done === true) return;
        yield r.value;
        for (let n = await events.next(); n.done !== true; n = await events.next()) yield n.value;
      } finally {
        signal.removeEventListener("abort", onAbort);
        stop.abort();
        await events.return?.();
      }
    }
    return sse(`subscribe.${name}`, rest, contracts[name].event, deps);
  });
  return app;
}
