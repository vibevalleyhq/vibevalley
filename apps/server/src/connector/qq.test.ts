import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import { decodeGatewayEvent, nextReplySeq, QQClient } from "./qq.ts";

const http = Effect.runSync(Effect.service(HttpClient.HttpClient).pipe(Effect.provide(FetchHttpClient.layer)));

describe("QQ gateway events", () => {
  it("decodes an event and rejects null and wrong field types", () => {
    const raw = `{"op":0,"s":7,"t":"C2C_MESSAGE_CREATE","d":{"id":"m1"}}`;
    expect(Effect.runSync(decodeGatewayEvent(raw))).toEqual({
      op: 0,
      s: 7,
      t: "C2C_MESSAGE_CREATE",
      d: { id: "m1" },
    });
    expect(() => Effect.runSync(decodeGatewayEvent("null"))).toThrow();
    expect(() => Effect.runSync(decodeGatewayEvent(`{"op":"0"}`))).toThrow();
  });

  it("takes a frame that is not a dispatch, with s and t null", () => {
    expect(Effect.runSync(decodeGatewayEvent(`{"op":11,"s":null,"t":null}`))).toEqual({ op: 11, s: null, t: null });
  });
});

describe("QQ sign-in", () => {
  it.effect("regression: rotating QQ credentials evicts the previous token and expired tokens refresh", () =>
    Effect.gen(function* () {
      let requests = 0;
      const client = new QQClient(
        HttpClient.make((request) =>
          Effect.sync(() => {
            requests++;
            return HttpClientResponse.fromWeb(request, Response.json({ access_token: `token-${requests}`, expires_in: 120 }));
          }),
        ),
      );
      const first = { appId: "a", secret: "old" };
      yield* client.check(first);
      yield* client.check(first);
      expect(requests).toBe(1);
      yield* client.check({ appId: "a", secret: "new" });
      yield* client.check(first);
      expect(requests).toBe(3);
      yield* TestClock.adjust(60_000);
      yield* client.check(first);
      expect(requests).toBe(4);
    }),
  );

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

describe("QQ reply numbers", () => {
  it("counts each message's replies and keeps only the latest messages", () => {
    const seqs = new Map<string, number>();
    expect([nextReplySeq(seqs, "a"), nextReplySeq(seqs, "a"), nextReplySeq(seqs, "b")]).toEqual([1, 2, 1]);
    for (let i = 0; i < 300; i++) nextReplySeq(seqs, `m${i}`);
    expect(seqs.size).toBe(256);
    expect(seqs.has("a")).toBe(false);
    expect(nextReplySeq(seqs, "m299")).toBe(2);
  });
});
