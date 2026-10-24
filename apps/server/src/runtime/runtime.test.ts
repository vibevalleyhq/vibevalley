import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineRuntime, type InstallationSnapshot, RuntimeRegistry } from "@botiverse/oar";
import { afterEach, describe, expect, it } from "@effect/vitest";
import type { Agent, LiveEvent, RuntimeInfo } from "@vibevalley/protocol";
import { factsOf, presetOf, runtimeIds } from "../agent/seed.ts";
import { Effect, Exit, Layer, Scope, Stream } from "effect";
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

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

  it.live("inherited session options are checked before a profile can be chosen", () =>
    Effect.gen(function* () {
      const store = yield* Agents;
      yield* store.saveSettings("antigravity", {
        ...store.settings("antigravity"),
        defaultEffort: "high",
        env: { INHERITED: "set" },
      });
      const r = yield* runtimes({
        registry: new RuntimeRegistry([fake("antigravity", { refusedSessionOptions: { env: "no env" } })]),
        probe: async (id) => ({ ...(await notFound(id)), installation: { status: "available", via: "bundled", command: id, version: null } }),
      });
      const a = agent({ runtime: "antigravity" });
      const assessed = yield* r.assess(a);
      expect(assessed.blocking.map((i) => i.field)).toEqual(["effort", "env"]);
      expect(usable(assessed)).toBe(false);
      expect(yield* r.check(a)).toEqual(assessed.issues);
      expect((yield* Effect.flip(r.resolve(a)))._tag).toBe("Refused");
    }).pipe(Effect.scoped, Effect.provide(world())),
  );

  it.live("model effort checks use the inherited effort and allow a profile override", () =>
    Effect.gen(function* () {
      const store = yield* Agents;
      yield* store.saveSettings("pi", {
        ...store.settings("pi"),
        defaultModel: "known",
        defaultEffort: "high",
        env: { BASE: "kept", OVERRIDE: "default" },
      });
      const r = yield* runtimes({
        registry: new RuntimeRegistry([fake("pi")]),
        probe: async (id) => ({
          ...(await notFound(id)),
          installation: { status: "available", via: "bundled", command: id, version: null },
          models: [{ id: "known", name: "Known", effortLevels: ["low"], isDefault: true }],
        }),
      });
      expect((yield* r.assess(agent({}))).blocking.map((i) => i.field)).toEqual(["effort"]);
      const override = agent({ effort: "low", env: { OVERRIDE: "profile" } });
      expect(usable(yield* r.assess(override))).toBe(true);
      const sent = yield* r.resolve(override);
      expect([sent.model, sent.effort, sent.env]).toEqual(["known", "low", { BASE: "kept", OVERRIDE: "profile" }]);
    }).pipe(Effect.scoped, Effect.provide(world())),
  );

  for (const source of ["profile", "runtime"] as const)
    it.live(`an unknown ${source} model warns and checks effort against the actual fallback`, () =>
      Effect.gen(function* () {
        const store = yield* Agents;
        yield* store.saveSettings("pi", { ...store.settings("pi"), defaultModel: source === "runtime" ? "missing" : "configured", defaultEffort: "high" });
        const r = yield* runtimes({
          registry: new RuntimeRegistry([fake("pi")]),
          probe: async (id) => ({
            ...(await notFound(id)),
            installation: { status: "available", via: "bundled", command: id, version: null },
            models: [
              { id: "configured", name: "Configured", effortLevels: ["high"], isDefault: false },
              { id: "fallback", name: "Fallback", effortLevels: ["low"], isDefault: true },
            ],
          }),
        });
        const a = agent({ model: source === "profile" ? "missing" : "" });
        const issues = yield* r.check(a);
        expect(issues).toEqual([
          { field: "model", level: "warn", text: "pi 的模型列表里没有 missing" },
          { field: "effort", level: "error", text: "pi 默认用的 Fallback 没有 high 这一档，可选：low" },
        ]);
        expect((yield* Effect.flip(r.resolve(a)))._tag).toBe("Refused");
        const sent = yield* r.resolve({ ...a, effort: "low" });
        expect([sent.model, sent.effort]).toEqual(["", "low"]);
      }).pipe(Effect.scoped, Effect.provide(world())),
    );

  it.live("a saved configuration is checked while its refreshed probe is still running", () => {
    let waiting = false;
    let release!: () => void;
    const held = new Promise<void>((done) => (release = done));
    return Effect.gen(function* () {
      let probes = 0;
      const r = yield* runtimes({
        registry: new RuntimeRegistry([fake("pi")]),
        probe: async (id) => {
          if (++probes > 1) {
            waiting = true;
            await held;
          }
          return {
            ...(await notFound(id)),
            installation: { status: "available", via: "bundled", command: id, version: null },
            models: [{ id: "known", name: "Known", effortLevels: ["low"], isDefault: true }],
          };
        },
      });
      yield* r.info("pi");
      const store = yield* Agents;
      const updating = Effect.runPromise(r.update("pi", { ...store.settings("pi"), defaultEffort: "high" }));
      yield* Effect.promise(() => until(() => waiting));
      const a = agent({});
      expect((yield* r.check(a)).map((i) => i.field)).toEqual(["effort"]);
      expect((yield* Effect.flip(r.resolve(a)))._tag).toBe("Refused");
      release();
      yield* Effect.promise(() => updating);
    }).pipe(Effect.ensuring(Effect.sync(() => release())), Effect.scoped, Effect.provide(world()));
  });

  for (const option of ["effort", "env"] as const)
    it.live(`resolve refuses a newly saved ${option} even after the profile passed its dispatch check`, () =>
      Effect.gen(function* () {
        const r = yield* runtimes({
          registry: new RuntimeRegistry([fake("pi", { refusedSessionOptions: { env: "no env" } })]),
          probe: async (id) => ({
            ...(await notFound(id)),
            installation: { status: "available", via: "bundled", command: id, version: null },
            models: [{ id: "known", name: "Known", effortLevels: ["low"], isDefault: true }],
          }),
        });
        const a = agent({});
        expect(yield* r.check(a)).toEqual([]);
        const store = yield* Agents;
        yield* r.update("pi", {
          ...store.settings("pi"),
          ...(option === "effort" ? { defaultEffort: "high" } : { env: { NEW: "set" } }),
        });
        const resolved = yield* Effect.result(r.resolve(a));
        expect(resolved._tag).toBe("Failure");
        if (resolved._tag === "Failure")
          expect(resolved.failure).toEqual({
            _tag: "Refused",
            reason: "小禾 派不出去：" + (option === "env" ? "no env" : "pi 默认用的 Known 没有 high 这一档，可选：low"),
          });
      }).pipe(Effect.scoped, Effect.provide(world())),
    );

  it.live("resolving an existing session does not reapply dispatch availability or spending policy", () =>
    Effect.gen(function* () {
      const r = yield* runtimes({
        registry: new RuntimeRegistry([fake("pi")]),
        probe: async (id) => ({ ...(await notFound(id)), installation: { status: "available", via: "bundled", command: id, version: null } }),
      });
      const store = yield* Agents;
      yield* r.update("pi", { ...store.settings("pi"), enabled: false, dailyBudget: 1 });
      r.spend("pi", 1);
      const a = agent({ enabled: false });
      expect(usable(yield* r.assess(a))).toBe(false);
      expect((yield* r.resolve(a)).runtime.id).toBe("pi");
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

  it.live("a failed list probe is retried without changing the synchronous checking answer", () => {
    const first = deferred<RuntimeInfo>();
    let probes = 0;
    return Effect.gen(function* () {
      const r = yield* runtimes({
        probe: (id) => {
          if (id !== "pi") return notFound(id);
          probes++;
          return probes === 1 ? first.promise : notFound(id);
        },
      });
      const pi = () => r.list().find((info) => info.id === "pi")!;
      expect(pi().installation.status).toBe("checking");
      yield* Effect.promise(() => until(() => probes === 1));
      first.reject(new Error("first probe failed"));
      yield* Effect.sleep(20);
      expect(pi().installation.status).toBe("checking");
      yield* Effect.promise(() => until(() => probes === 2 && pi().installation.status === "not_found"));
      expect(probes).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(world()));
  });

  it.live("an old read's failure does not clear the newer read's checking marker", () => {
    const old = deferred<RuntimeInfo>();
    const latest = deferred<RuntimeInfo>();
    let probes = 0;
    return Effect.gen(function* () {
      const r = yield* runtimes({
        probe: (id) => {
          if (id !== "pi") return notFound(id);
          probes++;
          return probes === 1 ? old.promise : latest.promise;
        },
      });
      const oldResult = Effect.runPromise(r.refresh("pi")).then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      yield* Effect.promise(() => until(() => probes === 1));
      const latestResult = Effect.runPromise(r.refresh("pi"));
      yield* Effect.promise(() => until(() => probes === 2));
      old.reject(new Error("old probe failed"));
      expect(yield* Effect.promise(() => oldResult)).toMatchObject({ status: "rejected" });
      expect(r.list().find((info) => info.id === "pi")!.installation.status).toBe("checking");
      yield* Effect.sleep(20);
      expect(probes).toBe(2);
      latest.resolve(yield* Effect.promise(() => notFound("pi")));
      expect((yield* Effect.promise(() => latestResult))!.installation.status).toBe("not_found");
    }).pipe(Effect.scoped, Effect.provide(world()));
  });

  it.live("an older usage read cannot overwrite a newer full probe", () => {
    const fullProbe = deferred<void>();
    const usageGate = deferred<void>();
    const entered = deferred<void>();
    let probes = 0;
    let firstUsage = true;
    const registry = new RuntimeRegistry([
      fake("pi", {
        installation: async (): Promise<InstallationSnapshot> => {
          probes++;
          if (probes === 2) await fullProbe.promise;
          return { kind: "available", via: "executable", command: probes === 1 ? "old" : "new" };
        },
      }),
    ]);
    return Effect.gen(function* () {
      const r = yield* make({
        registry,
        background: false,
        usageOf: async (_id, _runtime, found) => {
          if (firstUsage) {
            firstUsage = false;
            return null;
          }
          if (found.via === "executable" && found.command === "new") return null;
          entered.resolve();
          await usageGate.promise;
          return { status: "ok" as const, subscription: "old", windows: [] };
        },
      });
      yield* r.refresh("pi");
      const core = yield* Core;
      const commands: string[] = [];
      yield* Effect.forkScoped(
        Stream.runForEach(core.live, (event) =>
          Effect.sync(() => {
            if (event.type !== "runtime") return;
            const installation = event.info.installation;
            if (installation.status === "available") commands.push(installation.command);
          }),
        ),
      );
      yield* Effect.sleep(10);
      const full = Effect.runPromise(r.refresh("pi"));
      yield* Effect.promise(() => until(() => probes === 2));
      const pending = r.refreshUsage("pi");
      yield* Effect.promise(() => entered.promise);
      fullProbe.resolve();
      yield* Effect.promise(() => full);
      const command = () => {
        const installation = r.cached.get("pi")!.info.installation;
        return installation.status === "available" ? installation.command : "";
      };
      expect(command()).toBe("new");
      usageGate.resolve();
      yield* Effect.promise(() => pending);
      expect(command()).toBe("new");
      expect(r.cached.get("pi")!.info.usage).toBeNull();
      expect(commands).toEqual(["new"]);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          fullProbe.resolve();
          usageGate.resolve();
        }),
      ),
      Effect.scoped,
      Effect.provide(world()),
    );
  });

  it.live("a deferred probe cannot begin, write cache or emit after its service closes", () => {
    const entered = deferred<void>();
    const held = deferred<void>();
    let probes = 0;
    return Effect.gen(function* () {
      const scope = yield* Scope.make();
      return yield* Effect.gen(function* () {
        const r = yield* Scope.provide(scope)(
          runtimes({
            probe: async (id) => {
              probes++;
              entered.resolve();
              await held.promise;
              return notFound(id);
            },
          }),
        );
        const core = yield* Core;
        const events: LiveEvent[] = [];
        yield* Effect.forkScoped(Stream.runForEach(core.live, (event) => Effect.sync(() => events.push(event))));
        yield* Effect.sleep(10);
        const pending = Effect.runPromise(r.refresh("pi"));
        yield* Effect.promise(() => entered.promise);
        yield* Scope.close(scope, Exit.void);
        held.resolve();
        yield* Effect.promise(() => pending);
        yield* Effect.sleep(20);
        expect(r.cached.has("pi")).toBe(false);
        expect(events.filter((event) => event.type === "runtime")).toEqual([]);
        expect(yield* r.refresh("pi")).toBeUndefined();
        expect(probes).toBe(1);
        expect(r.cached.has("pi")).toBe(false);
        expect(events.filter((event) => event.type === "runtime")).toEqual([]);
      }).pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            held.resolve();
            return Scope.close(scope, Exit.void);
          }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(world()));
  });

  it.live("a deferred usage read cannot overwrite cache or emit after its service closes", () => {
    const entered = deferred<void>();
    const held = deferred<void>();
    const registry = new RuntimeRegistry([
      fake("pi", { installation: async (): Promise<InstallationSnapshot> => ({ kind: "available", via: "executable", command: "pi" }) }),
    ]);
    let late = false;
    return Effect.gen(function* () {
      const scope = yield* Scope.make();
      return yield* Effect.gen(function* () {
        const r = yield* Scope.provide(scope)(
          make({
            registry,
            background: false,
            usageOf: async () => {
              if (!late) return null;
              entered.resolve();
              await held.promise;
              return { status: "ok" as const, subscription: "late", windows: [] };
            },
          }),
        );
        yield* r.refresh("pi");
        const checkedAt = r.cached.get("pi")!.info.checkedAt;
        const core = yield* Core;
        const events: LiveEvent[] = [];
        yield* Effect.forkScoped(Stream.runForEach(core.live, (event) => Effect.sync(() => events.push(event))));
        yield* Effect.sleep(10);
        late = true;
        const pending = r.refreshUsage("pi");
        yield* Effect.promise(() => entered.promise);
        yield* Scope.close(scope, Exit.void);
        held.resolve();
        yield* Effect.promise(() => pending);
        yield* Effect.sleep(20);
        expect(r.cached.get("pi")!.info.checkedAt).toBe(checkedAt);
        expect(r.cached.get("pi")!.info.usage).toBeNull();
        expect(events.filter((event) => event.type === "runtime")).toEqual([]);
      }).pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            held.resolve();
            return Scope.close(scope, Exit.void);
          }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(world()));
  });

  it.live("crossing midnight clears spending and opens the daily budget gate with the injected clock", () => {
    let now = new Date(2026, 0, 1, 23, 59).getTime();
    return Effect.gen(function* () {
      const r = yield* runtimes({
        now: () => now,
        probe: async (id) => ({
          ...(await notFound(id)),
          installation: { status: "available", via: "bundled", command: id, version: null },
        }),
      });
      const agents = yield* Agents;
      yield* agents.saveSettings("pi", { ...agents.settings("pi"), dailyBudget: 10 });
      yield* r.refresh("pi");
      r.spend("pi", 12);
      const blocked = yield* r.assess(agent({}));
      expect(usable(blocked)).toBe(false);
      expect(blocked.blocking.some((issue) => issue.text.includes("每日预算 ¥10.00"))).toBe(true);
      now += 2 * 60_000;
      const got = yield* r.info("pi");
      expect([got!.spentToday, got!.stop]).toEqual([undefined, undefined]);
      expect(r.spent()).toEqual({ day: "2026-01-02", byRuntime: {} });
      expect(usable(yield* r.assess(agent({})))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(world()));
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
