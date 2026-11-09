import { Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { WebSocket } from "undici";

import { jsonText } from "../json.ts";
import { decodeMossFrame, mossErrorMessage, mossRealtimeUrl } from "../moss.ts";
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
  /** The HTTP status of a plain request with the key and its body, or why nothing answered. */
  readonly status: (key: string, model?: string) => Effect.Effect<{ readonly code: number; readonly body: string }, string>;
}

export const nodeMossTransport: MossTransport = {
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
  status: (key, model = "moss-live-1.0") =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const url = new URL(mossRealtimeUrl.replace(/^wss:/u, "https:"));
      url.searchParams.set("model", model);
      const r = yield* http.execute(HttpClientRequest.get(url.href).pipe(HttpClientRequest.bearerToken(key)));
      return { code: r.status, body: yield* r.text };
    }).pipe(
      Effect.timeoutOrElse({ duration: mossDeadlineMs, orElse: () => Effect.fail("timed out") }),
      Effect.mapError(String),
      Effect.provide(FetchHttpClient.layer),
    ),
};

const handshake = (key: string, transport: MossTransport, model: string) =>
  Effect.callback<"attached" | { readonly error: string } | { readonly down: string } | "silent">((resume) => {
    let settled = false;
    let link: MossLink | undefined;
    const settle = (r: "attached" | { readonly error: string } | { readonly down: string } | "silent") => {
      if (settled) return;
      settled = true;
      link?.close();
      resume(Effect.succeed(r));
    };
    link = transport.connect(
      key,
      {
        open: () => link?.send(jsonText({ action: "attach_session", memory_scope: "session" })),
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
      },
      model,
    );
    return Effect.sync(() => settle("silent"));
  }).pipe(
    // Timing out interrupts the callback, whose finalizer closes the link.
    Effect.timeoutOrElse({ duration: mossDeadlineMs, orElse: () => Effect.succeed("silent" as const) }),
  );

/** Whether MOSS Live takes key. */
export const verifyMoss = Effect.fn("Moss.verify")(function* (
  key: string,
  transport: MossTransport = nodeMossTransport,
  model: string = "moss-live-1.0",
): Effect.fn.Return<MossVerify> {
  const safe = (text: string) => (key ? text.replaceAll(key, "[redacted]") : text).slice(0, 200);
  const got = yield* handshake(key, transport, model);
  if (got === "attached") return { kind: "ok" } as const;
  if (got === "silent") return { kind: "silent" } as const;
  if ("error" in got) return { kind: "failed", why: safe(got.error) } as const;
  return yield* transport.status(key, model).pipe(
    Effect.match({
      onFailure: (why): MossVerify => ({ kind: "unreachable", why: safe(got.down || why) }),
      onSuccess: ({ code, body }): MossVerify =>
        code === 401 || code === 403 ? { kind: "refused", why: safe(mossErrorMessage(body)) } : { kind: "failed", why: safe(got.down || `HTTP ${code}`) },
    }),
  );
});
