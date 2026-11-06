import { afterEach, expect, test, vi } from "vite-plus/test";

import { livePath, statePath } from "./shapes";
import { readStream, streamHeartbeatMs, streamSilenceMs } from "./stream";

afterEach(() => vi.useRealTimers());

/** A response whose body the test writes to, as the server would, and never ends. */
function serverStream() {
  const encoder = new TextEncoder();
  let write: (text: string) => void = () => {};
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (write = (text) => c.enqueue(encoder.encode(text))), cancel });
  return { response: new Response(body, { headers: { "content-type": "text/event-stream" } }), write: (text: string) => write(text), cancel };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

const notice = { type: "notice", at: 1, level: "info", text: "hi" };

test("a stream that only pings is alive; one silent past the limit is given up as dead", async () => {
  vi.useFakeTimers();
  const server = serverStream();
  const heard: unknown[] = [];
  const read = readStream(
    "",
    livePath,
    (f) => heard.push(f),
    new AbortController().signal,
    () => Promise.resolve(server.response),
  );
  const ended = read.catch((e: unknown) => e);
  await settle();
  server.write(`data: ${JSON.stringify(notice)}\n\n`);
  await settle();
  expect(heard).toEqual([notice]);
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
  expect(heard).toEqual([notice]);
  expect(server.cancel).toHaveBeenCalledOnce();
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

test("a frame not in its stream's shape ends the stream with why", async () => {
  const server = serverStream();
  const heard: unknown[] = [];
  const ended = readStream(
    "",
    livePath,
    (f) => heard.push(f),
    new AbortController().signal,
    () => Promise.resolve(server.response),
  ).catch((e: unknown) => e);
  server.write(`data: {"type":"notice","at":"soon"}\n\n`);
  expect(String(await ended)).toContain("a frame not in its shape");
  expect(heard).toEqual([]);
});

for (const failure of ["frame", "callback", "http", "abort"] as const) {
  test(`regression: ${failure} exits release the stream and its request`, async () => {
    const server = serverStream();
    const caller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const callbackError = new Error("listener failed");
    const ended = readStream(
      "",
      livePath,
      () => {
        if (failure === "callback") throw callbackError;
      },
      caller.signal,
      (_url, init) => {
        requestSignal = init.signal ?? undefined;
        return Promise.resolve(failure === "http" ? new Response(server.response.body, { status: 503 }) : server.response);
      },
    ).catch((error: unknown) => error);
    if (failure === "abort") caller.abort();
    else if (failure !== "http") server.write(`data: ${JSON.stringify(failure === "frame" ? { type: "notice", at: "soon" } : notice)}\n\n`);
    const error = await ended;
    expect(error).toBeInstanceOf(Error);
    if (failure === "callback") expect(error).toBe(callbackError);
    expect(requestSignal?.aborted).toBe(true);
    expect(server.cancel).toHaveBeenCalledOnce();
  });
}

test("regression: cancellation failure does not replace the frame error", async () => {
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => controller.enqueue(new TextEncoder().encode('data: {"type":"notice","at":"soon"}\n\n')),
    cancel: () => Promise.reject(new Error("cancel failed")),
  });
  const error = await readStream(
    "",
    livePath,
    () => {},
    new AbortController().signal,
    () => Promise.resolve(new Response(body)),
  ).catch((e: unknown) => e);
  expect(String(error)).toContain("a frame not in its shape");
});
