import { Effect, Layer, Stream } from "effect";
import { HttpRouter } from "effect/http";
import { describe, expect, it } from "vite-plus/test";

import type { LiveEvent, SideEvent, StateFrame } from "@vibevalley/protocol";

import { Core } from "@/core/core.ts";
import { ServerConfig } from "@/infra/config.ts";
import { layer as projection } from "@/projection/projection.ts";
import { testConfig } from "@/testing/layers.ts";

import { streams } from "./streams.ts";

const appFor = (change: (core: Core["Service"]) => Core["Service"]) => {
  const base = Core.layer.pipe(Layer.provide(projection), Layer.provide(Layer.succeed(ServerConfig, testConfig())));
  const custom = Layer.unwrap(Effect.map(Core, (core) => Layer.succeed(Core, Core.of(change(core))))).pipe(Layer.provide(base));
  return streams.pipe(Layer.provide(custom));
};

async function withRoutes(change: (core: Core["Service"]) => Core["Service"], body: (handler: (request: Request) => Promise<Response>) => Promise<void>) {
  const { handler, dispose } = HttpRouter.toWebHandler(appFor(change));
  try {
    await body(handler);
  } finally {
    await dispose();
  }
}

const firstChunk = async (res: Response) => {
  const reader = res.body!.getReader();
  const first = await reader.read();
  if (first.done === true || first.value === undefined) throw new Error("the stream had no first frame");
  const text = new TextDecoder().decode(first.value);
  await reader.cancel();
  return text;
};

describe("the SSE contract", () => {
  it("encodes a real StateFrame", async () => {
    await withRoutes(
      (core) => core,
      async (handler) => {
        const res = await handler(new Request("http://farm/api/v1/state"));
        expect(res.status).toBe(200);
        const text = await firstChunk(res);
        expect(text.startsWith("data: ")).toBe(true);
        expect(JSON.parse(text.trim().slice(6)).state.call).toBe("idle");
      },
    );
  });

  it("ends the stream on an invalid StateFrame", async () => {
    await withRoutes(
      (core) => ({ ...core, states: Stream.succeed({} as StateFrame) }),
      async (handler) => {
        const res = await handler(new Request("http://farm/api/v1/state"));
        expect(res.status).toBe(200);
        await expect(res.text()).rejects.toThrow();
      },
    );
  });

  it("ends the stream on an invalid SideEvent", async () => {
    const bad = { type: "notice", at: 0, level: "info", text: 42 } as unknown as SideEvent;
    await withRoutes(
      (core) => ({ ...core, events: Stream.succeed(bad) }),
      async (handler) => {
        const res = await handler(new Request("http://farm/api/v1/events"));
        await expect(res.text()).rejects.toThrow();
      },
    );
  });

  it("ends the stream on an invalid LiveEvent", async () => {
    const bad = { type: "notice", at: 0, level: "info", text: 42 } as unknown as LiveEvent;
    await withRoutes(
      (core) => ({ ...core, live: Stream.succeed(bad) }),
      async (handler) => {
        const res = await handler(new Request("http://farm/api/v1/live"));
        await expect(res.text()).rejects.toThrow();
      },
    );
  });
});
