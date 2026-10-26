// Feishu and Lark. Logging in is Feishu's scan-to-create flow: Feishu creates a personal bot app for
// the owner and hands back its app id and secret (the device-code flow nanobot uses: accounts.feishu.cn/oauth/v1/app/
// registration). Messages come over the official SDK's long connection, outbound only; replies go through the message
// API to the owner's open_id, with no reply window.

import * as Lark from "@larksuiteoapi/node-sdk";
import { wallTime } from "../base/time.ts";

export type Domain = "feishu" | "lark";

const accounts: Record<Domain, string> = {
  feishu: "https://accounts.feishu.cn",
  lark: "https://accounts.larksuite.com",
};
const larkDomain = (d: Domain) => (d === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu);

export interface Message {
  readonly messageId: string;
  readonly from: string;
  /** p2p for a direct chat; the farm takes only those. */
  readonly chatType: string;
  readonly messageType: string;
  /** JSON, as Feishu sends it. */
  readonly content: string;
  readonly parentId: string;
}

export interface App {
  readonly appId: string;
  readonly appSecret: string;
  readonly domain: Domain;
}

export interface LoginAccount {
  readonly app: App;
  readonly owner: string;
}

export interface FeishuApi {
  login(signal: AbortSignal, progress: (url: string) => void): Promise<LoginAccount>;
  /** Until the connection fails or signal aborts (then it resolves); got's promise is the SDK's acknowledgement. */
  listen(signal: AbortSignal, app: App, got: (m: Message) => Promise<void>): Promise<void>;
  sendText(signal: AbortSignal, app: App, openId: string, text: string): Promise<string>;
}

/** The endpoint answers JSON even with an error status (a pending poll is a 400). */
async function form(domain: Domain, body: Record<string, string>, signal: AbortSignal): Promise<Record<string, unknown>> {
  const timed = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  try {
    const res = await fetch(accounts[domain] + "/oauth/v1/app/registration", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
      signal: timed,
    });
    return (await res.json()) as Record<string, unknown>;
  } catch (e) {
    if (timed.aborted && !signal.aborted) throw new Error("飞书注册：超时了", { cause: e });
    throw new Error("飞书注册：" + (e instanceof Error ? e.message : String(e)), { cause: e });
  }
}

const str = (m: unknown, key: string) => {
  const v = (m as Record<string, unknown> | undefined)?.[key];
  return typeof v === "string" ? v : "";
};

export class FeishuClient implements FeishuApi {
  private async register(signal: AbortSignal) {
    const init = await form("feishu", { action: "init" }, signal);
    const methods = Array.isArray(init.supported_auth_methods) ? init.supported_auth_methods : [];
    if (!methods.includes("client_secret")) throw new Error("飞书现在不支持扫码建应用，请稍后再试。");
    const begin = await form(
      "feishu",
      {
        action: "begin",
        archetype: "PersonalAgent",
        auth_method: "client_secret",
        request_user_info: "open_id",
      },
      signal,
    );
    const deviceCode = str(begin, "device_code");
    let link = str(begin, "verification_uri_complete");
    if (!deviceCode || !link) throw new Error("飞书没给二维码，请重试。");
    // Personal-agent codes land on /page/cli (as nanobot does it); keep the query as it is.
    try {
      const parsed = new URL(link);
      if ((parsed.host === "open.feishu.cn" || parsed.host === "open.larksuite.com") && parsed.pathname === "/page/launcher") {
        parsed.pathname = "/page/cli";
        link = parsed.toString();
      }
    } catch {
      // Not a URL: shown as it is.
    }
    const interval = typeof begin.interval === "number" ? begin.interval : 5;
    const expires = typeof begin.expires_in === "number" ? begin.expires_in : typeof begin.expire_in === "number" ? begin.expire_in : 600;
    return {
      deviceCode,
      link,
      intervalMs: Math.max(2, interval) * 1000,
      expiresMs: expires * 1000,
    };
  }

  private async poll(deviceCode: string, domain: Domain, signal: AbortSignal) {
    let res: Record<string, unknown>;
    try {
      res = await form(domain, { action: "poll", device_code: deviceCode, tp: "ob_app" }, signal);
    } catch {
      return { status: "pending" as const, domain };
    }
    const user = res.user_info;
    const where: Domain = str(user, "tenant_brand") === "lark" ? "lark" : domain;
    if (typeof res.client_id === "string" && typeof res.client_secret === "string")
      return {
        status: "succeeded" as const,
        app: { appId: res.client_id, appSecret: res.client_secret, domain: where },
        owner: str(user, "open_id"),
      };
    if (res.error === "access_denied") return { status: "failed" as const, reason: "在飞书里拒绝了。" };
    if (res.error === "expired_token") return { status: "failed" as const, reason: "二维码过期了。" };
    return { status: "pending" as const, domain: where };
  }

  /** Owns the registration lease, the polling interval and the tenant-domain handoff. */
  async login(signal: AbortSignal, progress: (url: string) => void): Promise<LoginAccount> {
    const reg = await this.register(signal);
    const attempt = AbortSignal.any([signal, AbortSignal.timeout(reg.expiresMs)]);
    progress(reg.link);
    let domain: Domain = "feishu";
    while (
      await wallTime.sleep(reg.intervalMs, attempt).then(
        () => true,
        () => false,
      )
    ) {
      const p = await this.poll(reg.deviceCode, domain, attempt);
      if (attempt.aborted) break;
      if (p.status === "succeeded") {
        if (!p.app.appId.trim() || !p.app.appSecret.trim()) throw new Error("飞书确认了，但没给齐登录信息，请重试。");
        return { app: p.app, owner: p.owner };
      }
      if (p.status === "failed") throw new Error(p.reason);
      domain = p.domain;
    }
    if (signal.aborted) throw signal.reason ?? new Error("aborted");
    throw new Error("等太久没扫，二维码过期了。");
  }

  listen(signal: AbortSignal, app: App, got: (m: Message) => Promise<void>): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let done = false;
      const abort = () => end();
      const end = (e?: Error) => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", abort);
        client.close({ force: true });
        if (e && !signal.aborted) reject(new Error("飞书长连接断了：" + e.message));
        else resolve();
      };
      const client = new Lark.WSClient({
        appId: app.appId,
        appSecret: app.appSecret,
        domain: larkDomain(app.domain),
        loggerLevel: Lark.LoggerLevel.warn,
        onError: (e: Error) => end(e),
      });
      const dispatcher = new Lark.EventDispatcher({}).register({
        "im.message.receive_v1": async (data) => {
          const from = data.sender.sender_id?.open_id;
          if (!from || data.sender.sender_type !== "user") return;
          await got({
            messageId: data.message.message_id,
            from,
            chatType: data.message.chat_type,
            messageType: data.message.message_type,
            content: data.message.content,
            parentId: data.message.parent_id ?? "",
          });
        },
      });
      if (done) return;
      signal.addEventListener("abort", abort, { once: true });
      void client.start({ eventDispatcher: dispatcher }).catch((e: unknown) => end(e instanceof Error ? e : new Error(String(e))));
    });
  }

  async sendText(_signal: AbortSignal, app: App, openId: string, text: string): Promise<string> {
    const client = new Lark.Client({
      appId: app.appId,
      appSecret: app.appSecret,
      domain: larkDomain(app.domain),
      loggerLevel: Lark.LoggerLevel.warn,
    });
    let res: { code?: number; msg?: string; data?: { message_id?: string } };
    try {
      res = await client.im.v1.message.create({
        params: { receive_id_type: "open_id" },
        data: { receive_id: openId, msg_type: "text", content: JSON.stringify({ text }) },
      });
    } catch (e) {
      throw new Error("飞书发消息：" + (e instanceof Error ? e.message : String(e)), { cause: e });
    }
    if (res.code !== undefined && res.code !== 0) throw new Error(`飞书发消息：${res.code} ${res.msg ?? ""}`);
    if (!res.data?.message_id) throw new Error("飞书发消息：没有确认消息编号");
    return res.data.message_id;
  }
}

export function text(m: Message): string {
  if (m.messageType !== "text")
    return (
      (
        {
          image: "[图片]",
          file: "[文件]",
          audio: "[语音]",
          media: "[视频]",
          sticker: "[表情]",
        } as Record<string, string>
      )[m.messageType] ?? "[消息]"
    );
  try {
    return ((JSON.parse(m.content) as { text?: string }).text ?? "").trim();
  } catch {
    return "";
  }
}
