import type { z } from "zod";

import type { ArtifactEvent, ChannelEvent, SuggestionEvent } from "@vibevalley/protocol";
import { streamSilenceMs } from "@vibevalley/protocol";
import { subscriptions, subscriptionUrl } from "@vibevalley/protocol/rpc";

/** The wait before connecting again after a connection could not be opened: 500 ms, growing by half each time, at most 5 s. */
export const reconnectDelayMs = (attempt: number) => Math.min(500 * 1.5 ** attempt, 5000);

// The connection could not be opened (no server, a dropped network): the subscription is asked for again.
class Unreachable extends Error {
  override readonly name = "Unreachable";
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** Each event of one subscription (its `subscriptionUrl`, each event decoded with its `event` Schema) until stop() is
 * called, or until it ends: the farm ended it or refused it, the line broke, or an event was not in its shape. A
 * connection that cannot be opened is tried again, with the same payload, after reconnectDelayMs. */
export function subscribe<E>(
  url: string,
  event: z.ZodType<E>,
  on: (e: E) => void,
  ended?: () => void,
  fetcher: Fetcher = (url, init) => fetch(url, init),
): () => void {
  const stop = new AbortController();
  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        await read(url, (data) => on(event.parse(JSON.parse(data))), stop.signal, fetcher);
        return;
      } catch (e) {
        if (stop.signal.aborted || !(e instanceof Unreachable)) return;
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      const again = setTimeout(resolve, reconnectDelayMs(attempt));
      stop.signal.addEventListener("abort", () => (clearTimeout(again), resolve()), { once: true });
      await promise;
      if (stop.signal.aborted) return;
    }
  };
  void run().finally(() => {
    if (!stop.signal.aborted) ended?.();
  });
  return () => stop.abort();
}

// Resolves when the server ends the stream; rejects when it refuses, breaks, stays silent for streamSilenceMs, or on abort.
async function read(url: string, onData: (data: string) => void, signal: AbortSignal, fetcher: Fetcher): Promise<void> {
  const request = new AbortController();
  const abort = () => request.abort();
  signal.addEventListener("abort", abort, { once: true });
  let quiet: ReturnType<typeof setTimeout> | undefined;
  const heard = () => {
    clearTimeout(quiet);
    quiet = setTimeout(() => request.abort(new Error(`${url}: nothing for ${streamSilenceMs} ms`)), streamSilenceMs);
  };
  let reader: ReadableStreamDefaultReader<string> | undefined;
  try {
    heard();
    let res: Response;
    try {
      res = await fetcher(url, { headers: { Accept: "text/event-stream" }, signal: request.signal });
    } catch (e) {
      if (e instanceof TypeError) throw new Unreachable(`${url}: unreachable`, { cause: e });
      throw e;
    }
    if (!res.ok || !res.body) throw new Error(`${url}: ${res.status}`);
    reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    request.signal.addEventListener("abort", () => void Promise.allSettled([reader?.cancel()]), { once: true });
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (request.signal.aborted) throw new Error(`${url}: aborted`);
      if (done) return;
      heard();
      buffer += value;
      let separator: RegExpExecArray | null;
      while ((separator = /\r?\n\r?\n/u.exec(buffer)) !== null) {
        const data = buffer
          .slice(0, separator.index)
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n");
        buffer = buffer.slice(separator.index + separator[0].length);
        if (data) onData(data);
      }
    }
  } finally {
    clearTimeout(quiet);
    signal.removeEventListener("abort", abort);
    request.abort();
    await Promise.allSettled([reader?.cancel()]);
  }
}

/** What is said in a channel after the message numbered after, then from now on. */
export const followChannel = (id: string, after: number, on: (e: ChannelEvent) => void, ended: () => void) =>
  subscribe(subscriptionUrl("channel.follow", { id, after }), subscriptions["channel.follow"].event, on, ended);

/** The farm's reports after the one with this id (the newest when absent), then each from now on. */
export const followReports = (after: string | undefined, on: (e: ChannelEvent) => void, ended: () => void) =>
  subscribe(subscriptionUrl("channel.reports", after === undefined ? {} : { after }), subscriptions["channel.reports"].event, on, ended);

/** A blocks artifact's changes after this seq, then each batch from now on. */
export const followArtifact = (id: string, after: number, on: (e: ArtifactEvent) => void, ended: () => void) =>
  subscribe(subscriptionUrl("artifact.follow", { id, after }), subscriptions["artifact.follow"].event, on, ended);

/** An artifact's suggestions as they now are, then the whole list after each change. */
export const followSuggestions = (id: string, on: (e: SuggestionEvent) => void, ended?: () => void) =>
  subscribe(subscriptionUrl("artifact.suggestion.follow", { id }), subscriptions["artifact.suggestion.follow"].event, on, ended);
