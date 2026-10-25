// What pi itself is set up with: its default model, the DeepSeek key and address it
// uses, and its DeepSeek balance. pi keeps these in its agent folder; the farm only reads them.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountUsage, RuntimeSettings } from "@vibevalley/protocol";
import { Schema } from "effect";
import { jsonOf } from "../base/json.ts";

/** Past this a read of pi's balance counts as unknown. */
const readTimeoutMs = 10_000;

/** pi's agent folder, as oar's pi runtime finds it. */
export const piAgentDir = () => process.env.OAR_PI_AGENT_DIR || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");

const SettingsFile = Schema.Struct({ defaultProvider: Schema.optionalKey(Schema.String), defaultModel: Schema.optionalKey(Schema.String) });
const AuthFile = Schema.Struct({ deepseek: Schema.optionalKey(Schema.Struct({ key: Schema.optionalKey(Schema.String) })) });
const ModelsFile = Schema.Struct({
  providers: Schema.optionalKey(
    Schema.Struct({ deepseek: Schema.optionalKey(Schema.Struct({ apiKey: Schema.optionalKey(Schema.String), baseUrl: Schema.optionalKey(Schema.String) })) }),
  ),
});
const BalanceResponse = Schema.Struct({
  is_available: Schema.optionalKey(Schema.Boolean),
  balance_infos: Schema.optionalKey(Schema.Array(Schema.Struct({ currency: Schema.String, total_balance: Schema.String }))),
});

function readJson<T>(name: string, schema: Schema.Codec<T>): T | undefined {
  const file = join(piAgentDir(), name);
  if (!existsSync(file)) return undefined;
  try {
    return jsonOf(schema)(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** pi's default provider and model, from its settings.json; "" when it has none. */
export function piSettings(): { provider: string; model: string } {
  const s = readJson("settings.json", SettingsFile);
  return { provider: s?.defaultProvider ?? "", model: s?.defaultModel ?? "" };
}

function piProvider(settings: Pick<RuntimeSettings, "defaultModel">): string {
  const slash = settings.defaultModel.indexOf("/");
  const provider = slash >= 0 ? settings.defaultModel.slice(0, slash).trim() : "";
  return provider || piSettings().provider;
}

const envName = /^\$?\{?([A-Z][A-Z0-9_]*)\}?$/;

/**
 * A value from pi's config as pi reads it: the environment variable it names when one is set (DEEPSEEK_API_KEY,
 * $DEEPSEEK_API_KEY, ${DEEPSEEK_API_KEY}), else itself. pi's `!command` values are not run.
 */
function piValue(value: string): string {
  const m = envName.exec(value);
  return (m && process.env[m[1]!]) || value;
}

/**
 * The DeepSeek key pi uses and where it sends DeepSeek's requests: the key in its auth.json, else DEEPSEEK_API_KEY, else
 * its models.json's providers.deepseek.apiKey; the base URL in models.json, else DeepSeek's own, without a trailing /v1.
 */
export function piDeepseek(): { key: string; base: string } {
  const authKey = readJson("auth.json", AuthFile)?.deepseek?.key;
  let key = authKey ? piValue(authKey) : (process.env.DEEPSEEK_API_KEY ?? "");
  let base = "https://api.deepseek.com";
  const p = readJson("models.json", ModelsFile)?.providers?.deepseek;
  if (!key && p?.apiKey) key = piValue(p.apiKey);
  if (p?.baseUrl) base = p.baseUrl;
  base = base.replace(/\/$/, "").replace(/\/v1$/, "").replace(/\/$/, "");
  return { key, base };
}

export const unavailable = (reason: string): AccountUsage => ({ status: "unavailable", reason });

/** pi's balance at DeepSeek, when its default model is DeepSeek's; no other provider reports one. */
export async function piBalance(settings: Pick<RuntimeSettings, "defaultModel">): Promise<AccountUsage> {
  const provider = piProvider(settings);
  if (provider !== "deepseek") return unavailable(provider ? provider + " 不报余额" : "pi 没有设默认模型");
  const { key, base } = piDeepseek();
  if (!key) return { status: "login_required" };
  let res: Response;
  try {
    res = await fetch(base + "/user/balance", { headers: { authorization: "Bearer " + key }, signal: AbortSignal.timeout(readTimeoutMs) });
  } catch (e) {
    return unavailable(e instanceof Error ? e.message : String(e));
  }
  if (!res.ok) return unavailable(`HTTP ${res.status}`);
  let b: typeof BalanceResponse.Type;
  try {
    b = Schema.decodeUnknownSync(BalanceResponse)(await res.json());
  } catch {
    return unavailable("没读到 DeepSeek 余额");
  }
  return {
    status: "balance",
    provider: "DeepSeek",
    available: b.is_available ?? true,
    balances: (b.balance_infos ?? []).map((x) => ({ currency: x.currency, amount: Number.parseFloat(x.total_balance) || 0 })),
  };
}
