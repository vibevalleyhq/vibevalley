import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { lanKeyCookie, type LanPaired } from "@vibevalley/protocol";
import { Context, Effect, Layer } from "effect";
import { app } from "../http/app.ts";
import { testConfig } from "../testing/layers.ts";
import { Lan } from "./lan.ts";
import { until } from "../testing/until.ts";
import { quietApp } from "../testing/world.ts";

const web = mkdtempSync(join(tmpdir(), "vv-lan-web-"));
writeFileSync(join(web, "index.html"), "<!doctype html><title>VibeValley</title>");

/** The whole farm on a free port, with a page, its lan listener on loopback, which it calls its network address. */
const farm = (lanPort = 0) =>
  Effect.gen(function* () {
    const config = { ...testConfig(), web, lan: { port: lanPort } };
    const built = yield* Layer.build(app(config, 0, () => Effect.void, { ...quietApp, lan: { host: "127.0.0.1", address: () => "127.0.0.1" } }));
    return Context.get(built, Lan);
  });

const request = async (method: string, url: string, key: string, body?: unknown) => {
  const res = await fetch(url, {
    method,
    headers: key ? { authorization: "Bearer " + key } : {},
    ...(body !== undefined && method !== "GET" ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.text() };
};

const ask = (addr: string, code: string, name: string) =>
  fetch(addr + "/api/v1/lan/pair", { method: "POST", body: JSON.stringify({ code, name }) }).then((r) => r.text());

const open = (lan: Lan["Service"]) =>
  Effect.map(lan.setOpen(true), (s) => {
    expect(s).toMatchObject({ open: true });
    expect(s.problem).toBeUndefined();
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

describe("lan access", () => {
  it.live("is shut until opened", () =>
    Effect.gen(function* () {
      const lan = yield* farm();
      expect(lan.status()).toMatchObject({ open: false, devices: [] });
      expect(lan.status().url).toBeUndefined();
      expect(yield* Effect.flip(lan.startPairing())).toMatchObject({ _tag: "LanRefused" });
      const addr = yield* open(lan);
      expect((yield* Effect.promise(() => request("GET", addr + "/api/v1/health", ""))).status).toBe(401);
      // The page holds nothing of the farm's: a device not paired yet gets it, to pair on.
      for (const path of ["/", "/pair"]) {
        const page = yield* Effect.promise(() => request("GET", addr + path, ""));
        expect([path, page.status, page.body]).toEqual([path, 200, expect.stringContaining("VibeValley")]);
      }
      yield* lan.setOpen(false);
      expect(
        yield* Effect.promise(() =>
          fetch(addr + "/api/v1/health").then(
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
      const port = address && typeof address === "object" ? address.port : 0;
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
      const health = yield* Effect.promise(() => request("GET", addr + "/api/v1/health", paired.key));
      expect([health.status, health.body]).toEqual([200, expect.stringContaining(`"ok":true`)]);
      const me = yield* Effect.promise(() => request("GET", addr + "/api/v1/lan/me", paired.key));
      expect(me.status).toBe(200);
      expect(JSON.parse(me.body)).toMatchObject({ id: paired.device, lastSeen: expect.any(Number) });
      // A paired browser's cookie is a key as the header is.
      const byCookie = yield* Effect.promise(() => fetch(addr + "/api/v1/lan/me", { headers: { cookie: `other=1; ${lanKeyCookie}=${paired.key}` } }));
      expect(byCookie.status).toBe(200);
      expect((yield* Effect.promise(() => fetch(addr + "/api/v1/health", { headers: { cookie: `${lanKeyCookie}=nope` } }))).status).toBe(401);
      for (const path of ["/mcp", "/mcp/x"]) expect((yield* Effect.promise(() => request("GET", addr + path, paired.key))).status).toBe(404);
      expect((yield* Effect.promise(() => request("POST", addr + "/pair", ""))).status).toBe(404);
      // What configures the farm stays on this computer: keys, a runtime's command, profiles, skills, chat accounts.
      for (const [method, path] of [
        ["GET", "/api/v1/lan"],
        ["PUT", "/api/v1/lan"],
        ["POST", "/api/v1/lan/pairing"],
        ["DELETE", "/api/v1/lan/devices/" + paired.device],
        ["PUT", "/api/v1/settings"],
        ["PUT", "/api/v1/runtimes/codex/settings"],
        ["POST", "/api/v1/agents"],
        ["PUT", "/api/v1/skills/s1"],
        ["POST", "/api/v1/connectors/weixin/login"],
      ] as const) {
        const got = yield* Effect.promise(() => request(method, addr + path, paired.key, { open: false }));
        expect([method, path, got.status, got.body.includes("LanRefused")]).toEqual([method, path, 403, true]);
      }
      expect((yield* Effect.promise(() => request("GET", addr + "/api/v1/health", paired.key + "x"))).status).toBe(401);
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
      expect((yield* Effect.promise(() => request("GET", addr + "/api/v1/health", paired.key))).status).toBe(401);
    }).pipe(Effect.scoped),
  );
});
