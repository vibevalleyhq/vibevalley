import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineRuntime, type InstallationSnapshot, RuntimeRegistry } from "@botiverse/oar";
import { afterEach, describe, expect, it } from "@effect/vitest";
import type { Agent, LiveEvent, RuntimeInfo } from "@vibevalley/protocol";
import { factsOf, presetOf, runtimeIds } from "../agent/seed.ts";
import { Effect, Layer, Stream } from "effect";
import { Agents, layer as agentLayer } from "../agent/agent.ts";
import { type Config, Settings } from "../base/config.ts";
import { Core, layer as coreLayer } from "../core/core.ts";
import { layer as projection } from "../projection/projection.ts";
import { testConfig } from "../testing/layers.ts";
import { piBalance } from "./pi.ts";
import { inCny, price } from "./price.ts";
import { make, type RuntimeOptions, usable } from "./runtime.ts";

const fake = (id: string, more: Partial<Parameters<typeof defineRuntime>[0]> = {}) =>
  defineRuntime({ id, session: () => Promise.reject(new Error("no sessions here")), ...more } as Parameters<typeof defineRuntime>[0]);

const notFound = async (id: string): Promise<RuntimeInfo> => ({
  id,
  preset: presetOf(id),
  facts: factsOf(id),
  installation: { status: "not_found" },
  models: null,
  usage: null,
  skills: null,
  mcpServers: null,
  tools: null,
  settings: { enabled: true, binPath: "", defaultModel: "", defaultEffort: "", env: {} },
  checkedAt: Date.now(),
});

const world = (config: Config = testConfig()) =>
  Layer.mergeAll(coreLayer.pipe(Layer.provide(projection)), agentLayer).pipe(Layer.provideMerge(Layer.succeed(Settings, config)));

/** A runtime service over the given runtimes, never asking this machine's. */
const runtimes = (options: RuntimeOptions = {}) => make({ background: false, probe: notFound, usageOf: async () => null, ...options });

const agent = (a: Partial<Agent>): Agent => ({ id: "a", name: "小禾", runtime: "pi", enabled: true, ...a }) as Agent;

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 500 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(ok()).toBe(true);
};

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const env = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

describe("runtime", () => {
  it.live("an accepted probe owns the installation its usage reads use, and a slow one does not overwrite a newer", () => {
    let n = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const registry = new RuntimeRegistry([
      fake("pi", {
        installation: async (): Promise<InstallationSnapshot> => {
          if (++n === 1) {
            await held;
            return { kind: "available", via: "executable", command: "old" };
          }
          return { kind: "available", via: "executable", command: "new" };
        },
      }),
    ]);
    return Effect.gen(function* () {
      let used = "";
      const options: RuntimeOptions = { registry, background: false, usageOf: async () => null };
      const r = yield* make(options);
      const slow = Effect.runPromise(r.refresh("pi"));
      yield* Effect.promise(() => until(() => n === 1));
      yield* r.refresh("pi");
      release();
      yield* Effect.promise(() => slow);
      const got = yield* r.info("pi");
      expect(got!.installation).toMatchObject({ command: "new" });
      options.usageOf = async (_id, _rt, found) => {
        used = found.via === "executable" ? found.command : "";
        return null;
      };
      yield* Effect.promise(() => r.refreshUsage("pi"));
      expect(used).toBe("new");
    }).pipe(Effect.scoped, Effect.provide(world()));
  });

  it.live("an adapter's refusals stop a profile, under the farm's", () =>
    Effect.gen(function* () {
      const registry = new RuntimeRegistry([
        fake("pi", { refusedSessionOptions: { env: "test adapter refuses env" } }),
        fake("opencode", { refusedSessionOptions: { env: "test env" } }),
      ]);
      const r = yield* runtimes({
        registry,
        probe: async (id) => ({ ...(await notFound(id)), installation: { status: "available", via: "executable", command: id, version: null } }),
      });
      const a = agent({ env: { TEST: "value" } });
      const assessed = yield* r.assess(a);
      expect(assessed.info!.facts.refused.env).toBe("test adapter refuses env");
      expect(usable(assessed)).toBe(false);
      expect(usable(yield* r.assess(agent({})))).toBe(true);
      expect(usable(yield* r.assess(agent({ enabled: false })))).toBe(false);
      const opencode = (yield* r.info("opencode"))!.facts.refused;
      expect(opencode).toEqual({ env: "test env", disallowedTools: factsOf("opencode").refused.disallowedTools });
    }).pipe(Effect.scoped, Effect.provide(world())),
  );

  it.live("the list carries every runtime's preset and facts", () =>
    Effect.gen(function* () {
      const registry = new RuntimeRegistry([
        fake("opencode", { refusedSessionOptions: { env: "test env" }, installation: async () => ({ kind: "not_found" }) as const }),
      ]);
      const r = yield* runtimes({ registry, probe: undefined });
      // The first answer does not wait for a probe: every runtime is checking, already with its name, look and facts.
      for (const info of r.list()) {
        expect(info.installation.status).toBe("checking");
        expect(info.preset).toEqual(presetOf(info.id));
      }
      let list: RuntimeInfo[] = [];
      yield* Effect.promise(() =>
        until(() => {
          list = r.list();
          return list.every((i) => i.installation.status !== "checking");
        }),
      );
      expect(list.map((i) => i.id)).toEqual(runtimeIds());
      const byId = Object.fromEntries(list.map((i) => [i.id, i]));
      expect(byId.opencode!.installation.status).toBe("not_found");
      expect(byId.opencode!.facts.refused).toEqual({ env: "test env", disallowedTools: factsOf("opencode").refused.disallowedTools });
      expect(byId.claude!.installation.status).toBe("unsupported");
      expect(byId.claude!.preset.label).toBe("Claude Code");
      expect(byId.claude!.facts.capabilities).toEqual(factsOf("claude").capabilities);
      expect(JSON.stringify(byId.claude)).toMatch(/"preset":\{"id":"claude","label":"Claude Code"/);
      expect(JSON.stringify(byId.claude)).toMatch(/"facts":\{"steer":true,"refused":\{\}/);
    }).pipe(Effect.scoped, Effect.provide(world())),
  );

  it.live("two farms' binaries do not meet in the environment", () => {
    const before = process.env.OAR_PI_BIN;
    process.env.OAR_PI_BIN = "external-default";
    const registry = new RuntimeRegistry([
      fake("pi", {
        installation: async () => {
          const bin = process.env.OAR_PI_BIN;
          await new Promise((r) => setTimeout(r, 5));
          return { kind: "available", via: "executable", command: bin ?? "none" } as const;
        },
      }),
    ]);
    const farm = (bin: string) =>
      Effect.gen(function* () {
        yield* Effect.flatMap(Agents, (a) => a.saveSettings("pi", { enabled: true, binPath: bin, defaultModel: "", defaultEffort: "", env: {} }));
        const r = yield* runtimes({ registry, probe: undefined });
        yield* r.refresh("pi");
        return yield* r.resolve(agent({}));
      }).pipe(Effect.scoped, Effect.provide(world()));
    return Effect.gen(function* () {
      const [a, b] = yield* Effect.all([farm("first-bin"), farm("second-bin")], { concurrency: "unbounded" });
      expect([a.installation, b.installation]).toMatchObject([{ command: "first-bin" }, { command: "second-bin" }]);
      expect(process.env.OAR_PI_BIN).toBe("external-default");
    }).pipe(Effect.ensuring(Effect.sync(() => env("OAR_PI_BIN", before))));
  });

  it.live("yesterday's spending does not stop today's work", () =>
    Effect.gen(function* () {
      const r = yield* runtimes({ probe: notFound });
      const agents = yield* Agents;
      yield* agents.saveSettings("pi", { ...agents.settings("pi"), dailyBudget: 10 });
      yield* r.refresh("pi");
      r.setSpent({ day: "2000-01-01", byRuntime: { pi: 12 } });
      const got = yield* r.info("pi");
      expect([got!.spentToday, got!.stop]).toEqual([undefined, undefined]);
      r.spend("pi", 3);
      expect((yield* r.info("pi"))!.spentToday).toBe(3);
      r.spend("pi", 9);
      expect((yield* r.info("pi"))!.stop).toMatch(/每日预算 ¥10\.00/);
    }).pipe(Effect.scoped, Effect.provide(world())),
  );

  it.live("an update that cannot be saved is refused, and nothing is probed", () => {
    const config = testConfig();
    let probed = false;
    return Effect.gen(function* () {
      const r = yield* runtimes({
        probe: async (id) => {
          probed = true;
          return notFound(id);
        },
      });
      const file = join(config.home, "config.json");
      rmSync(file);
      mkdirSync(file);
      expect((yield* Effect.flip(r.update("pi", { enabled: true, binPath: "", defaultModel: "unsaved", defaultEffort: "", env: {} })))._tag).toBe("Refused");
      expect(probed).toBe(false);
      expect((yield* Agents).settings("pi").defaultModel).not.toBe("unsaved");
    }).pipe(Effect.scoped, Effect.provide(world(config)));
  });

  it.live("resolve owns the defaults, the overrides and the model's fallback", () =>
    Effect.gen(function* () {
      yield* Effect.flatMap(Agents, (a) =>
        a.saveSettings("pi", { enabled: true, binPath: "", defaultModel: "known", defaultEffort: "default-effort", env: { base: "kept", override: "base" } }),
      );
      const r = yield* runtimes({
        registry: new RuntimeRegistry([fake("pi")]),
        probe: async (id) => ({ ...(await notFound(id)), models: [{ id: "known", name: "known", effortLevels: [], isDefault: false }] }),
      });
      const a = agent({ env: { override: "profile" } });
      const got = yield* r.resolve(a);
      expect([got.runtime.id, got.model, got.effort, got.env]).toEqual(["pi", "known", "default-effort", { base: "kept", override: "profile" }]);
      const core = yield* Core;
      const notices: LiveEvent[] = [];
      yield* Effect.forkScoped(Stream.runForEach(core.live, (e) => Effect.sync(() => notices.push(e))));
      yield* Effect.sleep(10);
      const fallback = yield* r.resolve({ ...a, model: "unknown", effort: "profile-effort" });
      expect([fallback.model, fallback.effort]).toEqual(["", "profile-effort"]);
      yield* Effect.promise(() => until(() => notices.some((e) => e.type === "notice")));
    }).pipe(Effect.scoped, Effect.provide(world())),
  );

  it("a rate counts cache tokens apart and charges in yuan", () => {
    const rate = inCny({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.5 }, 7);
    expect(rate.charge({ input: 1_000_000, output: 0, cacheRead: 400_000 })).toBe(0.64 * 7);
    expect(rate.charge({ input: 10, output: 0, cacheRead: 20 })).toBe((2.0 / 1_000_000) * 7);
    expect(price("missing", "unknown")).toBeUndefined();
  });

  it("dsh prices DeepSeek's own models", () => {
    expect(price("dsh", "deepseek-official/deepseek-flash")?.input).toBe(0.14);
    expect(price("dsh", "deepseek-official/deepseek-v4-flash")).toBeUndefined();
    expect(price("dsh", "openrouter/deepseek-flash")).toBeUndefined();
    expect(price("vibevalley", "")?.input).toBe(0.14);
  });

  it("pi's balance, as pi configures DeepSeek", async () => {
    const saved = { dir: process.env.OAR_PI_AGENT_DIR, key: process.env.DEEPSEEK_API_KEY, mine: process.env.MY_DEEPSEEK };
    const balance = async (key: string) => {
      const s = createServer((req, res) => {
        if (req.url !== "/user/balance" || req.headers.authorization !== "Bearer " + key) return void res.writeHead(401).end();
        res.end(JSON.stringify({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "12.50" }] }));
      });
      servers.push(s);
      await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
      return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    };
    const piHome = (models: string, auth: string) => {
      const dir = mkdtempSync(join(tmpdir(), "pi-"));
      dirs.push(dir);
      process.env.OAR_PI_AGENT_DIR = dir;
      writeFileSync(join(dir, "settings.json"), `{"defaultProvider":"deepseek","defaultModel":"deepseek-chat"}`);
      if (models) writeFileSync(join(dir, "models.json"), models);
      if (auth) writeFileSync(join(dir, "auth.json"), auth);
    };
    const want = { status: "balance", provider: "DeepSeek", available: true, balances: [{ currency: "CNY", amount: 12.5 }] };
    try {
      let url = await balance("sk-from-env");
      delete process.env.DEEPSEEK_API_KEY;
      process.env.MY_DEEPSEEK = "sk-from-env";
      piHome(`{"providers":{"deepseek":{"apiKey":"$MY_DEEPSEEK","baseUrl":"${url}/v1/"}}}`, "");
      expect(await piBalance({ defaultModel: "" })).toEqual(want);
      url = await balance("sk-auth");
      process.env.DEEPSEEK_API_KEY = "sk-env";
      piHome(`{"providers":{"deepseek":{"apiKey":"sk-models","baseUrl":"${url}"}}}`, `{"deepseek":{"type":"api_key","key":"sk-auth"}}`);
      expect(await piBalance({ defaultModel: "" })).toEqual(want);
      url = await balance("sk-env");
      piHome(`{"providers":{"deepseek":{"apiKey":"sk-models","baseUrl":"${url}"}}}`, "");
      expect(await piBalance({ defaultModel: "" })).toEqual(want);
      delete process.env.DEEPSEEK_API_KEY;
      piHome(`{"providers":{"deepseek":{"baseUrl":"${url}"}}}`, "");
      expect(await piBalance({ defaultModel: "" })).toEqual({ status: "login_required" });
      expect(await piBalance({ defaultModel: "anthropic/claude" })).toEqual({ status: "unavailable", reason: "anthropic 不报余额" });
    } finally {
      env("OAR_PI_AGENT_DIR", saved.dir);
      env("DEEPSEEK_API_KEY", saved.key);
      env("MY_DEEPSEEK", saved.mine);
    }
  });
});
