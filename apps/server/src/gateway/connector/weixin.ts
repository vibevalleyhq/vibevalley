import { randomBytes, randomUUID } from "node:crypto";

import { z } from "zod";

import { type Clock, isAbort, systemClock } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";

import { messageOf } from "#/base/errors.ts";
import { numberIn } from "#/base/order.ts";
import type { Logger } from "#/infra/log.ts";

import { type Adapter, AppFailed, appFailure, failedWith, timed } from "./adapter.ts";

/** A confirmed login may name another host for its account. */
export const baseUrl = "https://ilinkai.weixin.qq.com";
const version = "2.4.10";
const staleToken = -14;
const restricted = -2;

export interface Account {
  readonly baseUrl: string;
  readonly token: string;
}

interface Item {
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

const ItemSchema: z.ZodType<Item> = z.object({
  type: z.exactOptional(z.number()),
  text_item: z.exactOptional(z.object({ text: z.exactOptional(z.string()) })),
  voice_item: z.exactOptional(z.object({ text: z.exactOptional(z.string()) })),
  file_item: z.exactOptional(z.object({ file_name: z.exactOptional(z.string()) })),
  ref_msg: z.exactOptional(
    z.object({
      svr_id: z.exactOptional(z.string()),
      title: z.exactOptional(z.string()),
      message_item: z.exactOptional(z.lazy(() => ItemSchema)),
    }),
  ),
});

const MessageSchema = z.object({
  message_id: z.exactOptional(z.string()),
  from_user_id: z.exactOptional(z.string()),
  message_type: z.exactOptional(z.number()),
  context_token: z.exactOptional(z.string()),
  group_id: z.exactOptional(z.string()),
  item_list: z.exactOptional(z.array(ItemSchema)),
});
export type Message = z.output<typeof MessageSchema>;

const UpdatesSchema = z.object({
  ret: z.exactOptional(z.number()),
  errcode: z.exactOptional(z.number()),
  errmsg: z.exactOptional(z.string()),
  msgs: z.exactOptional(z.array(MessageSchema)),
  get_updates_buf: z.exactOptional(z.string()),
  longpolling_timeout_ms: z.exactOptional(z.number()),
});
export type Updates = z.output<typeof UpdatesSchema>;

/** Throws when u is not WeChat's answer. */
export const decodeUpdates = (u: unknown): Updates => UpdatesSchema.parse(u);

const QrCodeResponse = z.object({
  qrcode: z.exactOptional(z.string()),
  qrcode_img_content: z.exactOptional(z.string()),
});
const QrStatusResponse = z.object({
  status: z.exactOptional(z.string()),
  bot_token: z.exactOptional(z.string()),
  ilink_bot_id: z.exactOptional(z.string()),
  baseurl: z.exactOptional(z.string()),
  ilink_user_id: z.exactOptional(z.string()),
  redirect_host: z.exactOptional(z.string()),
});
const SendMessageResponse = z.object({
  ret: z.exactOptional(z.number()),
  errcode: z.exactOptional(z.number()),
  errmsg: z.exactOptional(z.string()),
  message_id: z.exactOptional(z.string()),
});

type LoginState = "waiting" | "scanned" | "verify";

export interface LoginAccount {
  readonly account: Account;
  readonly botId: string;
  readonly user: string;
}

export interface WeixinApi {
  /** One QR attempt: redirects, expiry refreshes and verification stay inside WeChat's protocol. */
  readonly login: (progress: (state: LoginState, url: string) => void, verification: () => string, signal: AbortSignal) => Promise<LoginAccount>;
  /** Nothing within timeout reads as an empty answer. */
  readonly getUpdates: (account: Account, buf: string, timeoutMs: number, signal?: AbortSignal) => Promise<Updates>;
  /** Rides on the context of the user's latest message. */
  readonly sendText: (account: Account, to: string, text: string, contextToken: string) => Promise<string>;
}

const failed = (ret?: number, errcode?: number) => (ret !== undefined && ret !== 0 ? ret : errcode !== undefined && errcode !== 0 ? errcode : undefined);

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
const sendFailure = (code: number, message: string) => new AppFailed(code === staleToken ? "stale" : code === restricted ? "restricted" : "failed", message);

export class WeixinClient implements WeixinApi {
  private readonly fetch: typeof fetch;
  private readonly base: string;
  private readonly clock: Clock;
  private readonly log: Logger | undefined;
  constructor(fetcher: typeof fetch, base: string = baseUrl, clock: Clock = systemClock, log?: Logger) {
    this.fetch = fetcher;
    this.base = base;
    this.clock = clock;
    this.log = log;
  }

  private async request<T>(
    label: string,
    url: string,
    init: RequestInit,
    token: string,
    auth: boolean,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      const res = await this.fetch(url, { ...init, headers: headers(token, auth), ...(signal ? { signal } : {}) });
      const text = await res.text();
      if (res.status < 200 || res.status > 299) throw failedWith(`${label}: ${res.status}`);
      return schema.parse(JSON.parse(text.replace(lossless, '"$1"$2:$3"$4"')));
    } catch (e) {
      throw appFailure(e, signal, (why) => label + ": " + why);
    }
  }

  private post<T>(label: string, url: string, body: unknown, token: string, schema: z.ZodType<T>, signal?: AbortSignal) {
    return this.request(label, url, { method: "POST", body: JSON.stringify(body) }, token, true, schema, signal);
  }

  private async qrCode(signal: AbortSignal) {
    try {
      const body = await timed(
        (s) => this.post("get_bot_qrcode", endpoint(this.base, "ilink/bot/get_bot_qrcode?bot_type=3"), { local_token_list: [] }, "", QrCodeResponse, s),
        15_000,
        this.clock,
        signal,
        () => {
          throw failedWith("get_bot_qrcode: timed out");
        },
      );
      if (!body.qrcode || !body.qrcode_img_content) throw failedWith("get_bot_qrcode: no code in the answer");
      return [body.qrcode, body.qrcode_img_content] as const;
    } catch (e) {
      if (isAbort(e, signal)) throw e;
      throw failedWith(t("server.connector.weixin.noQr", { why: messageOf(e) }));
    }
  }

  /** WeChat's long poll on the code; a poll that fails reads as still waiting, after a breath so it does not spin. */
  private async qrStatus(base: string, qrcode: string, verifyCode: string, signal: AbortSignal): Promise<z.output<typeof QrStatusResponse>> {
    let q = "ilink/bot/get_qrcode_status?qrcode=" + encodeURIComponent(qrcode);
    if (verifyCode) q += "&verify_code=" + encodeURIComponent(verifyCode);
    try {
      const s = await timed(
        (sig) => this.request("get_qrcode_status", endpoint(base, q), { method: "GET" }, "", false, QrStatusResponse, sig),
        35_000,
        this.clock,
        signal,
        () => {
          throw failedWith("get_qrcode_status: timed out");
        },
      );
      return s.status ? s : { status: "wait" };
    } catch (e) {
      if (isAbort(e, signal)) throw e;
      this.log?.debug("weixin qr poll failed", e);
      await this.clock.sleep(2_000, signal);
      return { status: "wait" };
    }
  }

  login(progress: (state: LoginState, url: string) => void, verification: () => string, signal: AbortSignal) {
    return timed(
      async (s) => {
        let [code, show] = await this.qrCode(s);
        progress("waiting", show);
        let base = this.base;
        let refreshes = 0;
        for (;;) {
          const status = await this.qrStatus(base, code, verification(), s);
          switch (status.status) {
            case "scaned":
              progress("scanned", show);
              break;
            case "need_verifycode":
              progress("verify", show);
              await this.clock.sleep(1_000, s);
              break;
            case "scaned_but_redirect":
              if (status.redirect_host) base = "https://" + status.redirect_host;
              break;
            case "expired":
            case "verify_code_blocked":
              if (++refreshes >= 3)
                throw failedWith(status.status === "expired" ? t("server.connector.weixin.qrExpiredTimes") : t("server.connector.weixin.codeWrongTimes"));
              [code, show] = await this.qrCode(s);
              progress("waiting", show);
              break;
            case "binded_redirect":
              throw failedWith(t("server.connector.weixin.taken"));
            case "confirmed": {
              if (!status.bot_token || !status.ilink_bot_id || !status.ilink_user_id) throw failedWith(t("server.connector.weixin.incomplete"));
              return { account: { baseUrl: status.baseurl || base, token: status.bot_token }, botId: status.ilink_bot_id, user: status.ilink_user_id };
            }
            default:
              break;
          }
        }
      },
      8 * 60_000,
      this.clock,
      signal,
      () => {
        throw failedWith(t("server.connector.weixin.tooLong"));
      },
    );
  }

  getUpdates(account: Account, buf: string, timeoutMs: number, signal?: AbortSignal) {
    return timed(
      (s) =>
        this.post(
          "getupdates",
          endpoint(account.baseUrl, "ilink/bot/getupdates"),
          { get_updates_buf: buf, base_info: baseInfo },
          account.token,
          UpdatesSchema,
          s,
        ),
      timeoutMs,
      this.clock,
      signal,
      (): Updates => ({ ret: 0, get_updates_buf: buf }),
    );
  }

  async sendText(account: Account, to: string, text: string, contextToken: string) {
    const msg = {
      from_user_id: "",
      to_user_id: to,
      client_id: "vibevalley-" + randomUUID(),
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text } }],
      ...(contextToken ? { context_token: contextToken } : {}),
    };
    const body = await timed(
      (s) => this.post("sendmessage", endpoint(account.baseUrl, "ilink/bot/sendmessage"), { msg, base_info: baseInfo }, account.token, SendMessageResponse, s),
      15_000,
      this.clock,
      undefined,
      () => {
        throw failedWith("sendmessage: timed out");
      },
    );
    const code = failed(body.ret, body.errcode);
    if (code !== undefined) throw sendFailure(code, "sendmessage: " + (body.errmsg || String(code)));
    return body.message_id ?? "";
  }
}

function text(m: Message): string {
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

const quoted = (m: Message) => (m.item_list ?? []).find((i) => i.ref_msg?.svr_id)?.ref_msg?.svr_id ?? "";

/** The long poll's own length until WeChat says another. */
const weixinPollMs = 35_000;

export function weixinAdapter(api: WeixinApi): Adapter {
  const accountOf = (s: Readonly<Record<string, string>>) => ({ baseUrl: s.baseUrl || baseUrl, token: s.token ?? "" });
  return {
    id: "weixin",
    login: async (_input, progress, verifyCode, signal) => {
      const linked = await api.login((state, url) => progress({ state, qr: url }), verifyCode, signal);
      return {
        secrets: { token: linked.account.token, botId: linked.botId, baseUrl: linked.account.baseUrl },
        user: linked.user,
      };
    },
    receive: async (secrets, io, signal) => {
      const account = accountOf(secrets);
      let buf = io.cursor;
      let timeout = weixinPollMs;
      for (;;) {
        const updates = await api.getUpdates(account, buf, timeout, signal);
        const code = failed(updates.ret, updates.errcode);
        if (code === staleToken) throw new AppFailed("stale", t("server.connector.staleLogin"));
        if (code !== undefined) throw failedWith("getupdates: " + (updates.errmsg || String(code)));
        if (updates.longpolling_timeout_ms != null && updates.longpolling_timeout_ms > 0) timeout = updates.longpolling_timeout_ms;
        // Its own messages echo back; groups are not for the farm.
        const messages = (updates.msgs ?? []).flatMap((m) =>
          m.message_type !== 2 && !m.group_id && m.from_user_id
            ? [{ id: m.message_id ?? "", from: m.from_user_id, text: text(m), reply: m.context_token ?? "", quoted: quoted(m) }]
            : [],
        );
        await io.accept(messages, updates.get_updates_buf ?? "");
        if (updates.get_updates_buf) buf = updates.get_updates_buf;
      }
    },
    send: (secrets, to, body, reply) => api.sendText(accountOf(secrets), to, body, reply),
  };
}
