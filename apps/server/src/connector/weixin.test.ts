import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { decodeUpdates, type WeixinApi, weixinAdapter, WeixinClient } from "./weixin.ts";

const http = Effect.runSync(Effect.service(HttpClient.HttpClient).pipe(Effect.provide(FetchHttpClient.layer)));
const run = Effect.runPromise;
const refusal = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(e));

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

const serve = async (answer: (path: string) => string) => {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(answer(req.url ?? ""));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no test port");
  return `http://127.0.0.1:${address.port}`;
};

describe("WeChat updates", () => {
  it("decodes nested messages and rejects a wrong messages shape", () => {
    const valid = {
      ret: 0,
      msgs: [
        {
          message_id: "m1",
          item_list: [
            {
              ref_msg: { svr_id: "old", message_item: { type: 1, text_item: { text: "nested" } } },
            },
          ],
        },
      ],
    };
    expect(decodeUpdates(valid)).toEqual(valid);
    expect(() => decodeUpdates({ ret: 0, msgs: {} })).toThrow();
  });

  it("returns a failure without accepting malformed updates", async () => {
    let accepted = 0;
    const api: WeixinApi = {
      login: () => Effect.die("not used"),
      getUpdates: () => Effect.sync(() => decodeUpdates({ ret: 0, msgs: {} })),
      sendText: () => Effect.die("not used"),
    };
    const adapter = weixinAdapter(api);
    const exit = await Effect.runPromiseExit(
      adapter.receive(
        {},
        {
          cursor: "",
          accept: () =>
            Effect.sync(() => {
              accepted++;
            }),
        },
      ),
    );
    expect(exit._tag).toBe("Failure");
    expect(accepted).toBe(0);
  });
});

describe("WeChat HTTP responses", () => {
  it("decodes QR and confirmation responses", async () => {
    const base = await serve((path) =>
      path.includes("get_bot_qrcode")
        ? `{"qrcode":"code","qrcode_img_content":"https://qr.example"}`
        : `{"status":"confirmed","bot_token":"tok","ilink_bot_id":"bot","ilink_user_id":"owner"}`,
    );
    const client = new WeixinClient(http, base);
    const got = await run(client.login(() => Effect.void, Effect.succeed("")));
    expect(got).toEqual({ account: { baseUrl: base, token: "tok" }, botId: "bot", owner: "owner" });
  });

  it("rejects a QR response with the wrong shape", async () => {
    const base = await serve(() => `{"qrcode":42,"qrcode_img_content":"https://qr.example"}`);
    const client = new WeixinClient(http, base);
    expect((await refusal(client.login(() => Effect.void, Effect.succeed("")))).message).toMatch(/拿不到登录二维码/);
  });

  it("keeps a 64-bit sent message id and rejects a wrong id shape", async () => {
    let answer = `{"ret":0,"message_id":9007199254740993}`;
    const base = await serve(() => answer);
    const client = new WeixinClient(http, base);
    const account = { baseUrl: base, token: "tok" };
    expect(await run(client.sendText(account, "owner", "hello", "ctx"))).toBe("9007199254740993");
    answer = `{"ret":0,"message_id":{}}`;
    expect(await refusal(client.sendText(account, "owner", "hello", "ctx"))).toMatchObject({ _tag: "AppFailed", kind: "failed" });
  });

  it("rejects malformed updates and decodes a later valid page", async () => {
    let answer = `{"ret":0,"msgs":{}}`;
    const base = await serve(() => answer);
    const client = new WeixinClient(http, base);
    const account = { baseUrl: base, token: "tok" };
    expect(await refusal(client.getUpdates(account, "", 1_000))).toMatchObject({ _tag: "AppFailed" });
    answer = `{"ret":0,"msgs":[{"message_id":9007199254740993,"item_list":[]}]}`;
    const got = await run(client.getUpdates(account, "", 1_000));
    expect(got.msgs?.[0]?.message_id).toBe("9007199254740993");
  });
});
