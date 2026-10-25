// WeChat, written from the official client (@tencent-weixin/openclaw-weixin 2.4.10, MIT). Only
// text: pictures, voice and files arrive as a word in brackets (voice with WeChat's own transcript).

import { randomBytes, randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import { answer, outside } from "../base/http.ts";

/** A confirmed login may name another host for its account. */
export const baseUrl = "https://ilinkai.weixin.qq.com";
export const version = "2.4.10";
export const staleToken = -14;
export const restricted = -2;

export class WeixinError extends Error {
  constructor(
    message: string,
    readonly code = 0,
  ) {
    super(message);
  }
}

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

export interface Message {
  readonly message_id?: string;
  readonly from_user_id?: string;
  readonly message_type?: number;
  readonly context_token?: string;
  readonly group_id?: string;
  readonly item_list?: readonly Item[];
}

export interface Updates {
  readonly ret?: number;
  readonly errcode?: number;
  readonly errmsg?: string;
  readonly msgs?: readonly Message[];
  readonly get_updates_buf?: string;
  readonly longpolling_timeout_ms?: number;
}

const str = Schema.optionalKey(Schema.String);
const ItemSchema: Schema.Codec<Item> = Schema.Struct({
  type: Schema.optionalKey(Schema.Number),
  text_item: Schema.optionalKey(Schema.Struct({ text: str })),
  voice_item: Schema.optionalKey(Schema.Struct({ text: str })),
  file_item: Schema.optionalKey(Schema.Struct({ file_name: str })),
  ref_msg: Schema.optionalKey(
    Schema.Struct({
      svr_id: str,
      title: str,
      message_item: Schema.optionalKey(Schema.suspend((): Schema.Codec<Item> => ItemSchema)),
    }),
  ),
});
const UpdatesSchema: Schema.Codec<Updates> = Schema.Struct({
  ret: Schema.optionalKey(Schema.Number),
  errcode: Schema.optionalKey(Schema.Number),
  errmsg: str,
  msgs: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        message_id: str,
        from_user_id: str,
        message_type: Schema.optionalKey(Schema.Number),
        context_token: str,
        group_id: str,
        item_list: Schema.optionalKey(Schema.Array(ItemSchema)),
      }),
    ),
  ),
  get_updates_buf: str,
  longpolling_timeout_ms: Schema.optionalKey(Schema.Number),
});
const QrCode = Schema.Struct({ qrcode: str, qrcode_img_content: str });
const QrStatus = Schema.Struct({
  status: str,
  bot_token: str,
  ilink_bot_id: str,
  baseurl: str,
  ilink_user_id: str,
  redirect_host: str,
});
const Sent = Schema.Struct({
  ret: Schema.optionalKey(Schema.Number),
  errcode: Schema.optionalKey(Schema.Number),
  errmsg: str,
  message_id: str,
});

export type LoginState = "waiting" | "scanned" | "verify";

export interface LoginAccount {
  readonly account: Account;
  readonly botId: string;
  readonly owner: string;
}

export interface WeixinApi {
  login(signal: AbortSignal, progress: (state: LoginState, url: string) => void, verification: () => string): Promise<LoginAccount>;
  /** Nothing within timeout reads as an empty answer. */
  getUpdates(signal: AbortSignal, account: Account, buf: string, timeoutMs: number): Promise<Updates>;
  /** Rides on the context of the user's latest message. */
  sendText(signal: AbortSignal, account: Account, to: string, text: string, contextToken: string): Promise<string>;
}

export const failed = (ret?: number, errcode?: number) => (ret !== undefined && ret !== 0 ? ret : errcode !== undefined && errcode !== 0 ? errcode : undefined);

const clientVersion = (v: string) => {
  const [a = 0, b = 0, c = 0] = v.split(".").map((x) => Number.parseInt(x, 10) || 0);
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
const lossless = /"(message_id|msg_id|svr_id)"(\s*):(\s*)(-?\d+)/g;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<boolean>((resolve) => {
    if (signal.aborted) return resolve(false);
    const t = setTimeout(() => resolve(true), ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve(false)), { once: true });
  });

export class WeixinClient implements WeixinApi {
  constructor(private readonly base = baseUrl) {}

  private request<T>(
    schema: Schema.Codec<T>,
    label: string,
    method: "GET" | "POST",
    url: string,
    body: unknown,
    token: string,
    auth: boolean,
    signal: AbortSignal,
  ): Promise<T> {
    const request = HttpClientRequest.make(method)(url, { headers: headers(token, auth) });
    return outside(
      answer(body === undefined ? request : HttpClientRequest.bodyJsonUnsafe(request, body)).pipe(
        Effect.mapError((e) => new WeixinError(label + ": " + e.message)),
        Effect.flatMap((got) => (got.ok ? Effect.succeed(got.text) : Effect.fail(new WeixinError(`${label}: ${got.status}`)))),
        Effect.flatMap((got) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(got.replace(lossless, '"$1"$2:$3"$4"')).pipe(
            Effect.mapError((e) => new WeixinError(label + ": " + e.message)),
          ),
        ),
      ),
      signal,
    );
  }

  private async qrCode(signal: AbortSignal): Promise<[string, string]> {
    const timed = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    let body: typeof QrCode.Type;
    try {
      body = await this.request(
        QrCode,
        "get_bot_qrcode",
        "POST",
        endpoint(this.base, "ilink/bot/get_bot_qrcode?bot_type=3"),
        { local_token_list: [] },
        "",
        true,
        timed,
      );
    } catch (e) {
      if (timed.aborted && !signal.aborted) throw new WeixinError("get_bot_qrcode: timed out");
      throw e;
    }
    if (!body.qrcode || !body.qrcode_img_content) throw new WeixinError("get_bot_qrcode: no code in the answer");
    return [body.qrcode, body.qrcode_img_content];
  }

  private async qrStatus(signal: AbortSignal, base: string, qrcode: string, verifyCode: string) {
    let q = "ilink/bot/get_qrcode_status?qrcode=" + encodeURIComponent(qrcode);
    if (verifyCode) q += "&verify_code=" + encodeURIComponent(verifyCode);
    try {
      const s = await this.request(
        QrStatus,
        "get_qrcode_status",
        "GET",
        endpoint(base, q),
        undefined,
        "",
        false,
        AbortSignal.any([signal, AbortSignal.timeout(35_000)]),
      );
      return s.status ? s : { status: "wait" };
    } catch {
      return { status: "wait" };
    }
  }

  /** One QR attempt: redirects, expiry refreshes and verification stay inside WeChat's protocol. */
  async login(signal: AbortSignal, progress: (state: LoginState, url: string) => void, verification: () => string): Promise<LoginAccount> {
    let code: string;
    let show: string;
    try {
      [code, show] = await this.qrCode(signal);
    } catch (e) {
      if (signal.aborted) throw e;
      throw new Error("拿不到登录二维码：" + (e instanceof Error ? e.message : String(e)));
    }
    progress("waiting", show);
    const attempt = AbortSignal.any([signal, AbortSignal.timeout(8 * 60_000)]);
    let base = this.base;
    let refreshes = 0;
    while (!attempt.aborted) {
      const status = await this.qrStatus(attempt, base, code, verification());
      if (attempt.aborted) break;
      switch (status.status) {
        case "scaned":
          progress("scanned", show);
          break;
        case "need_verifycode":
          progress("verify", show);
          await sleep(1_000, attempt);
          break;
        case "scaned_but_redirect":
          if ("redirect_host" in status && status.redirect_host) base = "https://" + status.redirect_host;
          break;
        case "expired":
        case "verify_code_blocked":
          if (++refreshes >= 3) throw new Error(status.status === "expired" ? "二维码过期了几次，请重新开始。" : "数字输错了几次，请重新开始。");
          try {
            [code, show] = await this.qrCode(attempt);
          } catch (e) {
            if (attempt.aborted) break;
            throw new Error("拿不到登录二维码：" + (e instanceof Error ? e.message : String(e)));
          }
          progress("waiting", show);
          break;
        case "binded_redirect":
          throw new Error("这个微信已经连过了：先在微信里删掉它，或者换一个微信扫。");
        case "confirmed": {
          const s = status;
          if (!s.bot_token || !s.ilink_bot_id || !s.ilink_user_id) throw new Error("微信确认了，但没给齐登录信息，请重试。");
          return {
            account: { baseUrl: s.baseurl || base, token: s.bot_token },
            botId: s.ilink_bot_id,
            owner: s.ilink_user_id,
          };
        }
      }
    }
    if (signal.aborted) throw signal.reason ?? new Error("aborted");
    throw new Error("等太久没扫，二维码过期了。");
  }

  async getUpdates(signal: AbortSignal, account: Account, buf: string, timeoutMs: number): Promise<Updates> {
    const poll = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    try {
      return await this.request(
        UpdatesSchema,
        "getupdates",
        "POST",
        endpoint(account.baseUrl, "ilink/bot/getupdates"),
        { get_updates_buf: buf, base_info: baseInfo },
        account.token,
        true,
        poll,
      );
    } catch (e) {
      if (!signal.aborted && poll.aborted) return { ret: 0, get_updates_buf: buf };
      throw e;
    }
  }

  async sendText(signal: AbortSignal, account: Account, to: string, text: string, contextToken: string): Promise<string> {
    const msg: Record<string, unknown> = {
      from_user_id: "",
      to_user_id: to,
      client_id: "vibevalley-" + randomUUID(),
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text } }],
      ...(contextToken ? { context_token: contextToken } : {}),
    };
    const timed = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    let body: typeof Sent.Type;
    try {
      body = await this.request(
        Sent,
        "sendmessage",
        "POST",
        endpoint(account.baseUrl, "ilink/bot/sendmessage"),
        { msg, base_info: baseInfo },
        account.token,
        true,
        timed,
      );
    } catch (e) {
      if (timed.aborted && !signal.aborted) throw new WeixinError("sendmessage: timed out");
      throw e;
    }
    const code = failed(body.ret, body.errcode);
    if (code !== undefined) throw new WeixinError("sendmessage: " + (body.errmsg || String(code)), code);
    return body.message_id ?? "";
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
        part = item.voice_item?.text || "[语音]";
        break;
      case 2:
        part = "[图片]";
        break;
      case 4:
        part = item.file_item?.file_name ? "[文件：" + item.file_item.file_name + "]" : "[文件]";
        break;
      case 5:
        part = "[视频]";
        break;
    }
    if (part) parts.push(part);
  }
  return parts.join("\n").trim();
}

export const quoted = (m: Message) => (m.item_list ?? []).find((i) => i.ref_msg?.svr_id)?.ref_msg?.svr_id ?? "";
