// What a run costs: a model's price per million tokens, in dollars, charged in the
// farm's yuan. VibeValley's own agent and DeepSeek Harness are priced by the farm's models (ai/models.ts); pi by pi-ai's
// built-in list, which is pi's own. No other runtime is priced.

import { getBuiltinModel, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { getModel } from "@vibevalley/ai/models";
import { piSettings } from "./pi.ts";

export interface Price {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** The tokens a run used; cache tokens are included in input. */
export interface Tokens {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

/** A price in the farm's currency. */
export interface Rate {
  readonly charge: (tokens: Tokens) => number;
}

export const inCny = (p: Price, cnyPerUsd: number): Rate => ({
  charge: (t) => {
    const read = t.cacheRead ?? 0;
    const write = t.cacheWrite ?? 0;
    return ((Math.max(0, t.input - read - write) * p.input + t.output * p.output + read * p.cacheRead + write * p.cacheWrite) / 1_000_000) * cnyPerUsd;
  },
});

export const vibevalleyRuntime = "vibevalley";
/** VibeValley's agent's model when the profile names none. */
export const defaultModel = "deepseek-flash";

const priceOf = (cost: Price | undefined): Price | undefined =>
  cost
    ? {
        input: cost.input,
        output: cost.output,
        cacheRead: cost.cacheRead,
        cacheWrite: cost.cacheWrite,
      }
    : undefined;

// pi-ai types the lookup by its generated catalog; any name we hold is a string, and an unknown one gives undefined.
const builtinCost = getBuiltinModel as unknown as (provider: string, model: string) => { readonly cost: Price } | undefined;

function piPrice(model: string): Price | undefined {
  const slash = model.indexOf("/");
  if (slash >= 0) return priceOf(builtinCost(model.slice(0, slash), model.slice(slash + 1))?.cost);
  for (const provider of [...getBuiltinProviders()].map((p) => (typeof p === "string" ? p : (p as { id: string }).id)).sort()) {
    const found = builtinCost(provider, model);
    if (found !== undefined) return priceOf(found.cost);
  }
  return undefined;
}

export function price(runtime: string, model: string): Price | undefined {
  switch (runtime) {
    case vibevalleyRuntime:
      return priceOf(getModel("deepseek", model || defaultModel)?.cost);
    case "pi": {
      if (!model) {
        const s = piSettings();
        if (!s.provider || !s.model) return undefined;
        model = s.provider + "/" + s.model;
      }
      return piPrice(model);
    }
    case "dsh": {
      // dsh names a model provider/model; only DeepSeek's own is priced here. The retired name it still lists,
      // deepseek-v4-flash, is folded into deepseek-flash by the dsh adapter before a session names it.
      const slash = model.indexOf("/");
      if (slash >= 0 && model.slice(0, slash) === "deepseek-official") return priceOf(getModel("deepseek", model.slice(slash + 1))?.cost);
      return undefined;
    }
  }
  return undefined;
}
