// QQ, written from Tencent's botpy (the official Python SDK). A reply is a passive one on the user's
// message id, which QQ honours only for a while.

import { Cause, Clock, Effect, Option, Queue, Schedule, Schema, Stream } from "effect";
import { type HttpClient, HttpClientRequest } from "effect/http";

import { t } from "@vibevalley/i18n";

import { numberIn } from "@/base/number.ts";

import { type Adapter, AppFailed, failedWith } from "./adapter.ts";

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
  readonly check: (app: App) => Effect.Effect<void, AppFailed>;
  /** Until the gateway closes or fails, taking each message before the next is read. */
  readonly listen: (app: App, got: (m: Message) => Effect.Effect<void, AppFailed>) => Effect.Effect<void, AppFailed>;
  readonly sendText: (app: App, openId: string, text: string, msgId: string) => Effect.Effect<string, AppFailed>;
}

const SendResponse = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.Finite),
});

/** A C2C message as the gateway dispatches it; fields it leaves out read as none. */
const C2CMessage = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.String),
  author: Schema.optionalKey(Schema.Struct({ user_openid: Schema.optionalKey(Schema.String) })),
  attachments: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});
const Hello = Schema.Struct({ heartbeat_interval: Schema.optionalKey(Schema.Finite) });

/** A refused send, by its status: a bad login is stale; a passive reply refused (too late, too many) waits for the owner's
 * next message. */
const sendFailure = (status: number, message: string) =>
  new AppFailed({ kind: status === 401 ? "stale" : status >= 400 && status < 500 ? "restricted" : "failed", message });

export class QQClient implements QQApi {
  /** Tokens last about two hours: one per app, renewed a minute early. */
  private readonly tokens = new Map<string, { token: string; until: number }>();
  /** QQ refuses the same (msg_id, msg_seq) twice. */
  private readonly replySeq = new Map<string, number>();

  private readonly http: HttpClient.HttpClient;
  private readonly api: string;
  private readonly tokenAt: string;
  constructor(http: HttpClient.HttpClient, api: string = apiBase, tokenAt: string = tokenUrl) {
    this.http = http;
    this.api = api;
    this.tokenAt = tokenAt;
  }

  private token(app: App) {
    return Effect.gen({ self: this }, function* () {
      const key = app.appId + "\u0000" + app.secret;
      const now = yield* Clock.currentTimeMillis;
      const cached = this.tokens.get(key);
      if (cached && cached.until > now) return cached.token;
      const request = HttpClientRequest.bodyText(
        HttpClientRequest.post(this.tokenAt),
        JSON.stringify({ appId: app.appId, clientSecret: app.secret }),
        "application/json",
      );
      const body = yield* this.http.execute(request).pipe(
        Effect.flatMap((res) => res.json),
        Effect.flatMap(Schema.decodeUnknownEffect(TokenResponse)),
        Effect.timeoutOrElse({ duration: 20_000, orElse: () => Effect.fail(failedWith(t("server.connector.qq.authTimeout"))) }),
        Effect.mapError((e) => (e instanceof AppFailed ? e : failedWith(t("server.connector.qq.auth", { why: e.message })))),
      );
      if (!body.access_token) return yield* failedWith(t("server.connector.qq.auth", { why: body.message || t("server.connector.qq.badKeys") }));
      const seconds = typeof body.expires_in === "number" ? body.expires_in : numberIn(body.expires_in, 7200);
      this.tokens.set(key, { token: body.access_token, until: now + (seconds - 60) * 1000 });
      return body.access_token;
    });
  }

  private headers(app: App, token: string) {
    return { Authorization: "QQBot " + token, "X-Union-Appid": app.appId, "Content-Type": "application/json" };
  }

  check(app: App) {
    return Effect.asVoid(this.token(app));
  }

  listen(app: App, got: (m: Message) => Effect.Effect<void, AppFailed>) {
    return Effect.scoped(
      Effect.gen({ self: this }, function* () {
        const token = yield* this.token(app);
        const gateway = yield* this.http.execute(HttpClientRequest.setHeaders(HttpClientRequest.get(this.api + "/gateway"), this.headers(app, token))).pipe(
          Effect.flatMap((res) => res.json),
          Effect.flatMap(Schema.decodeUnknownEffect(GatewayResponse)),
          Effect.mapError((e) => failedWith(t("server.connector.qq.gateway", { why: e.message }))),
        );
        if (!gateway.url) return yield* failedWith(t("server.connector.qq.noGateway"));
        const ws = yield* Effect.acquireRelease(
          Effect.sync(() => new WebSocket(gateway.url)),
          (socket) => Effect.sync(() => socket.close()),
        );
        const send = (payload: unknown) =>
          Effect.sync(() => {
            try {
              ws.send(JSON.stringify(payload));
            } catch {
              ws.close();
            }
          });
        // The socket's frames, in order; its close or error ends them as a failure.
        const frames = Stream.callback<string, AppFailed>((queue) =>
          Effect.sync(() => {
            ws.addEventListener("message", (event) => Queue.offerUnsafe(queue, String(event.data)));
            ws.addEventListener("close", (event) =>
              Queue.failCauseUnsafe(queue, Cause.fail(failedWith(t("server.connector.qq.closed", { code: event.code })))),
            );
            ws.addEventListener("error", () => Queue.failCauseUnsafe(queue, Cause.fail(failedWith(t("server.connector.qq.gatewayError")))));
          }),
        );
        let seq: number | null = null;
        let beating = false;
        yield* Stream.runForEach(frames, (frame) =>
          Effect.gen(function* () {
            const msg = yield* Effect.mapError(
              Effect.try(() => decodeGatewayEvent(frame)),
              () => failedWith(t("server.connector.qq.gatewayError")),
            );
            if (typeof msg.s === "number") seq = msg.s;
            switch (msg.op) {
              case 10: {
                yield* send({ op: 2, d: { token: "QQBot " + token, intents, shard: [0, 1], properties: {} } });
                if (beating) return;
                beating = true;
                const asked = Option.match(Schema.decodeUnknownOption(Hello)(msg.d), { onNone: () => 0, onSome: (h) => h.heartbeat_interval ?? 0 });
                const every = asked > 0 ? asked : 30_000;
                // The gateway's heartbeat, every interval it asked for, as long as the connection lasts.
                yield* Effect.forkScoped(
                  Effect.repeat(
                    Effect.suspend(() => send({ op: 1, d: seq })),
                    Schedule.spaced(every),
                  ).pipe(Effect.delay(every)),
                );
                return;
              }
              case 0: {
                if (msg.t !== "C2C_MESSAGE_CREATE") return;
                const d = Schema.decodeUnknownOption(C2CMessage)(msg.d);
                if (d._tag === "None" || !d.value.id || !d.value.author?.user_openid) return;
                yield* got({ id: d.value.id, from: d.value.author.user_openid, content: d.value.content ?? "", attachments: d.value.attachments?.length ?? 0 });
                return;
              }
              case 7:
                return yield* failedWith(t("server.connector.qq.reconnect"));
              case 9:
                return yield* failedWith(t("server.connector.qq.invalid"));
              default:
                return;
            }
          }),
        );
      }),
    );
  }

  sendText(app: App, openId: string, text: string, msgId: string) {
    return Effect.gen({ self: this }, function* () {
      const token = yield* this.token(app).pipe(Effect.mapError((e) => sendFailure(401, e.message)));
      const payload: Record<string, unknown> = { content: text, msg_type: 0 };
      if (msgId) {
        const next = (this.replySeq.get(msgId) ?? 0) + 1;
        this.replySeq.set(msgId, next);
        payload.msg_id = msgId;
        payload.msg_seq = next;
      }
      const request = HttpClientRequest.bodyText(
        HttpClientRequest.setHeaders(HttpClientRequest.post(this.api + "/v2/users/" + encodeURIComponent(openId) + "/messages"), this.headers(app, token)),
        JSON.stringify(payload),
        "application/json",
      );
      const res = yield* this.http.execute(request).pipe(
        Effect.timeoutOrElse({ duration: 25_000, orElse: () => Effect.fail(failedWith(t("server.connector.qq.send", { why: "timed out" }))) }),
        Effect.mapError((e) => (e instanceof AppFailed ? e : failedWith(t("server.connector.qq.send", { why: e.message })))),
      );
      const body = yield* Effect.result(Effect.flatMap(res.json, Schema.decodeUnknownEffect(SendResponse)));
      const read = body._tag === "Success" ? body.success : undefined;
      if (res.status < 200 || res.status > 299)
        return yield* sendFailure(res.status, t("server.connector.qq.send", { why: `${read?.code ?? res.status} ${read?.message ?? ""}`.trim() }));
      if (body._tag === "Failure") return yield* failedWith(t("server.connector.qq.unread", { why: body.failure.message }));
      if (!read?.id || (read.code !== undefined && read.code !== 0)) return yield* failedWith(t("server.connector.qq.noId", { why: read?.message ?? "" }));
      return read.id;
    });
  }
}

export function qqAdapter(api: QQApi): Adapter {
  const appOf = (s: Readonly<Record<string, string>>) => ({ appId: s.appId ?? "", secret: s.secret ?? "" });
  return {
    id: "qq",
    login: (input) =>
      Effect.gen(function* () {
        const appId = (input.appId ?? "").trim();
        const secret = (input.secret ?? "").trim();
        if (!appId || !secret) return yield* failedWith(t("server.connector.qqKeys"));
        yield* api.check({ appId, secret });
        return { secrets: { appId, secret }, owner: "" };
      }),
    receive: (secrets, io) =>
      api.listen(appOf(secrets), (m) => {
        const parts = [m.content.trim(), m.attachments > 0 ? t("server.connector.media.attachment") : ""].filter(Boolean);
        return io.accept([{ id: m.id, from: m.from, text: parts.join("\n"), reply: m.id, quoted: "" }], "");
      }),
    send: (secrets, to, text, reply) => api.sendText(appOf(secrets), to, text, reply),
  };
}
