import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { decodeGatewayEvent, QQClient } from "./qq.ts";

const http = Effect.runSync(Effect.service(HttpClient.HttpClient).pipe(Effect.provide(FetchHttpClient.layer)));

describe("QQ gateway events", () => {
  it("decodes an event and rejects null and wrong field types", () => {
    const raw = `{"op":0,"s":7,"t":"C2C_MESSAGE_CREATE","d":{"id":"m1"}}`;
    expect(decodeGatewayEvent(raw)).toEqual({
      op: 0,
      s: 7,
      t: "C2C_MESSAGE_CREATE",
      d: { id: "m1" },
    });
    expect(() => decodeGatewayEvent("null")).toThrow();
    expect(() => decodeGatewayEvent(`{"op":"0"}`)).toThrow();
  });

  it("takes a frame that is not a dispatch, with s and t null", () => {
    expect(decodeGatewayEvent(`{"op":11,"s":null,"t":null}`)).toEqual({ op: 11, s: null, t: null });
  });
});

describe("QQ sign-in", () => {
  it("a refused AppID or secret says QQ's own reason", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ code: 100016, message: "invalid appid or secret" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const refused = await Effect.runPromise(Effect.flip(new QQClient(http, url, url + "/token").check({ appId: "a1", secret: "bad" })));
      expect(refused).toMatchObject({ _tag: "AppFailed", kind: "failed", message: "QQ 鉴权：invalid appid or secret" });
    } finally {
      server.close();
    }
  });
});
