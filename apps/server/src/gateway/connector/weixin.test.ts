import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, test } from "vite-plus/test";

import { failedWith } from "./adapter.ts";
import { decodeUpdates, type WeixinApi, weixinAdapter, WeixinClient } from "./weixin.ts";

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("it went through");
    },
    (e: unknown) => e,
  );
const never = () => new AbortController().signal;

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
  await new Promise<void>((resolve) => void server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no test port");
  return `http://127.0.0.1:${address.port}`;
};

describe("WeChat updates", () => {
  test("decodes nested messages and rejects a wrong messages shape", () => {
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

  test("returns a failure without accepting malformed updates", async () => {
    let accepted = 0;
    const api: WeixinApi = {
      login: () => Promise.reject(new Error("not used")),
      getUpdates: async () => {
        try {
          return decodeUpdates({ ret: 0, msgs: {} });
        } catch (e) {
          throw failedWith(e instanceof Error ? e.message : String(e));
        }
      },
      sendText: () => Promise.reject(new Error("not used")),
    };
    const adapter = weixinAdapter(api);
    await expect(
      adapter.receive(
        {},
        {
          cursor: "",
          accept: async () => {
            accepted++;
          },
        },
        never(),
      ),
    ).rejects.toBeDefined();
    expect(accepted).toBe(0);
  });
});

describe("WeChat HTTP responses", () => {
  test("decodes QR and confirmation responses", async () => {
    const base = await serve((path) =>
      path.includes("get_bot_qrcode")
        ? `{"qrcode":"code","qrcode_img_content":"https://qr.example"}`
        : `{"status":"confirmed","bot_token":"tok","ilink_bot_id":"bot","ilink_user_id":"user"}`,
    );
    const client = new WeixinClient(fetch, base);
    const got = await client.login(
      () => undefined,
      () => "",
      never(),
    );
    expect(got).toEqual({ account: { baseUrl: base, token: "tok" }, botId: "bot", user: "user" });
  });

  test("rejects a QR response with the wrong shape", async () => {
    const base = await serve(() => `{"qrcode":42,"qrcode_img_content":"https://qr.example"}`);
    const client = new WeixinClient(fetch, base);
    expect(
      (
        (await refusal(
          client.login(
            () => undefined,
            () => "",
            never(),
          ),
        )) as Error
      ).message,
    ).toMatch(/拿不到登录二维码/u);
  });

  test("keeps a 64-bit sent message id and rejects a wrong id shape", async () => {
    let answer = `{"ret":0,"message_id":9007199254740993}`;
    const base = await serve(() => answer);
    const client = new WeixinClient(fetch, base);
    const account = { baseUrl: base, token: "tok" };
    expect(await client.sendText(account, "user", "hello", "ctx")).toBe("9007199254740993");
    answer = `{"ret":0,"message_id":{}}`;
    expect(await refusal(client.sendText(account, "user", "hello", "ctx"))).toMatchObject({ name: "AppFailed", kind: "failed" });
  });

  test("rejects malformed updates and decodes a later valid page", async () => {
    let answer = `{"ret":0,"msgs":{}}`;
    const base = await serve(() => answer);
    const client = new WeixinClient(fetch, base);
    const account = { baseUrl: base, token: "tok" };
    expect(await refusal(client.getUpdates(account, "", 1_000))).toMatchObject({ name: "AppFailed" });
    answer = `{"ret":0,"msgs":[{"message_id":9007199254740993,"item_list":[]}]}`;
    const got = await client.getUpdates(account, "", 1_000);
    expect(got.msgs?.[0]?.message_id).toBe("9007199254740993");
  });
});
