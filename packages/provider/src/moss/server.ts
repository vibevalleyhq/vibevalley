import { Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { WebSocket } from "undici";

import { decodeMossFrame, mossErrorMessage, mossRealtimeUrl } from "../moss.ts";

/** Real time: the handshake and the first answer each come within a few hundred ms. */
const mossDeadlineMs = 8_000;

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
    return { send: (text) => ws.send(typeof text === "string" ? text : new Uint8Array(text)), close: () => ws.close() };
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
