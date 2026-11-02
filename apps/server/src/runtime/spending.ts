import { Clock, Effect, Fiber, Queue, Semaphore } from "effect";

import { Db } from "@/infra/db.ts";
import { bestEffort } from "@/infra/log.ts";

import * as q from "../../db/generated/runtime_spend.sql.ts";

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
