import { getBuiltinModel, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { Clock, Effect, Fiber, Queue, Semaphore } from "effect";

import { getModel } from "@vibevalley/ai/models";

import { Db } from "#/infra/db.ts";
import { bestEffort } from "#/infra/log.ts";
import * as q from "#db/runtime_spend.sql.ts";

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
      return priceOf(getModel("deepseek", model || defaultModel)?.cost);
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
      if (slash >= 0 && model.slice(0, slash) === "deepseek-official") return priceOf(getModel("deepseek", model.slice(slash + 1))?.cost);
      return undefined;
    }
  }
  return undefined;
}

const dayOf = (at: number) => {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

export const spending = Effect.gen(function* () {
  const db = yield* Db;
  const clock = yield* Clock.Clock;
  let day = dayOf(yield* Clock.currentTimeMillis);
  let today: Record<string, number> = Object.fromEntries((yield* db.run(q.spendForDay({ day }))).map((row) => [row.runtime, row.cny]));
  const pending = new Map<string, q.AddSpendParams>();
  const changed = yield* Queue.sliding<void>(1);
  const serial = yield* Semaphore.make(1);
  let closed = false;

  const tally = () => {
    const now = dayOf(clock.currentTimeMillisUnsafe());
    if (now !== day) {
      day = now;
      today = {};
    }
    return today;
  };

  const flush = Effect.gen(function* () {
    if (pending.size === 0) return;
    const batch = [...pending.entries()];
    yield* db.inTx(Effect.forEach(batch, ([, delta]) => db.run(q.addSpend(delta)), { discard: true }));
    for (const [key, delta] of batch) {
      const current = pending.get(key);
      if (!current) continue;
      const remaining = current.cny - delta.cny;
      if (remaining > 0) pending.set(key, { ...current, cny: remaining });
      else pending.delete(key);
    }
  }).pipe(Effect.uninterruptible, serial.withPermits(1));

  const writer = yield* Effect.forkScoped(
    Effect.forever(
      Effect.gen(function* () {
        yield* Queue.take(changed);
        yield* Effect.sleep(1000);
        yield* flush.pipe(bestEffort("runtime: daily spending was not saved"));
        if (!closed && pending.size > 0) Queue.offerUnsafe(changed, undefined);
      }),
    ),
  );
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      closed = true;
      yield* Fiber.interrupt(writer);
      yield* flush.pipe(bestEffort("runtime: final daily spending was not saved"));
    }),
  );

  return {
    tally,
    spend: (runtime: string, cny: number) => {
      if (closed || !Number.isFinite(cny) || cny <= 0) return false;
      tally()[runtime] = (today[runtime] ?? 0) + cny;
      const key = `${day}:${runtime}`;
      const prior = pending.get(key);
      pending.set(key, { day, runtime, cny: (prior?.cny ?? 0) + cny });
      Queue.offerUnsafe(changed, undefined);
      return true;
    },
  };
});
