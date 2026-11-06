import { Effect, Queue, type Scope } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { Socket } from "effect/socket";

import { decodeMossFrame, mossErrorMessage, mossRealtimeUrl } from "./protocol.ts";

/** Real time: the handshake and the first answer each come within a few hundred ms. */
export const mossDeadlineMs = 8_000;

export type MossVerify =
  | { readonly kind: "ok" }
  | { readonly kind: "refused"; readonly why: string }
  | { readonly kind: "unreachable"; readonly why: string }
  | { readonly kind: "failed"; readonly why: string }
  | { readonly kind: "silent" };

/** What a check needs of a WebSocket. */
export interface MossLink {
  readonly send: (frame: string | Uint8Array) => void;
  readonly close: () => void;
}

export interface MossEvents {
  readonly open: () => void;
  readonly text: (data: string) => void;
  /** Audio and the like; a check ignores them. */
  readonly binary?: (data: Uint8Array) => void;
  /** Before or after it opened; why is "" when the socket says nothing. */
  readonly down: (why: string) => void;
}

export interface MossTransport {
  readonly connect: (key: string, on: MossEvents) => MossLink;
  /** The HTTP status of a plain request with the key and its body, or why nothing answered. */
  readonly status: (key: string) => Effect.Effect<{ readonly code: number; readonly body: string }, string>;
}

/** Optional hooks allowing the server to bridge an active MOSS line with the farm's Orchestrator and call state. */
export interface MossRelayHooks {
  /** Invoked when the upstream MOSS WebSocket opens; may return a cleanup function invoked when the relay ends. */
  readonly onOpen?: (link: MossLink, sendToPage: (frame: string) => void) => (() => void) | void;
  /** Invoked for each text frame from the browser page; returns the frame to forward to MOSS (or undefined to drop). */
  readonly onPageText?: (data: string, link: MossLink, sendToPage: (frame: string) => void) => string | undefined;
  /** Invoked for each text frame from MOSS Live before it is forwarded to the browser page. */
  readonly onMossText?: (data: string, link: MossLink, sendToPage: (frame: string) => void) => void;
}

const defaultAfterRealTime = (ms: number, fn: () => void) => {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
};

export const nodeMossTransport: MossTransport = {
  connect: (key, on) => {
    const ws = new WebSocket(mossRealtimeUrl, { headers: { Authorization: `Bearer ${key}` } });
    ws.binaryType = "arraybuffer";
    ws.addEventListener("open", on.open);
    ws.addEventListener("message", (e) => {
      if (typeof e.data === "string") on.text(e.data);
      else if (e.data instanceof ArrayBuffer) on.binary?.(new Uint8Array(e.data));
    });
    ws.addEventListener("close", (e) => on.down(e.reason));
    ws.addEventListener("error", () => on.down(""));
    return { send: (text) => ws.send(text), close: () => ws.close() };
  },
  status: (key) =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const r = yield* http.execute(HttpClientRequest.get(mossRealtimeUrl.replace(/^wss:/u, "https:")).pipe(HttpClientRequest.bearerToken(key)));
      return { code: r.status, body: yield* r.text };
    }).pipe(
      Effect.timeoutOrElse({ duration: mossDeadlineMs, orElse: () => Effect.fail("timed out") }),
      Effect.mapError(String),
      Effect.provide(FetchHttpClient.layer),
    ),
};

const handshake = (key: string, transport: MossTransport) =>
  Effect.callback<"attached" | { readonly error: string } | { readonly down: string } | "silent">((resume) => {
    let settled = false;
    let cancel = () => {};
    let link: MossLink | undefined;
    const settle = (r: "attached" | { readonly error: string } | { readonly down: string } | "silent") => {
      if (settled) return;
      settled = true;
      cancel();
      link?.close();
      resume(Effect.succeed(r));
    };
    cancel = defaultAfterRealTime(mossDeadlineMs, () => settle("silent"));
    link = transport.connect(key, {
      open: () => link?.send(JSON.stringify({ action: "attach_session" })),
      text: (data) => {
        const decoded = decodeMossFrame(data);
        if (decoded._tag === "None") return;
        const m = decoded.value;
        if (m.action === "session_attached") settle("attached");
        else if (m.action === "error") {
          const err = m.data?.error;
          settle({ error: typeof err === "string" ? err : (err?.message ?? "") });
        }
      },
      down: (why) => settle({ down: why }),
    });
    return Effect.sync(() => settle("silent"));
  });

/** Whether MOSS Live takes key. */
export const verifyMoss = Effect.fn("Moss.verify")(function* (key: string, transport: MossTransport = nodeMossTransport): Effect.fn.Return<MossVerify> {
  const got = yield* handshake(key, transport);
  if (got === "attached") return { kind: "ok" } as const;
  if (got === "silent") return { kind: "silent" } as const;
  if ("error" in got) return { kind: "failed", why: got.error } as const;
  return yield* transport.status(key).pipe(
    Effect.match({
      onFailure: (why): MossVerify => ({ kind: "unreachable", why: got.down || why }),
      onSuccess: ({ code, body }): MossVerify =>
        code === 401 || code === 403 ? { kind: "refused", why: mossErrorMessage(body) } : { kind: "failed", why: got.down || `HTTP ${code}` },
    }),
  );
});

/** Where MOSS's frames go to the page, and where a closing goes: one queue, so they keep their order. */
type Down = string | Uint8Array | Socket.CloseEvent;

/** A page's line to MOSS Live, until either side closes: every frame passes as it is, both ways. What the page sends
 * before MOSS has opened waits for it. */
export const relay = (
  page: Socket.Socket,
  key: string,
  transport: MossTransport = nodeMossTransport,
  hooks?: MossRelayHooks,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const down = yield* Queue.unbounded<Down>();
    const writer = yield* page.writer;
    const sendToPage = (frame: string) => {
      Queue.offerUnsafe(down, frame);
    };
    let open = false;
    let closeHook: (() => void) | void;
    const waiting: (string | Uint8Array)[] = [];
    const link: MossLink = yield* Effect.acquireRelease(
      Effect.sync(() =>
        transport.connect(key, {
          open: () => {
            open = true;
            closeHook = hooks?.onOpen?.(link, sendToPage);
            for (const f of waiting.splice(0)) link.send(f);
          },
          text: (data) => {
            hooks?.onMossText?.(data, link, sendToPage);
            Queue.offerUnsafe(down, data);
          },
          binary: (data) => Queue.offerUnsafe(down, data),
          // 1011: MOSS went away; its reason, when it gave one, goes to the page.
          down: (why) => Queue.offerUnsafe(down, new Socket.CloseEvent(1011, why.slice(0, 120))),
        }),
      ),
      (l) =>
        Effect.sync(() => {
          closeHook?.();
          l.close();
        }),
    );
    const toPage = Effect.gen(function* () {
      for (;;) {
        const frame = yield* Queue.take(down);
        yield* writer.write(frame);
        if (Socket.isCloseEvent(frame)) return;
      }
    });
    const fromPage = Effect.gen(function* () {
      const { pull } = yield* page.reader;
      for (;;)
        for (const frame of yield* pull) {
          const transformed = typeof frame === "string" && hooks?.onPageText ? hooks.onPageText(frame, link, sendToPage) : frame;
          if (transformed === undefined) continue;
          if (open) link.send(transformed);
          else waiting.push(transformed);
        }
    });
    yield* Effect.raceFirst(toPage, fromPage).pipe(Effect.ignore({ log: "Debug" }));
  });
