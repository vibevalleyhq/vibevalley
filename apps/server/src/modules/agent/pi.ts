import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { isAbort, withTimeout } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type { AccountUsage, RuntimeSettings } from "@vibevalley/protocol";

import { messageOf } from "#/base/errors.ts";
import { numberIn } from "#/base/order.ts";

/** Past this a read of pi's balance counts as unknown. */
const readTimeoutMs = 10_000;

/** The environment pi reads (process.env; a test gives its own). */
export type PiEnv = Readonly<Record<string, string | undefined>>;

/** An environment variable; "" when it is not set. */
const envVar = (env: PiEnv, name: string) => env[name] ?? "";

/** pi's agent folder, as oar's pi runtime finds it. */
const piAgentDir = (env: PiEnv) => envVar(env, "OAR_PI_AGENT_DIR") || envVar(env, "PI_CODING_AGENT_DIR") || join(homedir(), ".pi", "agent");

const SettingsFile = z.object({
  defaultProvider: z.exactOptional(z.string()),
  defaultModel: z.exactOptional(z.string()),
});
const AuthFile = z.object({
  deepseek: z.exactOptional(z.object({ key: z.exactOptional(z.string()) })),
});
const ModelsFile = z.object({
  providers: z.exactOptional(
    z.object({
      deepseek: z.exactOptional(
        z.object({
          apiKey: z.exactOptional(z.string()),
          baseUrl: z.exactOptional(z.string()),
        }),
      ),
    }),
  ),
});
const BalanceResponse = z.object({
  is_available: z.exactOptional(z.boolean()),
  balance_infos: z.exactOptional(z.array(z.object({ currency: z.string(), total_balance: z.string() }))),
});

/** text as JSON of schema's shape; undefined when it is not. */
const decoded = <A>(schema: z.ZodType<A>, text: string): A | undefined => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Not JSON: read as none, as a file of pi's that does not fit.
    return undefined;
  }
  const got = schema.safeParse(raw);
  return got.success ? got.data : undefined;
};

/** One of pi's own files; none when it is not there or does not read. */
const readJson = async <A>(env: PiEnv, name: string, schema: z.ZodType<A>): Promise<A | undefined> => {
  let text: string;
  try {
    text = await readFile(join(piAgentDir(env), name), "utf8");
  } catch {
    // pi's file not there (or not readable): pi has no word on it either.
    return undefined;
  }
  return decoded(schema, text);
};

/** pi's default provider and model, from its settings.json; "" when it has none. */
export const piSettings = async (env: PiEnv): Promise<PiDefault> => {
  const s = await readJson(env, "settings.json", SettingsFile);
  return { provider: s?.defaultProvider ?? "", model: s?.defaultModel ?? "" };
};

/** pi's default provider and model, as its settings.json names them. */
export interface PiDefault {
  readonly provider: string;
  readonly model: string;
}

const piProvider = async (env: PiEnv, settings: Pick<RuntimeSettings, "defaultModel">) => {
  const slash = settings.defaultModel.indexOf("/");
  const provider = slash >= 0 ? settings.defaultModel.slice(0, slash).trim() : "";
  return provider || (await piSettings(env)).provider;
};

const envName = /^\$?\{?([A-Z][A-Z0-9_]*)\}?$/u;

/** A value from pi's config as pi reads it. pi's `!command` values are not run. */
const piValue = (env: PiEnv, value: string) => {
  const m = envName.exec(value);
  return (m?.[1] && envVar(env, m[1])) || value;
};

/** The DeepSeek key pi uses and where it sends DeepSeek's requests. the base URL in models.json, else DeepSeek's own, without a trailing /v1. */
const piDeepseek = async (env: PiEnv) => {
  const authKey = (await readJson(env, "auth.json", AuthFile))?.deepseek?.key;
  let key = authKey ? piValue(env, authKey) : envVar(env, "DEEPSEEK_API_KEY");
  let base = "https://api.deepseek.com";
  const p = (await readJson(env, "models.json", ModelsFile))?.providers?.deepseek;
  if (!key && p?.apiKey) key = piValue(env, p.apiKey);
  if (p?.baseUrl) base = p.baseUrl;
  base = base.replace(/\/$/u, "").replace(/\/v1$/u, "").replace(/\/$/u, "");
  return { key, base };
};

const unavailable = (reason: string): AccountUsage => ({ status: "unavailable", reason });

/** pi's balance at DeepSeek, when its default model is DeepSeek's. no other provider reports one. fetch: how DeepSeek is
 * reached (the global one, as pi itself would). */
export async function piBalance(
  settings: Pick<RuntimeSettings, "defaultModel">,
  env: PiEnv,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<AccountUsage> {
  const provider = await piProvider(env, settings);
  if (provider !== "deepseek") return unavailable(provider ? t("server.runtime.piNoBalance", { provider }) : t("server.runtime.piNoModel"));
  const { key, base } = await piDeepseek(env);
  if (!key) return { status: "login_required" };
  let text: string;
  let status: number;
  try {
    const res = await withTimeout((s) => fetcher(base + "/user/balance", { headers: { authorization: `Bearer ${key}` }, signal: s }), readTimeoutMs, {
      ...(signal ? { signal } : {}),
    });
    status = res.status;
    text = await res.text();
  } catch (e) {
    if (signal?.aborted === true) throw e;
    return unavailable(isAbort(e) ? t("server.runtime.piTimedOut") : messageOf(e));
  }
  if (status < 200 || status >= 300) return unavailable(`HTTP ${status}`);
  const b = decoded(BalanceResponse, text);
  if (!b) return unavailable(t("server.runtime.piUnread"));
  return {
    status: "balance",
    provider: "DeepSeek",
    available: b.is_available ?? true,
    balances: (b.balance_infos ?? []).map((x) => ({ currency: x.currency, amount: numberIn(x.total_balance) })),
  };
}
