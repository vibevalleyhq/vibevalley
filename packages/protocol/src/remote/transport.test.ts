import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { VibeValleyApi, VibeValleyApiError } from "../client";
import { BizCode } from "../endpoint";
import { createHttpRemoteTransport, normalizeServerUrl, pairWithServer, parsePairUrl, type RemoteConnectionState, type RemoteEnvelope } from "./transport";

const encoder = new TextEncoder();

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function streamFromChunks(
  chunks: readonly string[],
  options?: { readonly holdOpen?: boolean },
): {
  readonly stream: ReadableStream<Uint8Array>;
  readonly cancelled: () => boolean;
} {
  let isCancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      if (options?.holdOpen !== true) {
        controller.close();
      }
    },
    cancel() {
      isCancelled = true;
    },
  });
  return { stream, cancelled: () => isCancelled };
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const headers = new Headers(init?.headers);
  return headers.get(name) ?? undefined;
}

describe("normalizeServerUrl and parsePairUrl", () => {
  it("normalizes bare host:port and trims whitespace and trailing slashes", () => {
    expect(normalizeServerUrl("100.99.221.58:8890")).toBe("http://100.99.221.58:8890");
    expect(normalizeServerUrl("  127.0.0.1:8890///  ")).toBe("http://127.0.0.1:8890");
    expect(normalizeServerUrl("https://mac.tail1234.ts.net/")).toBe("https://mac.tail1234.ts.net");
    expect(normalizeServerUrl("   ")).toBe("");
  });

  it("parses valid vibevalley://pair deep links and rejects unsafe or malformed ones", () => {
    expect(parsePairUrl("vibevalley://pair?url=http%3A%2F%2F100.99.221.58%3A8890%2F&code=%20ABCD-1234%20")).toEqual({
      url: "http://100.99.221.58:8890",
      code: "ABCD-1234",
    });
    expect(parsePairUrl("vibevalley://pair/?url=https%3A%2F%2Fmac.ts.net&code=XYZ")).toEqual({
      url: "https://mac.ts.net",
      code: "XYZ",
    });

    expect(parsePairUrl("")).toBeNull();
    expect(parsePairUrl("https://pair?url=http://100.1.2.3:8890&code=ABC")).toBeNull();
    expect(parsePairUrl("vibevalley://other?url=http://100.1.2.3:8890&code=ABC")).toBeNull();
    expect(parsePairUrl("vibevalley://pair/extra?url=http://100.1.2.3:8890&code=ABC")).toBeNull();
    expect(parsePairUrl("vibevalley://pair?url=javascript%3Aalert(1)&code=ABC")).toBeNull();
    expect(parsePairUrl("vibevalley://pair?url=file%3A%2F%2F%2Fetc%2Fpasswd&code=ABC")).toBeNull();
    expect(parsePairUrl("vibevalley://pair?url=http%3A%2F%2F100.1.2.3%3A8890&code=%20%20")).toBeNull();
    expect(parsePairUrl("vibevalley://pair?code=ABC")).toBeNull();
  });
});

describe("pairWithServer", () => {
  it("POSTs pairing exchange, validates Zod result, and throws VibeValleyApiError on non-zero bizCode", async () => {
    const requests: { url: string; method: string | undefined; client: string | undefined; body: string | undefined }[] = [];
    const okResult = {
      device: { id: "dev-1", name: "iPhone", platform: "ios" as const, scope: "remote:default", createdAt: 1700000000000 },
      token: "vv_dev_secret",
      serverName: "MacBook",
      version: "0.1.0",
    };

    const got = await pairWithServer("100.99.221.58:8890/", { code: "ABCD", deviceName: "iPhone", platform: "ios" }, (input, init) => {
      requests.push({
        url: urlOf(input),
        method: init?.method,
        client: headerOf(init, "x-vibevalley-client"),
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return Promise.resolve(new Response(JSON.stringify({ bizCode: 0, message: "ok", data: okResult }), { status: 200 }));
    });

    expect(got).toEqual(okResult);
    expect(requests).toEqual([
      {
        url: "http://100.99.221.58:8890/api/v1/remote/pair/exchange",
        method: "POST",
        client: "remote",
        body: JSON.stringify({ code: "ABCD", deviceName: "iPhone", platform: "ios" }),
      },
    ]);

    const err = await pairWithServer("http://100.99.221.58:8890", { code: "BAD", deviceName: "iPhone", platform: "ios" }, () =>
      Promise.resolve(new Response(JSON.stringify({ bizCode: BizCode.AuthRefused, message: "expired" }), { status: 403 })),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(VibeValleyApiError);
    expect((err as VibeValleyApiError).bizCode).toBe(BizCode.AuthRefused);
    expect((err as VibeValleyApiError).status).toBe(403);
    expect((err as VibeValleyApiError).reason).toBe("expired");
  });
});

describe("createHttpRemoteTransport", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends Bearer auth on call(), works with VibeValleyApi.over, and reports unauthorized on 401", async () => {
    const states: RemoteConnectionState[] = [];
    const seen: { url: string; auth: string | undefined; client: string | undefined; contentType: string | undefined }[] = [];

    const transport = createHttpRemoteTransport({
      baseUrl: "100.99.221.58:8890/",
      token: "vv_dev_tok1",
      onConnectionChange: (s) => states.push(s),
      fetch: (input, init) => {
        seen.push({
          url: urlOf(input),
          auth: headerOf(init, "authorization"),
          client: headerOf(init, "x-vibevalley-client"),
          contentType: headerOf(init, "content-type"),
        });
        if (urlOf(input).endsWith("/api/v1/remote/whoami")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                bizCode: 0,
                message: "ok",
                data: { caller: "remote", serverName: "Mac", version: "0.1.0", channel: "dev" },
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response(JSON.stringify({ bizCode: BizCode.Unauthorized, message: "revoked" }), { status: 401 }));
      },
    });

    const api = VibeValleyApi.over((op, input, opts) => transport.call(op, input, opts));
    const whoami = await api.remote.whoami();
    expect(whoami).toEqual({ caller: "remote", serverName: "Mac", version: "0.1.0", channel: "dev" });

    await expect(transport.call("issue.comment.create", { id: "i1", body: "hi" })).resolves.toEqual({
      bizCode: BizCode.Unauthorized,
      message: "revoked",
    });

    expect(seen).toEqual([
      {
        url: "http://100.99.221.58:8890/api/v1/remote/whoami",
        auth: "Bearer vv_dev_tok1",
        client: "remote",
        contentType: undefined,
      },
      {
        url: "http://100.99.221.58:8890/api/v1/issue/comment/create",
        auth: "Bearer vv_dev_tok1",
        client: "remote",
        contentType: "application/json",
      },
    ]);
    expect(states).toEqual(["unauthorized"]);
    transport.close();
  });

  it("parses chunked multiline SSE slices, reconnects with exponential backoff and Last-Event-ID, and stops on 401", async () => {
    vi.useFakeTimers();
    const states: RemoteConnectionState[] = [];
    const lastEventIds: (string | undefined)[] = [];
    const receivedSeqs: number[] = [];
    let attempt = 0;

    const transport = createHttpRemoteTransport({
      baseUrl: "http://100.99.221.58:8890",
      token: "vv_dev_tok2",
      onConnectionChange: (s) => states.push(s),
      fetch: (_input, init) => {
        attempt++;
        lastEventIds.push(headerOf(init, "last-event-id"));
        if (attempt === 1) {
          const { stream } = streamFromChunks([": ping\r\n\r\n", "id: 7\r\n", 'data: {"seq":7,\r\n', 'data: "issues":[]}\r', "\n\r\n"]);
          return Promise.resolve(new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }));
        }
        if (attempt === 2) {
          return Promise.reject(new TypeError("network down"));
        }
        if (attempt === 3) {
          const { stream } = streamFromChunks(['id: 8\ndata: {"seq":8,"issues":[]}\n\n']);
          return Promise.resolve(new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }));
        }
        return Promise.resolve(new Response(JSON.stringify({ bizCode: BizCode.Unauthorized, message: "revoked" }), { status: 401 }));
      },
    });

    const unsub = transport.slice("board", (frame) => receivedSeqs.push(frame.seq));

    await vi.advanceTimersByTimeAsync(0);
    expect(receivedSeqs).toEqual([7]);
    expect(lastEventIds).toEqual([undefined]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(attempt).toBe(2);
    expect(lastEventIds).toEqual([undefined, "7"]);

    await vi.advanceTimersByTimeAsync(1500);
    expect(attempt).toBe(2);

    await vi.advanceTimersByTimeAsync(500);
    expect(attempt).toBe(3);
    expect(receivedSeqs).toEqual([7, 8]);
    expect(lastEventIds).toEqual([undefined, "7", "7"]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(attempt).toBe(4);
    expect(lastEventIds).toEqual([undefined, "7", "7", "8"]);
    expect(states).toContain("connecting");
    expect(states).toContain("connected");
    expect(states).toContain("reconnecting");
    expect(states.at(-1)).toBe("unauthorized");

    await vi.advanceTimersByTimeAsync(30000);
    expect(attempt).toBe(4);

    unsub();
    transport.close();
  });

  it("streams subscribe() events, delivers refusal envelopes, and cancels all streams cleanly on close()", async () => {
    const events: unknown[] = [];
    const endedCalls: (RemoteEnvelope | null)[] = [];
    const seenUrls: string[] = [];
    const openStream = streamFromChunks(['data: {"type":"notice","at":1,"level":"info","text":"hi"}\n\n'], { holdOpen: true });
    const liveSeen: string[] = [];

    const transport = createHttpRemoteTransport({
      baseUrl: "http://127.0.0.1:8890",
      token: "vv_dev_tok3",
      fetch: (input) => {
        const url = urlOf(input);
        seenUrls.push(url);
        if (url.includes("/api/v1/subscribe/channel.follow")) {
          const { stream } = streamFromChunks(['data: {"kind":"message","seq":1}\n\n', 'data: {"kind":"message","seq":2}\n\n']);
          return Promise.resolve(new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }));
        }
        if (url.includes("/api/v1/subscribe/session.watch")) {
          return Promise.resolve(
            new Response(JSON.stringify({ bizCode: BizCode.SessionNotFound, message: "missing" }), {
              status: 404,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        return Promise.resolve(new Response(openStream.stream, { status: 200, headers: { "content-type": "text/event-stream" } }));
      },
    });

    const unsubFollow = transport.subscribe(
      "channel.follow",
      { id: "c1", after: 0 },
      (ev) => events.push(ev),
      (why) => endedCalls.push(why),
    );
    const unsubRefused = transport.subscribe(
      "session.watch",
      { id: "missing" },
      (ev) => events.push(ev),
      (why) => endedCalls.push(why),
    );
    const unsubLive = transport.live((ev) => {
      if (ev.type === "notice") liveSeen.push(ev.text);
    });

    await vi.waitFor(() => {
      expect(events).toEqual([
        { kind: "message", seq: 1 },
        { kind: "message", seq: 2 },
      ]);
      expect(endedCalls).toContain(null);
      expect(endedCalls).toContainEqual({ bizCode: BizCode.SessionNotFound, message: "missing" });
      expect(liveSeen).toEqual(["hi"]);
    });

    expect(seenUrls).toContain(`http://127.0.0.1:8890/api/v1/subscribe/channel.follow?payload=${encodeURIComponent(JSON.stringify({ id: "c1", after: 0 }))}`);

    transport.close();
    await vi.waitFor(() => {
      expect(openStream.cancelled()).toBe(true);
    });
    unsubFollow();
    unsubRefused();
    unsubLive();
  });

  it("suspends active SSE streams cleanly without disconnect errors and resyncs immediately with Last-Event-ID on resume()", async () => {
    vi.useFakeTimers();
    const states: RemoteConnectionState[] = [];
    const sliceLastIds: (string | undefined)[] = [];
    const receivedSeqs: number[] = [];
    const subEvents: unknown[] = [];
    const subEnded: (RemoteEnvelope | null)[] = [];

    const firstSlice = streamFromChunks(['id: 10\ndata: {"seq":10,"issues":[]}\n\n'], { holdOpen: true });
    const secondSlice = streamFromChunks(['id: 12\ndata: {"seq":12,"issues":[]}\n\n'], { holdOpen: true });
    const firstSub = streamFromChunks(['data: {"kind":"state","rev":1}\n\n'], { holdOpen: true });
    const secondSub = streamFromChunks(['data: {"kind":"state","rev":2}\n\n'], { holdOpen: true });
    const finishedSub = streamFromChunks(['data: {"kind":"done"}\n\n']);

    let sliceAttempts = 0;
    let subAttempts = 0;
    let finishedSubAttempts = 0;

    const transport = createHttpRemoteTransport({
      baseUrl: "http://127.0.0.1:8890",
      token: "vv_dev_tok_lifecycle",
      onConnectionChange: (s) => states.push(s),
      fetch: (input, init) => {
        const url = urlOf(input);
        if (url.includes("/api/v1/slice/board")) {
          sliceAttempts++;
          sliceLastIds.push(headerOf(init, "last-event-id"));
          const chosen = sliceAttempts === 1 ? firstSlice.stream : secondSlice.stream;
          return Promise.resolve(new Response(chosen, { status: 200, headers: { "content-type": "text/event-stream" } }));
        }
        if (url.includes("/api/v1/subscribe/session.watch")) {
          subAttempts++;
          const chosen = subAttempts === 1 ? firstSub.stream : secondSub.stream;
          return Promise.resolve(new Response(chosen, { status: 200, headers: { "content-type": "text/event-stream" } }));
        }
        finishedSubAttempts++;
        return Promise.resolve(new Response(finishedSub.stream, { status: 200, headers: { "content-type": "text/event-stream" } }));
      },
    });

    const unsubSlice = transport.slice("board", (frame) => receivedSeqs.push(frame.seq));
    const unsubWatch = transport.subscribe(
      "session.watch",
      { id: "sess-1" },
      (ev) => subEvents.push(ev),
      (why) => subEnded.push(why),
    );
    const unsubDone = transport.subscribe(
      "one.shot",
      {},
      () => undefined,
      (why) => subEnded.push(why),
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(receivedSeqs).toEqual([10]);
    expect(sliceLastIds).toEqual([undefined]);
    expect(subEvents).toEqual([{ kind: "state", rev: 1 }]);
    expect(subEnded).toEqual([null]);
    expect(states).toEqual(["connecting", "connected"]);

    // Backgrounding aborts active SSE streams cleanly without reporting reconnecting/offline or ending active subscriptions.
    transport.suspend();
    await vi.advanceTimersByTimeAsync(0);
    expect(firstSlice.cancelled()).toBe(true);
    expect(firstSub.cancelled()).toBe(true);
    expect(states).toEqual(["connecting", "connected"]);
    expect(subEnded).toEqual([null]);

    // While suspended, advancing time does not reconnect.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sliceAttempts).toBe(1);
    expect(subAttempts).toBe(1);

    // Returning to foreground immediately resyncs in 0ms with Last-Event-ID and reopens active subscriptions only.
    transport.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(sliceAttempts).toBe(2);
    expect(sliceLastIds).toEqual([undefined, "10"]);
    expect(receivedSeqs).toEqual([10, 12]);
    expect(subAttempts).toBe(2);
    expect(subEvents).toEqual([
      { kind: "state", rev: 1 },
      { kind: "state", rev: 2 },
    ]);
    expect(finishedSubAttempts).toBe(1);
    expect(states).toEqual(["connecting", "connected"]);

    unsubSlice();
    unsubWatch();
    unsubDone();
    transport.close();
  });

  it("resume() interrupts backoff immediately and refreshes active streams on system wake without flagging reconnecting", async () => {
    vi.useFakeTimers();
    const states: RemoteConnectionState[] = [];
    const lastIds: (string | undefined)[] = [];
    const receivedSeqs: number[] = [];
    let attempt = 0;

    const heldSecond = streamFromChunks(['id: 21\ndata: {"seq":21,"issues":[]}\n\n'], { holdOpen: true });
    const heldThird = streamFromChunks(['id: 22\ndata: {"seq":22,"issues":[]}\n\n'], { holdOpen: true });

    const transport = createHttpRemoteTransport({
      baseUrl: "http://127.0.0.1:8890",
      token: "vv_dev_tok_wake",
      onConnectionChange: (s) => states.push(s),
      fetch: (_input, init) => {
        attempt++;
        lastIds.push(headerOf(init, "last-event-id"));
        if (attempt === 1) {
          return Promise.reject(new TypeError("offline"));
        }
        if (attempt === 2) {
          return Promise.resolve(new Response(heldSecond.stream, { status: 200, headers: { "content-type": "text/event-stream" } }));
        }
        return Promise.resolve(new Response(heldThird.stream, { status: 200, headers: { "content-type": "text/event-stream" } }));
      },
    });

    const unsub = transport.slice("board", (frame) => receivedSeqs.push(frame.seq));

    // Initial failure enters 1000ms backoff.
    await vi.advanceTimersByTimeAsync(0);
    expect(attempt).toBe(1);
    expect(states).toEqual(["connecting", "reconnecting"]);

    // resume() cancels the backoff timer and reconnects immediately at t=0.
    transport.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(attempt).toBe(2);
    expect(receivedSeqs).toEqual([21]);
    expect(states).toEqual(["connecting", "reconnecting", "connected"]);

    // System wake while active cycles the open stream and resyncs immediately with Last-Event-ID without reporting reconnecting.
    transport.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(heldSecond.cancelled()).toBe(true);
    expect(attempt).toBe(3);
    expect(lastIds).toEqual([undefined, undefined, "21"]);
    expect(receivedSeqs).toEqual([21, 22]);
    expect(states).toEqual(["connecting", "reconnecting", "connected"]);

    unsub();
    transport.close();
  });

  it("holds subscriptions created while suspended until resume() and cleans up if unsubscribed while suspended", async () => {
    vi.useFakeTimers();
    let fetchCalls = 0;

    const transport = createHttpRemoteTransport({
      baseUrl: "http://127.0.0.1:8890",
      token: "vv_dev_tok_pre_suspend",
      fetch: () => {
        fetchCalls++;
        const { stream } = streamFromChunks(['id: 1\ndata: {"seq":1,"issues":[]}\n\n'], { holdOpen: true });
        return Promise.resolve(new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }));
      },
    });

    transport.suspend();
    const unsubDropped = transport.slice("board", () => undefined);
    const received: number[] = [];
    const unsubKept = transport.slice("board", (frame) => received.push(frame.seq));

    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchCalls).toBe(0);

    unsubDropped();
    transport.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCalls).toBe(1);
    expect(received).toEqual([1]);

    unsubKept();
    transport.close();
  });

  it("coalesces reconnect backoff across concurrent failing SSE streams and clears timer on close()", async () => {
    vi.useFakeTimers();
    let boardAttempt = 0;
    let inboxAttempt = 0;
    const boardSeqs: number[] = [];
    const inboxSeqs: number[] = [];

    const transport = createHttpRemoteTransport({
      baseUrl: "http://127.0.0.1:8890",
      token: "vv_dev_tok_coalesced",
      fetch: (input) => {
        const url = urlOf(input);
        if (url.includes("/slice/board")) {
          boardAttempt++;
          if (boardAttempt === 1) {
            return Promise.reject(new Error("offline"));
          }
          const { stream } = streamFromChunks(['id: 1\ndata: {"seq":1,"issues":[]}\n\n'], { holdOpen: true });
          return Promise.resolve(new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }));
        }
        inboxAttempt++;
        if (inboxAttempt === 1) {
          return Promise.reject(new Error("offline"));
        }
        const { stream } = streamFromChunks(['id: 2\ndata: {"seq":2,"call":"idle","callReason":"","items":[]}\n\n'], { holdOpen: true });
        return Promise.resolve(new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }));
      },
    });

    const unsubBoard = transport.slice("board", (frame) => boardSeqs.push(frame.seq));
    const unsubInbox = transport.slice("inbox", (frame) => inboxSeqs.push(frame.seq));

    await vi.advanceTimersByTimeAsync(0);
    expect(boardAttempt).toBe(1);
    expect(inboxAttempt).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(boardAttempt).toBe(2);
    expect(inboxAttempt).toBe(2);
    expect(boardSeqs).toEqual([1]);
    expect(inboxSeqs).toEqual([2]);
    expect(vi.getTimerCount()).toBe(0);

    unsubBoard();
    unsubInbox();
    transport.close();

    // Closing while a coalesced backoff timer is pending cancels the timer.
    const transport2 = createHttpRemoteTransport({
      baseUrl: "http://127.0.0.1:8890",
      token: "vv_dev_tok_cancel_timer",
      fetch: () => Promise.reject(new Error("offline")),
    });
    const unsub2 = transport2.slice("board", () => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    unsub2();
    transport2.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("short-circuits pre-aborted call() signals, forwards mid-flight aborts, and rejects malformed envelopes", async () => {
    let fetchCalls = 0;
    let seenSignal: AbortSignal | undefined;

    const transport = createHttpRemoteTransport({
      baseUrl: "http://127.0.0.1:8890",
      token: "vv_dev_tok_abort",
      fetch: (_input, init) => {
        fetchCalls++;
        seenSignal = init?.signal ?? undefined;
        if (fetchCalls === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                reject(new DOMException("The operation was aborted.", "AbortError"));
              },
              { once: true },
            );
          });
        }
        return Promise.resolve(new Response(JSON.stringify({ unexpected: true }), { status: 200 }));
      },
    });

    const preAborted = new AbortController();
    preAborted.abort();
    const preErr = await transport.call("issue.list", {}, { signal: preAborted.signal }).catch((e: unknown) => e);
    expect(preErr).toBeInstanceOf(Error);
    expect((preErr as Error).name).toBe("AbortError");
    expect(fetchCalls).toBe(0);

    const midController = new AbortController();
    const pendingCall = transport.call("issue.list", {}, { signal: midController.signal }).catch((e: unknown) => e);
    expect(fetchCalls).toBe(1);
    expect(seenSignal?.aborted).toBe(false);
    midController.abort();
    const midErr = await pendingCall;
    expect(seenSignal?.aborted).toBe(true);
    expect(midErr).toBeInstanceOf(Error);
    expect((midErr as Error).name).toBe("AbortError");

    const badEnvErr = await transport.call("issue.list", {}).catch((e: unknown) => e);
    expect(badEnvErr).toBeInstanceOf(Error);

    transport.close();
  });

  it("automatically reconnects subscribe() with bounded exponential backoff on unexpected SSE/stream drops and resets on recovery", async () => {
    vi.useFakeTimers();
    const events: unknown[] = [];
    const endedCalls: (RemoteEnvelope | null)[] = [];
    const lastIds: (string | undefined)[] = [];
    let attempt = 0;

    const heldRecovered = streamFromChunks(['id: 2\ndata: {"kind":"event","seq":2}\n\n'], { holdOpen: true });

    const transport = createHttpRemoteTransport({
      baseUrl: "http://127.0.0.1:8890",
      token: "vv_dev_tok_sub_backoff",
      fetch: (_input, init) => {
        attempt++;
        lastIds.push(headerOf(init, "last-event-id"));
        // Attempt 1: initial SSE stream delivers event id:1 then drops unexpectedly mid-stream.
        if (attempt === 1) {
          let step = 0;
          const dropStream = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (step === 0) {
                step++;
                controller.enqueue(encoder.encode('id: 1\ndata: {"kind":"event","seq":1}\n\n'));
              } else {
                controller.error(new TypeError("stream reset"));
              }
            },
          });
          return Promise.resolve(new Response(dropStream, { status: 200, headers: { "content-type": "text/event-stream" } }));
        }
        // Attempts 2..6: network failures + 503 verify bounded exponential backoff (1s, 2s, 4s, 8s, 8s).
        if (attempt === 2 || attempt === 3 || attempt === 4 || attempt === 5) {
          return Promise.reject(new TypeError("network down"));
        }
        if (attempt === 6) {
          return Promise.resolve(new Response("temporarily unavailable", { status: 503, headers: { "content-type": "text/plain" } }));
        }
        // Attempt 7: recovers and streams new event while carrying Last-Event-ID.
        return Promise.resolve(new Response(heldRecovered.stream, { status: 200, headers: { "content-type": "text/event-stream" } }));
      },
    });

    const unsub = transport.subscribe(
      "session.watch",
      { id: "sess-1" },
      (ev) => events.push(ev),
      (why) => endedCalls.push(why),
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(attempt).toBe(1);
    expect(events).toEqual([{ kind: "event", seq: 1 }]);
    expect(endedCalls).toEqual([]);

    // 1000ms -> attempt 2
    await vi.advanceTimersByTimeAsync(1000);
    expect(attempt).toBe(2);

    // 2000ms -> attempt 3
    await vi.advanceTimersByTimeAsync(1999);
    expect(attempt).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempt).toBe(3);

    // 4000ms -> attempt 4
    await vi.advanceTimersByTimeAsync(4000);
    expect(attempt).toBe(4);

    // 8000ms -> attempt 5
    await vi.advanceTimersByTimeAsync(8000);
    expect(attempt).toBe(5);

    // Bounded cap at 8000ms -> attempt 6 (503)
    await vi.advanceTimersByTimeAsync(8000);
    expect(attempt).toBe(6);

    // Bounded cap at 8000ms -> attempt 7 (recovers)
    await vi.advanceTimersByTimeAsync(8000);
    expect(attempt).toBe(7);
    expect(events).toEqual([
      { kind: "event", seq: 1 },
      { kind: "event", seq: 2 },
    ]);
    expect(lastIds.slice(1)).toEqual(["1", "1", "1", "1", "1", "1"]);
    expect(endedCalls).toEqual([]);

    unsub();
    await vi.advanceTimersByTimeAsync(0);
    expect(heldRecovered.cancelled()).toBe(true);
    transport.close();
  });
});
