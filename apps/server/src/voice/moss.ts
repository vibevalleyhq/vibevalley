// MOSS Live (platform.mosi.cn): a realtime voice model the server connects to, so its key never reaches a page. A check
// attaches a session and closes it at once: MOSS bills from session_attached to the close. A refused key fails the
// WebSocket handshake with no reason (close 1006, as a network failure does), so a failed handshake is asked again over
// plain HTTPS, where a refused key answers 401 or 403. A relay is a page's own line to MOSS: the page speaks MOSS's
// protocol (JSON actions, and binary frames tagged 0x00 for audio), the server only adds the key.

import { jsonOrNone } from "@/base/json.ts";
import { Effect, Queue, type Scope, Schema } from "effect";
import { Socket } from "effect/socket";
import { afterRealTime } from "@/base/time.ts";

export const mossUrl = "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0";

/** MOSS's transcription (platform.mosi.cn/docs/reference/transcriptions): OpenAI's /audio/transcriptions, with the same key
 * as MOSS Live. moss-transcribe-1.0 is the plain one; the diarize model (speakers, streaming) is not needed to dictate. */
export const mossTranscription = { url: "https://api.mosi.cn/v1", model: "moss-transcribe-1.0" } as const;

/** Real time: the handshake and the first answer each come within a few hundred ms. */
const deadlineMs = 8_000;

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
  /** The HTTP status of a plain request with the key and its body, or an error when nothing answers. */
  readonly status: (key: string) => Promise<{ readonly code: number; readonly body: string }>;
}

export const nodeTransport: MossTransport = {
  connect: (key, on) => {
    const ws = new WebSocket(mossUrl, { headers: { Authorization: `Bearer ${key}` } });
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
    fetch(mossUrl.replace(/^wss:/u, "https:"), { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(deadlineMs) }).then((r) =>
      r.text().then((body) => ({ code: r.status, body })),
    ),
};

const mossError = Schema.optionalKey(Schema.Struct({ message: Schema.optionalKey(Schema.String) }));

/** What MOSS says, on the socket ({ action, data: { error } }) or in a refused handshake's body ({ error }). */
const mossMessage = jsonOrNone(
  Schema.Struct({ action: Schema.optionalKey(Schema.String), error: mossError, data: Schema.optionalKey(Schema.Struct({ error: mossError })) }),
);

/** The message of a refusal's JSON body ({ error: { message } }), or the body itself, cut short. */
const refusal = (body: string) => {
  const m = mossMessage(body)?.error?.message;
  return m ? m : body.slice(0, 200);
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
        const m = mossMessage(data);
        if (m?.action === "session_attached") settle("attached");
        else if (m?.action === "error") settle({ error: m.data?.error?.message ?? "" });
      },
      down: (why) => settle({ down: why }),
    });
    return Effect.sync(() => settle("silent"));
  });

/** Whether MOSS Live takes key. */
export const verifyMoss = (key: string, transport: MossTransport = nodeTransport): Effect.Effect<MossVerify> =>
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

/** Where MOSS's frames go to the page, and where a closing goes: one queue, so they keep their order. */
type Down = string | Uint8Array | Socket.CloseEvent;

/** A page's line to MOSS Live, until either side closes: every frame passes as it is, both ways. What the page sends
 * before MOSS has opened waits for it. */
export const relay = (page: Socket.Socket, key: string, transport: MossTransport = nodeTransport): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const down = yield* Queue.unbounded<Down>();
    const writer = yield* page.writer;
    let open = false;
    const waiting: (string | Uint8Array)[] = [];
    const link = transport.connect(key, {
      open: () => {
        open = true;
        for (const f of waiting.splice(0)) link.send(f);
      },
      text: (data) => Queue.offerUnsafe(down, data),
      binary: (data) => Queue.offerUnsafe(down, data),
      // 1011: MOSS went away; its reason, when it gave one, goes to the page.
      down: (why) => Queue.offerUnsafe(down, new Socket.CloseEvent(1011, why.slice(0, 120))),
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => link.close()));
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
          if (open) link.send(frame);
          else waiting.push(frame);
        }
    });
    yield* Effect.raceFirst(toPage, fromPage).pipe(Effect.ignore);
  });
