import * as Lark from "@larksuiteoapi/node-sdk";
import { z } from "zod";

import { type Clock, isAbort, reasonOf, systemClock } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";

import { messageOf } from "#/base/errors.ts";
import { jsonOrNone } from "#/base/json.ts";

import { type Adapter, appFailure, failedOf, failedWith, timed } from "./adapter.ts";

/** A text message's content: {"text": …}. */
const textContent = jsonOrNone(z.object({ text: z.exactOptional(z.string()) }));

type Domain = "feishu" | "lark";

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
  readonly user: string;
}

export interface FeishuApi {
  /** Owns the registration lease, the polling interval and the tenant-domain handoff. */
  readonly login: (progress: (url: string) => void, signal: AbortSignal) => Promise<LoginAccount>;
  /** Until the connection fails or signal aborts; got's success is the SDK's acknowledgement. */
  readonly listen: (app: App, got: (m: Message) => Promise<void>, signal: AbortSignal) => Promise<void>;
  readonly sendText: (app: App, openId: string, text: string) => Promise<string>;
}

/** What the registration endpoint answers; it answers JSON even with an error status (a pending poll is a 400). */
const RegistrationInit = z.object({
  supported_auth_methods: z.exactOptional(z.array(z.string())),
});
const RegistrationBegin = z.object({
  device_code: z.exactOptional(z.string()),
  verification_uri_complete: z.exactOptional(z.string()),
  interval: z.exactOptional(z.number()),
  expires_in: z.exactOptional(z.number()),
  expire_in: z.exactOptional(z.number()),
});
const RegistrationPoll = z.object({
  client_id: z.exactOptional(z.string()),
  client_secret: z.exactOptional(z.string()),
  error: z.exactOptional(z.string()),
  user_info: z.exactOptional(
    z.object({
      tenant_brand: z.exactOptional(z.string()),
      open_id: z.exactOptional(z.string()),
    }),
  ),
});

type Polled =
  | { readonly status: "succeeded"; readonly app: App; readonly user: string }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "pending"; readonly domain: Domain };

export class FeishuClient implements FeishuApi {
  private readonly fetch: typeof fetch;
  private readonly clock: Clock;
  constructor(fetcher: typeof fetch, clock: Clock = systemClock) {
    this.fetch = fetcher;
    this.clock = clock;
  }

  private form<T>(domain: Domain, fields: Record<string, string>, schema: z.ZodType<T>, signal: AbortSignal): Promise<T> {
    return timed(
      async (s) => {
        try {
          const res = await this.fetch(accounts[domain] + "/oauth/v1/app/registration", { method: "POST", body: new URLSearchParams(fields), signal: s });
          return schema.parse(await res.json());
        } catch (e) {
          throw appFailure(e, s, (why) => t("server.connector.feishu.register", { why }));
        }
      },
      10_000,
      this.clock,
      signal,
      () => {
        throw failedWith(t("server.connector.feishu.registerTimeout"));
      },
    );
  }

  private async register(signal: AbortSignal) {
    const init = await this.form("feishu", { action: "init" }, RegistrationInit, signal);
    const methods = init.supported_auth_methods ?? [];
    if (!methods.includes("client_secret")) throw failedWith(t("server.connector.feishu.noQr"));
    const begin = await this.form(
      "feishu",
      { action: "begin", archetype: "PersonalAgent", auth_method: "client_secret", request_user_info: "open_id" },
      RegistrationBegin,
      signal,
    );
    const deviceCode = begin.device_code ?? "";
    let link = begin.verification_uri_complete ?? "";
    if (!deviceCode || !link) throw failedWith(t("server.connector.feishu.noLink"));
    // Personal-agent codes land on /page/cli (as nanobot does it); keep the query as it is.
    if (URL.canParse(link)) {
      const parsed = new URL(link);
      if ((parsed.host === "open.feishu.cn" || parsed.host === "open.larksuite.com") && parsed.pathname === "/page/launcher") {
        parsed.pathname = "/page/cli";
        link = parsed.toString();
      }
    }
    const interval = begin.interval ?? 5;
    const expires = begin.expires_in ?? begin.expire_in ?? 600;
    return { deviceCode, link, intervalMs: Math.max(2, interval) * 1000, expiresMs: expires * 1000 };
  }

  /** One poll; one that does not answer reads as still pending. */
  private async poll(deviceCode: string, domain: Domain, signal: AbortSignal): Promise<Polled> {
    let res: z.output<typeof RegistrationPoll>;
    try {
      res = await this.form(domain, { action: "poll", device_code: deviceCode, tp: "ob_app" }, RegistrationPoll, signal);
    } catch (e) {
      if (isAbort(e, signal)) throw e;
      return { status: "pending", domain };
    }
    const user = res.user_info;
    const where: Domain = user?.tenant_brand === "lark" ? "lark" : domain;
    if (res.client_id !== undefined && res.client_secret !== undefined)
      return { status: "succeeded", app: { appId: res.client_id, appSecret: res.client_secret, domain: where }, user: user?.open_id ?? "" };
    if (res.error === "access_denied") return { status: "failed", reason: t("server.connector.feishu.denied") };
    if (res.error === "expired_token") return { status: "failed", reason: t("server.connector.feishu.qrExpired") };
    return { status: "pending", domain: where };
  }

  async login(progress: (url: string) => void, signal: AbortSignal): Promise<LoginAccount> {
    const reg = await this.register(signal);
    progress(reg.link);
    // Asked every interval, on the domain the last answer named, until it is done one way or the other.
    return timed(
      async (s) => {
        let domain: Domain = "feishu";
        for (;;) {
          await this.clock.sleep(reg.intervalMs, s);
          const p = await this.poll(reg.deviceCode, domain, s);
          if (p.status === "succeeded") {
            if (!p.app.appId.trim() || !p.app.appSecret.trim()) throw failedWith(t("server.connector.feishu.incomplete"));
            return { app: p.app, user: p.user };
          }
          if (p.status === "failed") throw failedWith(p.reason);
          domain = p.domain;
        }
      },
      reg.expiresMs,
      this.clock,
      signal,
      () => {
        throw failedWith(t("server.connector.feishu.tooLong"));
      },
    );
  }

  listen(app: App, got: (m: Message) => Promise<void>, signal: AbortSignal): Promise<void> {
    const { promise, reject } = Promise.withResolvers<void>();
    let settled = false;
    const client = new Lark.WSClient({
      appId: app.appId,
      appSecret: app.appSecret,
      domain: larkDomain(app.domain),
      loggerLevel: Lark.LoggerLevel.warn,
      onError: (e: Error) => end(failedWith(t("server.connector.feishu.disconnected", { why: e.message }))),
    });
    const onAbort = () => end(reasonOf(signal));
    const end = (e: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      client.close({ force: true });
      reject(e);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    const dispatcher = new Lark.EventDispatcher({}).register({
      // The SDK waits on what this returns before it acknowledges the event.
      "im.message.receive_v1": (data) => {
        const from = data.sender.sender_id?.open_id;
        if (!from || data.sender.sender_type !== "user") return Promise.resolve();
        return got({
          messageId: data.message.message_id,
          from,
          chatType: data.message.chat_type,
          messageType: data.message.message_type,
          content: data.message.content,
          parentId: data.message.parent_id ?? "",
        });
      },
    });
    if (!settled)
      client
        .start({ eventDispatcher: dispatcher })
        .catch((e: unknown) => end(failedWith(t("server.connector.feishu.disconnected", { why: failedOf(e).message }))));
    return promise;
  }

  async sendText(app: App, openId: string, text: string): Promise<string> {
    const client = new Lark.Client({ appId: app.appId, appSecret: app.appSecret, domain: larkDomain(app.domain), loggerLevel: Lark.LoggerLevel.warn });
    let res: Awaited<ReturnType<typeof client.im.v1.message.create>>;
    try {
      res = await client.im.v1.message.create({
        params: { receive_id_type: "open_id" },
        data: { receive_id: openId, msg_type: "text", content: JSON.stringify({ text }) },
      });
    } catch (e) {
      throw failedWith(t("server.connector.feishu.send", { why: messageOf(e) }));
    }
    if (res.code !== undefined && res.code !== 0) throw failedWith(t("server.connector.feishu.send", { why: `${res.code} ${res.msg ?? ""}` }));
    if (!res.data?.message_id) throw failedWith(t("server.connector.feishu.noId"));
    return res.data.message_id;
  }
}

function text(m: Message): string {
  if (m.messageType !== "text") {
    const media: Record<string, string> = {
      image: t("server.connector.media.image"),
      file: t("server.connector.media.file"),
      audio: t("server.connector.media.audio"),
      media: t("server.connector.media.video"),
      sticker: t("server.connector.media.sticker"),
    };
    return media[m.messageType] ?? t("server.connector.media.message");
  }
  return (textContent(m.content)?.text ?? "").trim();
}

export function feishuAdapter(api: FeishuApi): Adapter {
  const appOf = (s: Readonly<Record<string, string>>): App => ({
    appId: s.appId ?? "",
    appSecret: s.appSecret ?? "",
    domain: s.domain === "lark" ? "lark" : "feishu",
  });
  return {
    id: "feishu",
    login: async (_input, progress, _verifyCode, signal) => {
      const linked = await api.login((url) => progress({ state: "waiting", qr: url }), signal);
      return {
        secrets: { appId: linked.app.appId, appSecret: linked.app.appSecret, domain: linked.app.domain },
        user: linked.user,
      };
    },
    // The SDK's acknowledgement waits only for the durable inbox write; the orchestrator's work runs elsewhere.
    receive: (secrets, io, signal) =>
      api.listen(
        appOf(secrets),
        async (m) => {
          if (m.chatType === "p2p") await io.accept([{ id: m.messageId, from: m.from, text: text(m), reply: "", quoted: m.parentId }], "");
        },
        signal,
      ),
    send: (secrets, to, body) => api.sendText(appOf(secrets), to, body),
  };
}
