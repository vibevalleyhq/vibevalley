import { homedir } from "node:os";
import { join } from "node:path";

import { Config, Effect, type FileSystem, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { t } from "@vibevalley/i18n";
import type { AccountUsage, RuntimeSettings } from "@vibevalley/protocol";

import { messageOf } from "#/base/errors.ts";
import { numberIn } from "#/base/order.ts";

/** Past this a read of pi's balance counts as unknown. */
const readTimeoutMs = 10_000;

/** An environment variable; "" when it is not set. */
const envVar = (name: string) =>
  Config.String(name).pipe(
    Config.withDefault(""),
    Effect.orElseSucceed(() => ""),
  );

/** pi's agent folder, as oar's pi runtime finds it. */
const piAgentDir = Effect.gen(function* () {
  return (yield* envVar("OAR_PI_AGENT_DIR")) || (yield* envVar("PI_CODING_AGENT_DIR")) || join(homedir(), ".pi", "agent");
});

const SettingsFile = Schema.Struct({
  defaultProvider: Schema.optionalKey(Schema.String),
  defaultModel: Schema.optionalKey(Schema.String),
});
const AuthFile = Schema.Struct({
  deepseek: Schema.optionalKey(Schema.Struct({ key: Schema.optionalKey(Schema.String) })),
});
const ModelsFile = Schema.Struct({
  providers: Schema.optionalKey(
    Schema.Struct({
      deepseek: Schema.optionalKey(
        Schema.Struct({
          apiKey: Schema.optionalKey(Schema.String),
          baseUrl: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  ),
});
const BalanceResponse = Schema.Struct({
  is_available: Schema.optionalKey(Schema.Boolean),
  balance_infos: Schema.optionalKey(Schema.Array(Schema.Struct({ currency: Schema.String, total_balance: Schema.String }))),
});

/** One of pi's own files; none when it is not there or does not read. */
const readJson = <T>(fs: FileSystem.FileSystem, name: string, schema: Schema.Codec<T>): Effect.Effect<T | undefined> =>
  Effect.gen(function* () {
    const dir = yield* piAgentDir;
    const text = yield* fs.readFileString(join(dir, name));
    return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(text);
  }).pipe(Effect.orElseSucceed(() => undefined));

/** pi's default provider and model, from its settings.json; "" when it has none. */
export const piSettings = Effect.fnUntraced(function* (fs: FileSystem.FileSystem) {
  const s = yield* readJson(fs, "settings.json", SettingsFile);
  return { provider: s?.defaultProvider ?? "", model: s?.defaultModel ?? "" } satisfies PiDefault;
});

/** pi's default provider and model, as its settings.json names them. */
export interface PiDefault {
  readonly provider: string;
  readonly model: string;
}

const piProvider = Effect.fnUntraced(function* (fs: FileSystem.FileSystem, settings: Pick<RuntimeSettings, "defaultModel">) {
  const slash = settings.defaultModel.indexOf("/");
  const provider = slash >= 0 ? settings.defaultModel.slice(0, slash).trim() : "";
  return provider || (yield* piSettings(fs)).provider;
});

const envName = /^\$?\{?([A-Z][A-Z0-9_]*)\}?$/u;

/** A value from pi's config as pi reads it. pi's `!command` values are not run. */
const piValue = Effect.fnUntraced(function* (value: string) {
  const m = envName.exec(value);
  return (m?.[1] && (yield* envVar(m[1]))) || value;
});

/** The DeepSeek key pi uses and where it sends DeepSeek's requests. the base URL in models.json, else DeepSeek's own, without a trailing /v1. */
const piDeepseek = Effect.fnUntraced(function* (fs: FileSystem.FileSystem) {
  const authKey = (yield* readJson(fs, "auth.json", AuthFile))?.deepseek?.key;
  let key = authKey ? yield* piValue(authKey) : yield* envVar("DEEPSEEK_API_KEY");
  let base = "https://api.deepseek.com";
  const p = (yield* readJson(fs, "models.json", ModelsFile))?.providers?.deepseek;
  if (!key && p?.apiKey) key = yield* piValue(p.apiKey);
  if (p?.baseUrl) base = p.baseUrl;
  base = base.replace(/\/$/u, "").replace(/\/v1$/u, "").replace(/\/$/u, "");
  return { key, base };
});

const unavailable = (reason: string): AccountUsage => ({ status: "unavailable", reason });

/** pi's balance at DeepSeek, when its default model is DeepSeek's. no other provider reports one. */
export const piBalance = (fs: FileSystem.FileSystem, settings: Pick<RuntimeSettings, "defaultModel">): Effect.Effect<AccountUsage> =>
  Effect.gen(function* () {
    const provider = yield* piProvider(fs, settings);
    if (provider !== "deepseek") return unavailable(provider ? t("server.runtime.piNoBalance", { provider }) : t("server.runtime.piNoModel"));
    const { key, base } = yield* piDeepseek(fs);
    if (!key) return { status: "login_required" } as const;
    const http = yield* HttpClient.HttpClient;
    const res = yield* http.execute(HttpClientRequest.get(base + "/user/balance").pipe(HttpClientRequest.bearerToken(key))).pipe(
      Effect.timeoutOrElse({ duration: readTimeoutMs, orElse: () => Effect.fail(t("server.runtime.piTimedOut")) }),
      Effect.mapError((e) => (typeof e === "string" ? e : messageOf(e))),
    );
    if (res.status < 200 || res.status >= 300) return unavailable(`HTTP ${res.status}`);
    const b = yield* Effect.option(HttpClientResponse.schemaBodyJson(BalanceResponse)(res));
    if (b._tag === "None") return unavailable(t("server.runtime.piUnread"));
    return {
      status: "balance",
      provider: "DeepSeek",
      available: b.value.is_available ?? true,
      balances: (b.value.balance_infos ?? []).map((x) => ({ currency: x.currency, amount: numberIn(x.total_balance) })),
    } satisfies AccountUsage;
  }).pipe(
    Effect.catch((why) => Effect.succeed(unavailable(why))),
    Effect.provide(FetchHttpClient.layer),
  );
