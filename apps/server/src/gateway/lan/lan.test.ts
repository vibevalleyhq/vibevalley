import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";
import type { z } from "zod";

import { attachmentPath, deviceKeyCookie } from "@vibevalley/protocol";
import { apiSuccessEnvelope, BizCode, pathOf } from "@vibevalley/protocol/api";
import { subscriptionUrl } from "@vibevalley/protocol/rpc";
import * as S from "@vibevalley/protocol/schema";
import { tempDir } from "@vibevalley/testkit/temp";

import { app } from "#/testing/http.ts";
import { testConfig, until } from "#/testing/layers.ts";
import { quietApp } from "#/testing/world.ts";

import { type Lan, remoteMay } from "./lan.ts";

const web = tempDir("vv-lan-web-");
writeFileSync(join(web, "index.html"), "<!doctype html><title>VibeValley</title>");

/** The whole farm on a free port, with a page, its lan listener on loopback, which it calls its network address; and its user. */
const farmAndUser = async (lanPort = 0) => {
  const config = { ...testConfig(), web, lan: { port: lanPort } };
  const served = await app(config, 0, undefined, { ...quietApp, lan: { host: "127.0.0.1", address: () => "127.0.0.1" } });
  return { lan: served.farm.lan, user: served.farm.user, [Symbol.asyncDispose]: () => served.close() };
};

const farm = farmAndUser;

const unwrap =
  <A>(schema: z.ZodType<A>) =>
  (body: string): A =>
    S.jsonString(apiSuccessEnvelope(schema)).parse(body).data;
const decodeStatus = unwrap(S.UserStatus);
const decodeCreated = unwrap(S.ApprovalCreated);
const decodeCollected = unwrap(S.ApprovalCollected);

const signIn = (addr: string, password: string, headers: Record<string, string> = {}) =>
  request("POST", addr + pathOf("user.login"), "", { password, device: "公司的笔记本" }, headers);

const request = async (method: string, url: string, key: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(url, {
    method,
    headers: { ...(key ? { authorization: "Bearer " + key } : {}), ...headers },
    ...(body !== undefined && method !== "GET" ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.text(), cookie: res.headers.get("set-cookie") ?? "" };
};

const healthPath = pathOf("server.health.get");

const ask = (addr: string, code: string, name: string) =>
  fetch(addr + pathOf("lan.pair"), { method: "POST", body: JSON.stringify({ code, name }) }).then((r) => r.text());

const open = async (lan: Lan) => {
  const s = await lan.setOpen(true);
  expect(s).toMatchObject({ open: true });
  expect(s.problem).toBe("");
  return s.url!;
};

const pair = async (lan: Lan, addr: string, name: string) => {
  const s = await lan.startPairing();
  const link = new URL(s.pairing!.link);
  expect([link.origin, link.pathname, link.searchParams.get("c")]).toEqual([addr, "/pair", s.pairing!.code]);
  const got = ask(addr, s.pairing!.code.toLowerCase(), name);
  await until(() => lan.status().pairing?.asking !== undefined, "it questions");
  await lan.answer(true);
  const got2 = await got;
  const paired = unwrap(S.LanPaired)(got2);
  expect(paired.key).not.toBe("");
  return paired;
};

describe("lan access", () => {
  test("lets a device read the chat's files, by GET only", () => {
    expect([remoteMay("GET", attachmentPath("ab12")), remoteMay("POST", attachmentPath("ab12")), remoteMay("GET", "/mcp")]).toEqual([true, false, false]);
  });

  test("is shut until opened", async () => {
    await using f = await farm();
    const { lan } = f;
    expect(lan.status()).toMatchObject({ open: false });
    expect(lan.status().url).toBeUndefined();
    const pairingStartedFailure = await lan.startPairing().catch((e: unknown) => e);
    expect(pairingStartedFailure).toMatchObject({ name: "ApiError", bizCode: BizCode.LanForbidden });
    const addr = await open(lan);
    expect((await request("POST", addr + healthPath, "")).status).toBe(401);
    // The page holds nothing of the farm's: a device not paired yet gets it, to pair on.
    for (const path of ["/", "/pair"]) {
      const page = await request("GET", addr + path, "", undefined, { "sec-fetch-site": "cross-site" });
      expect([path, page.status, page.body]).toEqual([path, 200, expect.stringContaining("VibeValley")]);
    }
    await lan.setOpen(false);
    // The test reaches the listener as a paired phone's browser does, through the platform's own fetch.
    const then2 = await fetch(addr + healthPath, { method: "POST" }).then(
      () => "answered",
      () => "shut",
    );
    expect(then2).toBe("shut");
  });

  test("waits for the old listener to close before reopening a fixed port", async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
    const address = probe.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    await using f = await farm(port);
    const { lan } = f;
    for (let i = 0; i < 3; i++) {
      const addr = await open(lan);
      expect(new URL(addr).port).toBe(String(port));
      await lan.setOpen(false);
    }
  });

  test("lets a paired device use the farm, and only what is remote", async () => {
    await using f = await farmAndUser();
    const { lan, user } = f;
    const addr = await open(lan);
    const paired = await pair(lan, addr, "  小明的\niPhone ");
    expect(lan.status().pairing).toBeUndefined();
    expect(user.devices().map((d) => [d.name, d.came])).toEqual([["小明的 iPhone", "paired"]]);
    for (const origin of [addr, "https://evil.example"]) {
      const res = await request("POST", addr + healthPath, "", undefined, { origin, cookie: `${deviceKeyCookie}=${paired.key}` });
      expect(res.status).toBe(origin === addr ? 200 : 403);
    }
    const health = await request("POST", addr + healthPath, paired.key);
    expect([health.status, health.body]).toEqual([200, expect.stringContaining(`"ok":true`)]);
    const me = await request("POST", addr + pathOf("user.get"), paired.key);
    expect(me.status).toBe(200);
    const device = decodeStatus(me.body);
    expect(device.device).toMatchObject({ id: paired.device, came: "paired", lastSeen: expect.any(Number) });
    // A paired browser's cookie is a key as the header is.
    // The test reaches the listener as a paired phone's browser does, through the platform's own fetch.
    const byCookie = await fetch(addr + pathOf("setting.get"), { method: "POST", headers: { cookie: `other=1; ${deviceKeyCookie}=${paired.key}` } });
    expect(byCookie.status).toBe(200);
    // The test reaches the listener as a paired phone's browser does, through the platform's own fetch.
    expect((await fetch(addr + healthPath, { method: "POST", headers: { cookie: `${deviceKeyCookie}=nope` } })).status).toBe(401);
    for (const path of ["/mcp", "/mcp/x"]) expect((await request("GET", addr + path, paired.key)).status).toBe(404);
    expect((await request("POST", addr + "/pair", "")).status).toBe(404);
    // What configures the farm stays on this computer: keys, a runtime's command, profiles, skills, chat accounts.
    for (const op of [
      "lan.get",
      "lan.update",
      "lan.pairing.start",
      "setting.update",
      "runtime.setting.update",
      "agent.create",
      "skill.update",
      "connector.login",
      "user.update",
      "user.password.set",
      "user.device.list",
    ] as const) {
      const got = await request("POST", addr + pathOf(op), paired.key, { open: false });
      expect([op, got.status, got.body.includes(String(BizCode.LanForbidden))]).toEqual([op, 403, true]);
    }
    expect((await request("POST", addr + healthPath, paired.key + "x")).status).toBe(401);
  });

  test("lets a device signed in with the password be the user, all but setting the password", async () => {
    await using f = await farmAndUser();
    const { lan, user } = f;
    const addr = await open(lan);
    const outside = await request("POST", addr + pathOf("user.get"), "");
    const before = decodeStatus(outside.body);
    expect([outside.status, before]).toEqual([200, { name: "", password: false, here: false }]);
    expect((await signIn(addr, "whatever1")).body).toContain("还没设密码");
    const fromOutside = await user.setPassword({ here: false }, "correct horse").catch((e: unknown) => e);
    const short = await user.setPassword({ here: true }, "short").catch((e: unknown) => e);
    expect([fromOutside, short]).toMatchObject([
      { name: "ApiError", bizCode: BizCode.AuthRefused },
      { name: "ApiError", bizCode: BizCode.AuthRefused },
    ]);
    await user.setPassword({ here: true }, "correct horse");
    await user.rename("  小明 ");
    // Without a key the gate tells only whether there is a password, not who the user is.
    const keyless = await request("POST", addr + pathOf("user.get"), "");
    const told = decodeStatus(keyless.body);
    expect(told).toEqual({ name: "", password: true, here: false });
    const wrong = await signIn(addr, "correct horses");
    expect([wrong.status, wrong.cookie, wrong.body.includes("密码不对")]).toEqual([403, "", true]);
    const got = await signIn(addr, "correct horse");
    expect(got.status).toBe(200);
    const login = unwrap(S.UserLogin)(got.body);
    expect(got.cookie).toBe(`${deviceKeyCookie}=${login.key}; Path=/; Max-Age=315360000; HttpOnly; SameSite=Strict`);
    expect((await signIn(addr, "correct horse", { "x-forwarded-proto": "https" })).cookie).toContain("; Secure");
    const me = await request("POST", addr + pathOf("user.get"), login.key);
    const status = decodeStatus(me.body);
    expect(status).toMatchObject({
      name: "小明",
      password: true,
      here: false,
      device: { id: login.device, came: "login", name: "公司的笔记本" },
    });
    // Not remote, so a paired device could not; a signed-in one is the user.
    for (const op of ["lan.get", "user.device.list", "setting.get"] as const)
      expect([op, (await request("POST", addr + pathOf(op), login.key)).status]).toEqual([op, 200]);
    const password = await request("POST", addr + pathOf("user.password.set"), login.key, { password: "taken over" });
    expect(password.status).toBe(403);
    for (const path of ["/mcp", "/mcp/x"]) expect((await request("GET", addr + path, login.key)).status).toBe(404);
    expect(user.devices().map((d) => d.came)).toEqual(["login", "login"]);
    const out = await request("POST", addr + pathOf("user.logout"), login.key);
    expect([out.status, out.cookie]).toEqual([200, `${deviceKeyCookie}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`]);
    expect((await request("POST", addr + healthPath, login.key)).status).toBe(401);
    expect(user.status({ here: true })).toEqual({ name: "小明", password: true, here: true });
    const here = await user.logout({ here: true }).catch((e: unknown) => e);
    expect(here).toMatchObject({ name: "ApiError", bizCode: BizCode.AuthRefused });
  });

  test("signs a device in once the user approves the code it shows, and gives its key only once", async () => {
    await using f = await farmAndUser();
    const { lan, user } = f;
    const addr = await open(lan);
    const ask = async (name: string) => decodeCreated((await request("POST", addr + pathOf("user.approval.create"), "", { name })).body);
    const collect = (claim: string) => request("POST", addr + pathOf("user.approval.collect"), "", { claim });
    const asked = await ask("  build\nbox ");
    expect(asked.code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/u);
    const waiting = await collect(asked.claim);
    expect([waiting.status, waiting.body]).toEqual([200, '{"bizCode":0,"message":"ok","data":{}}']);
    // Only someone holding a key sees or answers what waits.
    for (const op of ["user.approval.list", "user.approval.answer"] as const)
      expect([op, (await request("POST", addr + pathOf(op), "", { id: "x", allow: true })).status]).toEqual([op, 401]);
    const pending = user.requests();
    // The gate tells who asked, for the user to judge by.
    expect(pending).toMatchObject([{ code: asked.code, name: "build box", from: "127.0.0.1" }]);
    // Approved, yet no device until its key is collected.
    await user.answerRequest(pending[0]?.id ?? "", true);
    expect(user.devices()).toEqual([]);
    const got = decodeCollected((await collect(asked.claim)).body);
    const key = got.login?.key ?? "";
    expect(user.devices().map((d) => [d.name, d.came])).toEqual([["build box", "login"]]);
    expect((await request("POST", addr + pathOf("setting.get"), key)).status).toBe(200);
    const again = await collect(asked.claim);
    expect([again.status, again.body.includes("登录请求没了")]).toEqual([403, true]);
    // Refused, the asking device is told so.
    const refused = await ask("陌生人");
    await user.answerRequest(user.requests()[0]?.id ?? "", false);
    expect((await collect(refused.claim)).status).toBe(403);
    // A keyless door is held to a few at once.
    for (let i = 0; i < 5; i++) await ask("刷屏 " + i);
    const sixth = await request("POST", addr + pathOf("user.approval.create"), "", { name: "第六个" });
    expect([sixth.status, sixth.body.includes("好几台设备")]).toEqual([403, true]);
  });

  test("locks signing in for a while after too many wrong passwords", async () => {
    await using f = await farmAndUser();
    const { user } = f;
    await user.setPassword({ here: true }, "correct horse");
    for (let i = 0; i < 5; i++) {
      const wrong = await user.login("guess " + i, "猜的").catch((e: unknown) => e);
      expect(wrong).toMatchObject({ name: "ApiError", bizCode: BizCode.AuthRefused, message: "密码不对" });
    }
    const locked = await user.login("correct horse", "我的").catch((e: unknown) => e);
    expect(locked).toMatchObject({ name: "ApiError", bizCode: BizCode.AuthRefused, message: expect.stringContaining("秒后再试") });
    expect(user.devices()).toEqual([]);
  });

  test("lets the user refuse a device, and holds a second one off", async () => {
    await using f = await farmAndUser();
    const { lan, user } = f;
    const addr = await open(lan);
    const s = await lan.startPairing();
    const got = ask(addr, s.pairing!.code, "陌生人");
    await until(() => lan.status().pairing?.asking === "陌生人", "it questions");
    const answer2 = await ask(addr, s.pairing!.code, "又一个");
    expect(answer2).toContain("另一台设备");
    await lan.answer(false);
    const body = await got;
    expect(body).toContain(String(BizCode.LanForbidden));
    expect(body).toContain("没让");
    expect(user.devices()).toEqual([]);
    expect(lan.status().pairing).toBeUndefined();
  });

  test("calls the pairing off after too many wrong codes", async () => {
    await using f = await farm();
    const { lan } = f;
    const addr = await open(lan);
    const s = await lan.startPairing();
    for (let i = 0; i < 5; i++) {
      const reply = await ask(addr, "WRONGCODE", "猜码的");
      expect(reply).toContain("配对码不对");
    }
    const answer = await ask(addr, s.pairing!.code, "猜码的");
    expect(answer).toContain("过期");
  });

  test("ends a forgotten device's streams", async () => {
    await using f = await farmAndUser();
    const { lan, user } = f;
    const addr = await open(lan);
    const paired = await pair(lan, addr, "旧手机");
    // The test reaches the listener as a paired phone's browser does, through the platform's own fetch.
    const res = await fetch(addr + "/api/v1/state", { headers: { authorization: "Bearer " + paired.key } });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first.startsWith("data:")).toBe(true);
    const ended = (async () => {
      try {
        for (;;) if ((await reader.read()).done) return "ended";
      } catch {
        return "ended";
      }
    })();
    await user.revoke(paired.device);
    const ended2 = await ended;
    expect(ended2).toBe("ended");
    expect((await request("POST", addr + healthPath, paired.key)).status).toBe(401);
  });
  test("hands a paired device's WebSocket to the farm, and forgetting the device ends it", async () => {
    await using f = await farmAndUser();
    const { lan, user } = f;
    const addr = await open(lan);
    const paired = await pair(lan, addr, "手机");
    // A page's subscriptions are event streams now: the listener hands them on as any GET of the API.
    const url = addr + subscriptionUrl("channel.reports", {});
    const statusOf = async (headers: Record<string, string>) => {
      const res = await fetch(url, { headers });
      await res.body?.cancel();
      return res.status;
    };
    expect(await statusOf({})).toBe(401);
    const key = { authorization: "Bearer " + paired.key };
    expect(await statusOf({ ...key, origin: "https://evil.example" })).toBe(403);
    const res = await fetch(url, { headers: { ...key, origin: addr } });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const ended = (async () => {
      try {
        for (;;) if ((await reader.read()).done) return "ended";
      } catch {
        return "ended";
      }
    })();
    await user.revoke(paired.device);
    const ended2 = await ended;
    expect(ended2).toBe("ended");
  });
});
