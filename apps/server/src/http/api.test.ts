import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { HttpRouter } from "effect/http";

import type { ApiError, Handlers } from "@vibevalley/protocol/api";

import { api, requestKeyMax, requestKeys } from "./api.ts";

async function withRoutes(handlers: Partial<Handlers>, body: (handler: (request: Request) => Promise<Response>) => Promise<void>) {
  const { handler, dispose } = HttpRouter.toWebHandler(api(handlers as Handlers));
  try {
    await body((request) => handler(new Request(request, { headers: { host: new URL(request.url).host, ...Object.fromEntries(request.headers) } })));
  } finally {
    await dispose();
  }
}

describe("the HTTP contract", () => {
  it("regression: rejects foreign origins and forged device headers before calling a handler", async () => {
    let calls = 0;
    await withRoutes({ "server.health.get": () => Effect.sync(() => ({ ok: true, version: String(++calls) })) }, async (handler) => {
      await Promise.all(
        [
          { origin: "https://evil.example" },
          { origin: "null" },
          { "sec-fetch-site": "cross-site" },
          { host: "evil.example" },
          { origin: "https://evil.example", "x-vibevalley-lan-device": "fake" },
        ].map(async (headers) => {
          expect((await handler(new Request("http://127.0.0.1/api/v1/server/health/get", { method: "POST", headers }))).status).toBe(403);
        }),
      );
      expect(calls).toBe(0);
    });
  });

  it("encodes success with the endpoint schema and turns an invalid success into a server error", async () => {
    await withRoutes({ "server.health.get": () => Effect.succeed({ ok: true, version: "test" }) }, async (handler) => {
      const res = await handler(new Request("http://127.0.0.1/api/v1/server/health/get", { method: "POST" }));
      expect([res.status, await res.json()]).toEqual([200, { ok: true, version: "test" }]);
    });
    await withRoutes({ "server.health.get": () => Effect.succeed({ ok: "yes", version: "test" } as never) }, async (handler) => {
      const res = await handler(new Request("http://127.0.0.1/api/v1/server/health/get", { method: "POST" }));
      expect(res.status).toBe(500);
    });
  });

  it("does not turn an interrupted handler into a 500 response", async () => {
    await withRoutes({ "server.health.get": () => Effect.interrupt }, async (handler) => {
      const res = await handler(new Request("http://127.0.0.1/api/v1/server/health/get", { method: "POST" }));
      expect([res.status, await res.text()]).toEqual([503, ""]);
    });
  });

  it("takes the input as the POST's JSON body, refuses one that does not decode, and routes nothing else", async () => {
    const seen: unknown[] = [];
    await withRoutes(
      {
        "channel.message.list": (input) => {
          seen.push(input);
          return Effect.succeed([]);
        },
      },
      async (handler) => {
        const post = (body: string) => handler(new Request("http://127.0.0.1/api/v1/channel/message/list", { method: "POST", body }));
        expect((await post(JSON.stringify({ id: "general", limit: 20 }))).status).toBe(200);
        const wrong = await post(JSON.stringify({ id: "general", limit: "20" }));
        expect([wrong.status, await wrong.text()]).toEqual([400, expect.stringContaining("limit")]);
        expect((await post("{")).status).toBe(400);
        expect((await handler(new Request("http://127.0.0.1/api/v1/channel/message/list"))).status).toBe(404);
      },
    );
    expect(seen).toEqual([{ id: "general", limit: 20 }]);
  });
});

describe("a request key", () => {
  it.effect("does the work once for a repeated key and returns the first result", () =>
    Effect.gen(function* () {
      let runs = 0;
      const once = requestKeys<number>();
      const work = Effect.sync(() => ++runs);
      expect([yield* once("k", work), yield* once("k", work), yield* once("other", work)]).toEqual([1, 1, 2]);
      // No key: every request is its own.
      expect([yield* once(undefined, work), yield* once("", work)]).toEqual([3, 4]);
    }),
  );

  it.effect("has a duplicate that comes while the first runs wait for it", () =>
    Effect.gen(function* () {
      let runs = 0;
      const gate = yield* Deferred.make<void>();
      const once = requestKeys<number>();
      const work = Effect.andThen(
        Deferred.await(gate),
        Effect.sync(() => ++runs),
      );
      const first = yield* Effect.forkChild(once("k", work));
      const second = yield* Effect.forkChild(once("k", work));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, undefined);
      expect([yield* Fiber.join(first), yield* Fiber.join(second), runs]).toEqual([1, 1, 1]);
    }),
  );

  it.effect("forgets a key whose request failed, so a retry runs again", () =>
    Effect.gen(function* () {
      let runs = 0;
      const once = requestKeys<number>();
      const refusal: ApiError = { _tag: "Refused", reason: "not now" };
      const work = Effect.suspend(() => (++runs === 1 ? Effect.fail(refusal) : Effect.succeed(runs)));
      expect(yield* Effect.flip(once("k", work))).toEqual(refusal);
      expect([yield* once("k", work), yield* once("k", work), runs]).toEqual([2, 2, 2]);
    }),
  );

  it.effect("refuses a key longer than a sendKey may be", () =>
    Effect.gen(function* () {
      const once = requestKeys<number>();
      expect(yield* Effect.flip(once("x".repeat(requestKeyMax + 1), Effect.succeed(1)))).toMatchObject({ _tag: "Refused" });
    }),
  );
});
