import { writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";

import { attachmentPath, lanKeyCookie, type LanPaired } from "@vibevalley/protocol";
import { pathOf } from "@vibevalley/protocol/api";
import { rpcPath } from "@vibevalley/protocol/rpc";
import { tempDir } from "@vibevalley/testkit/temp";

import { app } from "@/http/app.ts";
import { testConfig } from "@/testing/layers.ts";
import { until } from "@/testing/until.ts";
import { quietApp } from "@/testing/world.ts";

import { Lan, remoteMay } from "./lan.ts";

const web = tempDir("vv-lan-web-");
writeFileSync(join(web, "index.html"), "<!doctype html><title>VibeValley</title>");

/** The whole farm on a free port, with a page, its lan listener on loopback, which it calls its network address. */
const farm = (lanPort = 0) =>
  Effect.gen(function* () {
    const config = { ...testConfig(), web, lan: { port: lanPort } };
    const built = yield* Layer.build(app(config, 0, () => Effect.void, { ...quietApp, lan: { host: "127.0.0.1", address: () => "127.0.0.1" } }));
    return Context.get(built, Lan);
  });

const request = async (method: string, url: string, key: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(url, {
    method,
    headers: { ...(key ? { authorization: "Bearer " + key } : {}), ...headers },
    ...(body !== undefined && method !== "GET" ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.text() };
};

const healthPath = pathOf("server.health.get");

const ask = (addr: string, code: string, name: string) =>
  fetch(addr + pathOf("lan.pair"), { method: "POST", body: JSON.stringify({ code, name }) }).then((r) => r.text());

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
    const paired = JSON.parse(yield* Effect.promise(() => got)) as LanPaired;
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
      expect(lan.status()).toMatchObject({ open: false, devices: [] });
      expect(lan.status().url).toBeUndefined();
      expect(yield* Effect.flip(lan.startPairing())).toMatchObject({ _tag: "LanRefused" });
      const addr = yield* open(lan);
      expect((yield* Effect.promise(() => request("POST", addr + healthPath, ""))).status).toBe(401);
      // The page holds nothing of the farm's: a device not paired yet gets it, to pair on.
      for (const path of ["/", "/pair"]) {
        const page = yield* Effect.promise(() => request("GET", addr + path, "", undefined, { "sec-fetch-site": "cross-site" }));
        expect([path, page.status, page.body]).toEqual([path, 200, expect.stringContaining("VibeValley")]);
      }
      yield* lan.setOpen(false);
      expect(
        yield* Effect.promise(() =>
          // The test reaches the listener as a paired phone's browser does, through the platform's own fetch.
          // @effect-diagnostics-next-line globalFetchInEffect:off
          fetch(addr + healthPath, { method: "POST" }).then(
            () => "answered",
            () => "shut",
          ),
        ),
      ).toBe("shut");
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
      const lan = yield* farm();
      const addr = yield* open(lan);
      const paired = yield* pair(lan, addr, "  小明的\niPhone ");
      const s = lan.status();
      expect(s.pairing).toBeUndefined();
      expect(s.devices.map((d) => d.name)).toEqual(["小明的 iPhone"]);
      for (const origin of [addr, "https://evil.example"]) {
        const res = yield* Effect.promise(() => request("POST", addr + healthPath, "", undefined, { origin, cookie: `${lanKeyCookie}=${paired.key}` }));
        expect(res.status).toBe(origin === addr ? 200 : 403);
      }
      const health = yield* Effect.promise(() => request("POST", addr + healthPath, paired.key));
      expect([health.status, health.body]).toEqual([200, expect.stringContaining(`"ok":true`)]);
      const me = yield* Effect.promise(() => request("POST", addr + pathOf("lan.me.get"), paired.key));
      expect(me.status).toBe(200);
      expect(JSON.parse(me.body)).toMatchObject({ id: paired.device, lastSeen: expect.any(Number) });
      // A paired browser's cookie is a key as the header is.
      const byCookie = yield* Effect.promise(() =>
        // The test reaches the listener as a paired phone's browser does, through the platform's own fetch.
        // @effect-diagnostics-next-line globalFetchInEffect:off
        fetch(addr + pathOf("lan.me.get"), { method: "POST", headers: { cookie: `other=1; ${lanKeyCookie}=${paired.key}` } }),
      );
      expect(byCookie.status).toBe(200);
      // The test reaches the listener as a paired phone's browser does, through the platform's own fetch.
      // @effect-diagnostics-next-line globalFetchInEffect:off
      expect((yield* Effect.promise(() => fetch(addr + healthPath, { method: "POST", headers: { cookie: `${lanKeyCookie}=nope` } }))).status).toBe(401);
      for (const path of ["/mcp", "/mcp/x"]) expect((yield* Effect.promise(() => request("GET", addr + path, paired.key))).status).toBe(404);
      expect((yield* Effect.promise(() => request("POST", addr + "/pair", ""))).status).toBe(404);
      // What configures the farm stays on this computer: keys, a runtime's command, profiles, skills, chat accounts.
      for (const op of [
        "lan.get",
        "lan.update",
        "lan.pairing.start",
        "lan.device.delete",
        "setting.update",
        "runtime.setting.update",
        "agent.create",
        "skill.update",
        "connector.login",
      ] as const) {
        const got = yield* Effect.promise(() => request("POST", addr + pathOf(op), paired.key, { open: false }));
        expect([op, got.status, got.body.includes("LanRefused")]).toEqual([op, 403, true]);
      }
      expect((yield* Effect.promise(() => request("POST", addr + healthPath, paired.key + "x"))).status).toBe(401);
      expect(yield* Effect.flip(lan.me(undefined))).toMatchObject({ _tag: "LanRefused" });
    }).pipe(Effect.scoped),
  );

  it.live("lets the owner refuse a device, and holds a second one off", () =>
    Effect.gen(function* () {
      const lan = yield* farm();
      const addr = yield* open(lan);
      const s = yield* lan.startPairing();
      const got = ask(addr, s.pairing!.code, "陌生人");
      yield* until(() => lan.status().pairing?.asking === "陌生人", "it questions");
      expect(yield* Effect.promise(() => ask(addr, s.pairing!.code, "又一个"))).toContain("另一台设备");
      yield* lan.answer(false);
      const body = yield* Effect.promise(() => got);
      expect(body).toContain("LanRefused");
      expect(body).toContain("没让");
      expect(lan.status()).toMatchObject({ devices: [] });
      expect(lan.status().pairing).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.live("calls the pairing off after too many wrong codes", () =>
    Effect.gen(function* () {
      const lan = yield* farm();
      const addr = yield* open(lan);
      const s = yield* lan.startPairing();
      for (let i = 0; i < 5; i++) expect(yield* Effect.promise(() => ask(addr, "WRONGCODE", "猜码的"))).toContain("配对码不对");
      expect(yield* Effect.promise(() => ask(addr, s.pairing!.code, "猜码的"))).toContain("过期");
    }).pipe(Effect.scoped),
  );

  it.live("ends a forgotten device's streams", () =>
    Effect.gen(function* () {
      const lan = yield* farm();
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
      yield* lan.forget(paired.device);
      expect(yield* Effect.promise(() => ended)).toBe("ended");
      expect((yield* Effect.promise(() => request("POST", addr + healthPath, paired.key))).status).toBe(401);
    }).pipe(Effect.scoped),
  );
  it.live("hands a paired device's WebSocket to the farm, and forgetting the device ends it", () =>
    Effect.gen(function* () {
      const lan = yield* farm();
      const addr = yield* open(lan);
      const paired = yield* pair(lan, addr, "手机");
      expect((yield* Effect.promise(() => upgradeAt(addr, {}))).status).toBe(401);
      const key = { authorization: "Bearer " + paired.key };
      expect((yield* Effect.promise(() => upgradeAt(addr, { ...key, origin: "https://evil.example" }))).status).toBe(403);
      const { status, socket } = yield* Effect.promise(() => upgradeAt(addr, { ...key, origin: addr }));
      expect(status).toBe(101);
      const ended = new Promise<string>((resolve) => socket!.once("close", () => resolve("ended")));
      yield* lan.forget(paired.device);
      expect(yield* Effect.promise(() => ended)).toBe("ended");
    }).pipe(Effect.scoped),
  );
});
