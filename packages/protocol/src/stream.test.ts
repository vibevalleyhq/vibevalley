import { afterEach, expect, test, vi } from "vite-plus/test";

import { statePath } from "./shapes";
import { readStream, streamHeartbeatMs, streamSilenceMs } from "./stream";

afterEach(() => vi.useRealTimers());

/** A response whose body the test writes to, as the server would, and never ends. */
function serverStream() {
  const encoder = new TextEncoder();
  let write: (text: string) => void = () => {};
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (write = (text) => c.enqueue(encoder.encode(text))) });
  return { response: new Response(body, { headers: { "content-type": "text/event-stream" } }), write: (text: string) => write(text) };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

test("a stream that only pings is alive; one silent past the limit is given up as dead", async () => {
  vi.useFakeTimers();
  const server = serverStream();
  const heard: unknown[] = [];
  const read = readStream(
    "",
    statePath,
    (f) => heard.push(f),
    new AbortController().signal,
    () => Promise.resolve(server.response),
  );
  const ended = read.catch((e: unknown) => e);
  await settle();
  server.write(`data: {"seq":1}\n\n`);
  await settle();
  expect(heard).toEqual([{ seq: 1 }]);
  // Five heartbeats: well past the silence limit in all, never past it between two.
  const pings = async (left: number): Promise<void> => {
    if (left === 0) return;
    await vi.advanceTimersByTimeAsync(streamHeartbeatMs);
    server.write(": ping\n\n");
    return pings(left - 1);
  };
  await pings(5);
  await settle();
  expect(await Promise.race([ended.then(() => "ended"), Promise.resolve("open")])).toBe("open");
  await vi.advanceTimersByTimeAsync(streamSilenceMs);
  expect(String(await ended)).toContain("nothing for");
  expect(heard).toEqual([{ seq: 1 }]);
});

test("the caller's abort ends it at once", async () => {
  const server = serverStream();
  const abort = new AbortController();
  const ended = readStream(
    "",
    statePath,
    () => {},
    abort.signal,
    (_url, init) => {
      init.signal?.addEventListener("abort", () => void server.response.body?.cancel());
      return Promise.resolve(server.response);
    },
  ).catch((e: unknown) => e);
  abort.abort();
  expect(await ended).toBeDefined();
});
