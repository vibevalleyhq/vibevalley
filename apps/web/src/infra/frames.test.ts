import { afterEach, expect, test, vi } from "vite-plus/test";

import { streamSilenceMs } from "@vibevalley/protocol";

import { frames } from "./frames";
import { frameAt } from "./testing";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Each request to the state stream gets a body the test writes frames to, and that is never ended by the server. */
function server() {
  const encoder = new TextEncoder();
  const opened: ((text: string) => void)[] = [];
  const fetch = vi.fn((_url: string, init: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        opened.push((text) => c.enqueue(encoder.encode(text)));
        init.signal?.addEventListener("abort", () => c.error(new Error("aborted")));
      },
    });
    return Promise.resolve(new Response(body));
  });
  const send = (seq: number) => opened.at(-1)?.(`data: ${JSON.stringify(frameAt(seq))}\n\n`);
  return { fetch, send };
}

test("a stream gone quiet past its heartbeats is lost and opened again, as a half-open one after sleep is", async () => {
  vi.useFakeTimers();
  const s = server();
  vi.stubGlobal("fetch", s.fetch);
  const links: string[] = [];
  const off = frames.subscribe(() => links.push(frames.get().link));
  try {
    await vi.advanceTimersByTimeAsync(0);
    s.send(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(frames.get()).toMatchObject({ link: "open", frame: { seq: 1 } });
    await vi.advanceTimersByTimeAsync(streamSilenceMs);
    expect(frames.get().link).toBe("lost");
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.fetch).toHaveBeenCalledTimes(2);
    s.send(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(frames.get()).toMatchObject({ link: "open", frame: { seq: 2 }, count: 2 });
    expect(links).toEqual(["open", "lost", "open"]);
  } finally {
    off();
  }
});
