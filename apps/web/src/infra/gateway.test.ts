import { expect, test, vi } from "vite-plus/test";

import { subscriptions, subscriptionUrl } from "@vibevalley/protocol/rpc";

import { reconnectDelayMs, subscribe } from "./gateway";

const event = subscriptions["channel.follow"].event;
const url = subscriptionUrl("channel.follow", { id: "c", after: 0 });

/** A response whose body is these SSE chunks, then ends. */
const stream = (...chunks: string[]) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
        c.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );

test("each data line is one decoded event, and the farm ending the stream ends the subscription", async () => {
  const fetcher = vi.fn(() => Promise.resolve(stream(': heartbeat\n\ndata: {"_tag":"Re', 'set"}\n\n', 'data: {"_tag":"Reset"}\n\n')));
  const seen: unknown[] = [];
  const { promise: ended, resolve } = Promise.withResolvers<void>();
  subscribe(url, event, (e) => seen.push(e), resolve, fetcher);
  await ended;
  expect(seen).toEqual([{ _tag: "Reset" }, { _tag: "Reset" }]);
  expect(fetcher).toHaveBeenCalledWith(url, expect.objectContaining({ headers: { Accept: "text/event-stream" } }));
});

test("a refusal or an event not in its shape ends it; one not reachable is asked for again", async () => {
  vi.useFakeTimers();
  try {
    const refused = vi.fn();
    subscribe(
      url,
      event,
      () => {},
      refused,
      () => Promise.resolve(Response.json({ bizCode: 404, message: "no such channel" }, { status: 404 })),
    );
    const malformed = vi.fn();
    subscribe(
      url,
      event,
      () => {},
      malformed,
      () => Promise.resolve(stream('data: {"_tag":"Other"}\n\n')),
    );
    let tries = 0;
    const unreachable = vi.fn();
    const stop = subscribe(
      url,
      event,
      () => {},
      unreachable,
      () => (++tries < 3 ? Promise.reject(new TypeError("offline")) : new Promise<Response>(() => {})),
    );
    await vi.advanceTimersByTimeAsync(reconnectDelayMs(0) + reconnectDelayMs(1));
    expect(refused).toHaveBeenCalledOnce();
    expect(malformed).toHaveBeenCalledOnce();
    expect(tries).toBe(3);
    expect(unreachable).not.toHaveBeenCalled();
    stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(unreachable).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
