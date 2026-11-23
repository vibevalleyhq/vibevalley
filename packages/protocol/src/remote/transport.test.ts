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
});
