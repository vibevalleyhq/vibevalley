import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vite-plus/test";
import { QQClient, SendError } from "./qq.ts";
import { WeixinClient, WeixinError } from "./weixin.ts";

interface Asked {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
}

const servers: ReturnType<typeof createServer>[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** A local stand-in for the chat app's API: answer says what each request gets back; undefined never answers. */
const api = async (answer: (asked: Asked) => { status?: number; body: string } | undefined) => {
  const asked: Asked[] = [];
  const s = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const one = {
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      };
      asked.push(one);
      const a = answer(one);
      if (a) res.writeHead(a.status ?? 200, { "content-type": "application/json" }).end(a.body);
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, asked };
};

const signal = () => new AbortController().signal;

test("QQ: a token, then a reply on the user's message, and what QQ says when it refuses", async () => {
  let refuse = false;
  const { url, asked } = await api((a) => {
    if (a.path === "/token") return { body: JSON.stringify({ access_token: "t1", expires_in: "7200" }) };
    if (refuse) return { status: 400, body: JSON.stringify({ code: 11, message: "超过回复次数" }) };
    return { body: JSON.stringify({ id: "m1" }) };
  });
  const qq = new QQClient(url, url + "/token");
  const app = { appId: "a1", secret: "s1" };
  expect(await qq.sendText(signal(), app, "u1", "你好", "in1")).toBe("m1");
  expect(JSON.parse(asked[0]!.body)).toEqual({ appId: "a1", clientSecret: "s1" });
  expect(asked[1]).toMatchObject({
    method: "POST",
    path: "/v2/users/u1/messages",
    headers: { authorization: "QQBot t1", "x-union-appid": "a1" },
  });
  expect(JSON.parse(asked[1]!.body)).toEqual({
    content: "你好",
    msg_type: 0,
    msg_id: "in1",
    msg_seq: 1,
  });
  refuse = true;
  const e = await qq.sendText(signal(), app, "u1", "再说", "in1").catch((e: unknown) => e);
  expect(e).toBeInstanceOf(SendError);
  expect(e).toMatchObject({ message: "QQ 发消息：11 超过回复次数", status: 400 });
  expect(JSON.parse(asked.at(-1)!.body)).toMatchObject({ msg_seq: 2 });
  expect(asked.filter((a) => a.path === "/token")).toHaveLength(1);
});

test("QQ: a wrong secret says what QQ said", async () => {
  const { url } = await api(() => ({
    body: JSON.stringify({ code: 100016, message: "invalid appid or secret" }),
  }));
  await expect(new QQClient(url, url + "/token").check(signal(), { appId: "a1", secret: "bad" })).rejects.toThrow("QQ 鉴权：invalid appid or secret");
});

test("WeChat: updates keep 64-bit message ids whole, a long poll with nothing is an empty answer, a refused send has its code", async () => {
  let quiet = false;
  const { url, asked } = await api((a) => {
    if (a.path.endsWith("getupdates")) {
      if (quiet) return undefined;
      return {
        body: `{"ret":0,"get_updates_buf":"b2","msgs":[{"message_id":12345678901234567890,"from_user_id":"o1","item_list":[{"type":1,"text_item":{"text":"在吗"}}]}]}`,
      };
    }
    return { body: JSON.stringify({ ret: -2, errmsg: "restricted" }) };
  });
  const wx = new WeixinClient(url);
  const account = { baseUrl: url, token: "k1" };
  const got = await wx.getUpdates(signal(), account, "b1", 5_000);
  expect(got.get_updates_buf).toBe("b2");
  expect(got.msgs?.[0]?.message_id).toBe("12345678901234567890");
  expect(got.msgs?.[0]?.item_list?.[0]?.text_item?.text).toBe("在吗");
  expect(asked[0]?.headers.authorization).toBe("Bearer k1");
  expect(JSON.parse(asked[0]!.body)).toMatchObject({ get_updates_buf: "b1" });
  quiet = true;
  expect(await wx.getUpdates(signal(), account, "b2", 200)).toEqual({
    ret: 0,
    get_updates_buf: "b2",
  });
  const e = await wx.sendText(signal(), account, "o1", "在", "c1").catch((e: unknown) => e);
  expect(e).toBeInstanceOf(WeixinError);
  expect(e).toMatchObject({ message: "sendmessage: restricted", code: -2 });
});

test("WeChat: an answer of the wrong shape is an error that names the call", async () => {
  const { url } = await api(() => ({ body: `{"ret":"zero"}` }));
  await expect(new WeixinClient(url).getUpdates(signal(), { baseUrl: url, token: "k1" }, "b1", 5_000)).rejects.toThrow(/^getupdates: /);
});
