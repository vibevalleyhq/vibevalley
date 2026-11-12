import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { defineRuntime, type InstallationSnapshot, RuntimeRegistry } from "@botiverse/oar";
import { afterEach, describe, expect, test } from "vite-plus/test";

import { reasonOf } from "@vibevalley/async";
import { setLocale, t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { ApiError, BizCode } from "@vibevalley/protocol/api";
import { tempDir } from "@vibevalley/testkit/temp";
import { nextTurn, waitFor, whenTrue } from "@vibevalley/testkit/until";

import { type Core, makeCore } from "#/core/core.ts";
import type { ServerConfig } from "#/infra/config.ts";
import { type Db, openDb } from "#/infra/db.ts";
import { keptLog } from "#/infra/log.ts";
import { localParts, type Time, wallTime } from "#/infra/time.ts";
import { type Agent, makeAgent } from "#/modules/agent/agent.ts";
import { sampleAgent } from "#/modules/agent/seed.ts";
import { makeSetting, type Setting } from "#/platform/setting/setting.ts";
import { offlineNetwork, testConfig } from "#/testing/layers.ts";
import { allow, refuse } from "#/testing/refuse.ts";

import { piBalance } from "./pi.ts";
import { supportOf, presetOf, runtimeIds } from "./presets.ts";
import { inCny, price } from "./price.ts";
import { makeRuntime, type Runtime, type RuntimeOptions, usable } from "./runtime.ts";

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
  checkedAt: wallTime.now(),
});

/** The test's clock, moved by the test (adjust) rather than waited on. */
type TestTime = Time & { readonly adjust: (ms: number) => Promise<void> };
/** A clock that stands still until adjust moves it on; a sleep wakes once its time has come, and what it wakes runs as
 * far as it can before adjust returns. */
const testTime = (start = 0): TestTime => {
  let now = start;
  const sleepers = new Set<{ readonly at: number; readonly wake: () => void }>();
  const wakeDue = () => {
    for (const s of [...sleepers].toSorted((a, b) => a.at - b.at))
      if (s.at <= now) {
        sleepers.delete(s);
        s.wake();
      }
  };
  const sleep = (ms: number, signal?: AbortSignal) => {
    if (signal?.aborted === true) return Promise.reject(reasonOf(signal));
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const sleeper = { at: now + Math.max(0, ms), wake: resolve };
    sleepers.add(sleeper);
    signal?.addEventListener(
      "abort",
      () => {
        sleepers.delete(sleeper);
        reject(reasonOf(signal));
      },
      { once: true },
    );
    wakeDue();
    return promise;
  };
  return {
    ...wallTime,
    now: () => now,
    sleep,
    adjust: async (ms) => {
      now += ms;
      wakeDue();
      for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
};

interface World extends AsyncDisposable {
  readonly config: ServerConfig;
  readonly clock: Time;
  readonly db: Db;
  readonly core: Core;
  readonly agent: Agent;
  readonly setting: Setting;
  readonly log: ReturnType<typeof keptLog>;
  /** A runtime service on this farm, closed with it (or by the test, before). */
  readonly runtime: (options: RuntimeOptions) => Promise<Runtime>;
}

/** What the runtime service stands on: the farm's own, no network (no runtime here asks a model). */
async function world(config: ServerConfig = testConfig(), clock: Time = wallTime): Promise<World> {
  const log = keptLog("runtime-test");
  const db = await openDb(config, log, clock);
  const core = makeCore({
    projection: {
      reduce: (state) => [state, false],
      effects: () => [],
      frame: () => {
        throw new Error("no frame is drawn in a runtime test");
      },
    },
    clock,
  });
  const setting = await makeSetting({ config, clock, log });
  const agent = await makeAgent({ config, clock, log });
  const opened: Runtime[] = [];
  return {
    config,
    clock,
    db,
    core,
    agent,
    setting,
    log,
    runtime: async (options) => {
      const r = await makeRuntime(
        { config, clock, log, db, core, agent, setting, fetch: offlineNetwork.fetch },
        { registry: new RuntimeRegistry([]), ...options },
      );
      opened.push(r);
      return r;
    },
    [Symbol.asyncDispose]: async () => {
      for (const r of opened.splice(0).toReversed()) await r.close();
      await agent.close();
      await setting.close();
      await db.close();
    },
  };
}

/** A runtime service over the given runtimes, never asking this machine's. */
const runtimes = (w: World, options: RuntimeOptions = {}) => w.runtime({ background: false, probe: notFound, usageOf: async () => null, ...options });

const agent = (a: Partial<T.Agent>): T.Agent => sampleAgent({ id: "a", name: "小禾", ...a });

const until = (ok: () => boolean) => whenTrue(ok, "it");

const refusal = async (p: Promise<unknown>): Promise<ApiError> => {
  const e = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(e instanceof ApiError)) throw new Error(`not refused: ${String(e)}`);
  return e;
};

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const env = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};
const envOf = (name: string) => process.env[name];

const noPi = { provider: "", model: "" };

const day = 24 * 60 * 60_000;

describe("runtime", () => {
  test("what a runtime's probe said is said again in the farm's new language", async () => {
    const registry = new RuntimeRegistry([
      fake("pi", { installation: async (): Promise<InstallationSnapshot> => ({ kind: "unsupported", reason: t("server.runtime.oarUnknown") }) }),
    ]);
    try {
      await using w = await world();
      const r = await w.runtime({ registry, background: false, usageOf: async () => null });
      const reason = async () => {
        const got = (await r.list()).find((x) => x.id === "pi")!.installation;
        return got.status === "unsupported" ? got.reason : "";
      };
      await r.refresh("pi");
      const chinese = await reason();
      setLocale("en");
      const reason2 = await reason();
      // The list shows what it held until the probe in English lands.
      expect(reason2).toBe(chinese);
      await waitFor(reason, (r) => r === "oar does not know this runtime", "the reason in English");
      expect((await r.info("pi"))!.installation).toMatchObject({ reason: "oar does not know this runtime" });
    } finally {
      setLocale("zh");
    }
  });

  test("an accepted probe owns the installation its usage reads use, and a slow one does not overwrite a newer", async () => {
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
    const clock = testTime();
    await using w = await world(testConfig(), clock);
    let used = "";
    let observeUsage = false;
    const r = await w.runtime({
      registry,
      background: false,
      usageOf: async (_id, _rt, found) => {
        if (observeUsage) used = found.via === "executable" ? found.command : "";
        return null;
      },
    });
    const slow = r.refresh("pi");
    await until(() => n === 1);
    await r.refresh("pi");
    release();
    await slow;
    const got = await r.info("pi");
    expect(got!.installation).toMatchObject({ command: "new" });
    observeUsage = true;
    r.usageSoon("pi");
    await clock.adjust(20_000);
    await until(() => used === "new");
    expect(used).toBe("new");
  });

  for (const first of ["full", "usage"] as const)
    test(`a changed usage cannot overwrite a newer full probe (${first} first)`, async () => {
      const { promise: fullGate, resolve: releaseFull } = Promise.withResolvers<void>();
      const { promise: usageGate, resolve: releaseUsage } = Promise.withResolvers<void>();
      try {
        const clock = testTime();
        await using w = await world(testConfig(), clock);
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
        const r = await w.runtime({
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
        await r.refresh("pi");
        const fullRefresh = r.refresh("pi");
        await until(() => full === 2);
        r.usageSoon("pi");
        await clock.adjust(20_000);
        await until(() => usageCalls === 2);
        if (first === "full") {
          releaseFull();
          await fullRefresh;
          releaseUsage();
          await nextTurn();
        } else {
          releaseUsage();
          await nextTurn();
          releaseFull();
          await fullRefresh;
        }
        const got = await r.info("pi");
        expect(got!.installation).toMatchObject({ command: "new" });
        expect(got!.usage).toBeNull();
      } finally {
        releaseFull();
        releaseUsage();
      }
    });

  // The spend push waits spendPushAfterMs on the service's Clock: moved through, not waited for.
  test("a usage read keeps its answer when a spend rebuilds what is shown meanwhile, and a late older one does not undo a newer", async () => {
    const out: PromiseWithResolvers<T.AccountUsage>[] = [];
    const heldUsage = () => {
      const answer = Promise.withResolvers<T.AccountUsage>();
      out.push(answer);
      return answer.promise;
    };
    const answer = (n: number, usage: T.AccountUsage) => out[n]!.resolve(usage);
    const used = (usedPercent: number) =>
      ({
        status: "ok",
        subscription: "pro",
        windows: [{ label: "5 hours", usedPercent, resetsAt: null }],
      }) as T.AccountUsage;
    const clock = testTime();
    await using w = await world(testConfig(), clock);
    const pushed: T.RuntimeInfo[] = [];
    using events = w.core.subscribe();
    void (async () => {
      for await (const event of events) if (event.type === "runtime") pushed.push(event.info);
    })();
    let calls = 0;
    const r = await w.runtime({
      registry: new RuntimeRegistry([fake("pi", { installation: async () => ({ kind: "available", via: "executable", command: "pi" }) })]),
      background: true,
      usageOf: async () => (++calls === 1 ? null : heldUsage()),
    });
    await whenTrue(() => new Set(pushed.map((info) => info.id)).size === runtimeIds().length, "the initial probes");
    r.usageSoon("pi");
    await clock.adjust(20_000);
    await whenTrue(() => out.length === 1, "first delayed usage");
    r.spend("pi", 1);
    await clock.adjust(3_000);
    await whenTrue(() => pushed.some((info) => info.id === "pi" && info.spentToday === 1), "spend push");
    answer(0, used(40));
    await waitFor(
      () => r.info("pi"),
      (info) => info?.usage?.status === "ok" && info.usage.windows[0]?.usedPercent === 40,
      "the usage kept after spend",
    );
    expect((await r.info("pi"))!.spentToday).toBe(1);
    await clock.adjust(300_000);
    await whenTrue(() => out.length === 2, "periodic usage");
    r.usageSoon("pi");
    await clock.adjust(20_000);
    await whenTrue(() => out.length === 3, "overlapping delayed usage");
    answer(2, used(100));
    await waitFor(
      () => r.info("pi"),
      (info) => info?.usage?.status === "ok" && info.usage.windows[0]?.usedPercent === 100,
      "the newer usage",
    );
    answer(1, used(70));
    await nextTurn();
    expect((await r.info("pi"))!.usage).toEqual(used(100));
  });

  test("a failed list probe is retried without changing the synchronous checking answer", async () => {
    const first = Promise.withResolvers<T.RuntimeInfo>();
    const second = Promise.withResolvers<T.RuntimeInfo>();
    let probes = 0;
    await using w = await world();
    const r = await runtimes(w, {
      probe: (id) => {
        if (id !== "pi") return notFound(id);
        probes++;
        return probes === 1 ? first.promise : second.promise;
      },
    });
    const pi = async () => (await r.list()).find((info) => info.id === "pi")!;
    expect((await pi()).installation.status).toBe("checking");
    await until(() => probes === 1);
    first.reject(new Error("first probe failed"));
    // Asked again, the list tries again, and says checking until the second read answers.
    await waitFor(pi, (p) => p.installation.status === "checking" && probes === 2, "a second probe");
    expect((await pi()).installation.status).toBe("checking");
    second.resolve(await notFound("pi"));
    await waitFor(pi, (p) => p.installation.status === "not_found", "the second probe landed");
    expect(probes).toBe(2);
  });

  test("an old read's failure does not clear the newer read's checking marker", async () => {
    const old = Promise.withResolvers<T.RuntimeInfo>();
    const latest = Promise.withResolvers<T.RuntimeInfo>();
    let probes = 0;
    await using w = await world();
    const r = await runtimes(w, {
      probe: (id) => {
        if (id !== "pi") return notFound(id);
        probes++;
        return probes === 1 ? old.promise : latest.promise;
      },
    });
    const oldResult = r.refresh("pi").then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await until(() => probes === 1);
    const latestResult = r.refresh("pi");
    await until(() => probes === 2);
    old.reject(new Error("old probe failed"));
    expect(await oldResult).toMatchObject({ status: "rejected" });
    expect((await r.list()).find((info) => info.id === "pi")!.installation.status).toBe("checking");
    latest.resolve(await notFound("pi"));
    expect((await latestResult)!.installation.status).toBe("not_found");
    // The old read's failure started no read of its own.
    expect(probes).toBe(2);
  });

  test("an adapter's refusals stop a profile, under the farm's", async () => {
    const registry = new RuntimeRegistry([
      fake("pi", { refusedSessionOptions: { env: "test adapter refuses env" } }),
      fake("opencode", { refusedSessionOptions: { env: "test env" } }),
    ]);
    await using w = await world();
    const r = await runtimes(w, {
      registry,
      probe: async (id) => ({
        ...(await notFound(id)),
        installation: { status: "available", via: "executable", command: id, version: null },
      }),
    });
    const a = agent({ env: { TEST: "value" } });
    const assessed = await r.assess(a);
    expect(assessed.info!.support.refused.env).toBe("test adapter refuses env");
    expect(usable(assessed)).toBe(false);
    expect(usable(await r.assess(agent({})))).toBe(true);
    expect(usable(await r.assess(agent({ enabled: false })))).toBe(false);
    const opencode = (await r.info("opencode"))!.support.refused;
    expect(opencode).toEqual({
      env: "test env",
      disallowedTools: supportOf("opencode").refused.disallowedTools,
    });
  });

  test("inherited session options are checked before a profile can be chosen", async () => {
    await using w = await world();
    const store = w.agent;
    await store.saveSettings("antigravity", {
      ...store.settings("antigravity"),
      defaultEffort: "high",
      env: { INHERITED: "set" },
    });
    const r = await runtimes(w, {
      registry: new RuntimeRegistry([fake("antigravity", { refusedSessionOptions: { env: "no env" } })]),
      probe: async (id) => ({
        ...(await notFound(id)),
        installation: { status: "available", via: "bundled", command: id, version: null },
      }),
    });
    const a = agent({ runtime: "antigravity" });
    const assessed = await r.assess(a);
    expect(assessed.blocking.map((i) => i.field)).toEqual(["effort", "env"]);
    expect(usable(assessed)).toBe(false);
    expect(await r.problemsOf(a)).toEqual(assessed.problems);
    expect((await refusal(r.resolve(a))).bizCode).toBe(BizCode.RuntimeRefused);
  });

  test("model effort checks use the inherited effort and allow a profile override", async () => {
    await using w = await world();
    const store = w.agent;
    await store.saveSettings("pi", {
      ...store.settings("pi"),
      defaultModel: "known",
      defaultEffort: "high",
      env: { BASE: "kept", OVERRIDE: "default" },
    });
    const r = await runtimes(w, {
      registry: new RuntimeRegistry([fake("pi")]),
      probe: async (id) => ({
        ...(await notFound(id)),
        installation: { status: "available", via: "bundled", command: id, version: null },
        models: [{ id: "known", name: "Known", effortLevels: ["low"], isDefault: true }],
      }),
    });
    expect((await r.assess(agent({}))).blocking.map((i) => i.field)).toEqual(["effort"]);
    const override = agent({ effort: "low", env: { OVERRIDE: "profile" } });
    expect(usable(await r.assess(override))).toBe(true);
    const sent = await r.resolve(override);
    expect([sent.model, sent.effort, sent.env]).toEqual(["known", "low", { BASE: "kept", OVERRIDE: "profile" }]);
  });

  for (const source of ["profile", "runtime"] as const)
    test(`an unknown ${source} model warns and checks effort against the actual fallback`, async () => {
      await using w = await world();
      const store = w.agent;
      await store.saveSettings("pi", {
        ...store.settings("pi"),
        defaultModel: source === "runtime" ? "missing" : "configured",
        defaultEffort: "high",
      });
      const r = await runtimes(w, {
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
      const problems = await r.problemsOf(a);
      expect(problems).toEqual([
        { field: "model", level: "warn", text: "pi 的模型列表里没有 missing" },
        {
          field: "effort",
          level: "error",
          text: "pi 默认用的 Fallback 没有 high 这一档，可选：low",
        },
      ]);
      expect((await refusal(r.resolve(a))).bizCode).toBe(BizCode.RuntimeRefused);
      const sent = await r.resolve({ ...a, effort: "low" });
      expect([sent.model, sent.effort]).toEqual(["", "low"]);
    });

  test("a saved configuration is checked while its refreshed probe is still running", async () => {
    let waiting = false;
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    try {
      await using w = await world();
      let probes = 0;
      const r = await runtimes(w, {
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
      await r.info("pi");
      const store = w.agent;
      const updating = r.update("pi", { ...store.settings("pi"), defaultEffort: "high" });
      await until(() => waiting);
      const a = agent({});
      expect((await r.problemsOf(a)).map((i) => i.field)).toEqual(["effort"]);
      expect((await refusal(r.resolve(a))).bizCode).toBe(BizCode.RuntimeRefused);
      release();
      await updating;
    } finally {
      release();
    }
  });

  for (const option of ["effort", "env"] as const)
    test(`resolve refuses a newly saved ${option} even after the profile passed its dispatch check`, async () => {
      await using w = await world();
      const r = await runtimes(w, {
        registry: new RuntimeRegistry([fake("pi", { refusedSessionOptions: { env: "no env" } })]),
        probe: async (id) => ({
          ...(await notFound(id)),
          installation: { status: "available", via: "bundled", command: id, version: null },
          models: [{ id: "known", name: "Known", effortLevels: ["low"], isDefault: true }],
        }),
      });
      const a = agent({});
      expect(await r.problemsOf(a)).toEqual([]);
      const store = w.agent;
      await r.update("pi", {
        ...store.settings("pi"),
        ...(option === "effort" ? { defaultEffort: "high" } : { env: { NEW: "set" } }),
      });
      const resolved = await refusal(r.resolve(a));
      expect(resolved).toMatchObject({
        bizCode: BizCode.RuntimeRefused,
        message: "小禾 派不出去：" + (option === "env" ? "no env" : "pi 默认用的 Known 没有 high 这一档，可选：low"),
      });
    });

  test("resolving an existing session does not reapply dispatch availability or spending policy", async () => {
    await using w = await world();
    const r = await runtimes(w, {
      registry: new RuntimeRegistry([fake("pi")]),
      probe: async (id) => ({
        ...(await notFound(id)),
        installation: { status: "available", via: "bundled", command: id, version: null },
      }),
    });
    const store = w.agent;
    await r.update("pi", { ...store.settings("pi"), enabled: false, dailyBudget: 1 });
    r.spend("pi", 1);
    const a = agent({ enabled: false });
    expect(usable(await r.assess(a))).toBe(false);
    expect((await r.resolve(a)).runtime.id).toBe("pi");
  });

  test("the list carries every runtime's preset and facts", async () => {
    const registry = new RuntimeRegistry([
      fake("opencode", {
        refusedSessionOptions: { env: "test env" },
        installation: async () => ({ kind: "not_found" }) as const,
      }),
    ]);
    await using w = await world();
    const r = await w.runtime({ background: false, usageOf: async () => null, registry });
    // The first answer does not wait for a probe: every runtime is checking, already with its name, look and facts.
    for (const info of await r.list()) {
      expect(info.installation.status).toBe("checking");
      expect(info.preset).toEqual(presetOf(info.id));
    }
    const list = await waitFor(
      () => r.list(),
      (all) => all.every((i) => i.installation.status !== "checking"),
      "every runtime probed",
    );
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
    const claude = JSON.stringify(byId.claude);
    expect(claude).toMatch(/"preset":\{"id":"claude","label":"Claude Code"/u);
    expect(claude).toMatch(/"support":\{"steer":true,"refused":\{\}/u);
  });

  test("two farms' binaries do not meet in the environment", async () => {
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
    const farm = async (bin: string) => {
      await using w = await world();
      await w.agent.saveSettings("pi", {
        enabled: true,
        binPath: bin,
        defaultModel: "",
        defaultEffort: "",
        env: {},
      });
      const r = await w.runtime({ background: false, usageOf: async () => null, registry });
      await r.refresh("pi");
      return await r.resolve(agent({}));
    };
    try {
      const [a, b] = await Promise.all([farm("first-bin"), farm("second-bin")]);
      expect([a.installation, b.installation]).toMatchObject([{ command: "first-bin" }, { command: "second-bin" }]);
      expect(envOf("OAR_PI_BIN")).toBe("external-default");
    } finally {
      env("OAR_PI_BIN", before);
    }
  });

  test("yesterday's spending does not stop today's work", async () => {
    const clock = testTime();
    await using w = await world(testConfig(), clock);
    const r = await runtimes(w, { probe: notFound });
    const agents = w.agent;
    await agents.saveSettings("pi", { ...agents.settings("pi"), dailyBudget: 10 });
    await r.refresh("pi");
    r.spend("pi", 12);
    expect((await r.info("pi"))!.stop).toMatch(/每日预算 ¥10\.00/u);
    await clock.adjust(day);
    const got = await r.info("pi");
    expect([got!.spentToday, got!.stop]).toEqual([undefined, ""]);
    r.spend("pi", 3);
    expect((await r.info("pi"))!.spentToday).toBe(3);
    r.spend("pi", 9);
    expect((await r.info("pi"))!.stop).toMatch(/每日预算 ¥10\.00/u);
  });

  test("regression: legacy spend files are ignored and invalid amounts cannot enter the database counter", async () => {
    const config = testConfig();
    const d = localParts(wallTime.now());
    const today = `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
    writeFileSync(join(config.home, "spend.json"), `{"day":"${today}","byRuntime":{"pi":1e999}}`);
    await using w = await world(config);
    const r = await runtimes(w, { probe: notFound });
    await r.refresh("pi");
    expect((await r.info("pi"))!.spentToday).toBeUndefined();
    r.spend("pi", Number.POSITIVE_INFINITY);
    r.spend("pi", Number.NaN);
    expect((await r.info("pi"))!.spentToday).toBeUndefined();
    const inserted = await w.db.sql.exec(`insert into runtime_spend (day, runtime, cny) values ('1970-01-01', 'pi', 9e999)`).then(
      () => "Success",
      () => "Failure",
    );
    expect(inserted).toBe("Failure");
    r.spend("pi", 2);
    expect((await r.info("pi"))!.spentToday).toBe(2);
  });

  test("regression: flushed spending survives restart without being added twice and each day remains separate", async () => {
    const config = testConfig();
    const clock = testTime();
    await using w = await world(config, clock);
    const cnyOf = async () => (await w.db.sql.query(`select cny from runtime_spend where runtime = 'pi' order by day`)).map((row) => ({ cny: row.cny }));
    {
      const runtime = await runtimes(w);
      runtime.spend("pi", 4);
      await clock.adjust(2000);
      await waitFor(cnyOf, (rows) => rows[0]?.cny === 4, "the spend committed");
      await runtime.close();
    }
    expect(existsSync(join(config.home, "spend.json"))).toBe(false);
    {
      const runtime = await runtimes(w);
      expect((await runtime.info("pi"))?.spentToday).toBe(4);
      runtime.spend("pi", 2);
      await runtime.close();
    }
    await clock.adjust(day);
    {
      const runtime = await runtimes(w);
      expect((await runtime.info("pi"))?.spentToday).toBeUndefined();
      runtime.spend("pi", 5);
      await runtime.close();
    }
    expect(await cnyOf()).toEqual([{ cny: 6 }, { cny: 5 }]);
  });

  test("regression: a failed spending write retries the same delta once", async () => {
    const config = testConfig();
    const clock = testTime();
    await using w = await world(config, clock);
    const sql = w.db.sql;
    const cnyOf = async () => (await sql.query(`select cny from runtime_spend where runtime = 'pi'`)).map((row) => ({ cny: row.cny }));
    await refuse(sql, "refuse_spend", "before insert on runtime_spend");
    {
      const runtime = await runtimes(w);
      runtime.spend("pi", 4);
      await clock.adjust(2000);
      await waitFor(
        () => w.log.lines.filter((l) => l.line.includes("refuse_spend")).length,
        (n) => n > 0,
        "the rejected write",
      );
      expect(await sql.query(`select * from runtime_spend`)).toEqual([]);
      expect((await runtime.info("pi"))?.spentToday).toBe(4);
      await allow(sql, "refuse_spend");
      await clock.adjust(2000);
      await waitFor(cnyOf, (rows) => rows[0]?.cny === 4, "the retry committed");
      await runtime.close();
    }
    expect(await cnyOf()).toEqual([{ cny: 4 }]);
  });

  test("an update that cannot be saved is refused, and nothing is probed", async () => {
    const config = testConfig();
    let probed = false;
    await using w = await world(config);
    const r = await runtimes(w, {
      probe: async (id) => {
        probed = true;
        return notFound(id);
      },
    });
    const file = join(config.home, "config.json");
    rmSync(file, { force: true });
    mkdirSync(file);
    const unsaved = await refusal(
      r.update("pi", {
        enabled: true,
        binPath: "",
        defaultModel: "unsaved",
        defaultEffort: "",
        env: {},
      }),
    );
    expect(unsaved).toMatchObject({ bizCode: BizCode.RuntimeRefused });
    expect(probed).toBe(false);
    expect(w.agent.settings("pi").defaultModel).not.toBe("unsaved");
  });

  test("resolve owns the defaults, the overrides and the model's fallback", async () => {
    await using w = await world();
    await w.agent.saveSettings("pi", {
      enabled: true,
      binPath: "",
      defaultModel: "known",
      defaultEffort: "default-effort",
      env: { base: "kept", override: "base" },
    });
    const r = await runtimes(w, {
      registry: new RuntimeRegistry([fake("pi")]),
      probe: async (id) => ({
        ...(await notFound(id)),
        models: [{ id: "known", name: "known", effortLevels: [], isDefault: false }],
      }),
    });
    const a = agent({ env: { override: "profile" } });
    const got = await r.resolve(a);
    expect([got.runtime.id, got.model, got.effort, got.env]).toEqual(["pi", "known", "default-effort", { base: "kept", override: "profile" }]);
    // Subscribed before it returns: no wait for the reader to start.
    using notices = w.core.subscribe();
    const fallback = await r.resolve({ ...a, model: "unknown", effort: "profile-effort" });
    expect([fallback.model, fallback.effort]).toEqual(["", "profile-effort"]);
    expect(notices.drain().some((e) => e.type === "notice")).toBe(true);
  });

  test("a rate counts cache tokens apart and charges in yuan", () => {
    const rate = inCny({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.5 }, 7);
    expect(rate.charge({ input: 1_000_000, output: 0, cacheRead: 400_000 })).toBe(0.64 * 7);
    expect(rate.charge({ input: 10, output: 0, cacheRead: 20 })).toBe((2.0 / 1_000_000) * 7);
    expect(price("missing", "unknown", noPi)).toBeUndefined();
  });

  test("pi prices the default its settings name when the model is left to it", () => {
    expect(price("pi", "", noPi)).toBeUndefined();
    expect(price("pi", "", { provider: "deepseek", model: "deepseek-chat" })).toEqual(price("pi", "deepseek/deepseek-chat", noPi));
  });

  test("dsh prices DeepSeek's own models", () => {
    expect(price("dsh", "deepseek-official/deepseek-flash", noPi)?.input).toBe(0.14);
    expect(price("dsh", "deepseek-official/deepseek-v4-flash", noPi)).toBeUndefined();
    expect(price("dsh", "openrouter/deepseek-flash", noPi)).toBeUndefined();
    expect(price("vibevalley", "", noPi)?.input).toBe(0.14);
  });

  test("pi's balance, as pi configures DeepSeek", async () => {
    // pi's environment, as it is read: this machine's own is never asked.
    const env: Record<string, string> = {};
    const balanceOf = (settings: { defaultModel: string }) => piBalance(settings, env);
    const balance = async (
      key: string,
      answer: unknown = {
        is_available: true,
        balance_infos: [{ currency: "CNY", total_balance: "12.50" }],
      },
    ) => {
      const body = JSON.stringify(answer);
      const s = createServer((req, res) => {
        if (req.url !== "/user/balance" || req.headers.authorization !== "Bearer " + key) return void res.writeHead(401).end();
        res.end(body);
      });
      servers.push(s);
      await new Promise<void>((resume) => void s.listen(0, "127.0.0.1", () => resume()));
      return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    };
    const piHome = (models: string, auth: string, settings = `{"defaultProvider":"deepseek","defaultModel":"deepseek-chat"}`) => {
      const dir = tempDir("pi-");
      dirs.push(dir);
      env.OAR_PI_AGENT_DIR = dir;
      writeFileSync(join(dir, "settings.json"), settings);
      if (models) writeFileSync(join(dir, "models.json"), models);
      if (auth) writeFileSync(join(dir, "auth.json"), auth);
    };
    const want = {
      status: "balance",
      provider: "DeepSeek",
      available: true,
      balances: [{ currency: "CNY", amount: 12.5 }],
    };
    let url = await balance("sk-from-env");
    env.MY_DEEPSEEK = "sk-from-env";
    piHome(`{"providers":{"deepseek":{"apiKey":"$MY_DEEPSEEK","baseUrl":"${url}/v1/"}}}`, "");
    expect(await balanceOf({ defaultModel: "" })).toEqual(want);
    url = await balance("sk-auth");
    env.DEEPSEEK_API_KEY = "sk-env";
    piHome(`{"providers":{"deepseek":{"apiKey":"sk-models","baseUrl":"${url}"}}}`, `{"deepseek":{"type":"api_key","key":"sk-auth"}}`);
    expect(await balanceOf({ defaultModel: "" })).toEqual(want);
    url = await balance("sk-env");
    piHome(`{"providers":{"deepseek":{"apiKey":"sk-models","baseUrl":"${url}"}}}`, "");
    expect(await balanceOf({ defaultModel: "" })).toEqual(want);
    delete env.DEEPSEEK_API_KEY;
    piHome(`{"providers":{"deepseek":{"baseUrl":"${url}"}}}`, "");
    expect(await balanceOf({ defaultModel: "" })).toEqual({ status: "login_required" });
    expect(await balanceOf({ defaultModel: "anthropic/claude" })).toEqual({
      status: "unavailable",
      reason: "anthropic 不报余额",
    });
    url = await balance("sk-bad", { is_available: true, balance_infos: {} });
    env.DEEPSEEK_API_KEY = "sk-bad";
    piHome(`{"providers":{"deepseek":{"baseUrl":"${url}"}}}`, "");
    expect(await balanceOf({ defaultModel: "" })).toEqual({
      status: "unavailable",
      reason: "没读到 DeepSeek 余额",
    });
    piHome("", "", `{"defaultProvider":{}}`);
    expect(await balanceOf({ defaultModel: "" })).toEqual({
      status: "unavailable",
      reason: "pi 没有设默认模型",
    });
  });
});
