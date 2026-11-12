import { describe, expect, test } from "vite-plus/test";

import { abortError } from "@vibevalley/async";
import { BizCode, type Handlers } from "@vibevalley/protocol/api";

import { bizError } from "#/base/errors.ts";

import { api, requestKeyMax, requestKeys } from "./api.ts";

async function withRoutes(handlers: Partial<Handlers>, body: (handler: (request: Request) => Promise<Response>) => Promise<void>) {
  const routes = api(handlers as Handlers);
  await body(async (request) => routes.fetch(new Request(request, { headers: { host: new URL(request.url).host, ...Object.fromEntries(request.headers) } })));
}

describe("the HTTP contract", () => {
  test("regression: rejects foreign origins and forged device headers before calling a handler", async () => {
    let calls = 0;
    await withRoutes({ "server.health.get": async () => ({ ok: true, version: String(++calls) }) }, async (handler) => {
      await Promise.all(
        [
          { origin: "https://evil.example" },
          { origin: "null" },
          { "sec-fetch-site": "cross-site" },
          { host: "evil.example" },
          { origin: "https://evil.example", "x-vibevalley-lan-device": "fake" },
        ].map(async (headers) => {
          const res = await handler(new Request("http://127.0.0.1/api/v1/server/health/get", { method: "POST", headers }));
          expect([res.status, await res.json()]).toEqual([403, { bizCode: BizCode.Forbidden, message: "forbidden" }]);
        }),
      );
      expect(calls).toBe(0);
    });
  });

  test("encodes success with the endpoint envelope schema and turns an invalid success into a server error envelope", async () => {
    await withRoutes({ "server.health.get": async () => ({ ok: true, version: "test" }) }, async (handler) => {
      const res = await handler(new Request("http://127.0.0.1/api/v1/server/health/get", { method: "POST" }));
      expect([res.status, await res.json()]).toEqual([200, { bizCode: 0, message: "ok", data: { ok: true, version: "test" } }]);
    });
    await withRoutes({ "server.health.get": async () => ({ ok: "yes", version: "test" }) as never }, async (handler) => {
      const res = await handler(new Request("http://127.0.0.1/api/v1/server/health/get", { method: "POST" }));
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({ bizCode: BizCode.InternalError });
    });
  });

  test("does not turn an interrupted handler into a 500 response", async () => {
    await withRoutes({ "server.health.get": () => Promise.reject(abortError()) }, async (handler) => {
      const res = await handler(new Request("http://127.0.0.1/api/v1/server/health/get", { method: "POST" }));
      expect([res.status, await res.text()]).toEqual([503, ""]);
    });
  });

  test("takes the input as the POST's JSON body, refuses one that does not decode with InvalidInput, and routes nothing else", async () => {
    const seen: unknown[] = [];
    await withRoutes(
      {
        "channel.message.list": async (input) => {
          seen.push(input);
          return [];
        },
      },
      async (handler) => {
        const post = (body: string) => handler(new Request("http://127.0.0.1/api/v1/channel/message/list", { method: "POST", body }));
        expect((await post(JSON.stringify({ id: "general", limit: 20 }))).status).toBe(200);
        const wrong = await post(JSON.stringify({ id: "general", limit: "20" }));
        expect([wrong.status, await wrong.json()]).toEqual([400, { bizCode: BizCode.InvalidInput, message: expect.stringContaining("limit") }]);
        expect((await post("{")).status).toBe(400);
        expect((await handler(new Request("http://127.0.0.1/api/v1/channel/message/list"))).status).toBe(404);
      },
    );
    expect(seen).toEqual([{ id: "general", limit: 20 }]);
  });
});

describe("a request key", () => {
  test("does the work once for a repeated key and returns the first result", async () => {
    let runs = 0;
    const once = requestKeys<number>();
    const work = async () => ++runs;
    expect([await once("k", work), await once("k", work), await once("other", work)]).toEqual([1, 1, 2]);
    // No key: every request is its own.
    expect([await once(undefined, work), await once("", work)]).toEqual([3, 4]);
  });

  test("has a duplicate that comes while the first runs wait for it", async () => {
    let runs = 0;
    const gate = Promise.withResolvers<void>();
    const once = requestKeys<number>();
    const work = async () => {
      await gate.promise;
      return ++runs;
    };
    const first = once("k", work);
    const second = once("k", work);
    gate.resolve();
    expect([await first, await second, runs]).toEqual([1, 1, 1]);
  });

  test("finishes the first write when its caller disconnects and serves the result on retry", async () => {
    let runs = 0;
    const gate = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const once = requestKeys<number>();
    const work = async () => {
      await gate.promise;
      runs++;
      finished.resolve();
      return runs;
    };
    // The caller goes away: nobody waits for the first write.
    void once("k", work);
    gate.resolve();
    await finished.promise;
    expect([await once("k", work), runs]).toEqual([1, 1]);
  });

  test("forgets a key whose request failed, so a retry runs again", async () => {
    let runs = 0;
    const once = requestKeys<number>();
    const refusal = bizError(BizCode.Refused, "not now");
    const work = async () => {
      if (++runs === 1) throw refusal;
      return runs;
    };
    const onceFailure = await once("k", work).catch((e: unknown) => e);
    expect(onceFailure).toEqual(refusal);
    expect([await once("k", work), await once("k", work), runs]).toEqual([2, 2, 2]);
  });

  test("refuses a key longer than a sendKey may be", async () => {
    const once = requestKeys<number>();
    const onceFailure = await once("x".repeat(requestKeyMax + 1), async () => 1).catch((e: unknown) => e);
    expect(onceFailure).toMatchObject({ name: "ApiError", bizCode: BizCode.RequestKeyTooLong });
  });
});
