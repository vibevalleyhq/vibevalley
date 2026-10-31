// Reads one of the server's SSE streams (statePath, eventsPath, livePath) with fetch rather than EventSource: a host may
// serve the page under a scheme EventSource does not take, and fetch lets the caller pass its own.

import { Cause, Exit, Schema } from "effect";

import * as S from "./schema";
import { eventsPath, livePath, statePath, type LiveEvent, type SideEvent, type StateFrame } from "./shapes";

/** What each long-lived stream carries, by its path. The server writes each with the Schema for it (http/streams.ts
 * checks its Schemas against this). */
export interface Streams {
  [statePath]: StateFrame;
  [eventsPath]: SideEvent;
  [livePath]: LiveEvent;
}

/** Each payload is decoded with the Schema its stream is written with: a server of another version is told, not taken
 * for the shape. */
const decoders: { readonly [P in keyof Streams]: (json: unknown) => Exit.Exit<Streams[P], Schema.SchemaError> } = {
  [statePath]: Schema.decodeUnknownExit(S.StateFrame),
  [eventsPath]: Schema.decodeUnknownExit(S.SideEvent),
  [livePath]: Schema.decodeUnknownExit(S.LiveEvent),
};

/** The server writes a comment line on every stream this often, however quiet it is (apps/server/src/http/streams.ts). */
export const streamHeartbeatMs = 20_000;

/**
 * Nothing at all for this long, not even a heartbeat: the connection is dead though it looks open (a machine woke from
 * sleep with it half-open, a network that dropped it without a word). Two heartbeats missed, and a margin for a slow one.
 */
export const streamSilenceMs = streamHeartbeatMs * 2 + 5_000;

/** Never resolves: it rejects when the signal aborts, the stream ends, or it stays silent for `silenceMs`. */
export async function readStream<P extends keyof Streams>(
  base: string,
  path: P,
  onEvent: (event: Streams[P]) => void,
  signal: AbortSignal,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
  silenceMs: number = streamSilenceMs,
): Promise<never> {
  const url = base.replace(/\/$/u, "") + path;
  // The request's own signal: the caller's abort ends it, and so does the silence, which the caller's signal does not see.
  const request = new AbortController();
  let reason: Error | undefined;
  // Read through a function: set in callbacks, a plain read would be narrowed to never set.
  const stoppedFor = (): Error | undefined => reason;
  const end = (why: Error) => {
    reason ??= why;
    request.abort(why);
  };
  const stop = () => end(new Error(`${url}: aborted`));
  if (signal.aborted) stop();
  signal.addEventListener("abort", stop, { once: true });
  let quiet: ReturnType<typeof setTimeout> | undefined;
  const heard = () => {
    clearTimeout(quiet);
    quiet = setTimeout(() => end(new Error(`${url}: nothing for ${silenceMs} ms`)), silenceMs);
  };
  try {
    heard();
    const res = await fetcher(url, { headers: { Accept: "text/event-stream" }, signal: request.signal });
    const early = stoppedFor();
    if (early) throw early;
    if (!res.ok || !res.body) throw new Error(`${url}: ${res.status}`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    // A fetcher that does not end its body on abort (a host's own) would leave the read below waiting forever. A cancel
    // refused because fetch already errored the body says nothing new: the read throws the stop's reason either way.
    request.signal.addEventListener("abort", () => void reader.cancel().catch(() => undefined), { once: true });
    let buffer = "";
    for (;;) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- a stream is read a chunk at a time
      const { value, done } = await reader.read();
      const why = stoppedFor();
      if (why) throw why;
      if (done) throw new Error(`${url}: ended`);
      heard();
      buffer += value;
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const data = buffer
          .slice(0, end)
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n");
        buffer = buffer.slice(end + 2);
        if (!data) continue;
        const decoded = decoders[path](JSON.parse(data));
        if (Exit.isFailure(decoded)) throw new Error(`${url}: a frame not in its shape: ${Cause.pretty(decoded.cause)}`);
        onEvent(decoded.value);
      }
    }
  } finally {
    clearTimeout(quiet);
    signal.removeEventListener("abort", stop);
  }
}
