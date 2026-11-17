import { type Clock, systemClock } from "@vibevalley/async";

import { jsonText } from "../base/json.ts";
import { decodeMossFrame, mossErrorMessage } from "./index.ts";

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
  readonly bufferedAmount?: () => number;
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
  readonly connect: (key: string, on: MossEvents, model?: string) => MossLink;
  /** The HTTP status of a plain request with the key and its body; rejects with why nothing answered. */
  readonly status: (key: string, model?: string) => Promise<{ readonly code: number; readonly body: string }>;
}

type Handshake = "attached" | { readonly error: string } | { readonly down: string } | "silent";

/** Attaches a session and closes it at once; "silent" when nothing decisive came within the deadline. */
const handshake = (key: string, transport: MossTransport, model: string, clock: Clock): Promise<Handshake> => {
  const { promise, resolve } = Promise.withResolvers<Handshake>();
  const stop = new AbortController();
  let settled = false;
  let link: MossLink | undefined;
  const settle = (r: Handshake) => {
    if (settled) return;
    settled = true;
    stop.abort();
    link?.close();
    resolve(r);
  };
  void clock.sleep(mossDeadlineMs, stop.signal).then(
    () => settle("silent"),
    // Stopped: the handshake settled first.
    () => undefined,
  );
  link = transport.connect(
    key,
    {
      open: () => link?.send(jsonText({ action: "attach_session", memory_scope: "session" })),
      text: (data) => {
        const m = decodeMossFrame(data);
        if (m === undefined) return;
        if (m.action === "session_attached") settle("attached");
        else if (m.action === "error") {
          const err = m.data?.error;
          settle({ error: typeof err === "string" ? err : (err?.message ?? "") });
        }
      },
      down: (why) => settle({ down: why }),
    },
    model,
  );
  return promise;
};

/** Whether MOSS Live takes key. */
export async function verifyMoss(key: string, transport: MossTransport, model: string = "moss-live-1.0", clock: Clock = systemClock): Promise<MossVerify> {
  const safe = (text: string) => (key ? text.replaceAll(key, "[redacted]") : text).slice(0, 200);
  const got = await handshake(key, transport, model, clock);
  if (got === "attached") return { kind: "ok" };
  if (got === "silent") return { kind: "silent" };
  if ("error" in got) return { kind: "failed", why: safe(got.error) };
  let answer: { readonly code: number; readonly body: string };
  try {
    answer = await transport.status(key, model);
  } catch (e) {
    return { kind: "unreachable", why: safe(got.down || (e instanceof Error ? e.message : String(e))) };
  }
  const { code, body } = answer;
  return code === 401 || code === 403 ? { kind: "refused", why: safe(mossErrorMessage(body)) } : { kind: "failed", why: safe(got.down || `HTTP ${code}`) };
}
