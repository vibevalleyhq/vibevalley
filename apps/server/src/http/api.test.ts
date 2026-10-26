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
    await withRoutes({ "server.health": () => Effect.succeed({ ok: true, version: "test" }) }, async (handler) => {
      const res = await handler(new Request("http://farm/api/v1/health"));
      expect([res.status, await res.json()]).toEqual([200, { ok: true, version: "test" }]);
    });
    await withRoutes({ "server.health": () => Effect.succeed({ ok: "yes", version: "test" } as never) }, async (handler) => {
      const res = await handler(new Request("http://farm/api/v1/health"));
      expect(res.status).toBe(500);
    });
  });

  it("does not turn an interrupted handler into a 500 response", async () => {
    await withRoutes({ "server.health": () => Effect.interrupt }, async (handler) => {
      const res = await handler(new Request("http://farm/api/v1/health"));
      expect([res.status, await res.text()]).toEqual([503, ""]);
    });
  });

  it("does not round or overflow a numeric query into the handler", async () => {
    const seen: { before?: number; limit?: number }[] = [];
    await withRoutes(
      {
        "channel.history": (args: { before?: number; limit?: number }) => {
          seen.push(args);
          return Effect.succeed([]);
        },
      },
      async (handler) => {
        const res = await handler(new Request("http://farm/api/v1/channels/general/messages?before=9007199254740993&limit=20"));
        expect(res.status).toBe(200);
        const huge = await handler(new Request("http://farm/api/v1/channels/general/messages?before=" + "9".repeat(400)));
        expect(huge.status).toBe(200);
      },
    );
    expect(seen).toEqual([
      { id: "general", before: undefined, limit: 20 },
      { id: "general", before: undefined, limit: undefined },
    ]);
  });
});
