import { WebSocket } from "undici";

import { type Clock, systemClock, withTimeout } from "@vibevalley/async";

import { jsonText } from "../base/json.ts";
import { decodeMossFrame, mossErrorMessage, mossRealtimeUrl } from "./index.ts";
import { mossLiveModels } from "./live-models.ts";
import { mossVisionModels } from "./vision-models.ts";

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

export const makeMossTransport = (fetcher: typeof fetch, clock: Clock = systemClock): MossTransport => ({
  connect: (key, on, model = "moss-live-1.0") => {
    if (!mossLiveModels.some((supported) => supported === model) && !mossVisionModels.some((supported) => supported === model))
      throw new Error("Unsupported MOSS realtime model");
    const url = new URL(mossRealtimeUrl);
    url.searchParams.set("model", model);
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` } });
    ws.binaryType = "arraybuffer";
    ws.addEventListener("open", on.open);
    ws.addEventListener("message", (e) => {
      if (typeof e.data === "string") on.text(e.data);
      else if (e.data instanceof ArrayBuffer) on.binary?.(new Uint8Array(e.data));
    });
    ws.addEventListener("close", (e) => on.down(e.reason));
    ws.addEventListener("error", () => on.down(""));
    return { send: (text) => ws.send(text), close: () => ws.close(), bufferedAmount: () => ws.bufferedAmount };
  },
  status: async (key, model = "moss-live-1.0") => {
    const url = new URL(mossRealtimeUrl.replace(/^wss:/u, "https:"));
    url.searchParams.set("model", model);
    try {
      return await withTimeout(
        async (signal) => {
          const r = await fetcher(url.href, { headers: { authorization: `Bearer ${key}` }, signal });
          return { code: r.status, body: await r.text() };
        },
        mossDeadlineMs,
        { clock },
      );
    } catch (e) {
      if (e instanceof DOMException && e.name === "TimeoutError") throw new Error("timed out", { cause: e });
      throw e;
    }
  },
});

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
