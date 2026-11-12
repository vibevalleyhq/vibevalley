import { createServer } from "node:http";

import { describe, expect, test } from "vite-plus/test";

import { decodeGatewayEvent, nextReplySeq, QQClient } from "./qq.ts";

describe("QQ gateway events", () => {
  test("decodes an event and rejects null and wrong field types", () => {
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

  test("takes a frame that is not a dispatch, with s and t null", () => {
    expect(decodeGatewayEvent(`{"op":11,"s":null,"t":null}`)).toEqual({ op: 11, s: null, t: null });
  });
});

describe("QQ sign-in", () => {
  test("regression: rotating QQ credentials evicts the previous token and expired tokens refresh", async () => {
    let requests = 0;
    let now = 0;
    // Time moves only when the test says: no deadline is reached on its own.
    const clock = {
      now: () => now,
      sleep: (_ms: number, signal?: AbortSignal) =>
        new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true })),
    };
    const client = new QQClient(
      async () => {
        requests++;
        return Response.json({ access_token: `token-${requests}`, expires_in: 120 });
      },
      undefined,
      undefined,
      clock,
    );
    const first = { appId: "a", secret: "old" };
    await client.check(first);
    await client.check(first);
    expect(requests).toBe(1);
    await client.check({ appId: "a", secret: "new" });
    await client.check(first);
    expect(requests).toBe(3);
    now += 60_000;
    await client.check(first);
    expect(requests).toBe(4);
  });

  test("a refused AppID or secret says QQ's own reason", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" }).end(`{"code":100016,"message":"invalid appid or secret"}`);
    });
    await new Promise<void>((resolve) => void server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no test port");
      const url = `http://127.0.0.1:${address.port}`;
      const refused = await new QQClient(fetch, url, url + "/token").check({ appId: "a1", secret: "bad" }).catch((e: unknown) => e);
      expect(refused).toMatchObject({ name: "AppFailed", kind: "failed", message: "QQ 鉴权：invalid appid or secret" });
    } finally {
      server.close();
    }
  });
});

describe("QQ reply numbers", () => {
  test("counts each message's replies and keeps only the latest messages", () => {
    const seqs = new Map<string, number>();
    expect([nextReplySeq(seqs, "a"), nextReplySeq(seqs, "a"), nextReplySeq(seqs, "b")]).toEqual([1, 2, 1]);
    for (let i = 0; i < 300; i++) nextReplySeq(seqs, `m${i}`);
    expect(seqs.size).toBe(256);
    expect(seqs.has("a")).toBe(false);
    expect(nextReplySeq(seqs, "m299")).toBe(2);
  });
});
