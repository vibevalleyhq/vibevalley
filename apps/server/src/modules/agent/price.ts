import { getBuiltinModel, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";

import { type Clock, Queue, Semaphore, TaskGroup } from "@vibevalley/async";

import type { Db } from "#/infra/db.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import { localParts } from "#/infra/time.ts";
import * as q from "#db/agent_spend.sql.ts";

import type { PiDefault } from "./pi.ts";

interface Price {
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

/** DeepSeek's own models, in dollars per million tokens: what the farm charges a run of them at, whatever a catalog says. */
const deepseekPrices: ReadonlyMap<string, Price> = new Map([
  ["deepseek-flash", { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 }],
  ["deepseek-v4-pro", { input: 1.74, output: 3.48, cacheRead: 0.145, cacheWrite: 0 }],
]);

const vibevalleyRuntime = "vibevalley";
/** VibeValley's agent's model when the profile names none. */
const defaultModel = "deepseek-flash";

const priceOf = (cost: Price | undefined): Price | undefined =>
  cost
    ? {
        input: cost.input,
        output: cost.output,
        cacheRead: cost.cacheRead,
        cacheWrite: cost.cacheWrite,
      }
    : undefined;

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- pi-ai types the lookup by its generated catalog; our names are strings, and an unknown one gives undefined
const builtinCost = getBuiltinModel as unknown as (provider: string, model: string) => { readonly cost: Price } | undefined;

function piPrice(model: string): Price | undefined {
  const slash = model.indexOf("/");
  if (slash >= 0) return priceOf(builtinCost(model.slice(0, slash), model.slice(slash + 1))?.cost);
  for (const provider of [...getBuiltinProviders()].filter(Boolean).toSorted()) {
    const found = builtinCost(provider, model);
    if (found !== undefined) return priceOf(found.cost);
  }
  return undefined;
}

/** pi: its settings.json's default, for a model left to it. */
export function price(runtime: string, model: string, pi: PiDefault): Price | undefined {
  switch (runtime) {
    case vibevalleyRuntime:
      return deepseekPrices.get(model || defaultModel);
    case "pi": {
      if (!model) {
        if (!pi.provider || !pi.model) return undefined;
        model = pi.provider + "/" + pi.model;
      }
      return piPrice(model);
    }
    case "dsh": {
      // dsh names a model provider/model. only DeepSeek's own is priced here.
      const slash = model.indexOf("/");
      if (slash >= 0 && model.slice(0, slash) === "deepseek-official") return deepseekPrices.get(model.slice(slash + 1));
      return undefined;
    }
  }
  return undefined;
}

const dayOf = (at: number) => {
  const date = localParts(at);
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
};

/** Today's spending per runtime, kept in memory and written a second after it changes; close writes what is left. */
export interface Spending {
  readonly tally: () => Record<string, number>;
  /** False once closed, or for an amount that is not a positive number. */
  readonly spend: (runtime: string, cny: number) => boolean;
  readonly close: () => Promise<void>;
}

export async function makeSpending(deps: { readonly db: Db; readonly clock: Clock; readonly log: Logger }): Promise<Spending> {
  const { db, clock, log } = deps;
  let day = dayOf(clock.now());
  let today: Record<string, number> = Object.fromEntries((await q.spendForDay(db.sql, { day })).map((row) => [row.runtime, row.cny]));
  const pending = new Map<string, q.AddSpendParams>();
  const changed = new Queue<void>({ capacity: 1, overflow: "sliding" });
  const serial = new Semaphore(1);
  let closed = false;

  const tally = () => {
    const now = dayOf(clock.now());
    if (now !== day) {
      day = now;
      today = {};
    }
    return today;
  };

  // Takes no signal: a flush once started is not cut short, so a delta is never half written.
  const flush = () =>
    serial.with(async () => {
      if (pending.size === 0) return;
      const batch = [...pending.entries()];
      await db.tx(async () => {
        for (const [, delta] of batch) await q.addSpend(db.sql, delta);
      });
      for (const [key, delta] of batch) {
        const current = pending.get(key);
        if (!current) continue;
        const remaining = current.cny - delta.cny;
        if (remaining > 0) pending.set(key, { ...current, cny: remaining });
        else pending.delete(key);
      }
    });

  const tasks = new TaskGroup({ name: "runtime spending", onError: (task, e) => log.error(`${task} failed`, e) });
  // When the write waiting is due: a second after the change that asked for it, counted from that change.
  let dueAt: number | undefined;
  const changedNow = () => {
    dueAt ??= clock.now() + 1000;
    changed.offer();
  };
  tasks.run("spending writer", async (signal) => {
    for (;;) {
      await changed.take(signal);
      await clock.sleep(Math.max(0, (dueAt ?? clock.now()) - clock.now()), signal);
      dueAt = undefined;
      await bestEffort(log, "runtime: daily spending was not saved", flush);
      if (!closed && pending.size > 0) changedNow();
    }
  });

  return {
    tally,
    spend: (runtime, cny) => {
      if (closed || !Number.isFinite(cny) || cny <= 0) return false;
      tally()[runtime] = (today[runtime] ?? 0) + cny;
      const key = `${day}:${runtime}`;
      const prior = pending.get(key);
      pending.set(key, { day, runtime, cny: (prior?.cny ?? 0) + cny });
      changedNow();
      return true;
    },
    close: async () => {
      closed = true;
      await tasks.close();
      await bestEffort(log, "runtime: final daily spending was not saved", flush);
    },
  };
}
