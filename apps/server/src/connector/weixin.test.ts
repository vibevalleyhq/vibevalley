import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { weixinAdapter } from "./connector.ts";
import { decodeUpdates, type WeixinApi, WeixinClient, WeixinError } from "./weixin.ts";

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
  if (!address || typeof address === "string") throw new Error("no test port");
  return `http://127.0.0.1:${address.port}`;
};

describe("WeChat updates", () => {
  it("decodes nested messages and rejects a wrong messages shape", () => {
    const valid = {
      ret: 0,
      msgs: [
        {
          message_id: "m1",
          item_list: [{ ref_msg: { svr_id: "old", message_item: { type: 1, text_item: { text: "nested" } } } }],
        },
      ],
    };
    expect(decodeUpdates(valid)).toEqual(valid);
    expect(() => decodeUpdates({ ret: 0, msgs: {} })).toThrow();
  });

  it("returns a failure without accepting malformed updates", async () => {
    let accepted = 0;
    const api: WeixinApi = {
      login: async () => {
        throw new Error("not used");
      },
      getUpdates: async () => ({ ret: 0, msgs: {} }) as never,
      sendText: async () => {
        throw new Error("not used");
      },
    };
    const adapter = weixinAdapter(api);
    const result = await adapter.receive(
      new AbortController().signal,
      {},
      {
        cursor: "",
        accept: async () => {
          accepted++;
        },
      },
    );
    expect(result).toMatchObject({ kind: "failed" });
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
    const client = new WeixinClient(base);
    const got = await client.login(
      AbortSignal.timeout(2_000),
      () => {},
      () => "",
    );
    expect(got).toEqual({ account: { baseUrl: base, token: "tok" }, botId: "bot", owner: "owner" });
  });

  it("rejects a QR response with the wrong shape", async () => {
    const base = await serve(() => `{"qrcode":42,"qrcode_img_content":"https://qr.example"}`);
    const client = new WeixinClient(base);
    await expect(
      client.login(
        AbortSignal.timeout(2_000),
        () => {},
        () => "",
      ),
    ).rejects.toThrow(/拿不到登录二维码/);
  });

  it("keeps a 64-bit sent message id and rejects a wrong id shape", async () => {
    let answer = `{"ret":0,"message_id":9007199254740993}`;
    const base = await serve(() => answer);
    const client = new WeixinClient(base);
    const account = { baseUrl: base, token: "tok" };
    expect(await client.sendText(AbortSignal.timeout(2_000), account, "owner", "hello", "ctx")).toBe("9007199254740993");
    answer = `{"ret":0,"message_id":{}}`;
    await expect(client.sendText(AbortSignal.timeout(2_000), account, "owner", "hello", "ctx")).rejects.toThrow(WeixinError);
  });

  it("rejects malformed updates and decodes a later valid page", async () => {
    let answer = `{"ret":0,"msgs":{}}`;
    const base = await serve(() => answer);
    const client = new WeixinClient(base);
    const account = { baseUrl: base, token: "tok" };
    await expect(client.getUpdates(AbortSignal.timeout(2_000), account, "", 1_000)).rejects.toThrow(WeixinError);
    answer = `{"ret":0,"msgs":[{"message_id":9007199254740993,"item_list":[]}]}`;
    const got = await client.getUpdates(AbortSignal.timeout(2_000), account, "", 1_000);
    expect(got.msgs?.[0]?.message_id).toBe("9007199254740993");
  });
});
