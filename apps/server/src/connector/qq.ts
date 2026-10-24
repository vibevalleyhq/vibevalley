// QQ, written from Tencent's botpy (the official Python SDK). A reply is a passive one on the user's
// message id, which QQ honours only for a while.

import { Schema } from "effect";

const apiBase = "https://api.sgroup.qq.com";
const tokenUrl = "https://bots.qq.com/app/getAppAccessToken";
const intents = 1 << 25;

const Envelope = Schema.Struct({
  op: Schema.optional(Schema.Int),
  s: Schema.optional(Schema.Int),
  t: Schema.optional(Schema.String),
  d: Schema.optional(Schema.Unknown),
});
const heartbeatInterval = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2_147_483_647 }));
const Heartbeat = Schema.Struct({ heartbeat_interval: Schema.optional(heartbeatInterval) });
const MessageData = Schema.Struct({
  id: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  author: Schema.optional(Schema.Struct({ user_openid: Schema.optional(Schema.String) })),
  attachments: Schema.optional(Schema.Array(Schema.Unknown)),
});
const decodeEnvelope = Schema.decodeUnknownSync(Envelope);
const decodeHeartbeat = Schema.decodeUnknownSync(Heartbeat);
const decodeMessageData = Schema.decodeUnknownSync(MessageData);

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
    if (cached && cached.until > Date.now()) return cached.token;
    const timed = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
    let body: { access_token?: string; expires_in?: number | string; message?: string };
    try {
      const res = await fetch(this.tokenAt, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId: app.appId, clientSecret: app.secret }),
        signal: timed,
      });
      body = (await res.json()) as typeof body;
    } catch (e) {
      if (timed.aborted && !signal.aborted) throw new Error("QQ 鉴权：超时了");
      throw new Error("QQ 鉴权：" + (e instanceof Error ? e.message : String(e)));
    }
    if (!body.access_token) throw new Error("QQ 鉴权：" + (body.message || "AppID 或 AppSecret 不对"));
    const seconds = typeof body.expires_in === "number" ? body.expires_in : Number.parseFloat(String(body.expires_in ?? "")) || 7200;
    this.tokens.set(key, { token: body.access_token, until: Date.now() + (seconds - 60) * 1000 });
    return body.access_token;
  }

  private headers(app: App, token: string) {
    return { Authorization: "QQBot " + token, "X-Union-Appid": app.appId, "Content-Type": "application/json" };
  }

  async check(signal: AbortSignal, app: App) {
    await this.token(signal, app);
  }

  async listen(signal: AbortSignal, app: App, got: (m: Message) => Promise<void>): Promise<void> {
    const token = await this.token(signal, app);
    let gateway: { url?: string };
    try {
      gateway = (await (await fetch(this.api + "/gateway", { headers: this.headers(app, token), signal })).json()) as { url?: string };
    } catch (e) {
      if (signal.aborted) return;
      throw new Error("QQ 网关：" + (e instanceof Error ? e.message : String(e)));
    }
    if (!gateway.url) throw new Error("QQ 没给网关地址");
    const ws = new WebSocket(gateway.url);
    return new Promise((resolve, reject) => {
      let seq: number | null = null;
      let beat: NodeJS.Timeout | undefined;
      let done = false;
      const end = (e?: Error) => {
        if (done) return;
        done = true;
        if (beat) clearInterval(beat);
        ws.close();
        if (e && !signal.aborted) reject(e);
        else resolve();
      };
      signal.addEventListener("abort", () => end(), { once: true });
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
            try {
              const msg = decodeEnvelope(JSON.parse(String(event.data)));
              if (msg.s !== undefined) seq = msg.s;
              switch (msg.op) {
                case 10: {
                  send({ op: 2, d: { token: "QQBot " + token, intents, shard: [0, 1], properties: {} } });
                  const d = msg.d === undefined ? {} : decodeHeartbeat(msg.d);
                  const every = d.heartbeat_interval ?? 0;
                  beat ??= setInterval(() => send({ op: 1, d: seq }), every > 0 ? every : 30_000);
                  return;
                }
                case 0: {
                  if (msg.t !== "C2C_MESSAGE_CREATE" || msg.d === undefined) return;
                  const d = decodeMessageData(msg.d);
                  if (!d.id || !d.author?.user_openid) return;
                  try {
                    await got({ id: d.id, from: d.author.user_openid, content: d.content ?? "", attachments: d.attachments?.length ?? 0 });
                  } catch (e) {
                    end(e instanceof Error ? e : new Error(String(e)));
                  }
                  return;
                }
                case 7:
                  return end(new Error("QQ 网关：QQ 让重新连接"));
                case 9:
                  return end(new Error("QQ 网关：QQ 说会话无效"));
              }
            } catch {
              end(new Error("QQ 网关：连接出错"));
            }
          })
          .catch(end);
      });
      ws.addEventListener("close", (event) => end(new Error(`QQ 网关：连接关了（${event.code}）`)));
      ws.addEventListener("error", () => end(new Error("QQ 网关：连接出错")));
    });
  }

  async sendText(signal: AbortSignal, app: App, openId: string, text: string, msgId: string): Promise<string> {
    let token: string;
    try {
      token = await this.token(signal, app);
    } catch (e) {
      throw new SendError(e instanceof Error ? e.message : String(e), 401);
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
      throw new SendError("QQ 发消息：" + (e instanceof Error ? e.message : String(e)));
    }
    let body: { id?: string; message?: string; code?: number } | undefined;
    let decodeError = "";
    try {
      body = (await res.json()) as typeof body;
    } catch (e) {
      decodeError = e instanceof Error ? e.message : String(e);
    }
    if (res.status < 200 || res.status > 299) throw new SendError("QQ 发消息：" + `${body?.code ?? res.status} ${body?.message ?? ""}`.trim(), res.status);
    if (decodeError) throw new SendError("QQ 发消息：读不出发送结果：" + decodeError);
    if (!body?.id || (body.code !== undefined && body.code !== 0)) throw new SendError("QQ 发消息：没有确认消息编号 " + (body?.message ?? ""));
    return body.id;
  }
}
