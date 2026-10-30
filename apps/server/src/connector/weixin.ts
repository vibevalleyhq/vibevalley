import { t } from "@vibevalley/i18n";
// WeChat, written from the official client (@tencent-weixin/openclaw-weixin 2.4.10, MIT). Only
// text: pictures, voice and files arrive as a word in brackets (voice with WeChat's own transcript).

import { randomBytes, randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import { type HttpClient, HttpClientRequest } from "effect/http";
import { type Adapter, AppFailed, failedWith } from "./adapter.ts";
import { numberIn } from "@/base/number.ts";

/** A confirmed login may name another host for its account. */
export const baseUrl = "https://ilinkai.weixin.qq.com";
export const version = "2.4.10";
export const staleToken = -14;
export const restricted = -2;

export interface Account {
  readonly baseUrl: string;
  readonly token: string;
}

export interface Item {
  readonly type?: number;
  readonly text_item?: { readonly text?: string };
  readonly voice_item?: { readonly text?: string };
  readonly file_item?: { readonly file_name?: string };
  readonly ref_msg?: {
    readonly svr_id?: string;
    readonly title?: string;
    readonly message_item?: Item;
  };
}

const ItemSchema: Schema.Codec<Item> = Schema.Struct({
  type: Schema.optionalKey(Schema.Finite),
  text_item: Schema.optionalKey(Schema.Struct({ text: Schema.optionalKey(Schema.String) })),
  voice_item: Schema.optionalKey(Schema.Struct({ text: Schema.optionalKey(Schema.String) })),
  file_item: Schema.optionalKey(Schema.Struct({ file_name: Schema.optionalKey(Schema.String) })),
  ref_msg: Schema.optionalKey(
    Schema.Struct({
      svr_id: Schema.optionalKey(Schema.String),
      title: Schema.optionalKey(Schema.String),
      message_item: Schema.optionalKey(Schema.suspend((): Schema.Codec<Item> => ItemSchema)),
    }),
  ),
});

export interface Message {
  readonly message_id?: string;
  readonly from_user_id?: string;
  readonly message_type?: number;
  readonly context_token?: string;
  readonly group_id?: string;
  readonly item_list?: readonly Item[];
}

const MessageSchema: Schema.Codec<Message> = Schema.Struct({
  message_id: Schema.optionalKey(Schema.String),
  from_user_id: Schema.optionalKey(Schema.String),
  message_type: Schema.optionalKey(Schema.Finite),
  context_token: Schema.optionalKey(Schema.String),
  group_id: Schema.optionalKey(Schema.String),
  item_list: Schema.optionalKey(Schema.Array(ItemSchema)),
});

export interface Updates {
  readonly ret?: number;
  readonly errcode?: number;
  readonly errmsg?: string;
  readonly msgs?: readonly Message[];
  readonly get_updates_buf?: string;
  readonly longpolling_timeout_ms?: number;
}

const UpdatesSchema: Schema.Codec<Updates> = Schema.Struct({
  ret: Schema.optionalKey(Schema.Finite),
  errcode: Schema.optionalKey(Schema.Finite),
  errmsg: Schema.optionalKey(Schema.String),
  msgs: Schema.optionalKey(Schema.Array(MessageSchema)),
  get_updates_buf: Schema.optionalKey(Schema.String),
  longpolling_timeout_ms: Schema.optionalKey(Schema.Finite),
});

export const decodeUpdates = Schema.decodeUnknownSync(UpdatesSchema);

const QrCodeResponse = Schema.Struct({
  qrcode: Schema.optionalKey(Schema.String),
  qrcode_img_content: Schema.optionalKey(Schema.String),
});
const QrStatusResponse = Schema.Struct({
  status: Schema.optionalKey(Schema.String),
  bot_token: Schema.optionalKey(Schema.String),
  ilink_bot_id: Schema.optionalKey(Schema.String),
  baseurl: Schema.optionalKey(Schema.String),
  ilink_user_id: Schema.optionalKey(Schema.String),
  redirect_host: Schema.optionalKey(Schema.String),
});
const SendMessageResponse = Schema.Struct({
  ret: Schema.optionalKey(Schema.Finite),
  errcode: Schema.optionalKey(Schema.Finite),
  errmsg: Schema.optionalKey(Schema.String),
  message_id: Schema.optionalKey(Schema.String),
});

export type LoginState = "waiting" | "scanned" | "verify";

export interface LoginAccount {
  readonly account: Account;
  readonly botId: string;
  readonly owner: string;
}

export interface WeixinApi {
  /** One QR attempt: redirects, expiry refreshes and verification stay inside WeChat's protocol. */
  readonly login: (
    progress: (state: LoginState, url: string) => Effect.Effect<void>,
    verification: Effect.Effect<string>,
  ) => Effect.Effect<LoginAccount, AppFailed>;
  /** Nothing within timeout reads as an empty answer. */
  readonly getUpdates: (account: Account, buf: string, timeoutMs: number) => Effect.Effect<Updates, AppFailed>;
  /** Rides on the context of the user's latest message. */
  readonly sendText: (account: Account, to: string, text: string, contextToken: string) => Effect.Effect<string, AppFailed>;
}

export const failed = (ret?: number, errcode?: number) => (ret !== undefined && ret !== 0 ? ret : errcode !== undefined && errcode !== 0 ? errcode : undefined);

const clientVersion = (v: string) => {
  const [a = 0, b = 0, c = 0] = v.split(".").map((x) => numberIn(x));
  return ((a & 0xff) << 16) | ((b & 0xff) << 8) | (c & 0xff);
};

const baseInfo = { channel_version: version, bot_agent: "vibevalley/0.1.0" };

function headers(token: string, auth: boolean): Record<string, string> {
  const h: Record<string, string> = {
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String(clientVersion(version)),
  };
  if (!auth) return h;
  h["Content-Type"] = "application/json";
  h.AuthorizationType = "ilink_bot_token";
  // A random number per request, as the official client sends it.
  h["X-WECHAT-UIN"] = Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString("base64");
  if (token) h.Authorization = "Bearer " + token;
  return h;
}

const endpoint = (base: string, path: string) => (base.endsWith("/") ? base : base + "/") + path;

/** Message ids are 64-bit numbers: kept as text before they are decoded. */
const lossless = /"(message_id|msg_id|svr_id)"(\s*):(\s*)(-?\d+)/gu;

/** A refused send, by WeChat's code: a stale token or a closed reply window. */
const sendFailure = (code: number, message: string) =>
  new AppFailed({ kind: code === staleToken ? "stale" : code === restricted ? "restricted" : "failed", message });

export class WeixinClient implements WeixinApi {
  private readonly http: HttpClient.HttpClient;
  private readonly base: string;
  constructor(http: HttpClient.HttpClient, base: string = baseUrl) {
    this.http = http;
    this.base = base;
  }

  private request<T>(label: string, request: HttpClientRequest.HttpClientRequest, token: string, auth: boolean, schema: Schema.Codec<T>) {
    return Effect.gen({ self: this }, function* () {
      const res = yield* this.http.execute(HttpClientRequest.setHeaders(request, headers(token, auth)));
      const text = yield* res.text;
      if (res.status < 200 || res.status > 299) return yield* failedWith(`${label}: ${res.status}`);
      return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(text.replace(lossless, '"$1"$2:$3"$4"'));
    }).pipe(Effect.mapError((e) => (e instanceof AppFailed ? e : failedWith(label + ": " + e.message))));
  }

  private post<T>(label: string, url: string, body: unknown, token: string, schema: Schema.Codec<T>) {
    return this.request(label, HttpClientRequest.bodyText(HttpClientRequest.post(url), JSON.stringify(body), "application/json"), token, true, schema);
  }

  private readonly qrCode = Effect.gen({ self: this }, function* () {
    const body = yield* this.post(
      "get_bot_qrcode",
      endpoint(this.base, "ilink/bot/get_bot_qrcode?bot_type=3"),
      { local_token_list: [] },
      "",
      QrCodeResponse,
    ).pipe(Effect.timeoutOrElse({ duration: 15_000, orElse: () => Effect.fail(failedWith("get_bot_qrcode: timed out")) }));
    if (!body.qrcode || !body.qrcode_img_content) return yield* failedWith("get_bot_qrcode: no code in the answer");
    return [body.qrcode, body.qrcode_img_content] as const;
  }).pipe(Effect.mapError((e) => failedWith(t("server.connector.weixin.noQr", { why: e.message }))));

  /** WeChat's long poll on the code; a poll that fails reads as still waiting, after a breath so it does not spin. */
  private qrStatus(base: string, qrcode: string, verifyCode: string) {
    let q = "ilink/bot/get_qrcode_status?qrcode=" + encodeURIComponent(qrcode);
    if (verifyCode) q += "&verify_code=" + encodeURIComponent(verifyCode);
    return this.request("get_qrcode_status", HttpClientRequest.get(endpoint(base, q)), "", false, QrStatusResponse).pipe(
      Effect.timeout(35_000),
      Effect.map((s) => (s.status ? s : { status: "wait" })),
      Effect.catch(() => Effect.as(Effect.sleep(2_000), { status: "wait" })),
    );
  }

  login(progress: (state: LoginState, url: string) => Effect.Effect<void>, verification: Effect.Effect<string>) {
    return Effect.gen({ self: this }, function* () {
      let [code, show] = yield* this.qrCode;
      yield* progress("waiting", show);
      let base = this.base;
      let refreshes = 0;
      for (;;) {
        const status = yield* this.qrStatus(base, code, yield* verification);
        switch (status.status) {
          case "scaned":
            yield* progress("scanned", show);
            break;
          case "need_verifycode":
            yield* progress("verify", show);
            yield* Effect.sleep(1_000);
            break;
          case "scaned_but_redirect":
            if ("redirect_host" in status && status.redirect_host) base = "https://" + status.redirect_host;
            break;
          case "expired":
          case "verify_code_blocked":
            if (++refreshes >= 3)
              return yield* failedWith(status.status === "expired" ? t("server.connector.weixin.qrExpiredTimes") : t("server.connector.weixin.codeWrongTimes"));
            [code, show] = yield* this.qrCode;
            yield* progress("waiting", show);
            break;
          case "binded_redirect":
            return yield* failedWith(t("server.connector.weixin.taken"));
          case "confirmed": {
            const s = status;
            if (!("bot_token" in s) || !s.bot_token || !s.ilink_bot_id || !s.ilink_user_id) return yield* failedWith(t("server.connector.weixin.incomplete"));
            return { account: { baseUrl: s.baseurl || base, token: s.bot_token }, botId: s.ilink_bot_id, owner: s.ilink_user_id };
          }
          default:
            break;
        }
      }
    }).pipe(Effect.timeoutOrElse({ duration: 8 * 60_000, orElse: () => Effect.fail(failedWith(t("server.connector.weixin.tooLong"))) }));
  }

  getUpdates(account: Account, buf: string, timeoutMs: number) {
    return this.post(
      "getupdates",
      endpoint(account.baseUrl, "ilink/bot/getupdates"),
      { get_updates_buf: buf, base_info: baseInfo },
      account.token,
      UpdatesSchema,
    ).pipe(Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.succeed<Updates>({ ret: 0, get_updates_buf: buf }) }));
  }

  sendText(account: Account, to: string, text: string, contextToken: string) {
    const msg = {
      from_user_id: "",
      to_user_id: to,
      client_id: "vibevalley-" + randomUUID(),
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text } }],
      ...(contextToken ? { context_token: contextToken } : {}),
    };
    return Effect.gen({ self: this }, function* () {
      const body = yield* this.post(
        "sendmessage",
        endpoint(account.baseUrl, "ilink/bot/sendmessage"),
        { msg, base_info: baseInfo },
        account.token,
        SendMessageResponse,
      ).pipe(Effect.timeoutOrElse({ duration: 15_000, orElse: () => Effect.fail(failedWith("sendmessage: timed out")) }));
      const code = failed(body.ret, body.errcode);
      if (code !== undefined) return yield* sendFailure(code, "sendmessage: " + (body.errmsg || String(code)));
      return body.message_id ?? "";
    });
  }
}

export function text(m: Message): string {
  const parts: string[] = [];
  for (const item of m.item_list ?? []) {
    let part = "";
    switch (item.type) {
      case 1:
        part = item.text_item?.text ?? "";
        break;
      case 3:
        part = item.voice_item?.text || t("server.connector.media.audio");
        break;
      case 2:
        part = t("server.connector.media.image");
        break;
      case 4:
        part = item.file_item?.file_name ? t("server.connector.namedFile", { name: item.file_item.file_name }) : t("server.connector.media.file");
        break;
      case 5:
        part = t("server.connector.media.video");
        break;
      case undefined:
        break;
    }
    if (part) parts.push(part);
  }
  return parts.join("\n").trim();
}

export const quoted = (m: Message) => (m.item_list ?? []).find((i) => i.ref_msg?.svr_id)?.ref_msg?.svr_id ?? "";

/** The long poll's own length until WeChat says another. */
const weixinPollMs = 35_000;

export function weixinAdapter(api: WeixinApi): Adapter {
  const accountOf = (s: Readonly<Record<string, string>>) => ({ baseUrl: s.baseUrl || baseUrl, token: s.token ?? "" });
  return {
    id: "weixin",
    login: (_input, progress, verifyCode) =>
      Effect.map(
        api.login((state, url) => progress({ state, qr: url }), verifyCode),
        (linked) => ({
          secrets: { token: linked.account.token, botId: linked.botId, baseUrl: linked.account.baseUrl },
          owner: linked.owner,
        }),
      ),
    receive: (secrets, io) =>
      Effect.gen(function* () {
        const account = accountOf(secrets);
        let buf = io.cursor;
        let timeout = weixinPollMs;
        for (;;) {
          const updates = yield* api.getUpdates(account, buf, timeout);
          const code = failed(updates.ret, updates.errcode);
          if (code === staleToken) return yield* new AppFailed({ kind: "stale", message: t("server.connector.staleLogin") });
          if (code !== undefined) return yield* failedWith("getupdates: " + (updates.errmsg || String(code)));
          if (updates.longpolling_timeout_ms != null && updates.longpolling_timeout_ms > 0) timeout = updates.longpolling_timeout_ms;
          // Its own messages echo back; groups are not for the farm.
          const messages = (updates.msgs ?? []).flatMap((m) =>
            m.message_type !== 2 && !m.group_id && m.from_user_id
              ? [{ id: m.message_id ?? "", from: m.from_user_id, text: text(m), reply: m.context_token ?? "", quoted: quoted(m) }]
              : [],
          );
          yield* io.accept(messages, updates.get_updates_buf ?? "");
          if (updates.get_updates_buf) buf = updates.get_updates_buf;
        }
      }),
    send: (secrets, to, body, reply) => api.sendText(accountOf(secrets), to, body, reply),
  };
}
