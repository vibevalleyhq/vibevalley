import type { Handlers } from "@vibevalley/protocol/api";
import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { HttpRouter } from "effect/http";
import { api } from "./api.ts";

async function withRoutes(handlers: Partial<Handlers>, body: (handler: (request: Request) => Promise<Response>) => Promise<void>) {
  const { handler, dispose } = HttpRouter.toWebHandler(api(handlers as Handlers));
  try {
    await body(handler);
  } finally {
    await dispose();
  }
}

describe("the HTTP contract", () => {
  it("encodes success with the endpoint schema and turns an invalid success into a server error", async () => {
    await withRoutes({ "server.health.get": () => Effect.succeed({ ok: true, version: "test" }) }, async (handler) => {
      const res = await handler(new Request("http://farm/api/v1/server/health/get", { method: "POST" }));
      expect([res.status, await res.json()]).toEqual([200, { ok: true, version: "test" }]);
    });
    await withRoutes({ "server.health.get": () => Effect.succeed({ ok: "yes", version: "test" } as never) }, async (handler) => {
      const res = await handler(new Request("http://farm/api/v1/server/health/get", { method: "POST" }));
      expect(res.status).toBe(500);
    });
  });

  it("does not turn an interrupted handler into a 500 response", async () => {
    await withRoutes({ "server.health.get": () => Effect.interrupt }, async (handler) => {
      const res = await handler(new Request("http://farm/api/v1/server/health/get", { method: "POST" }));
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
        const post = (body: string) => handler(new Request("http://farm/api/v1/channel/message/list", { method: "POST", body }));
        expect((await post(JSON.stringify({ id: "general", limit: 20 }))).status).toBe(200);
        const wrong = await post(JSON.stringify({ id: "general", limit: "20" }));
        expect([wrong.status, await wrong.text()]).toEqual([400, expect.stringContaining("limit")]);
        expect((await post("{")).status).toBe(400);
        expect((await handler(new Request("http://farm/api/v1/channel/message/list"))).status).toBe(404);
      },
    );
    expect(seen).toEqual([{ id: "general", limit: 20 }]);
  });
});
