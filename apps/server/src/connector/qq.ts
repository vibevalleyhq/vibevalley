// QQ, written from Tencent's botpy (the official Python SDK). A reply is a passive one on the user's
// message id, which QQ honours only for a while.

import { Effect, Option, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import { type Answer, answer, outside } from "../base/http.ts";
import { jsonOrNone } from "../base/json.ts";

const apiBase = "https://api.sgroup.qq.com";
const tokenUrl = "https://bots.qq.com/app/getAppAccessToken";
const intents = 1 << 25;

const readToken = jsonOrNone(
  Schema.Struct({
    access_token: Schema.optionalKey(Schema.String),
    expires_in: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
    message: Schema.optionalKey(Schema.String),
  }),
);
/** A gateway frame: its op, sequence and event name; d is read for the ops this client acts on. */
const readFrame = jsonOrNone(
  Schema.Struct({
    op: Schema.optionalKey(Schema.Number),
    s: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    t: Schema.optionalKey(Schema.NullOr(Schema.String)),
    d: Schema.optionalKey(Schema.Unknown),
  }),
);
const readHello = Schema.decodeUnknownOption(Schema.Struct({ heartbeat_interval: Schema.optionalKey(Schema.Number) }));
const readC2C = Schema.decodeUnknownOption(
  Schema.Struct({
    id: Schema.optionalKey(Schema.String),
    content: Schema.optionalKey(Schema.String),
    author: Schema.optionalKey(Schema.Struct({ user_openid: Schema.optionalKey(Schema.String) })),
    attachments: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  }),
);
const readGateway = jsonOrNone(Schema.Struct({ url: Schema.optionalKey(Schema.String) }));
const readSent = jsonOrNone(
  Schema.Struct({
    id: Schema.optionalKey(Schema.String),
    message: Schema.optionalKey(Schema.String),
    code: Schema.optionalKey(Schema.Number),
  }),
);

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
    const body = await outside(
      answer(HttpClientRequest.post(this.tokenAt).pipe(HttpClientRequest.bodyJsonUnsafe({ appId: app.appId, clientSecret: app.secret }))).pipe(
        Effect.timeoutOrElse({ duration: 20_000, orElse: () => Effect.fail(new Error("超时了")) }),
        Effect.flatMap((got) => {
          const read = readToken(got.text);
          return read ? Effect.succeed(read) : Effect.fail(new Error("回答读不出：" + got.text.slice(0, 200)));
        }),
        Effect.mapError((e) => new Error("QQ 鉴权：" + e.message)),
      ),
      signal,
    );
    if (!body.access_token) throw new Error("QQ 鉴权：" + (body.message || "AppID 或 AppSecret 不对"));
    const seconds = typeof body.expires_in === "number" ? body.expires_in : Number.parseFloat(String(body.expires_in ?? "")) || 7200;
    this.tokens.set(key, { token: body.access_token, until: Date.now() + (seconds - 60) * 1000 });
    return body.access_token;
  }

  private headers(app: App, token: string) {
    return { Authorization: "QQBot " + token, "X-Union-Appid": app.appId };
  }

  async check(signal: AbortSignal, app: App) {
    await this.token(signal, app);
  }

  async listen(signal: AbortSignal, app: App, got: (m: Message) => Promise<void>): Promise<void> {
    const token = await this.token(signal, app);
    let gateway: { readonly url?: string } | undefined;
    try {
      gateway = readGateway((await outside(answer(HttpClientRequest.get(this.api + "/gateway", { headers: this.headers(app, token) })), signal)).text);
    } catch (e) {
      if (signal.aborted) return;
      throw new Error("QQ 网关：" + (e instanceof Error ? e.message : String(e)));
    }
    if (!gateway?.url) throw new Error("QQ 没给网关地址");
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
        chain = chain.then(async () => {
          if (done) return;
          const msg = readFrame(String(event.data));
          if (!msg) return end(new Error("QQ 网关：连接出错"));
          if (typeof msg.s === "number") seq = msg.s;
          switch (msg.op) {
            case 10: {
              send({
                op: 2,
                d: { token: "QQBot " + token, intents, shard: [0, 1], properties: {} },
              });
              const every = Option.getOrUndefined(readHello(msg.d))?.heartbeat_interval ?? 0;
              beat ??= setInterval(() => send({ op: 1, d: seq }), every > 0 ? every : 30_000);
              return;
            }
            case 0: {
              if (msg.t !== "C2C_MESSAGE_CREATE") return;
              const d = Option.getOrUndefined(readC2C(msg.d));
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
              return end(new Error("QQ 网关：QQ 让重新连接"));
            case 9:
              return end(new Error("QQ 网关：QQ 说会话无效"));
          }
        });
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
    let got: Answer;
    try {
      got = await outside(
        answer(
          HttpClientRequest.post(this.api + "/v2/users/" + encodeURIComponent(openId) + "/messages", { headers: this.headers(app, token) }).pipe(
            HttpClientRequest.bodyJsonUnsafe(payload),
          ),
        ).pipe(
          Effect.timeoutOrElse({
            duration: 25_000,
            orElse: () => Effect.fail(new Error("超时了")),
          }),
        ),
        signal,
      );
    } catch (e) {
      throw new SendError("QQ 发消息：" + (e instanceof Error ? e.message : String(e)));
    }
    const body = readSent(got.text);
    if (!got.ok) throw new SendError("QQ 发消息：" + `${body?.code ?? got.status} ${body?.message ?? ""}`.trim(), got.status);
    if (!body) throw new SendError("QQ 发消息：读不出发送结果：" + got.text.slice(0, 200));
    if (!body.id || (body.code !== undefined && body.code !== 0)) throw new SendError("QQ 发消息：没有确认消息编号 " + (body.message ?? ""));
    return body.id;
  }
}
