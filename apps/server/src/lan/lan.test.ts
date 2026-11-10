import { writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Array as Arr, Context, Effect, Formatter, Layer, Schema, String as Str } from "effect";

import { attachmentPath, deviceKeyCookie } from "@vibevalley/protocol";
import { pathOf } from "@vibevalley/protocol/api";
import { rpcPath } from "@vibevalley/protocol/rpc";
import * as S from "@vibevalley/protocol/schema";
import { tempDir } from "@vibevalley/testkit/temp";

import { app } from "#/testing/http.ts";
import { testConfig, until } from "#/testing/layers.ts";
import { quietApp } from "#/testing/world.ts";
import { User } from "#/user/user.ts";

import { Lan, remoteMay } from "./lan.ts";

const web = tempDir("vv-lan-web-");
writeFileSync(join(web, "index.html"), "<!doctype html><title>VibeValley</title>");

/** The whole farm on a free port, with a page, its lan listener on loopback, which it calls its network address; and its user. */
const farmAndUser = (lanPort = 0) =>
  Effect.gen(function* () {
    const config = { ...testConfig(), web, lan: { port: lanPort } };
    const built = yield* Layer.build(app(config, 0, () => Effect.void, { ...quietApp, lan: { host: "127.0.0.1", address: () => "127.0.0.1" } }));
    return { lan: Context.get(built, Lan), user: Context.get(built, User) };
  });

const farm = (lanPort = 0) => Effect.map(farmAndUser(lanPort), (f) => f.lan);

const decodeStatus = Schema.decodeEffect(Schema.fromJsonString(S.UserStatus));
const decodeCreated = Schema.decodeEffect(Schema.fromJsonString(S.ApprovalCreated));
const decodeCollected = Schema.decodeEffect(Schema.fromJsonString(S.ApprovalCollected));

const signIn = (addr: string, password: string, headers: Record<string, string> = {}) =>
  request("POST", addr + pathOf("user.login"), "", { password, device: "公司的笔记本" }, headers);

const request = async (method: string, url: string, key: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(url, {
    method,
    headers: { ...(key ? { authorization: "Bearer " + key } : {}), ...headers },
    ...(body !== undefined && method !== "GET" ? { body: Formatter.formatJson(body) } : {}),
  });
  return { status: res.status, body: await res.text(), cookie: res.headers.get("set-cookie") ?? "" };
};

const healthPath = pathOf("server.health.get");

const ask = (addr: string, code: string, name: string) =>
  fetch(addr + pathOf("lan.pair"), { method: "POST", body: Formatter.formatJson({ code, name }) }).then((r) => r.text());

const open = (lan: Lan["Service"]) =>
  Effect.map(lan.setOpen(true), (s) => {
    expect(s).toMatchObject({ open: true });
    expect(s.problem).toBe("");
    return s.url!;
  });

const pair = (lan: Lan["Service"], addr: string, name: string) =>
  Effect.gen(function* () {
    const s = yield* lan.startPairing();
    const link = new URL(s.pairing!.link);
    expect([link.origin, link.pathname, link.searchParams.get("c")]).toEqual([addr, "/pair", s.pairing!.code]);
    const got = ask(addr, s.pairing!.code.toLowerCase(), name);
    yield* until(() => lan.status().pairing?.asking !== undefined, "it questions");
    yield* lan.answer(true);
    const got2 = yield* Effect.promise(() => got);
    const paired = yield* Schema.decodeEffect(Schema.fromJsonString(S.LanPaired))(got2);
    expect(paired.key).not.toBe("");
    return paired;
  });

/** An upgrade to the RPC socket through the listener: its status, and the socket when it was upgraded. */
const upgradeAt = (addr: string, headers: Record<string, string>) =>
  new Promise<{ status: number; socket?: Socket }>((resolve, reject) => {
    const u = new URL(addr);
    const req = httpRequest({
      host: u.hostname,
      port: Number(u.port),
      path: rpcPath,
      agent: false,
      headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers },
    });
    req.on("upgrade", (res, socket) => resolve({ status: res.statusCode ?? 0, socket }));
    req.on("response", (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0 });
    });
    req.on("error", reject);
    req.end();
  });

describe("lan access", () => {
  it("lets a device read the chat's files, by GET only", () => {
    expect([remoteMay("GET", attachmentPath("ab12")), remoteMay("POST", attachmentPath("ab12")), remoteMay("GET", "/mcp")]).toEqual([true, false, false]);
  });

  it.live("is shut until opened", () =>
    Effect.gen(function* () {
      const lan = yield* farm();
      expect(lan.status()).toMatchObject({ open: false });
      expect(lan.status().url).toBeUndefined();
      const pairingStartedFailure = yield* Effect.flip(lan.startPairing());
      expect(pairingStartedFailure).toMatchObject({ _tag: "LanRefused" });
      const addr = yield* open(lan);
      expect((yield* Effect.promise(() => request("POST", addr + healthPath, ""))).status).toBe(401);
      // The page holds nothing of the farm's: a device not paired yet gets it, to pair on.
      for (const path of ["/", "/pair"]) {
        const page = yield* Effect.promise(() => request("GET", addr + path, "", undefined, { "sec-fetch-site": "cross-site" }));
        expect([path, page.status, page.body]).toEqual([path, 200, expect.stringContaining("VibeValley")]);
      }
      yield* lan.setOpen(false);
      const then2 = yield* Effect.promise(() =>
        // The test reaches the listener as a paired phone's browser does, through the platform's own fetch.
        // @effect-diagnostics-next-line globalFetchInEffect:off
        fetch(addr + healthPath, { method: "POST" }).then(
          () => "answered",
          () => "shut",
        ),
      );
      expect(then2).toBe("shut");
    }).pipe(Effect.scoped),
  );

  it.live("waits for the old listener to close before reopening a fixed port", () =>
    Effect.gen(function* () {
      const probe = createServer();
      yield* Effect.promise(() => new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve())));
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      yield* Effect.promise(() => new Promise<void>((resolve) => probe.close(() => resolve())));
      const lan = yield* farm(port);
      for (let i = 0; i < 3; i++) {
        const addr = yield* open(lan);
        expect(new URL(addr).port).toBe(String(port));
        yield* lan.setOpen(false);
      }
    }).pipe(Effect.scoped),
  );

  it.live("lets a paired device use the farm, and only what is remote", () =>
    Effect.gen(function* () {
      const { lan, user } = yield* farmAndUser();
      const addr = yield* open(lan);
      const paired = yield* pair(lan, addr, "  小明的\niPhone ");
      expect(lan.status().pairing).toBeUndefined();
      expect(user.devices().map((d) => [d.name, d.came])).toEqual([["小明的 iPhone", "paired"]]);
      for (const origin of [addr, "https://evil.example"]) {
        const res = yield* Effect.promise(() => request("POST", addr + healthPath, "", undefined, { origin, cookie: `${deviceKeyCookie}=${paired.key}` }));
        expect(res.status).toBe(origin === addr ? 200 : 403);
      }
      const health = yield* Effect.promise(() => request("POST", addr + healthPath, paired.key));
      expect([health.status, health.body]).toEqual([200, expect.stringContaining(`"ok":true`)]);
      const me = yield* Effect.promise(() => request("POST", addr + pathOf("user.get"), paired.key));
      expect(me.status).toBe(200);
      const device = yield* decodeStatus(me.body);
      expect(device.device).toMatchObject({ id: paired.device, came: "paired", lastSeen: expect.any(Number) });
      // A paired browser's cookie is a key as the header is.
      const byCookie = yield* Effect.promise(() =>
        // The test reaches the listener as a paired phone's browser does, through the platform's own fetch.
        // @effect-diagnostics-next-line globalFetchInEffect:off
        fetch(addr + pathOf("setting.get"), { method: "POST", headers: { cookie: `other=1; ${deviceKeyCookie}=${paired.key}` } }),
      );
      expect(byCookie.status).toBe(200);
      // The test reaches the listener as a paired phone's browser does, through the platform's own fetch.
      // @effect-diagnostics-next-line globalFetchInEffect:off
      expect((yield* Effect.promise(() => fetch(addr + healthPath, { method: "POST", headers: { cookie: `${deviceKeyCookie}=nope` } }))).status).toBe(401);
      for (const path of ["/mcp", "/mcp/x"]) expect((yield* Effect.promise(() => request("GET", addr + path, paired.key))).status).toBe(404);
      expect((yield* Effect.promise(() => request("POST", addr + "/pair", ""))).status).toBe(404);
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
        const got = yield* Effect.promise(() => request("POST", addr + pathOf(op), paired.key, { open: false }));
        expect([op, got.status, got.body.includes("LanRefused")]).toEqual([op, 403, true]);
      }
      expect((yield* Effect.promise(() => request("POST", addr + healthPath, paired.key + "x"))).status).toBe(401);
    }).pipe(Effect.scoped),
  );

  it.live("lets a device signed in with the password be the user, all but setting the password", () =>
    Effect.gen(function* () {
      const { lan, user } = yield* farmAndUser();
      const addr = yield* open(lan);
      const outside = yield* Effect.promise(() => request("POST", addr + pathOf("user.get"), ""));
      const before = yield* decodeStatus(outside.body);
      expect([outside.status, before]).toEqual([200, { name: "", password: false, here: false }]);
      expect((yield* Effect.promise(() => signIn(addr, "whatever1"))).body).toContain("还没设密码");
      const fromOutside = yield* Effect.flip(user.setPassword({ here: false }, "correct horse"));
      const short = yield* Effect.flip(user.setPassword({ here: true }, "short"));
      expect([fromOutside, short]).toMatchObject([{ _tag: "LanRefused" }, { _tag: "LanRefused" }]);
      yield* user.setPassword({ here: true }, "correct horse");
      yield* user.rename("  小明 ");
      // Without a key the gate tells only whether there is a password, not who the user is.
      const keyless = yield* Effect.promise(() => request("POST", addr + pathOf("user.get"), ""));
      const told = yield* decodeStatus(keyless.body);
      expect(told).toEqual({ name: "", password: true, here: false });
      const wrong = yield* Effect.promise(() => signIn(addr, "correct horses"));
      expect([wrong.status, wrong.cookie, wrong.body.includes("密码不对")]).toEqual([403, "", true]);
      const got = yield* Effect.promise(() => signIn(addr, "correct horse"));
      expect(got.status).toBe(200);
      const login = yield* Schema.decodeEffect(Schema.fromJsonString(S.UserLogin))(got.body);
      expect(got.cookie).toBe(`${deviceKeyCookie}=${login.key}; Path=/; Max-Age=315360000; HttpOnly; SameSite=Strict`);
      expect((yield* Effect.promise(() => signIn(addr, "correct horse", { "x-forwarded-proto": "https" }))).cookie).toContain("; Secure");
      const me = yield* Effect.promise(() => request("POST", addr + pathOf("user.get"), login.key));
      const status = yield* decodeStatus(me.body);
      expect(status).toMatchObject({
        name: "小明",
        password: true,
        here: false,
        device: { id: login.device, came: "login", name: "公司的笔记本" },
      });
      // Not remote, so a paired device could not; a signed-in one is the user.
      for (const op of ["lan.get", "user.device.list", "setting.get"] as const)
        expect([op, (yield* Effect.promise(() => request("POST", addr + pathOf(op), login.key))).status]).toEqual([op, 200]);
      const password = yield* Effect.promise(() => request("POST", addr + pathOf("user.password.set"), login.key, { password: "taken over" }));
      expect(password.status).toBe(403);
      for (const path of ["/mcp", "/mcp/x"]) expect((yield* Effect.promise(() => request("GET", addr + path, login.key))).status).toBe(404);
      expect(user.devices().map((d) => d.came)).toEqual(["login", "login"]);
      const out = yield* Effect.promise(() => request("POST", addr + pathOf("user.logout"), login.key));
      expect([out.status, out.cookie]).toEqual([204, `${deviceKeyCookie}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`]);
      expect((yield* Effect.promise(() => request("POST", addr + healthPath, login.key))).status).toBe(401);
      expect(user.status({ here: true })).toEqual({ name: "小明", password: true, here: true });
      const here = yield* Effect.flip(user.logout({ here: true }));
      expect(here).toMatchObject({ _tag: "LanRefused" });
    }).pipe(Effect.scoped),
  );

  it.live("signs a device in once the user approves the code it shows, and gives its key only once", () =>
    Effect.gen(function* () {
      const { lan, user } = yield* farmAndUser();
      const addr = yield* open(lan);
      const ask = (name: string) =>
        Effect.flatMap(
          Effect.promise(() => request("POST", addr + pathOf("user.approval.create"), "", { name })),
          (r) => decodeCreated(r.body),
        );
      const collect = (claim: string) => Effect.promise(() => request("POST", addr + pathOf("user.approval.collect"), "", { claim }));
      const asked = yield* ask("  build\nbox ");
      expect(asked.code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/u);
      const waiting = yield* collect(asked.claim);
      expect([waiting.status, waiting.body]).toEqual([200, "{}"]);
      // Only someone holding a key sees or answers what waits.
      for (const op of ["user.approval.list", "user.approval.answer"] as const)
        expect([op, (yield* Effect.promise(() => request("POST", addr + pathOf(op), "", { id: "x", allow: true }))).status]).toEqual([op, 401]);
      const pending = user.requests();
      // The gate tells who asked, for the user to judge by.
      expect(pending).toMatchObject([{ code: asked.code, name: "build box", from: "127.0.0.1" }]);
      // Approved, yet no device until its key is collected.
      yield* user.answerRequest(pending[0]?.id ?? "", true);
      expect(user.devices()).toEqual([]);
      const got = yield* Effect.flatMap(collect(asked.claim), (r) => decodeCollected(r.body));
      const key = got.login?.key ?? "";
      expect(Arr.map(user.devices(), (d) => [d.name, d.came])).toEqual([["build box", "login"]]);
      expect((yield* Effect.promise(() => request("POST", addr + pathOf("setting.get"), key))).status).toBe(200);
      const again = yield* collect(asked.claim);
      expect([again.status, Str.includes("登录请求没了")(again.body)]).toEqual([403, true]);
      // Refused, the asking device is told so.
      const refused = yield* ask("陌生人");
      yield* user.answerRequest(user.requests()[0]?.id ?? "", false);
      expect((yield* collect(refused.claim)).status).toBe(403);
      // A keyless door is held to a few at once.
      for (let i = 0; i < 5; i++) yield* ask("刷屏 " + i);
      const sixth = yield* Effect.promise(() => request("POST", addr + pathOf("user.approval.create"), "", { name: "第六个" }));
      expect([sixth.status, Str.includes("好几台设备")(sixth.body)]).toEqual([403, true]);
    }).pipe(Effect.scoped),
  );

  it.live("locks signing in for a while after too many wrong passwords", () =>
    Effect.gen(function* () {
      const { user } = yield* farmAndUser();
      yield* user.setPassword({ here: true }, "correct horse");
      for (let i = 0; i < 5; i++) {
        const wrong = yield* Effect.flip(user.login("guess " + i, "猜的"));
        expect(wrong).toMatchObject({ reason: "密码不对" });
      }
      const locked = yield* Effect.flip(user.login("correct horse", "我的"));
      expect(locked).toMatchObject({ reason: expect.stringContaining("秒后再试") });
      expect(user.devices()).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live("lets the user refuse a device, and holds a second one off", () =>
    Effect.gen(function* () {
      const { lan, user } = yield* farmAndUser();
      const addr = yield* open(lan);
      const s = yield* lan.startPairing();
      const got = ask(addr, s.pairing!.code, "陌生人");
      yield* until(() => lan.status().pairing?.asking === "陌生人", "it questions");
      const answer2 = yield* Effect.promise(() => ask(addr, s.pairing!.code, "又一个"));
      expect(answer2).toContain("另一台设备");
      yield* lan.answer(false);
      const body = yield* Effect.promise(() => got);
      expect(body).toContain("LanRefused");
      expect(body).toContain("没让");
      expect(user.devices()).toEqual([]);
      expect(lan.status().pairing).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.live("calls the pairing off after too many wrong codes", () =>
    Effect.gen(function* () {
      const lan = yield* farm();
      const addr = yield* open(lan);
      const s = yield* lan.startPairing();
      for (let i = 0; i < 5; i++) {
        const reply = yield* Effect.promise(() => ask(addr, "WRONGCODE", "猜码的"));
        expect(reply).toContain("配对码不对");
      }
      const answer = yield* Effect.promise(() => ask(addr, s.pairing!.code, "猜码的"));
      expect(answer).toContain("过期");
    }).pipe(Effect.scoped),
  );

  it.live("ends a forgotten device's streams", () =>
    Effect.gen(function* () {
      const { lan, user } = yield* farmAndUser();
      const addr = yield* open(lan);
      const paired = yield* pair(lan, addr, "旧手机");
      // The test reaches the listener as a paired phone's browser does, through the platform's own fetch.
      // @effect-diagnostics-next-line globalFetchInEffect:off
      const res = yield* Effect.promise(() => fetch(addr + "/api/v1/state", { headers: { authorization: "Bearer " + paired.key } }));
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const first = new TextDecoder().decode((yield* Effect.promise(() => reader.read())).value);
      expect(first.startsWith("data:")).toBe(true);
      const ended = (async () => {
        try {
          for (;;) if ((await reader.read()).done) return "ended";
        } catch {
          return "ended";
        }
      })();
      yield* user.revoke(paired.device);
      const ended2 = yield* Effect.promise(() => ended);
      expect(ended2).toBe("ended");
      expect((yield* Effect.promise(() => request("POST", addr + healthPath, paired.key))).status).toBe(401);
    }).pipe(Effect.scoped),
  );
  it.live("hands a paired device's WebSocket to the farm, and forgetting the device ends it", () =>
    Effect.gen(function* () {
      const { lan, user } = yield* farmAndUser();
      const addr = yield* open(lan);
      const paired = yield* pair(lan, addr, "手机");
      expect((yield* Effect.promise(() => upgradeAt(addr, {}))).status).toBe(401);
      const key = { authorization: "Bearer " + paired.key };
      expect((yield* Effect.promise(() => upgradeAt(addr, { ...key, origin: "https://evil.example" }))).status).toBe(403);
      const { status, socket } = yield* Effect.promise(() => upgradeAt(addr, { ...key, origin: addr }));
      expect(status).toBe(101);
      const ended = new Promise<string>((resolve) => socket!.once("close", () => resolve("ended")));
      yield* user.revoke(paired.device);
      const ended2 = yield* Effect.promise(() => ended);
      expect(ended2).toBe("ended");
    }).pipe(Effect.scoped),
  );
});
