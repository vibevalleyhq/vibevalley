import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { defineRuntime, type InstallationSnapshot, RuntimeRegistry } from "@botiverse/oar";
import { NodeServices } from "@effect/platform-node";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Clock, ConfigProvider, Context, Deferred, Effect, FileSystem, Layer, Schema, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import { setLocale, t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { ApiError, BizCode } from "@vibevalley/protocol/api";
import { tempDir } from "@vibevalley/testkit/temp";
import { waitFor } from "@vibevalley/testkit/until";

import { Core } from "#/core/core.ts";
import { type ServerConfig } from "#/infra/config.ts";
import { localParts } from "#/infra/time.ts";
import { Agent } from "#/modules/agent/agent.ts";
import { sampleAgent } from "#/modules/agent/seed.ts";
import { platform } from "#/services.ts";
import { offlineNetwork, testConfig, nextTurn, whenTrue } from "#/testing/layers.ts";
import { allow, heard, refuse } from "#/testing/refuse.ts";

import { piBalance } from "./pi.ts";
import { supportOf, presetOf, runtimeIds } from "./presets.ts";
import { inCny, price } from "./price.ts";
import { Runtime, type RuntimeOptions, usable } from "./runtime.ts";

const fake = (id: string, more: Partial<Parameters<typeof defineRuntime>[0]> = {}) =>
  defineRuntime({
    id,
    session: () => Promise.reject(new Error("no sessions here")),
    ...more,
  });

const notFound = async (id: string): Promise<T.RuntimeInfo> => ({
  stop: "",
  id,
  preset: presetOf(id),
  support: supportOf(id),
  installation: { status: "not_found" },
  models: null,
  usage: null,
  skills: null,
  mcpServers: null,
  tools: null,
  settings: { enabled: true, binPath: "", defaultModel: "", defaultEffort: "", env: {} },
  checkedAt: await Effect.runPromise(Clock.currentTimeMillis),
});

const world = (config: ServerConfig["Service"] = testConfig()) =>
  Agent.layer.pipe(Layer.provideMerge(platform(config).pipe(Layer.provideMerge(offlineNetwork))));

const makeRuntime = (options: RuntimeOptions) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(Runtime.layer({ registry: new RuntimeRegistry([]), ...options }));
    return Context.get(context, Runtime);
  });

/** A runtime service over the given runtimes, never asking this machine's. */
const runtimes = (options: RuntimeOptions = {}) => makeRuntime({ background: false, probe: notFound, usageOf: async () => null, ...options });

const agent = (a: Partial<T.Agent>): T.Agent => sampleAgent({ id: "a", name: "小禾", ...a });

const until = (ok: () => boolean) => whenTrue(ok, "it");

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) s.close();
  await Effect.runPromise(Effect.forEach(dirs.splice(0), (d) => fs.remove(d, { recursive: true, force: true }), { discard: true }));
});

const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const fs = Effect.runSync(Effect.service(FileSystem.FileSystem).pipe(Effect.provide(NodeServices.layer)));

const env = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};
const envOf = (name: string) => process.env[name];

const noPi = { provider: "", model: "" };

describe("runtime", () => {
  it.live("what a runtime's probe said is said again in the farm's new language", () => {
    const registry = new RuntimeRegistry([
      fake("pi", { installation: async (): Promise<InstallationSnapshot> => ({ kind: "unsupported", reason: t("server.runtime.oarUnknown") }) }),
    ]);
    return Effect.gen(function* () {
      const r = yield* makeRuntime({ registry, background: false, usageOf: async () => null });
      const reason = Effect.map(r.list(), (all) => {
        const got = all.find((x) => x.id === "pi")!.installation;
        return got.status === "unsupported" ? got.reason : "";
      });
      yield* r.refresh("pi");
      const chinese = yield* reason;
      setLocale("en");
      const reason2 = yield* reason;
      // The list shows what it held until the probe in English lands.
      expect(reason2).toBe(chinese);
      yield* waitFor(reason, (r) => r === "oar does not know this runtime", "the reason in English");
      expect((yield* r.info("pi"))!.installation).toMatchObject({ reason: "oar does not know this runtime" });
    }).pipe(Effect.ensuring(Effect.sync(() => setLocale("zh"))), Effect.scoped, Effect.provide(world()));
  });

  it.effect("an accepted probe owns the installation its usage reads use, and a slow one does not overwrite a newer", () => {
    let n = 0;
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
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
      const context2 = yield* Effect.context();
      const runPromise = Effect.runPromiseWith(context2);
      let used = "";
      let observeUsage = false;
      const options: RuntimeOptions = {
        registry,
        background: false,
        usageOf: async (_id, _rt, found) => {
          if (observeUsage) used = found.via === "executable" ? found.command : "";
          return null;
        },
      };
      const r = yield* makeRuntime(options);
      const slow = runPromise(r.refresh("pi"));
      yield* Effect.promise(() => until(() => n === 1));
      yield* r.refresh("pi");
      release();
      yield* Effect.promise(() => slow);
      const got = yield* r.info("pi");
      expect(got!.installation).toMatchObject({ command: "new" });
      observeUsage = true;
      r.usageSoon("pi");
      yield* TestClock.adjust(20_000);
      yield* Effect.promise(() => until(() => used === "new"));
      expect(used).toBe("new");
    }).pipe(Effect.scoped, Effect.provide(world()));
  });

  for (const first of ["full", "usage"] as const)
    it.effect(`a changed usage cannot overwrite a newer full probe (${first} first)`, () => {
      const { promise: fullGate, resolve: releaseFull } = Promise.withResolvers<void>();
      const { promise: usageGate, resolve: releaseUsage } = Promise.withResolvers<void>();
      return Effect.gen(function* () {
        const context2 = yield* Effect.context();
        const runPromise = Effect.runPromiseWith(context2);
        let full = 0;
        let usageCalls = 0;
        const changed: T.AccountUsage = { status: "ok", subscription: "pro", windows: [] };
        const registry = new RuntimeRegistry([
          fake("pi", {
            installation: async (): Promise<InstallationSnapshot> => {
              const n = ++full;
              if (n === 2) await fullGate;
              return { kind: "available", via: "executable", command: n === 1 ? "old" : "new" };
            },
          }),
        ]);
        const r = yield* makeRuntime({
          registry,
          background: false,
          usageOf: async () => {
            if (++usageCalls === 2) {
              await usageGate;
              return changed;
            }
            return null;
          },
        });
        yield* r.refresh("pi");
        const fullRefresh = runPromise(r.refresh("pi"));
        yield* Effect.promise(() => until(() => full === 2));
        r.usageSoon("pi");
        yield* TestClock.adjust(20_000);
        yield* Effect.promise(() => until(() => usageCalls === 2));
        if (first === "full") {
          releaseFull();
          yield* Effect.promise(() => fullRefresh);
          releaseUsage();
          yield* Effect.promise(nextTurn);
        } else {
          releaseUsage();
          yield* Effect.promise(nextTurn);
          releaseFull();
          yield* Effect.promise(() => fullRefresh);
        }
        const got = yield* r.info("pi");
        expect(got!.installation).toMatchObject({ command: "new" });
        expect(got!.usage).toBeNull();
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            releaseFull();
            releaseUsage();
          }),
        ),
        Effect.scoped,
        Effect.provide(world()),
      );
    });

  // The spend push waits spendPushAfterMs on the service's Clock: moved through, not waited for.
  it.effect("a usage read keeps its answer when a spend rebuilds what is shown meanwhile, and a late older one does not undo a newer", () => {
    const out: Deferred.Deferred<T.AccountUsage>[] = [];
    const heldUsage = () => {
      const answer = Deferred.makeUnsafe<T.AccountUsage>();
      out.push(answer);
      return Effect.runPromise(Deferred.await(answer));
    };
    const answer = (n: number, usage: T.AccountUsage) => Deferred.doneUnsafe(out[n]!, Effect.succeed(usage));
    const used = (usedPercent: number) =>
      ({
        status: "ok",
        subscription: "pro",
        windows: [{ label: "5 hours", usedPercent, resetsAt: null }],
      }) as T.AccountUsage;
    return Effect.gen(function* () {
      const pushed: T.RuntimeInfo[] = [];
      const subscribe2 = yield* (yield* Core).subscribe;
      yield* Effect.forkScoped(
        Stream.runForEach(subscribe2, (event) =>
          Effect.sync(() => {
            if (event.type === "runtime") pushed.push(event.info);
          }),
        ),
      );
      let calls = 0;
      const r = yield* makeRuntime({
        registry: new RuntimeRegistry([fake("pi", { installation: async () => ({ kind: "available", via: "executable", command: "pi" }) })]),
        background: true,
        usageOf: async () => (++calls === 1 ? null : heldUsage()),
      });
      yield* Effect.promise(() => whenTrue(() => new Set(pushed.map((info) => info.id)).size === runtimeIds().length, "the initial probes"));
      r.usageSoon("pi");
      yield* TestClock.adjust(20_000);
      yield* Effect.promise(() => whenTrue(() => out.length === 1, "first delayed usage"));
      r.spend("pi", 1);
      yield* TestClock.adjust(3_000);
      yield* Effect.promise(() => whenTrue(() => pushed.some((info) => info.id === "pi" && info.spentToday === 1), "spend push"));
      answer(0, used(40));
      yield* waitFor(r.info("pi"), (info) => info?.usage?.status === "ok" && info.usage.windows[0]?.usedPercent === 40, "the usage kept after spend");
      expect((yield* r.info("pi"))!.spentToday).toBe(1);
      yield* TestClock.adjust(300_000);
      yield* Effect.promise(() => whenTrue(() => out.length === 2, "periodic usage"));
      r.usageSoon("pi");
      yield* TestClock.adjust(20_000);
      yield* Effect.promise(() => whenTrue(() => out.length === 3, "overlapping delayed usage"));
      answer(2, used(100));
      yield* waitFor(r.info("pi"), (info) => info?.usage?.status === "ok" && info.usage.windows[0]?.usedPercent === 100, "the newer usage");
      answer(1, used(70));
      yield* Effect.promise(nextTurn);
      expect((yield* r.info("pi"))!.usage).toEqual(used(100));
    }).pipe(Effect.scoped, Effect.provide(world()));
  });

  it.live("a failed list probe is retried without changing the synchronous checking answer", () => {
    const first = Promise.withResolvers<T.RuntimeInfo>();
    const second = Promise.withResolvers<T.RuntimeInfo>();
    let probes = 0;
    return Effect.gen(function* () {
      const r = yield* runtimes({
        probe: (id) => {
          if (id !== "pi") return notFound(id);
          probes++;
          return probes === 1 ? first.promise : second.promise;
        },
      });
      const pi = Effect.map(r.list(), (all) => all.find((info) => info.id === "pi")!);
      expect((yield* pi).installation.status).toBe("checking");
      yield* Effect.promise(() => until(() => probes === 1));
      first.reject(new Error("first probe failed"));
      // Asked again, the list tries again, and says checking until the second read answers.
      yield* waitFor(pi, (p) => p.installation.status === "checking" && probes === 2, "a second probe");
      expect((yield* pi).installation.status).toBe("checking");
      const notFound2 = yield* Effect.promise(() => notFound("pi"));
      second.resolve(notFound2);
      yield* waitFor(pi, (p) => p.installation.status === "not_found", "the second probe landed");
      expect(probes).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(world()));
  });

  it.live("an old read's failure does not clear the newer read's checking marker", () => {
    const old = Promise.withResolvers<T.RuntimeInfo>();
    const latest = Promise.withResolvers<T.RuntimeInfo>();
    let probes = 0;
    return Effect.gen(function* () {
      const context2 = yield* Effect.context();
      const runPromise = Effect.runPromiseWith(context2);
      const r = yield* runtimes({
        probe: (id) => {
          if (id !== "pi") return notFound(id);
          probes++;
          return probes === 1 ? old.promise : latest.promise;
        },
      });
      const oldResult = runPromise(r.refresh("pi")).then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      yield* Effect.promise(() => until(() => probes === 1));
      const latestResult = runPromise(r.refresh("pi"));
      yield* Effect.promise(() => until(() => probes === 2));
      old.reject(new Error("old probe failed"));
      const oldResult2 = yield* Effect.promise(() => oldResult);
      expect(oldResult2).toMatchObject({ status: "rejected" });
      expect((yield* r.list()).find((info) => info.id === "pi")!.installation.status).toBe("checking");
      const notFound2 = yield* Effect.promise(() => notFound("pi"));
      latest.resolve(notFound2);
      expect((yield* Effect.promise(() => latestResult))!.installation.status).toBe("not_found");
      // The old read's failure started no read of its own.
      expect(probes).toBe(2);
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
        probe: async (id) => ({
          ...(await notFound(id)),
          installation: { status: "available", via: "executable", command: id, version: null },
        }),
      });
      const a = agent({ env: { TEST: "value" } });
      const assessed = yield* r.assess(a);
      expect(assessed.info!.support.refused.env).toBe("test adapter refuses env");
      expect(usable(assessed)).toBe(false);
      const assess2 = yield* r.assess(agent({}));
      expect(usable(assess2)).toBe(true);
      const assess3 = yield* r.assess(agent({ enabled: false }));
      expect(usable(assess3)).toBe(false);
      const opencode = (yield* r.info("opencode"))!.support.refused;
      expect(opencode).toEqual({
        env: "test env",
        disallowedTools: supportOf("opencode").refused.disallowedTools,
      });
    }).pipe(Effect.scoped, Effect.provide(world())),
  );

  it.live("inherited session options are checked before a profile can be chosen", () =>
    Effect.gen(function* () {
      const store = yield* Agent;
      yield* store.saveSettings("antigravity", {
        ...store.settings("antigravity"),
        defaultEffort: "high",
        env: { INHERITED: "set" },
      });
      const r = yield* runtimes({
        registry: new RuntimeRegistry([fake("antigravity", { refusedSessionOptions: { env: "no env" } })]),
        probe: async (id) => ({
          ...(await notFound(id)),
          installation: { status: "available", via: "bundled", command: id, version: null },
        }),
      });
      const a = agent({ runtime: "antigravity" });
      const assessed = yield* r.assess(a);
      expect(assessed.blocking.map((i) => i.field)).toEqual(["effort", "env"]);
      expect(usable(assessed)).toBe(false);
      const problemsOf2 = yield* r.problemsOf(a);
      expect(problemsOf2).toEqual(assessed.problems);
      expect((yield* Effect.flip(r.resolve(a))).bizCode).toBe(BizCode.RuntimeRefused);
    }).pipe(Effect.scoped, Effect.provide(world())),
  );

  it.live("model effort checks use the inherited effort and allow a profile override", () =>
    Effect.gen(function* () {
      const store = yield* Agent;
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
      const assess2 = yield* r.assess(override);
      expect(usable(assess2)).toBe(true);
      const sent = yield* r.resolve(override);
      expect([sent.model, sent.effort, sent.env]).toEqual(["known", "low", { BASE: "kept", OVERRIDE: "profile" }]);
    }).pipe(Effect.scoped, Effect.provide(world())),
  );

  for (const source of ["profile", "runtime"] as const)
    it.live(`an unknown ${source} model warns and checks effort against the actual fallback`, () =>
      Effect.gen(function* () {
        const store = yield* Agent;
        yield* store.saveSettings("pi", {
          ...store.settings("pi"),
          defaultModel: source === "runtime" ? "missing" : "configured",
          defaultEffort: "high",
        });
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
        const problems = yield* r.problemsOf(a);
        expect(problems).toEqual([
          { field: "model", level: "warn", text: "pi 的模型列表里没有 missing" },
          {
            field: "effort",
            level: "error",
            text: "pi 默认用的 Fallback 没有 high 这一档，可选：low",
          },
        ]);
        expect((yield* Effect.flip(r.resolve(a))).bizCode).toBe(BizCode.RuntimeRefused);
        const sent = yield* r.resolve({ ...a, effort: "low" });
        expect([sent.model, sent.effort]).toEqual(["", "low"]);
      }).pipe(Effect.scoped, Effect.provide(world())),
    );

  it.live("a saved configuration is checked while its refreshed probe is still running", () => {
    let waiting = false;
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    return Effect.gen(function* () {
      const context2 = yield* Effect.context();
      const runPromise = Effect.runPromiseWith(context2);
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
      const store = yield* Agent;
      const updating = runPromise(r.update("pi", { ...store.settings("pi"), defaultEffort: "high" }));
      yield* Effect.promise(() => until(() => waiting));
      const a = agent({});
      expect((yield* r.problemsOf(a)).map((i) => i.field)).toEqual(["effort"]);
      expect((yield* Effect.flip(r.resolve(a))).bizCode).toBe(BizCode.RuntimeRefused);
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
        const problemsOf2 = yield* r.problemsOf(a);
        expect(problemsOf2).toEqual([]);
        const store = yield* Agent;
        yield* r.update("pi", {
          ...store.settings("pi"),
          ...(option === "effort" ? { defaultEffort: "high" } : { env: { NEW: "set" } }),
        });
        const resolved = yield* Effect.result(r.resolve(a));
        expect(resolved._tag).toBe("Failure");
        if (resolved._tag === "Failure")
          expect(resolved.failure).toEqual(
            ApiError.make({
              bizCode: BizCode.RuntimeRefused,
              message: "小禾 派不出去：" + (option === "env" ? "no env" : "pi 默认用的 Known 没有 high 这一档，可选：low"),
            }),
          );
      }).pipe(Effect.scoped, Effect.provide(world())),
    );

  it.live("resolving an existing session does not reapply dispatch availability or spending policy", () =>
    Effect.gen(function* () {
      const r = yield* runtimes({
        registry: new RuntimeRegistry([fake("pi")]),
        probe: async (id) => ({
          ...(await notFound(id)),
          installation: { status: "available", via: "bundled", command: id, version: null },
        }),
      });
      const store = yield* Agent;
      yield* r.update("pi", { ...store.settings("pi"), enabled: false, dailyBudget: 1 });
      r.spend("pi", 1);
      const a = agent({ enabled: false });
      const assess2 = yield* r.assess(a);
      expect(usable(assess2)).toBe(false);
      expect((yield* r.resolve(a)).runtime.id).toBe("pi");
    }).pipe(Effect.scoped, Effect.provide(world())),
  );

  it.live("the list carries every runtime's preset and facts", () =>
    Effect.gen(function* () {
      const registry = new RuntimeRegistry([
        fake("opencode", {
          refusedSessionOptions: { env: "test env" },
          installation: async () => ({ kind: "not_found" }) as const,
        }),
      ]);
      const r = yield* makeRuntime({ background: false, usageOf: async () => null, registry });
      // The first answer does not wait for a probe: every runtime is checking, already with its name, look and facts.
      for (const info of yield* r.list()) {
        expect(info.installation.status).toBe("checking");
        expect(info.preset).toEqual(presetOf(info.id));
      }
      const list = yield* waitFor(r.list(), (all) => all.every((i) => i.installation.status !== "checking"), "every runtime probed");
      expect(list.map((i) => i.id)).toEqual(runtimeIds());
      const byId = Object.fromEntries(list.map((i) => [i.id, i]));
      expect(byId.opencode!.installation.status).toBe("not_found");
      expect(byId.opencode!.support.refused).toEqual({
        env: "test env",
        disallowedTools: supportOf("opencode").refused.disallowedTools,
      });
      expect(byId.claude!.installation.status).toBe("unsupported");
      expect(byId.claude!.preset.label).toBe("Claude Code");
      expect(byId.claude!.support.capabilities).toEqual(supportOf("claude").capabilities);
      const claude = yield* json(byId.claude);
      expect(claude).toMatch(/"preset":\{"id":"claude","label":"Claude Code"/u);
      expect(claude).toMatch(/"support":\{"steer":true,"refused":\{\}/u);
    }).pipe(Effect.scoped, Effect.provide(world())),
  );

  it.live("two farms' binaries do not meet in the environment", () => {
    const before = process.env.OAR_PI_BIN;
    process.env.OAR_PI_BIN = "external-default";
    const registry = new RuntimeRegistry([
      fake("pi", {
        // As oar's probes: the overlay wins over the host's environment.
        installation: async (probe) => {
          const bin = probe?.env?.OAR_PI_BIN ?? process.env.OAR_PI_BIN;
          await nextTurn();
          return { kind: "available", via: "executable", command: bin ?? "none" } as const;
        },
      }),
    ]);
    const farm = (bin: string) =>
      Effect.gen(function* () {
        yield* Effect.flatMap(Agent, (a) =>
          a.saveSettings("pi", {
            enabled: true,
            binPath: bin,
            defaultModel: "",
            defaultEffort: "",
            env: {},
          }),
        );
        const r = yield* makeRuntime({ background: false, usageOf: async () => null, registry });
        yield* r.refresh("pi");
        return yield* r.resolve(agent({}));
      }).pipe(Effect.scoped, Effect.provide(world()));
    return Effect.gen(function* () {
      const [a, b] = yield* Effect.all([farm("first-bin"), farm("second-bin")], {
        concurrency: "unbounded",
      });
      expect([a.installation, b.installation]).toMatchObject([{ command: "first-bin" }, { command: "second-bin" }]);
      expect(envOf("OAR_PI_BIN")).toBe("external-default");
    }).pipe(Effect.ensuring(Effect.sync(() => env("OAR_PI_BIN", before))));
  });

  it.effect("yesterday's spending does not stop today's work", () =>
    Effect.gen(function* () {
      const r = yield* runtimes({ probe: notFound });
      const agents = yield* Agent;
      yield* agents.saveSettings("pi", { ...agents.settings("pi"), dailyBudget: 10 });
      yield* r.refresh("pi");
      r.spend("pi", 12);
      expect((yield* r.info("pi"))!.stop).toMatch(/每日预算 ¥10\.00/u);
      yield* TestClock.adjust("24 hours");
      const got = yield* r.info("pi");
      expect([got!.spentToday, got!.stop]).toEqual([undefined, ""]);
      r.spend("pi", 3);
      expect((yield* r.info("pi"))!.spentToday).toBe(3);
      r.spend("pi", 9);
      expect((yield* r.info("pi"))!.stop).toMatch(/每日预算 ¥10\.00/u);
    }).pipe(Effect.scoped, Effect.provide(world())),
  );

  it.live("regression: legacy spend files are ignored and invalid amounts cannot enter the database counter", () => {
    const config = testConfig();
    const legacy = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const d = localParts(now);
      const day = `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(join(config.home, "spend.json"), `{"day":"${day}","byRuntime":{"pi":1e999}}`);
    }).pipe(Effect.provide(NodeServices.layer));
    return Effect.andThen(
      legacy,
      Effect.gen(function* () {
        const r = yield* runtimes({ probe: notFound });
        yield* r.refresh("pi");
        expect((yield* r.info("pi"))!.spentToday).toBeUndefined();
        r.spend("pi", Number.POSITIVE_INFINITY);
        r.spend("pi", Number.NaN);
        expect((yield* r.info("pi"))!.spentToday).toBeUndefined();
        const sql = yield* SqlClient.SqlClient;
        expect((yield* Effect.exit(sql`insert into runtime_spend (day, runtime, cny) values ('1970-01-01', 'pi', 9e999)`))._tag).toBe("Failure");
        r.spend("pi", 2);
        expect((yield* r.info("pi"))!.spentToday).toBe(2);
      }).pipe(Effect.scoped, Effect.provide(world(config))),
    );
  });

  it.effect("regression: flushed spending survives restart without being added twice and each day remains separate", () => {
    const config = testConfig();
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* runtimes();
          runtime.spend("pi", 4);
          yield* TestClock.adjust(2000);
          yield* waitFor(sql<{ cny: number }>`select cny from runtime_spend where runtime = 'pi'`, (rows) => rows[0]?.cny === 4, "the spend committed");
        }),
      );
      const legacy = yield* fs.exists(join(config.home, "spend.json"));
      expect(legacy).toBe(false);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* runtimes();
          expect((yield* runtime.info("pi"))?.spentToday).toBe(4);
          runtime.spend("pi", 2);
        }),
      );
      yield* TestClock.adjust("24 hours");
      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* runtimes();
          expect((yield* runtime.info("pi"))?.spentToday).toBeUndefined();
          runtime.spend("pi", 5);
        }),
      );
      const rows2 = yield* sql<{
        cny: number;
      }>`select cny from runtime_spend where runtime = 'pi' order by day`;
      expect(rows2).toEqual([{ cny: 6 }, { cny: 5 }]);
    }).pipe(Effect.scoped, Effect.provide(world(config)));
  });

  it.effect("regression: a failed spending write retries the same delta once", () => {
    const config = testConfig();
    const log = heard();
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* refuse(sql, "refuse_spend", "before insert on runtime_spend");
      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* runtimes();
          runtime.spend("pi", 4);
          yield* TestClock.adjust(2000);
          yield* waitFor(
            Effect.sync(() => log.count("refuse_spend")),
            (n) => n > 0,
            "the rejected write",
          );
          const rows3 = yield* sql`select * from runtime_spend`;
          expect(rows3).toEqual([]);
          expect((yield* runtime.info("pi"))?.spentToday).toBe(4);
          yield* allow(sql, "refuse_spend");
          yield* TestClock.adjust(2000);
          yield* waitFor(sql<{ cny: number }>`select cny from runtime_spend where runtime = 'pi'`, (rows) => rows[0]?.cny === 4, "the retry committed");
        }),
      );
      const rows2 = yield* sql<{
        cny: number;
      }>`select cny from runtime_spend where runtime = 'pi'`;
      expect(rows2).toEqual([{ cny: 4 }]);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(world(config), log.layer)));
  });

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
      yield* fs.remove(file);
      yield* fs.makeDirectory(file);
      const unsaved = yield* Effect.flip(
        r.update("pi", {
          enabled: true,
          binPath: "",
          defaultModel: "unsaved",
          defaultEffort: "",
          env: {},
        }),
      );
      expect(unsaved).toMatchObject({ _tag: "ApiError", bizCode: BizCode.RuntimeRefused });
      expect(probed).toBe(false);
      expect((yield* Agent).settings("pi").defaultModel).not.toBe("unsaved");
    }).pipe(Effect.scoped, Effect.provide(world(config)));
  });

  it.live("resolve owns the defaults, the overrides and the model's fallback", () =>
    Effect.gen(function* () {
      yield* Effect.flatMap(Agent, (a) =>
        a.saveSettings("pi", {
          enabled: true,
          binPath: "",
          defaultModel: "known",
          defaultEffort: "default-effort",
          env: { base: "kept", override: "base" },
        }),
      );
      const r = yield* runtimes({
        registry: new RuntimeRegistry([fake("pi")]),
        probe: async (id) => ({
          ...(await notFound(id)),
          models: [{ id: "known", name: "known", effortLevels: [], isDefault: false }],
        }),
      });
      const a = agent({ env: { override: "profile" } });
      const got = yield* r.resolve(a);
      expect([got.runtime.id, got.model, got.effort, got.env]).toEqual(["pi", "known", "default-effort", { base: "kept", override: "profile" }]);
      const core = yield* Core;
      const notices: T.ServerEvent[] = [];
      const subscribe2 = yield* core.subscribe;
      // Subscribed before it returns: no wait for the reader to start.
      yield* Effect.forkScoped(Stream.runForEach(subscribe2, (e) => Effect.sync(() => notices.push(e))));
      const fallback = yield* r.resolve({ ...a, model: "unknown", effort: "profile-effort" });
      expect([fallback.model, fallback.effort]).toEqual(["", "profile-effort"]);
      yield* Effect.promise(() => until(() => notices.some((e) => e.type === "notice")));
    }).pipe(Effect.scoped, Effect.provide(world())),
  );

  it("a rate counts cache tokens apart and charges in yuan", () => {
    const rate = inCny({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.5 }, 7);
    expect(rate.charge({ input: 1_000_000, output: 0, cacheRead: 400_000 })).toBe(0.64 * 7);
    expect(rate.charge({ input: 10, output: 0, cacheRead: 20 })).toBe((2.0 / 1_000_000) * 7);
    expect(price("missing", "unknown", noPi)).toBeUndefined();
  });

  it("pi prices the default its settings name when the model is left to it", () => {
    expect(price("pi", "", noPi)).toBeUndefined();
    expect(price("pi", "", { provider: "deepseek", model: "deepseek-chat" })).toEqual(price("pi", "deepseek/deepseek-chat", noPi));
  });

  it("dsh prices DeepSeek's own models", () => {
    expect(price("dsh", "deepseek-official/deepseek-flash", noPi)?.input).toBe(0.14);
    expect(price("dsh", "deepseek-official/deepseek-v4-flash", noPi)).toBeUndefined();
    expect(price("dsh", "openrouter/deepseek-flash", noPi)).toBeUndefined();
    expect(price("vibevalley", "", noPi)?.input).toBe(0.14);
  });

  it("pi's balance, as pi configures DeepSeek", async () => {
    // pi's environment, as its Config reads it: this machine's own is never asked.
    const env: Record<string, string> = {};
    const balanceOf = (settings: { defaultModel: string }) =>
      Effect.runPromise(piBalance(fs, settings).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))));
    const balance = async (
      key: string,
      answer: unknown = {
        is_available: true,
        balance_infos: [{ currency: "CNY", total_balance: "12.50" }],
      },
    ) => {
      const body = await Effect.runPromise(json(answer));
      const s = createServer((req, res) => {
        if (req.url !== "/user/balance" || req.headers.authorization !== "Bearer " + key) return void res.writeHead(401).end();
        res.end(body);
      });
      servers.push(s);
      await Effect.runPromise(Effect.callback<void>((resume) => void s.listen(0, "127.0.0.1", () => resume(Effect.void))));
      return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    };
    const piHome = (models: string, auth: string, settings = `{"defaultProvider":"deepseek","defaultModel":"deepseek-chat"}`) => {
      const dir = tempDir("pi-");
      dirs.push(dir);
      env.OAR_PI_AGENT_DIR = dir;
      return Effect.runPromise(
        Effect.all([
          fs.writeFileString(join(dir, "settings.json"), settings),
          models ? fs.writeFileString(join(dir, "models.json"), models) : Effect.void,
          auth ? fs.writeFileString(join(dir, "auth.json"), auth) : Effect.void,
        ]),
      );
    };
    const want = {
      status: "balance",
      provider: "DeepSeek",
      available: true,
      balances: [{ currency: "CNY", amount: 12.5 }],
    };
    let url = await balance("sk-from-env");
    env.MY_DEEPSEEK = "sk-from-env";
    await piHome(`{"providers":{"deepseek":{"apiKey":"$MY_DEEPSEEK","baseUrl":"${url}/v1/"}}}`, "");
    expect(await balanceOf({ defaultModel: "" })).toEqual(want);
    url = await balance("sk-auth");
    env.DEEPSEEK_API_KEY = "sk-env";
    await piHome(`{"providers":{"deepseek":{"apiKey":"sk-models","baseUrl":"${url}"}}}`, `{"deepseek":{"type":"api_key","key":"sk-auth"}}`);
    expect(await balanceOf({ defaultModel: "" })).toEqual(want);
    url = await balance("sk-env");
    await piHome(`{"providers":{"deepseek":{"apiKey":"sk-models","baseUrl":"${url}"}}}`, "");
    expect(await balanceOf({ defaultModel: "" })).toEqual(want);
    delete env.DEEPSEEK_API_KEY;
    await piHome(`{"providers":{"deepseek":{"baseUrl":"${url}"}}}`, "");
    expect(await balanceOf({ defaultModel: "" })).toEqual({ status: "login_required" });
    expect(await balanceOf({ defaultModel: "anthropic/claude" })).toEqual({
      status: "unavailable",
      reason: "anthropic 不报余额",
    });
    url = await balance("sk-bad", { is_available: true, balance_infos: {} });
    env.DEEPSEEK_API_KEY = "sk-bad";
    await piHome(`{"providers":{"deepseek":{"baseUrl":"${url}"}}}`, "");
    expect(await balanceOf({ defaultModel: "" })).toEqual({
      status: "unavailable",
      reason: "没读到 DeepSeek 余额",
    });
    await piHome("", "", `{"defaultProvider":{}}`);
    expect(await balanceOf({ defaultModel: "" })).toEqual({
      status: "unavailable",
      reason: "pi 没有设默认模型",
    });
  });
});
