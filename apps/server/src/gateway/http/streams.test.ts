import { describe, expect, test } from "vite-plus/test";

import type { LiveEvent, ServerEvent, StateFrame } from "@vibevalley/protocol";

import { type Core, makeCore } from "#/core/core.ts";
import { makeProjection } from "#/gateway/projection/frame.ts";
import { keptLog } from "#/infra/log.ts";
import { wallTime } from "#/infra/time.ts";

import { streams } from "./streams.ts";

async function* one<A>(a: A): AsyncGenerator<A> {
  yield a;
}

async function withRoutes(change: (core: Core) => Core, body: (handler: (request: Request) => Promise<Response>) => Promise<void>) {
  const core = makeCore({ projection: makeProjection(), clock: wallTime });
  try {
    const routes = streams({ core: change(core), log: keptLog(), clock: wallTime });
    await body(async (request) => routes.fetch(request));
  } finally {
    core.close();
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
  test("encodes a real StateFrame", async () => {
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

  test("ends the stream on an invalid StateFrame", async () => {
    await withRoutes(
      (core) => ({ ...core, states: () => one({} as StateFrame) }),
      async (handler) => {
        const res = await handler(new Request("http://farm/api/v1/state"));
        expect(res.status).toBe(200);
        await expect(res.text()).rejects.toThrow();
      },
    );
  });

  test("ends the stream on an invalid ServerEvent", async () => {
    const bad = { type: "notice", at: 0, level: "info", text: 42 } as unknown as ServerEvent;
    await withRoutes(
      (core) => ({ ...core, events: () => one(bad) }),
      async (handler) => {
        const res = await handler(new Request("http://farm/api/v1/events"));
        await expect(res.text()).rejects.toThrow();
      },
    );
  });

  test("ends the stream on an invalid LiveEvent", async () => {
    const bad = { type: "notice", at: 0, level: "info", text: 42 } as unknown as LiveEvent;
    await withRoutes(
      (core) => ({ ...core, live: () => one(bad) }),
      async (handler) => {
        const res = await handler(new Request("http://farm/api/v1/live"));
        await expect(res.text()).rejects.toThrow();
      },
    );
  });
});
