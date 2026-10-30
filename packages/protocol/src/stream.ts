// Reads one of the server's SSE streams (statePath, eventsPath, livePath) with fetch rather than EventSource: a host may
// serve the page under a scheme EventSource does not take, and fetch lets the caller pass its own.

import { type eventsPath, type livePath, type statePath, type LiveEvent, type SideEvent, type StateFrame } from "./shapes";

/** What each long-lived stream carries, by its path. The server writes each with the Schema for it (http/streams.ts
 * checks its Schemas against this), so a payload read here is taken as that shape, not decoded again on every frame. */
export interface Streams {
  [statePath]: StateFrame;
  [eventsPath]: SideEvent;
  [livePath]: LiveEvent;
}

/** Never resolves: it rejects when the signal aborts or the stream ends. */
export async function readStream<P extends keyof Streams>(
  base: string,
  path: P,
  onEvent: (event: Streams[P]) => void,
  signal: AbortSignal,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
): Promise<never> {
  const url = base.replace(/\/$/u, "") + path;
  const res = await fetcher(url, { headers: { Accept: "text/event-stream" }, signal });
  if (!res.ok || !res.body) throw new Error(`${url}: ${res.status}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`${url}: ended`);
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
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the server writes each stream's frames in the shape Streams gives its path
      if (data) onEvent(JSON.parse(data) as Streams[P]);
    }
  }
}
