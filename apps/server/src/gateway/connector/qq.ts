import { z } from "zod";

import { type Clock, Queue, systemClock } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";

import { numberIn } from "#/base/order.ts";

import { type Adapter, AppFailed, appFailure, failedWith, timed } from "./adapter.ts";

const apiBase = "https://api.sgroup.qq.com";
const tokenUrl = "https://bots.qq.com/app/getAppAccessToken";
const intents = 1 << 25;

// A refused AppID or secret answers without a token, with QQ's reason in message: that reason is what the user sees.
const TokenResponse = z.object({
  access_token: z.exactOptional(z.string()),
  expires_in: z.exactOptional(z.union([z.number(), z.string()])),
  message: z.exactOptional(z.string()),
});
const GatewayResponse = z.object({ url: z.string() });
const GatewayEvent = z.object({
  op: z.number(),
  // Frames that are not dispatches may carry s and t as null.
  s: z.exactOptional(z.number().nullable()),
  t: z.exactOptional(z.string().nullable()),
  d: z.exactOptional(z.unknown()),
});
/** Throws when the frame is not the gateway's JSON. */
export const decodeGatewayEvent = (raw: string) => GatewayEvent.parse(JSON.parse(raw));

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

export interface QQApi {
  readonly check: (app: App, signal?: AbortSignal) => Promise<void>;
  /** Until the gateway closes or fails (or signal aborts), taking each message before the next is read. */
  readonly listen: (app: App, got: (m: Message) => Promise<void>, signal: AbortSignal) => Promise<void>;
  readonly sendText: (app: App, openId: string, text: string, msgId: string) => Promise<string>;
}

const SendResponse = z.object({
  id: z.exactOptional(z.string()),
  message: z.exactOptional(z.string()),
  code: z.exactOptional(z.number()),
});

/** A C2C message as the gateway dispatches it; fields it leaves out read as none. */
const C2CMessage = z.object({
  id: z.exactOptional(z.string()),
  content: z.exactOptional(z.string()),
  author: z.exactOptional(z.object({ user_openid: z.exactOptional(z.string()) })),
  attachments: z.exactOptional(z.array(z.unknown())),
});
const Hello = z.object({ heartbeat_interval: z.exactOptional(z.number()) });

/** A refused send, by its status: a bad login is stale; a passive reply refused (too late, too many) waits for the user's
 * next message. */
const sendFailure = (status: number, message: string) =>
  new AppFailed(status === 401 ? "stale" : status >= 400 && status < 500 ? "restricted" : "failed", message);

/** QQ takes passive replies to a message for minutes only: the counts of the latest messages answered are enough. */
const repliesKept = 256;

/** The next msg_seq for a reply to msgId. Newest last: a message answered again moves to the end, and the oldest goes
 * past the cap. */
export const nextReplySeq = (seqs: Map<string, number>, msgId: string) => {
  const next = (seqs.get(msgId) ?? 0) + 1;
  seqs.delete(msgId);
  seqs.set(msgId, next);
  const oldest = seqs.keys().next().value;
  if (seqs.size > repliesKept && oldest !== undefined) seqs.delete(oldest);
  return next;
};

export class QQClient implements QQApi {
  /** One active QQ account; changing its credentials evicts the previous token. */
  private tokenCache: { readonly key: string; readonly token: string; readonly until: number } | undefined;
  /** QQ refuses the same (msg_id, msg_seq) twice. */
  private readonly replySeq = new Map<string, number>();

  private readonly fetch: typeof fetch;
  private readonly api: string;
  private readonly tokenAt: string;
  private readonly clock: Clock;
  constructor(fetcher: typeof fetch, api: string = apiBase, tokenAt: string = tokenUrl, clock: Clock = systemClock) {
    this.fetch = fetcher;
    this.api = api;
    this.tokenAt = tokenAt;
    this.clock = clock;
  }

  private async token(app: App, signal?: AbortSignal): Promise<string> {
    const key = app.appId + "\u0000" + app.secret;
    const now = this.clock.now();
    const cached = this.tokenCache;
    if (cached?.key === key && cached.until > now) return cached.token;
    const body = await timed(
      async (s) => {
        try {
          const res = await this.fetch(this.tokenAt, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ appId: app.appId, clientSecret: app.secret }),
            signal: s,
          });
          return TokenResponse.parse(await res.json());
        } catch (e) {
          throw appFailure(e, s, (why) => t("server.connector.qq.auth", { why }));
        }
      },
      20_000,
      this.clock,
      signal,
      () => {
        throw failedWith(t("server.connector.qq.authTimeout"));
      },
    );
    if (!body.access_token) throw failedWith(t("server.connector.qq.auth", { why: body.message || t("server.connector.qq.badKeys") }));
    const seconds = typeof body.expires_in === "number" ? body.expires_in : numberIn(body.expires_in, 7200);
    this.tokenCache = { key, token: body.access_token, until: now + (seconds - 60) * 1000 };
    return body.access_token;
  }

  private headers(app: App, token: string) {
    return { Authorization: "QQBot " + token, "X-Union-Appid": app.appId, "Content-Type": "application/json" };
  }

  async check(app: App, signal?: AbortSignal) {
    await this.token(app, signal);
  }

  async listen(app: App, got: (m: Message) => Promise<void>, signal: AbortSignal): Promise<void> {
    const token = await this.token(app, signal);
    let gateway: z.output<typeof GatewayResponse>;
    try {
      const res = await this.fetch(this.api + "/gateway", { headers: this.headers(app, token), signal });
      gateway = GatewayResponse.parse(await res.json());
    } catch (e) {
      throw appFailure(e, signal, (why) => t("server.connector.qq.gateway", { why }));
    }
    if (!gateway.url) throw failedWith(t("server.connector.qq.noGateway"));
    const ws = new WebSocket(gateway.url);
    // The socket's frames, in order; its close or error ends them as a failure.
    const frames = new Queue<string>();
    let failure: AppFailed | undefined;
    const fail = (e: AppFailed) => {
      failure ??= e;
      frames.end();
    };
    ws.addEventListener("message", (event) => frames.offer(String(event.data)));
    ws.addEventListener("close", (event) => fail(failedWith(t("server.connector.qq.closed", { code: event.code }))));
    ws.addEventListener("error", () => fail(failedWith(t("server.connector.qq.gatewayError"))));
    const send = (frame: { readonly op: number; readonly d: unknown }) => {
      try {
        ws.send(JSON.stringify(frame));
      } catch {
        // A socket that cannot take a frame is done: its close event ends the listen.
        ws.close();
      }
    };
    const beat = new AbortController();
    let seq: number | null = null;
    let beating = false;
    try {
      for (;;) {
        const next = await frames.next(signal);
        if (next.done === true) throw failure ?? failedWith(t("server.connector.qq.gatewayError"));
        let msg: z.output<typeof GatewayEvent>;
        try {
          msg = decodeGatewayEvent(next.value);
        } catch {
          throw failedWith(t("server.connector.qq.gatewayError"));
        }
        if (typeof msg.s === "number") seq = msg.s;
        switch (msg.op) {
          case 10: {
            send({ op: 2, d: { token: "QQBot " + token, intents, shard: [0, 1], properties: {} } });
            if (beating) break;
            beating = true;
            const hello = Hello.safeParse(msg.d);
            const asked = hello.success ? (hello.data.heartbeat_interval ?? 0) : 0;
            const every = asked > 0 ? asked : 30_000;
            // The gateway's heartbeat, every interval it asked for, as long as the connection lasts.
            const heartbeat = async () => {
              for (;;) {
                await this.clock.sleep(every, beat.signal);
                send({ op: 1, d: seq });
              }
            };
            // Its sleep rejects only when the listen ends and stops it.
            void heartbeat().catch(() => undefined);
            break;
          }
          case 0: {
            if (msg.t !== "C2C_MESSAGE_CREATE") break;
            const d = C2CMessage.safeParse(msg.d);
            if (!d.success || !d.data.id || !d.data.author?.user_openid) break;
            await got({ id: d.data.id, from: d.data.author.user_openid, content: d.data.content ?? "", attachments: d.data.attachments?.length ?? 0 });
            break;
          }
          case 7:
            throw failedWith(t("server.connector.qq.reconnect"));
          case 9:
            throw failedWith(t("server.connector.qq.invalid"));
          default:
            break;
        }
      }
    } finally {
      beat.abort();
      ws.close();
    }
  }

  async sendText(app: App, openId: string, text: string, msgId: string): Promise<string> {
    let token: string;
    try {
      token = await this.token(app);
    } catch (e) {
      throw sendFailure(401, e instanceof Error ? e.message : String(e));
    }
    const reply = msgId ? { msg_id: msgId, msg_seq: nextReplySeq(this.replySeq, msgId) } : {};
    const payload = JSON.stringify({ content: text, msg_type: 0, ...reply });
    const res = await timed(
      async (s) => {
        try {
          return await this.fetch(this.api + "/v2/users/" + encodeURIComponent(openId) + "/messages", {
            method: "POST",
            headers: this.headers(app, token),
            body: payload,
            signal: s,
          });
        } catch (e) {
          throw appFailure(e, s, (why) => t("server.connector.qq.send", { why }));
        }
      },
      25_000,
      this.clock,
      undefined,
      () => {
        throw failedWith(t("server.connector.qq.send", { why: "timed out" }));
      },
    );
    const decoded = async () => SendResponse.parse(await res.json());
    if (res.status < 200 || res.status > 299) {
      const read = await decoded().catch(() => undefined);
      throw sendFailure(res.status, t("server.connector.qq.send", { why: `${read?.code ?? res.status} ${read?.message ?? ""}`.trim() }));
    }
    let read: z.output<typeof SendResponse>;
    try {
      read = await decoded();
    } catch (e) {
      throw appFailure(e, undefined, (why) => t("server.connector.qq.unread", { why }));
    }
    if (!read.id || (read.code !== undefined && read.code !== 0)) throw failedWith(t("server.connector.qq.noId", { why: read.message ?? "" }));
    return read.id;
  }
}

export function qqAdapter(api: QQApi): Adapter {
  const appOf = (s: Readonly<Record<string, string>>) => ({ appId: s.appId ?? "", secret: s.secret ?? "" });
  return {
    id: "qq",
    login: async (input, _progress, _verifyCode, signal) => {
      const appId = (input.appId ?? "").trim();
      const secret = (input.secret ?? "").trim();
      if (!appId || !secret) throw failedWith(t("server.connector.qqKeys"));
      await api.check({ appId, secret }, signal);
      return { secrets: { appId, secret }, user: "" };
    },
    receive: (secrets, io, signal) =>
      api.listen(
        appOf(secrets),
        (m) => {
          const parts = [m.content.trim(), m.attachments > 0 ? t("server.connector.media.attachment") : ""].filter(Boolean);
          return io.accept([{ id: m.id, from: m.from, text: parts.join("\n"), reply: m.id, quoted: "" }], "");
        },
        signal,
      ),
    send: (secrets, to, text, reply) => api.sendText(appOf(secrets), to, text, reply),
  };
}
