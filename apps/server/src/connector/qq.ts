import { t } from "@vibevalley/i18n";
// QQ, written from Tencent's botpy (the official Python SDK). A reply is a passive one on the user's
// message id, which QQ honours only for a while.

import { messageOf } from "../errors.ts";
import { Schema } from "effect";
import { wallTime } from "../base/time.ts";
import { type Adapter } from "./adapter.ts";

const apiBase = "https://api.sgroup.qq.com";
const tokenUrl = "https://bots.qq.com/app/getAppAccessToken";
const intents = 1 << 25;

// A refused AppID or secret answers without a token, with QQ's reason in message: that reason is what the owner sees.
const TokenResponse = Schema.Struct({
  access_token: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Union([Schema.Finite, Schema.String])),
  message: Schema.optionalKey(Schema.String),
});
const GatewayResponse = Schema.Struct({ url: Schema.String });
const GatewayEvent = Schema.Struct({
  op: Schema.Finite,
  // Frames that are not dispatches may carry s and t as null.
  s: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  t: Schema.optionalKey(Schema.NullOr(Schema.String)),
  d: Schema.optionalKey(Schema.Unknown),
});
export const decodeGatewayEvent = Schema.decodeUnknownSync(Schema.fromJsonString(GatewayEvent));
const decodeTokenResponse = Schema.decodeUnknownSync(TokenResponse);
const decodeGatewayResponse = Schema.decodeUnknownSync(GatewayResponse);

export interface App {
  readonly appId: string;
  readonly secret: string;
}

export interface Message {
  readonly id: string;
  readonly from: string;
  readonly content: string;
  readonly attachments: number;
}

export class SendError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

export interface QQApi {
  check(signal: AbortSignal, app: App): Promise<void>;
  /** Until the connection fails or signal aborts (then it resolves). */
  listen(signal: AbortSignal, app: App, got: (m: Message) => Promise<void>): Promise<void>;
  sendText(signal: AbortSignal, app: App, openId: string, text: string, msgId: string): Promise<string>;
}

export class QQClient implements QQApi {
  /** Tokens last about two hours: one per app, renewed a minute early. */
  private readonly tokens = new Map<string, { token: string; until: number }>();
  /** QQ refuses the same (msg_id, msg_seq) twice. */
  private readonly replySeq = new Map<string, number>();

  constructor(
    private readonly api = apiBase,
    private readonly tokenAt = tokenUrl,
  ) {}

  private async token(signal: AbortSignal, app: App): Promise<string> {
    const key = app.appId + "\u0000" + app.secret;
    const cached = this.tokens.get(key);
    // A token lasts as long as QQ said, in real time.
    if (cached && cached.until > wallTime.now()) return cached.token;
    const timed = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
    let body: typeof TokenResponse.Type;
    try {
      const res = await fetch(this.tokenAt, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId: app.appId, clientSecret: app.secret }),
        signal: timed,
      });
      body = decodeTokenResponse(await res.json());
    } catch (e) {
      if (timed.aborted && !signal.aborted) throw new Error(t("server.connector.qq.authTimeout"), { cause: e });
      throw new Error(t("server.connector.qq.auth", { why: messageOf(e) }), { cause: e });
    }
    if (!body.access_token) throw new Error(t("server.connector.qq.auth", { why: body.message || t("server.connector.qq.badKeys") }));
    const seconds = typeof body.expires_in === "number" ? body.expires_in : Number.parseFloat(String(body.expires_in ?? "")) || 7200;
    this.tokens.set(key, { token: body.access_token, until: wallTime.now() + (seconds - 60) * 1000 });
    return body.access_token;
  }

  private headers(app: App, token: string) {
    return {
      Authorization: "QQBot " + token,
      "X-Union-Appid": app.appId,
      "Content-Type": "application/json",
    };
  }

  async check(signal: AbortSignal, app: App) {
    await this.token(signal, app);
  }

  async listen(signal: AbortSignal, app: App, got: (m: Message) => Promise<void>): Promise<void> {
    if (signal.aborted) return;
    const token = await this.token(signal, app);
    let gateway: typeof GatewayResponse.Type;
    try {
      gateway = decodeGatewayResponse(await (await fetch(this.api + "/gateway", { headers: this.headers(app, token), signal })).json());
    } catch (e) {
      if (signal.aborted) return;
      throw new Error(t("server.connector.qq.gateway", { why: messageOf(e) }), { cause: e });
    }
    if (!gateway.url) throw new Error(t("server.connector.qq.noGateway"));
    if (signal.aborted) return;
    const ws = new WebSocket(gateway.url);
    return new Promise((resolve, reject) => {
      let seq: number | null = null;
      // The gateway's heartbeat, on the protocol's own (real) time: what stops it.
      let beat: (() => void) | undefined;
      let done = false;
      const abort = () => end();
      const end = (e?: Error) => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", abort);
        beat?.();
        ws.close();
        if (e && !signal.aborted) reject(e);
        else resolve();
      };
      signal.addEventListener("abort", abort, { once: true });
      const send = (payload: unknown) => {
        try {
          ws.send(JSON.stringify(payload));
        } catch {
          ws.close();
        }
      };
      // One message at a time: each is handed over before the next is read.
      let chain = Promise.resolve();
      ws.addEventListener("message", (event) => {
        chain = chain
          .then(async () => {
            if (done) return;
            let msg: typeof GatewayEvent.Type;
            try {
              msg = decodeGatewayEvent(String(event.data));
            } catch {
              return end(new Error(t("server.connector.qq.gatewayError")));
            }
            if (typeof msg.s === "number") seq = msg.s;
            switch (msg.op) {
              case 10: {
                send({
                  op: 2,
                  d: { token: "QQBot " + token, intents, shard: [0, 1], properties: {} },
                });
                const every = (msg.d as { heartbeat_interval?: number } | undefined)?.heartbeat_interval ?? 0;
                const beatEvery = (ms: number) => {
                  beat = wallTime.after(ms, () => {
                    send({ op: 1, d: seq });
                    beatEvery(ms);
                  });
                };
                if (!beat) beatEvery(every > 0 ? every : 30_000);
                return;
              }
              case 0: {
                if (msg.t !== "C2C_MESSAGE_CREATE") return;
                const d = msg.d as
                  | {
                      id?: string;
                      content?: string;
                      author?: { user_openid?: string };
                      attachments?: unknown[];
                    }
                  | undefined;
                if (!d?.id || !d.author?.user_openid) return;
                try {
                  await got({
                    id: d.id,
                    from: d.author.user_openid,
                    content: d.content ?? "",
                    attachments: d.attachments?.length ?? 0,
                  });
                } catch (e) {
                  end(e instanceof Error ? e : new Error(String(e)));
                }
                return;
              }
              case 7:
                return end(new Error(t("server.connector.qq.reconnect")));
              case 9:
                return end(new Error(t("server.connector.qq.invalid")));
            }
          })
          .catch((e: unknown) => end(e instanceof Error ? e : new Error(String(e))));
      });
      ws.addEventListener("close", (event) => end(new Error(t("server.connector.qq.closed", { code: event.code }))));
      ws.addEventListener("error", () => end(new Error(t("server.connector.qq.gatewayError"))));
    });
  }

  async sendText(signal: AbortSignal, app: App, openId: string, text: string, msgId: string): Promise<string> {
    let token: string;
    try {
      token = await this.token(signal, app);
    } catch (e) {
      throw new SendError(messageOf(e), 401);
    }
    const payload: Record<string, unknown> = { content: text, msg_type: 0 };
    if (msgId) {
      const next = (this.replySeq.get(msgId) ?? 0) + 1;
      this.replySeq.set(msgId, next);
      payload.msg_id = msgId;
      payload.msg_seq = next;
    }
    let res: Response;
    try {
      res = await fetch(this.api + "/v2/users/" + encodeURIComponent(openId) + "/messages", {
        method: "POST",
        headers: this.headers(app, token),
        body: JSON.stringify(payload),
        signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]),
      });
    } catch (e) {
      throw new SendError(t("server.connector.qq.send", { why: messageOf(e) }));
    }
    let body: { id?: string; message?: string; code?: number } | undefined;
    let decodeError = "";
    try {
      body = (await res.json()) as typeof body;
    } catch (e) {
      decodeError = messageOf(e);
    }
    if (res.status < 200 || res.status > 299)
      throw new SendError(t("server.connector.qq.send", { why: `${body?.code ?? res.status} ${body?.message ?? ""}`.trim() }), res.status);
    if (decodeError) throw new SendError(t("server.connector.qq.unread", { why: decodeError }));
    if (!body?.id || (body.code !== undefined && body.code !== 0)) throw new SendError(t("server.connector.qq.noId", { why: body?.message ?? "" }));
    return body.id;
  }
}

export function qqAdapter(api: QQApi): Adapter {
  const appOf = (s: Record<string, string>) => ({ appId: s.appId ?? "", secret: s.secret ?? "" });
  return {
    id: "qq",
    login: async (signal, input) => {
      const appId = (input.appId ?? "").trim();
      const secret = (input.secret ?? "").trim();
      if (!appId || !secret) throw new Error(t("server.connector.qqKeys"));
      await api.check(signal, { appId, secret });
      return { secrets: { appId, secret }, owner: "" };
    },
    receive: async (signal, secrets, io) => {
      try {
        await api.listen(signal, appOf(secrets), (m) => {
          const parts = [m.content.trim(), m.attachments > 0 ? t("server.connector.media.attachment") : ""].filter(Boolean);
          return io.accept([{ id: m.id, from: m.from, text: parts.join("\n"), reply: m.id }], "");
        });
        return undefined;
      } catch (e) {
        return signal.aborted ? undefined : { kind: "failed", reason: messageOf(e) };
      }
    },
    send: async (signal, secrets, to, text, reply) => {
      try {
        return await api.sendText(signal, appOf(secrets), to, text, reply);
      } catch (e) {
        // A refused passive reply (too late, too many) waits for the owner's next message; a bad login is stale.
        const status = e instanceof SendError ? e.status : 0;
        return {
          kind: status === 401 ? "stale" : status >= 400 && status < 500 ? "restricted" : "failed",
          reason: messageOf(e),
        };
      }
    },
  };
}
