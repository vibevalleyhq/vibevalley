// MOSS Live (platform.mosi.cn): a realtime voice model the server connects to, so its key never reaches a page. A check
// attaches a session and closes it at once: MOSS bills from session_attached to the close. A refused key fails the
// WebSocket handshake with no reason (close 1006, as a network failure does), so a failed handshake is asked again over
// plain HTTPS, where a refused key answers 401 or 403.

import { Effect } from "effect";
import { afterRealTime } from "../base/time.ts";

export const mossUrl = "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0";

/** Real time: the handshake and the first answer each come within a few hundred ms. */
const deadlineMs = 8_000;

export type MossCheck =
  | { readonly kind: "ok" }
  | { readonly kind: "refused"; readonly why: string }
  | { readonly kind: "unreachable"; readonly why: string }
  | { readonly kind: "failed"; readonly why: string }
  | { readonly kind: "silent" };

/** What a check needs of a WebSocket. */
export interface MossLink {
  readonly send: (text: string) => void;
  readonly close: () => void;
}

export interface MossEvents {
  readonly open: () => void;
  readonly text: (data: string) => void;
  /** Before or after it opened; why is "" when the socket says nothing. */
  readonly down: (why: string) => void;
}

export interface MossTransport {
  readonly connect: (key: string, on: MossEvents) => MossLink;
  /** The HTTP status of a plain request with the key and its body, or an error when nothing answers. */
  readonly status: (key: string) => Promise<{ readonly code: number; readonly body: string }>;
}

export const nodeTransport: MossTransport = {
  connect: (key, on) => {
    const ws = new WebSocket(mossUrl, { headers: { Authorization: `Bearer ${key}` } });
    ws.addEventListener("open", on.open);
    ws.addEventListener("message", (e) => {
      if (typeof e.data === "string") on.text(e.data);
    });
    ws.addEventListener("close", (e) => on.down(e.reason));
    ws.addEventListener("error", () => on.down(""));
    return { send: (text) => ws.send(text), close: () => ws.close() };
  },
  status: async (key) => {
    const r = await fetch(mossUrl.replace(/^wss:/, "https:"), { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(deadlineMs) });
    return { code: r.status, body: await r.text() };
  },
};

/** The message of a refusal's JSON body ({ error: { message } }), or the body itself, cut short. */
const refusal = (body: string) => {
  try {
    const m = (JSON.parse(body) as { error?: { message?: unknown } }).error?.message;
    if (typeof m === "string" && m !== "") return m;
  } catch {
    // Not JSON: the body is the reason.
  }
  return body.slice(0, 200);
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
    cancel = afterRealTime(deadlineMs, () => settle("silent"), { unref: true });
    link = transport.connect(key, {
      open: () => link?.send(JSON.stringify({ action: "attach_session" })),
      text: (data) => {
        let m: { action?: unknown; data?: { error?: { message?: unknown } } };
        try {
          m = JSON.parse(data) as typeof m;
        } catch {
          return;
        }
        if (m.action === "session_attached") settle("attached");
        else if (m.action === "error") {
          const message = m.data?.error?.message;
          settle({ error: typeof message === "string" ? message : "" });
        }
      },
      down: (why) => settle({ down: why }),
    });
    return Effect.sync(() => settle("silent"));
  });

/** Whether MOSS Live takes key. */
export const checkMoss = (key: string, transport: MossTransport = nodeTransport): Effect.Effect<MossCheck> =>
  Effect.gen(function* () {
    const got = yield* handshake(key, transport);
    if (got === "attached") return { kind: "ok" } as const;
    if (got === "silent") return { kind: "silent" } as const;
    if ("error" in got) return { kind: "failed", why: got.error } as const;
    const asked = yield* Effect.tryPromise(() => transport.status(key)).pipe(Effect.result);
    if (asked._tag === "Failure") return { kind: "unreachable", why: got.down || String(asked.failure.cause) } as const;
    const { code, body } = asked.success;
    if (code === 401 || code === 403) return { kind: "refused", why: refusal(body) } as const;
    return { kind: "failed", why: got.down || `HTTP ${code}` } as const;
  });
