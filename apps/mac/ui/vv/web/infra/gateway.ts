// VibeValley's infra/gateway.ts with the same exports. There each
// subscription is an SSE stream (`subscriptionUrl`) read with fetch; in
// VibeValley it is the transport's `subscribe` (the bridge's, ui/bridge.ts),
// each event still decoded with rpc.ts's Schema. A refusal or a broken
// stream ends it; one the transport could not open at all is asked for again
// after reconnectDelayMs, as there. The fetcher parameter is gone (no HTTP).
import type { z } from "zod";

import type { ArtifactEvent, ChannelEvent, SuggestionEvent } from "@vibevalley/protocol";
import { type SubscriptionName, subscriptions } from "@vibevalley/protocol/rpc";

import { transport } from "./transport";

/** The wait before connecting again after a connection could not be opened: 500 ms, growing by half each time, at most 5 s. */
const reconnectDelayMs = (attempt: number) => Math.min(500 * 1.5 ** attempt, 5000);

/** VibeValley's ServiceUnavailable: the bridge had no server to ask. */
const unreachable = 100009;

/** Each event of one subscription (each decoded with its `event` Schema) until stop() is called, or until it ends: the
 * farm ended it or refused it, or an event was not in its shape. A subscription that could not be opened is tried
 * again, with the same payload, after reconnectDelayMs. */
function subscribe<E>(name: SubscriptionName, payload: unknown, event: z.ZodType<E>, on: (e: E) => void, ended?: () => void): () => void {
  let stopped = false;
  let stop: (() => void) | undefined;
  let again: ReturnType<typeof setTimeout> | undefined;
  const open = (attempt: number) => {
    const t = transport();
    if (!t.subscribe) {
      queueMicrotask(() => !stopped && ended?.());
      return;
    }
    let done = false;
    const finish = (retry: boolean) => {
      if (done) return;
      done = true;
      stop?.();
      stop = undefined;
      if (stopped) return;
      if (retry) again = setTimeout(() => !stopped && open(attempt + 1), reconnectDelayMs(attempt));
      else ended?.();
    };
    stop = t.subscribe(
      name,
      payload,
      (raw) => {
        if (done || stopped) return;
        const parsed = event.safeParse(raw);
        if (parsed.success) on(parsed.data);
        else finish(false);
      },
      (why) => finish(why?.bizCode === unreachable),
    );
  };
  open(0);
  return () => {
    stopped = true;
    clearTimeout(again);
    stop?.();
    stop = undefined;
  };
}

/** What is said in a channel after the message numbered after, then from now on. */
export const followChannel = (id: string, after: number, on: (e: ChannelEvent) => void, ended: () => void) =>
  subscribe("channel.follow", { id, after }, subscriptions["channel.follow"].event, on, ended);

/** A blocks artifact's changes after this seq, then each batch from now on. */
export const followArtifact = (id: string, after: number, on: (e: ArtifactEvent) => void, ended: () => void) =>
  subscribe("artifact.follow", { id, after }, subscriptions["artifact.follow"].event, on, ended);

/** An artifact's suggestions as they now are, then the whole list after each change. */
export const followSuggestions = (id: string, on: (e: SuggestionEvent) => void, ended?: () => void) =>
  subscribe("artifact.suggestion.follow", { id }, subscriptions["artifact.suggestion.follow"].event, on, ended);
