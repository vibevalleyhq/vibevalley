import { setImmediate } from "node:timers/promises";

import { describe, expect, test } from "vite-plus/test";

import { abortError } from "@vibevalley/async";

import { keptLog } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import { testDb } from "#/testing/layers.ts";

import { makeUser } from "./user.ts";

const day = 24 * 3600_000;

/** A clock that moves only when the test says, from 0; each wait it passes ends in order, and what it woke gets a few turns. */
function heldTime() {
  let at = 0;
  const waits = new Set<{ readonly until: number; readonly wake: () => void }>();
  const time: Time = {
    now: () => at,
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        const wait = { until: at + Math.max(0, ms), wake: resolve };
        waits.add(wait);
        signal?.addEventListener(
          "abort",
          () => {
            waits.delete(wait);
            reject(signal.reason ?? abortError("stopped"));
          },
          { once: true },
        );
      }),
    after: () => () => undefined,
  };
  const turns = async (n: number) => {
    for (let turn = 0; turn < n; turn++) await setImmediate();
  };
  const adjust = async (ms: number) => {
    const target = at + ms;
    for (;;) {
      const next = [...waits].filter((w) => w.until <= target).toSorted((a, b) => a.until - b.until)[0];
      if (next === undefined) break;
      waits.delete(next);
      at = next.until;
      next.wake();
      await turns(2);
    }
    at = target;
    await turns(20);
  };
  return { time, adjust };
}

/** A user over a fresh database, each test with no devices on its own clock. */
const aUser = async () => {
  const db = await testDb();
  const clock = heldTime();
  const user = await makeUser({ db, clock: clock.time, log: keptLog() });
  return {
    user,
    adjust: clock.adjust,
    [Symbol.asyncDispose]: async () => {
      await user.close();
      await db.close();
    },
  };
};

describe("the user's devices", () => {
  test("hold keys that say what they are, and lose them after 90 days unused, even before the daily sweep", async () => {
    await using farm = await aUser();
    const u = farm.user;
    const kept = await u.pair("在用的手机");
    const left = await u.pair("丢了的笔记本");
    expect([kept.key.startsWith("vvk_"), left.key.startsWith("vvk_")]).toEqual([true, true]);
    await farm.adjust(89 * day);
    expect(u.byKey(kept.key)?.name).toBe("在用的手机");
    // A day past 90 since it was last seen: refused when used, before any sweep has come round.
    await farm.adjust(1 * day + 1);
    expect(u.byKey(left.key)).toBeUndefined();
    // Taken back in the background: given a few turns to land.
    for (let turn = 0; turn < 50 && u.devices().length > 1; turn++) await setImmediate();
    expect(u.devices().map((d) => d.name)).toEqual(["在用的手机"]);
    // Seen on day 89, it is swept on the daily round once 90 more pass unused.
    await farm.adjust(91 * day);
    expect(u.devices()).toEqual([]);
  });

  test("a sign-in request records who asked, and one asking too often is told to wait longer", async () => {
    await using farm = await aUser();
    const u = farm.user;
    const asked = await u.request({ here: false, from: "203.0.113.7" }, "笔记本");
    expect(u.requests()).toMatchObject([{ name: "笔记本", from: "203.0.113.7", code: asked.code }]);
    const first = await u.collect(asked.claim);
    // Sooner than asked (RFC 8628's slow_down): five seconds more, from now on.
    const tooSoon = await u.collect(asked.claim);
    await farm.adjust((asked.every + 5) * 1000);
    const waited = await u.collect(asked.claim);
    expect([first, tooSoon, waited]).toEqual([{}, { every: asked.every + 5 }, {}]);
    const here = await u.request({ here: true }, "这台");
    expect(u.requests().find((r) => r.code === here.code)?.from).toEqual("");
  });
});
