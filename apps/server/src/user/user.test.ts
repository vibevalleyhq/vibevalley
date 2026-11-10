import { expect, layer } from "@effect/vitest";
import { Array as Arr, Effect, Layer, Option, String as Str } from "effect";
import { TestClock } from "effect/testing";

import { Db } from "#/infra/db.ts";
import { testDatabase } from "#/testing/layers.ts";

import { User } from "./user.ts";

const user = User.layer.pipe(Layer.provideMerge(Db.layer), Layer.provideMerge(testDatabase()));
const day = 24 * 3600_000;

// Built per test: each starts with no devices, on its own TestClock.
layer(user, { buildPerTest: true })("the user's devices", (it) => {
  it.effect("hold keys that say what they are, and lose them after 90 days unused, even before the daily sweep", () =>
    Effect.gen(function* () {
      const u = yield* User;
      const kept = yield* u.pair("在用的手机");
      const left = yield* u.pair("丢了的笔记本");
      expect([Str.startsWith("vvk_")(kept.key), Str.startsWith("vvk_")(left.key)]).toEqual([true, true]);
      yield* TestClock.adjust(89 * day);
      expect(u.byKey(kept.key)?.name).toBe("在用的手机");
      // A day past 90 since it was last seen: refused when used, before any sweep has come round.
      yield* TestClock.adjust(1 * day + 1);
      expect(u.byKey(left.key)).toBeUndefined();
      // Taken back on its own fiber: given a few turns to land.
      for (let turn = 0; turn < 50 && u.devices().length > 1; turn++) yield* Effect.yieldNow;
      expect(Arr.map(u.devices(), (d) => d.name)).toEqual(["在用的手机"]);
      // Seen on day 89, it is swept on the daily round once 90 more pass unused.
      yield* TestClock.adjust(91 * day);
      expect(u.devices()).toEqual([]);
    }),
  );

  it.effect("a sign-in request records who asked, and one asking too often is told to wait longer", () =>
    Effect.gen(function* () {
      const u = yield* User;
      const asked = yield* u.request({ here: false, from: "203.0.113.7" }, "笔记本");
      expect(u.requests()).toMatchObject([{ name: "笔记本", from: "203.0.113.7", code: asked.code }]);
      const first = yield* u.collect(asked.claim);
      // Sooner than asked (RFC 8628's slow_down): five seconds more, from now on.
      const tooSoon = yield* u.collect(asked.claim);
      yield* TestClock.adjust((asked.every + 5) * 1000);
      const waited = yield* u.collect(asked.claim);
      expect([first, tooSoon, waited]).toEqual([{}, { every: asked.every + 5 }, {}]);
      const here = yield* u.request({ here: true }, "这台");
      expect(
        Option.map(
          Arr.findFirst(u.requests(), (r) => r.code === here.code),
          (r) => r.from,
        ),
      ).toEqual(Option.some(""));
    }),
  );
});
