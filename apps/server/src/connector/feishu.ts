import * as Lark from "@larksuiteoapi/node-sdk";
import { Effect, FiberSet, Option, Predicate, Ref, Schema } from "effect";
import { type HttpClient, HttpClientRequest } from "effect/http";

import { t } from "@vibevalley/i18n";

import { Inconsistent } from "#/base/errors.ts";
import { jsonOrNone } from "#/base/json.ts";

import { type Adapter, type AppFailed, failedOf, failedWith } from "./adapter.ts";

/** A text message's content: {"text": …}. */
const textContent = jsonOrNone(Schema.Struct({ text: Schema.optionalKey(Schema.String) }));
const encodeTextContent = Schema.encodeEffect(Schema.fromJsonString(Schema.Struct({ text: Schema.String })));

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
  readonly login: (progress: (url: string) => Effect.Effect<void>) => Effect.Effect<LoginAccount, AppFailed>;
  /** Until the connection fails; got's success is the SDK's acknowledgement. */
  readonly listen: (app: App, got: (m: Message) => Effect.Effect<void, AppFailed>) => Effect.Effect<void, AppFailed>;
  readonly sendText: (app: App, openId: string, text: string) => Effect.Effect<string, AppFailed>;
}

/** What the registration endpoint answers; it answers JSON even with an error status (a pending poll is a 400). */
const RegistrationInit = Schema.Struct({
  supported_auth_methods: Schema.optionalKey(Schema.Array(Schema.String)),
});
const RegistrationBegin = Schema.Struct({
  device_code: Schema.optionalKey(Schema.String),
  verification_uri_complete: Schema.optionalKey(Schema.String),
  interval: Schema.optionalKey(Schema.Finite),
  expires_in: Schema.optionalKey(Schema.Finite),
  expire_in: Schema.optionalKey(Schema.Finite),
});
const RegistrationPoll = Schema.Struct({
  client_id: Schema.optionalKey(Schema.String),
  client_secret: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
  user_info: Schema.optionalKey(
    Schema.Struct({
      tenant_brand: Schema.optionalKey(Schema.String),
      open_id: Schema.optionalKey(Schema.String),
    }),
  ),
});

type Polled =
  | { readonly status: "succeeded"; readonly app: App; readonly user: string }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "pending"; readonly domain: Domain };

export class FeishuClient implements FeishuApi {
  private readonly http: HttpClient.HttpClient;
  constructor(http: HttpClient.HttpClient) {
    this.http = http;
  }

  private form<S extends Schema.Top>(domain: Domain, fields: Record<string, string>, schema: S) {
    const http = this.http;
    return Effect.gen(function* () {
      const res = yield* http.execute(HttpClientRequest.bodyUrlParams(HttpClientRequest.post(accounts[domain] + "/oauth/v1/app/registration"), fields));
      const json = yield* res.json;
      return yield* Schema.decodeEffect(schema)(json);
    }).pipe(
      Effect.timeoutOrElse({ duration: 10_000, orElse: () => Effect.fail(failedWith(t("server.connector.feishu.registerTimeout"))) }),
      Effect.mapError((e) => (Predicate.isTagged(e, "AppFailed") ? e : failedWith(t("server.connector.feishu.register", { why: e.message })))),
    );
  }

  private readonly register = Effect.gen({ self: this }, function* () {
    const init = yield* this.form("feishu", { action: "init" }, RegistrationInit);
    const methods = init.supported_auth_methods ?? [];
    if (!methods.includes("client_secret")) return yield* failedWith(t("server.connector.feishu.noQr"));
    const begin = yield* this.form(
      "feishu",
      { action: "begin", archetype: "PersonalAgent", auth_method: "client_secret", request_user_info: "open_id" },
      RegistrationBegin,
    );
    const deviceCode = begin.device_code ?? "";
    let link = begin.verification_uri_complete ?? "";
    if (!deviceCode || !link) return yield* failedWith(t("server.connector.feishu.noLink"));
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
  });

  /** One poll; one that does not answer reads as still pending. */
  private poll(deviceCode: string, domain: Domain): Effect.Effect<Polled> {
    return this.form(domain, { action: "poll", device_code: deviceCode, tp: "ob_app" }, RegistrationPoll).pipe(
      Effect.map((res) => {
        const user = res.user_info;
        const where: Domain = user?.tenant_brand === "lark" ? "lark" : domain;
        if (res.client_id !== undefined && res.client_secret !== undefined)
          return { status: "succeeded" as const, app: { appId: res.client_id, appSecret: res.client_secret, domain: where }, user: user?.open_id ?? "" };
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
      // Asked every interval, on the domain the last answer named, until it is done one way or the other.
      const domain = yield* Ref.make<Domain>("feishu");
      const once = Effect.gen({ self: this }, function* () {
        const current = yield* Ref.get(domain);
        const p: Polled = yield* this.poll(reg.deviceCode, current);
        if (p.status === "succeeded") {
          if (!p.app.appId.trim() || !p.app.appSecret.trim()) return yield* failedWith(t("server.connector.feishu.incomplete"));
          return Option.some<LoginAccount>({ app: p.app, user: p.user });
        }
        if (p.status === "failed") return yield* failedWith(p.reason);
        yield* Ref.set(domain, p.domain);
        return Option.none<LoginAccount>();
      });
      const polling: Effect.Effect<LoginAccount, AppFailed> = Effect.repeat(Effect.delay(once, reg.intervalMs), { until: Option.isSome }).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.die(Inconsistent.make({ message: "the login poll stopped without an account" })),
            onSome: Effect.succeed,
          }),
        ),
      );
      return yield* polling.pipe(
        Effect.timeoutOrElse({ duration: reg.expiresMs, orElse: () => Effect.fail(failedWith(t("server.connector.feishu.tooLong"))) }),
      );
    });
  }

  listen(app: App, got: (m: Message) => Effect.Effect<void, AppFailed>) {
    return Effect.scoped(
      Effect.gen(function* () {
        // The SDK calls back outside any fiber: each message is taken on this listen's fibers, ended with it.
        const take = yield* FiberSet.makeRuntimePromise();
        return yield* Effect.callback<void, AppFailed>((resume) => {
          const client = new Lark.WSClient({
            appId: app.appId,
            appSecret: app.appSecret,
            domain: larkDomain(app.domain),
            loggerLevel: Lark.LoggerLevel.warn,
            onError: (e: Error) => resume(Effect.fail(failedWith(t("server.connector.feishu.disconnected", { why: e.message })))),
          });
          const dispatcher = new Lark.EventDispatcher({}).register({
            // The SDK waits on what this returns before it acknowledges the event.
            "im.message.receive_v1": (data) => {
              const from = data.sender.sender_id?.open_id;
              if (!from || data.sender.sender_type !== "user") return Promise.resolve();
              return take(
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
      const content = yield* encodeTextContent({ text }).pipe(Effect.mapError((e) => failedWith(t("server.connector.feishu.send", { why: e.message }))));
      const res = yield* Effect.tryPromise({
        try: () =>
          client.im.v1.message.create({
            params: { receive_id_type: "open_id" },
            data: { receive_id: openId, msg_type: "text", content },
          }),
        catch: (e) => failedWith(t("server.connector.feishu.send", { why: failedOf(e).message })),
      });
      if (res.code !== undefined && res.code !== 0) return yield* failedWith(t("server.connector.feishu.send", { why: `${res.code} ${res.msg ?? ""}` }));
      if (!res.data?.message_id) return yield* failedWith(t("server.connector.feishu.noId"));
      return res.data.message_id;
    });
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
    login: (_input, progress) =>
      Effect.map(
        api.login((url) => progress({ state: "waiting", qr: url })),
        (linked) => ({
          secrets: { appId: linked.app.appId, appSecret: linked.app.appSecret, domain: linked.app.domain },
          user: linked.user,
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
