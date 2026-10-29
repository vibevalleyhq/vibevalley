import { t } from "@vibevalley/i18n";
// Feishu and Lark. Logging in is Feishu's scan-to-create flow: Feishu creates a personal bot app for
// the owner and hands back its app id and secret (the device-code flow nanobot uses: accounts.feishu.cn/oauth/v1/app/
// registration). Messages come over the official SDK's long connection, outbound only; replies go through the message
// API to the owner's open_id, with no reply window.

import { Effect, FiberSet, Predicate, Schema } from "effect";
import { type HttpClient, HttpClientRequest } from "effect/http";
import { jsonOrNone } from "../base/json.ts";
import * as Lark from "@larksuiteoapi/node-sdk";
import { type Adapter, AppFailed, failedOf, failedWith } from "./adapter.ts";

/** A text message's content: {"text": …}. */
const textContent = jsonOrNone(Schema.Struct({ text: Schema.optionalKey(Schema.String) }));

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
  /** Owns the registration lease, the polling interval and the tenant-domain handoff. */
  readonly login: (progress: (url: string) => Effect.Effect<void>) => Effect.Effect<LoginAccount, AppFailed>;
  /** Until the connection fails; got's success is the SDK's acknowledgement. */
  readonly listen: (app: App, got: (m: Message) => Effect.Effect<void, AppFailed>) => Effect.Effect<void, AppFailed>;
  readonly sendText: (app: App, openId: string, text: string) => Effect.Effect<string, AppFailed>;
}

/** What the registration endpoint answers; it answers JSON even with an error status (a pending poll is a 400). */
const Registration = Schema.Record(Schema.String, Schema.Unknown);

const str = (m: unknown, key: string) => {
  const v = Predicate.isObject(m) ? m[key] : undefined;
  return typeof v === "string" ? v : "";
};

type Polled =
  | { readonly status: "succeeded"; readonly app: App; readonly owner: string }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "pending"; readonly domain: Domain };

export class FeishuClient implements FeishuApi {
  constructor(private readonly http: HttpClient.HttpClient) {}

  private form(domain: Domain, fields: Record<string, string>) {
    return this.http.execute(HttpClientRequest.bodyUrlParams(HttpClientRequest.post(accounts[domain] + "/oauth/v1/app/registration"), fields)).pipe(
      Effect.flatMap((res) => res.json),
      Effect.flatMap(Schema.decodeUnknownEffect(Registration)),
      Effect.timeoutOrElse({ duration: 10_000, orElse: () => Effect.fail(failedWith(t("server.connector.feishu.registerTimeout"))) }),
      Effect.mapError((e) => (e instanceof AppFailed ? e : failedWith(t("server.connector.feishu.register", { why: e.message })))),
    );
  }

  private readonly register = Effect.gen({ self: this }, function* () {
    const init = yield* this.form("feishu", { action: "init" });
    const methods = Array.isArray(init.supported_auth_methods) ? init.supported_auth_methods : [];
    if (!methods.includes("client_secret")) return yield* failedWith(t("server.connector.feishu.noQr"));
    const begin = yield* this.form("feishu", { action: "begin", archetype: "PersonalAgent", auth_method: "client_secret", request_user_info: "open_id" });
    const deviceCode = str(begin, "device_code");
    let link = str(begin, "verification_uri_complete");
    if (!deviceCode || !link) return yield* failedWith(t("server.connector.feishu.noLink"));
    // Personal-agent codes land on /page/cli (as nanobot does it); keep the query as it is.
    if (URL.canParse(link)) {
      const parsed = new URL(link);
      if ((parsed.host === "open.feishu.cn" || parsed.host === "open.larksuite.com") && parsed.pathname === "/page/launcher") {
        parsed.pathname = "/page/cli";
        link = parsed.toString();
      }
    }
    const interval = typeof begin.interval === "number" ? begin.interval : 5;
    const expires = typeof begin.expires_in === "number" ? begin.expires_in : typeof begin.expire_in === "number" ? begin.expire_in : 600;
    return { deviceCode, link, intervalMs: Math.max(2, interval) * 1000, expiresMs: expires * 1000 };
  });

  /** One poll; one that does not answer reads as still pending. */
  private poll(deviceCode: string, domain: Domain): Effect.Effect<Polled> {
    return this.form(domain, { action: "poll", device_code: deviceCode, tp: "ob_app" }).pipe(
      Effect.map((res) => {
        const user = res.user_info;
        const where: Domain = str(user, "tenant_brand") === "lark" ? "lark" : domain;
        if (typeof res.client_id === "string" && typeof res.client_secret === "string")
          return { status: "succeeded" as const, app: { appId: res.client_id, appSecret: res.client_secret, domain: where }, owner: str(user, "open_id") };
        if (res.error === "access_denied") return { status: "failed" as const, reason: t("server.connector.feishu.denied") };
        if (res.error === "expired_token") return { status: "failed" as const, reason: t("server.connector.feishu.qrExpired") };
        return { status: "pending" as const, domain: where };
      }),
      Effect.orElseSucceed(() => ({ status: "pending" as const, domain })),
    );
  }

  login(progress: (url: string) => Effect.Effect<void>) {
    return Effect.gen({ self: this }, function* () {
      const reg = yield* this.register;
      yield* progress(reg.link);
      const polling: Effect.Effect<LoginAccount, AppFailed> = Effect.gen({ self: this }, function* () {
        let domain: Domain = "feishu";
        for (;;) {
          yield* Effect.sleep(reg.intervalMs);
          const p: Polled = yield* this.poll(reg.deviceCode, domain);
          if (p.status === "succeeded") {
            if (!p.app.appId.trim() || !p.app.appSecret.trim()) return yield* failedWith(t("server.connector.feishu.incomplete"));
            return { app: p.app, owner: p.owner };
          }
          if (p.status === "failed") return yield* failedWith(p.reason);
          domain = p.domain;
        }
      });
      return yield* polling.pipe(
        Effect.timeoutOrElse({ duration: reg.expiresMs, orElse: () => Effect.fail(failedWith(t("server.connector.feishu.tooLong"))) }),
      );
    });
  }

  listen(app: App, got: (m: Message) => Effect.Effect<void, AppFailed>) {
    return Effect.scoped(
      Effect.gen(function* () {
        // The SDK calls back outside any fiber: each message is taken on this listen's fibers, ended with it.
        const take = yield* FiberSet.makeRuntimePromise<never>();
        return yield* Effect.callback<void, AppFailed>((resume) => {
          const client = new Lark.WSClient({
            appId: app.appId,
            appSecret: app.appSecret,
            domain: larkDomain(app.domain),
            loggerLevel: Lark.LoggerLevel.warn,
            onError: (e: Error) => resume(Effect.fail(failedWith(t("server.connector.feishu.disconnected", { why: e.message })))),
          });
          const dispatcher = new Lark.EventDispatcher({}).register({
            "im.message.receive_v1": async (data) => {
              const from = data.sender.sender_id?.open_id;
              if (!from || data.sender.sender_type !== "user") return;
              await take(
                got({
                  messageId: data.message.message_id,
                  from,
                  chatType: data.message.chat_type,
                  messageType: data.message.message_type,
                  content: data.message.content,
                  parentId: data.message.parent_id ?? "",
                }),
              );
            },
          });
          client
            .start({ eventDispatcher: dispatcher })
            .catch((e: unknown) => resume(Effect.fail(failedWith(t("server.connector.feishu.disconnected", { why: failedOf(e).message })))));
          return Effect.sync(() => client.close({ force: true }));
        });
      }),
    );
  }

  sendText(app: App, openId: string, text: string) {
    return Effect.gen(function* () {
      const client = new Lark.Client({ appId: app.appId, appSecret: app.appSecret, domain: larkDomain(app.domain), loggerLevel: Lark.LoggerLevel.warn });
      const res = yield* Effect.tryPromise({
        try: () =>
          client.im.v1.message.create({
            params: { receive_id_type: "open_id" },
            data: { receive_id: openId, msg_type: "text", content: JSON.stringify({ text }) },
          }),
        catch: (e) => failedWith(t("server.connector.feishu.send", { why: failedOf(e).message })),
      });
      if (res.code !== undefined && res.code !== 0) return yield* failedWith(t("server.connector.feishu.send", { why: `${res.code} ${res.msg ?? ""}` }));
      if (!res.data?.message_id) return yield* failedWith(t("server.connector.feishu.noId"));
      return res.data.message_id;
    });
  }
}

export function text(m: Message): string {
  if (m.messageType !== "text")
    return (
      (
        {
          image: t("server.connector.media.image"),
          file: t("server.connector.media.file"),
          audio: t("server.connector.media.audio"),
          media: t("server.connector.media.video"),
          sticker: t("server.connector.media.sticker"),
        } as Record<string, string>
      )[m.messageType] ?? t("server.connector.media.message")
    );
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
    login: (_input, progress) =>
      Effect.map(
        api.login((url) => progress({ state: "waiting", qr: url })),
        (linked) => ({
          secrets: { appId: linked.app.appId, appSecret: linked.app.appSecret, domain: linked.app.domain },
          owner: linked.owner,
        }),
      ),
    // The SDK's acknowledgement waits only for the durable inbox write; the orchestrator's work runs elsewhere.
    receive: (secrets, io) =>
      api.listen(appOf(secrets), (m) =>
        m.chatType === "p2p" ? io.accept([{ id: m.messageId, from: m.from, text: text(m), reply: "", quoted: m.parentId }], "") : Effect.void,
      ),
    send: (secrets, to, body) => api.sendText(appOf(secrets), to, body),
  };
}
