import {
  type AvailableInstallation,
  defaultRuntimes,
  type InstallationSnapshot,
  type InventoryReader,
  type Runtime as OarRuntime,
  RuntimeRegistry,
} from "@botiverse/oar";

import type { Llm } from "@vibevalley/ai/llm";
import { mapConcurrent, TaskGroup } from "@vibevalley/async";
import { currentLocale, type Locale, t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { ApiError, BizCode, refuseIn } from "#/base/errors.ts";
import type { Core } from "#/core/core.ts";
import { reposDir, type ServerConfig } from "#/infra/config.ts";
import type { Db } from "#/infra/db.ts";
import type { Logger } from "#/infra/log.ts";
import { type Time, withinRealTime } from "#/infra/time.ts";
import { type Agent, modelClient } from "#/modules/agent/agent.ts";
import type { Setting } from "#/modules/setting/setting.ts";

import { dshRuntime } from "./dsh.ts";
import { piBalance, type PiDefault, piSettings } from "./pi.ts";
import { agentProblems, type Candidate, chooseAgent, supportOf, moneyStop, presetOf, runtimeIds, runtimeLabel, sessionOptions } from "./presets.ts";
import { inCny, makeSpending, price, type Rate } from "./price.ts";
import { quotaOf } from "./quota.ts";
import { dbTodoStores, vibevalleyRuntimeOf } from "./vibevalley.ts";

const refused = refuseIn(BizCode.RuntimeRefused);

const probeTimeoutMs = 10_000;
const usageEveryMs = 5 * 60_000;
const usageAfterRunMs = 20_000;
const spendPushAfterMs = 3_000;

interface Assessment {
  readonly agent: T.Agent;
  readonly info: T.RuntimeInfo | undefined;
  readonly problems: T.AgentProblem[];
  readonly blocking: T.AgentProblem[];
}

export const usable = (a: Assessment) => a.agent.enabled && a.blocking.length === 0;

export interface Resolved {
  readonly runtime: OarRuntime;
  readonly installation?: AvailableInstallation;
  readonly binPath: string;
  readonly model: string;
  readonly effort: string;
  readonly env: Record<string, string>;
}

export interface Runtime {
  /** Returns immediately with `checking` placeholders while background probes run. */
  readonly list: () => Promise<T.RuntimeInfo[]>;
  readonly refresh: (id: string) => Promise<T.RuntimeInfo | undefined>;
  readonly info: (id: string) => Promise<T.RuntimeInfo | undefined>;
  readonly update: (id: string, s: T.RuntimeSettings) => Promise<T.RuntimeInfo | undefined>;
  readonly problemsOf: (agent: T.Agent) => Promise<T.AgentProblem[]>;
  readonly assess: (agent: T.Agent) => Promise<Assessment>;
  readonly candidates: () => Promise<Candidate[]>;
  readonly choose: (brief: string, named: string, picked: string) => Promise<T.Agent | undefined>;
  readonly resolve: (agent: T.Agent) => Promise<Resolved>;
  readonly runtime: (id: string) => OarRuntime | undefined;
  readonly quote: (id: string, model: string) => Rate | undefined;
  readonly spend: (id: string, cny: number) => void;
  readonly usageSoon: (id: string) => void;
  /** Stops the probes and timers, writes the day's spending, then closes the sessions of VibeValley's own runtime. */
  readonly close: () => Promise<void>;
}

export interface RuntimeDeps {
  readonly config: ServerConfig;
  readonly clock: Time;
  readonly log: Logger;
  readonly db: Db;
  readonly core: Core;
  readonly agent: Agent;
  /** Only for VibeValley's own runtime, which is not built when options.registry is given. */
  readonly setting: Setting;
  readonly llm: Llm;
}

type UsageOf = (id: string, runtime: OarRuntime, found: AvailableInstallation, settings: T.RuntimeSettings) => Promise<T.AccountUsage | null>;

export interface RuntimeOptions {
  registry?: RuntimeRegistry;
  probe?: (id: string) => Promise<T.RuntimeInfo>;
  usageOf?: UsageOf;
  background?: boolean;
}

export function registryOf(extra: readonly OarRuntime[] = []) {
  const added = new Set(extra.map((r) => r.id));
  return new RuntimeRegistry([...defaultRuntimes.list().filter((r) => !added.has(r.id)), ...extra]);
}

interface Observation {
  info: T.RuntimeInfo;
  found?: AvailableInstallation;
  read: number;
  locale?: Locale;
}

/** Empty `binPath` overrides host env to search `PATH`. */
export function probeInstallation(runtime: OarRuntime, binPath: string): Promise<InstallationSnapshot> {
  if (!runtime.installation) return Promise.resolve({ kind: "not_found" });
  return runtime.installation({ env: { [`OAR_${runtime.id.toUpperCase()}_BIN`]: binPath } });
}

function fromOar(usage: Awaited<ReturnType<NonNullable<OarRuntime["accountUsage"]>>>): T.AccountUsage {
  if (usage.kind === "reauth_required") return { status: "login_required" };
  if (usage.kind === "unsupported") return { status: "unavailable", reason: usage.reason || t("server.runtime.noUsage") };
  return {
    status: "ok",
    subscription: usage.plan || null,
    windows: usage.windows.map((w) => {
      const at = w.resetsAt ? Date.parse(w.resetsAt) : Number.NaN;
      return {
        label: w.label,
        usedPercent: Math.round(w.usedRatio * 100),
        resetsAt: Number.isNaN(at) ? null : at,
      };
    }),
  };
}

const oarRead = <A, B>(read: () => Promise<A>, fallback: B): Promise<A | B> => withinRealTime<A | B>(read(), probeTimeoutMs, fallback);

const inventory = async <T>(
  read: InventoryReader<T> | undefined,
  found: AvailableInstallation,
  cwd: string,
  entry: (item: T) => T.InventoryEntry,
): Promise<T.InventoryEntry[] | null> => {
  if (!read) return null;
  const result = await oarRead(() => read(found, { cwd, timeoutMs: probeTimeoutMs }), undefined);
  return result?.kind === "ok" ? result.items.map(entry) : null;
};

/** Two reads of a runtime's usage say the same. */
const sameUsage = (a: T.AccountUsage | null, b: T.AccountUsage | null) => JSON.stringify(a) === JSON.stringify(b);

const defaultUsageOf: UsageOf = async (_id, runtime, found) => {
  if (!runtime.accountUsage) return null;
  const usage = await withinRealTime(runtime.accountUsage(found, { timeoutMs: probeTimeoutMs }), probeTimeoutMs, undefined);
  return usage ? fromOar(usage) : null;
};

export async function makeRuntime(deps: RuntimeDeps, options: RuntimeOptions = {}): Promise<Runtime> {
  const { config, core, agent: store, clock } = deps;
  const log = deps.log.child("runtime");
  // The sessions of VibeValley's own runtime: closed last, after the probes and the spending.
  const owner = new TaskGroup({ name: "runtime sessions", onError: (task, e) => log.error(`${task} failed`, e) });
  const registry =
    options.registry ??
    registryOf([
      vibevalleyRuntimeOf({
        home: () => config.home,
        llm: (model) => modelClient(model, deps.setting.deepseekApiKey, deps.llm),
        time: clock,
        owner,
        log,
        todos: dbTodoStores({ db: deps.db, clock }),
      }),
      dshRuntime,
    ]);
  const tasks = new TaskGroup({ name: "runtime", onError: (task, e) => log.warn(`${task} failed`, e) });
  const usageOf = async (id: string, runtime: OarRuntime, found: AvailableInstallation, settings: T.RuntimeSettings): Promise<T.AccountUsage | null> => {
    if (!options.usageOf && id === "pi") return piBalance(settings, process.env);
    try {
      return await (options.usageOf ?? defaultUsageOf)(id, runtime, found, settings);
    } catch (e) {
      log.debug(`the usage of ${id} was not read`, e);
      return null;
    }
  };

  const readPiDefault = () => piSettings(process.env);
  let piDefault: PiDefault = await readPiDefault();
  const relabeling = new Set<string>();
  const probes = new Map<string, number>();
  // Track in-flight refreshes so concurrent `list()` calls do not spawn duplicate probes before the cache populates.
  const probing = new Map<string, number>();
  const out = async <A>(id: string, f: () => Promise<A>): Promise<A> => {
    probing.set(id, (probing.get(id) ?? 0) + 1);
    try {
      return await f();
    } finally {
      const n = (probing.get(id) ?? 1) - 1;
      if (n > 0) probing.set(id, n);
      else probing.delete(id);
    }
  };
  const usageAsked = new Map<string, number>();
  const usageTaken = new Map<string, number>();
  let closed = false;

  const daily = await makeSpending({ db: deps.db, clock, log });
  const tally = daily.tally;

  function withSpend(info: T.RuntimeInfo): T.RuntimeInfo {
    const { spentToday: _, ...rest } = info;
    const cny = tally()[info.id];
    const out: T.RuntimeInfo = { ...rest, ...(cny !== undefined ? { spentToday: cny } : {}) };
    return { ...out, stop: moneyStop(out), quota: quotaOf(out.usage) };
  }

  function support(id: string) {
    const f = supportOf(id);
    const refused: Record<string, string> = { ...registry.get(id)?.refusedSessionOptions, ...f.refused };
    return { ...f, refused };
  }

  const shown = (next: Observation): Observation => {
    const id = next.info.id;
    return { ...next, info: withSpend({ ...next.info, preset: presetOf(id), support: support(id) }), locale: currentLocale() };
  };

  const probe = async (id: string): Promise<Observation> => {
    if (id === "pi") piDefault = await readPiDefault();
    const settings = store.settings(id);
    const info: T.RuntimeInfo = {
      id,
      preset: presetOf(id),
      support: support(id),
      installation: { status: "checking" },
      models: null,
      usage: null,
      skills: null,
      mcpServers: null,
      tools: null,
      stop: "",
      settings,
      checkedAt: clock.now(),
    };
    const runtime = registry.get(id);
    if (!runtime) {
      const reason = id === "cursor" ? t("server.runtime.cursor") : t("server.runtime.oarUnknown");
      return { info: { ...info, installation: { status: "unsupported", reason } }, read: 0 };
    }
    const notFound: InstallationSnapshot = { kind: "not_found" };
    const snapshot = await oarRead(() => probeInstallation(runtime, settings.binPath), notFound);
    if (snapshot.kind !== "available") {
      return {
        info: {
          ...info,
          installation: snapshot.kind === "unsupported" ? { status: "unsupported", reason: snapshot.reason } : { status: "not_found" },
        },
        read: 0,
      };
    }
    const found = snapshot;
    info.installation =
      found.via === "executable"
        ? {
            status: "available",
            via: "executable",
            command: found.command,
            version: found.version || null,
          }
        : { status: "available", via: "bundled", command: id, version: null };
    const cwd = reposDir(config);
    const listModels = runtime.listModels;
    const [models, usage, skills, mcpServers, tools] = await Promise.all([
      listModels
        ? oarRead(() => listModels(found, { timeoutMs: probeTimeoutMs }), undefined).then((m) =>
            m?.kind === "ok"
              ? m.models
                  .filter((x) => !x.disabled)
                  .map((x) => ({
                    id: x.id,
                    name: x.displayName || x.id,
                    effortLevels: [...(x.effortLevels ?? [])],
                    isDefault: !!x.default,
                  }))
              : null,
          )
        : null,
      usageOf(id, runtime, found, settings),
      inventory(runtime.skills, found, cwd, (s) => ({
        name: s.name,
        description: s.description ?? "",
        source: s.path || s.source || "",
        enabled: s.enabled ?? true,
      })),
      inventory(runtime.mcpServers, found, cwd, (m) => {
        const parts = [m.status, m.toolCount !== undefined ? t("server.runtime.tools", { n: m.toolCount }) : ""].filter(Boolean);
        return {
          name: m.name,
          description: parts.join(" · "),
          source: m.source ?? "",
          enabled: m.enabled ?? true,
        };
      }),
      inventory(runtime.tools, found, cwd, (item) => ({
        name: item.name,
        description: item.description ?? "",
        source: item.mcpServerId || item.source || "",
        enabled: item.enabled ?? true,
      })),
    ]);
    return { info: { ...info, models, usage, skills, mcpServers, tools }, found, read: 0 };
  };

  const known = (id: string) => runtimeIds().includes(id);

  // What each runtime was last seen as, as Effect's Cache kept it: an entry is there from the moment a first lookup
  // starts; a lookup that fails is not kept; a refresh of an entry that is there keeps the old one until it answers.
  interface Entry {
    readonly promise: Promise<Observation>;
    value?: Observation;
  }
  const cache = new Map<string, Entry>();
  const lookup = async (id: string): Promise<Observation> => {
    const read = (probes.get(id) ?? 0) + 1;
    probes.set(id, read);
    const customProbe = options.probe;
    const next = customProbe ? { info: { ...(await customProbe(id)), settings: store.settings(id) }, read: 0 } : await probe(id);
    const kept = shown({ ...next, read });
    core.runtime(kept.info);
    return kept;
  };
  const entryOf = (id: string, existing: boolean): Entry => {
    const promise = lookup(id);
    const entry: Entry = { promise };
    if (!existing) cache.set(id, entry);
    promise.then(
      (value) => {
        entry.value = value;
        if (existing) cache.set(id, entry);
      },
      () => {
        if (existing) cache.delete(id);
        else if (cache.get(id) === entry) cache.delete(id);
      },
    );
    return entry;
  };
  /** A new lookup, whatever is kept. */
  const reprobe = (id: string): Promise<Observation> => entryOf(id, cache.has(id)).promise;
  /** What is kept, else the lookup under way, else a new one. */
  const get = (id: string): Promise<Observation> => (cache.get(id) ?? entryOf(id, false)).promise;
  const held = (id: string) => cache.get(id)?.value;
  const keep = (next: Observation) => {
    const kept = shown(next);
    cache.set(next.info.id, { promise: Promise.resolve(kept), value: kept });
    core.runtime(kept.info);
  };

  const refresh = async (id: string): Promise<T.RuntimeInfo | undefined> => {
    if (!known(id) || closed) return undefined;
    const next = await out(id, () => reprobe(id));
    return closed ? undefined : next.info;
  };

  const info = async (id: string) => {
    const hit = held(id);
    return hit && hit.locale === currentLocale() ? withSpend(hit.info) : refresh(id);
  };

  const refreshUsage = async (id: string) => {
    const runtime = registry.get(id);
    const before = held(id);
    // Skip disabled runtimes because quota checks can hit rate-limited vendor APIs (e.g. Claude).
    if (closed || !runtime || !before?.found || !before.info.settings.enabled) return;
    const asked = (usageAsked.get(id) ?? 0) + 1;
    usageAsked.set(id, asked);
    const usage = await usageOf(id, runtime, before.found, before.info.settings);
    // Drop stale quota results superseded by a newer full probe (`read`) or a newer `refreshUsage` (`asked`).
    const now = held(id);
    if (closed || !now || now.read !== before.read || (usageTaken.get(id) ?? 0) > asked) return;
    usageTaken.set(id, asked);
    if (sameUsage(usage, now.info.usage)) return;
    keep({ ...now, info: { ...now.info, usage, checkedAt: clock.now() } });
  };

  const warned = async (what: string, f: () => Promise<unknown>): Promise<void> => {
    try {
      await f();
    } catch (e) {
      log.warn(what, e);
    }
  };

  const each = (what: string, f: (id: string) => Promise<unknown>) => mapConcurrent(runtimeIds(), 4, (id) => warned(`${what} ${id}`, () => f(id)));

  if (options.background ?? true)
    tasks.run("probes", async (signal) => {
      await each("probing", refresh);
      for (;;) {
        await clock.sleep(usageEveryMs, signal);
        await each("reading the usage of", refreshUsage);
      }
    });

  /** Runs f ms from now under key, unless one is waiting there already. */
  const later = (key: string, ms: number, f: () => Promise<void>) => {
    if (tasks.has(key)) return;
    // The deadline is taken now: the task starts a turn later, and the wait counts from the call.
    const at = clock.now() + ms;
    tasks.keyed(key, async (signal) => {
      await clock.sleep(Math.max(0, at - clock.now()), signal);
      await f();
    });
  };

  // Overlay live `store.settings` onto cached probe results so newly saved settings apply before re-probe completes.
  const configuration = async (id: string) => {
    const observed = await info(id);
    const settings = store.settings(id);
    return { settings, info: observed ? withSpend({ ...observed, settings }) : undefined };
  };

  const assess = async (agent: T.Agent): Promise<Assessment> => {
    const { info: i } = await configuration(agent.runtime);
    const problems = agentProblems(agent, i);
    return { agent, info: i, problems, blocking: problems.filter((x) => x.level === "error") };
  };

  const candidates = async () => {
    const out: Candidate[] = [];
    for (const agent of store.agents()) out.push({ agent, usable: usable(await assess(agent)) });
    return out;
  };

  return {
    list: async () => {
      const infos: T.RuntimeInfo[] = [];
      for (const id of runtimeIds()) {
        const hit = held(id);
        if (hit && hit.locale !== currentLocale() && !closed && !relabeling.has(id)) {
          relabeling.add(id);
          tasks.run(`relabel ${id}`, async () => {
            try {
              await warned(`relabeling ${id}`, () => refresh(id));
            } finally {
              relabeling.delete(id);
            }
          });
        }
        if (hit) {
          infos.push(withSpend(hit.info));
          continue;
        }
        if (!closed && !probing.has(id)) tasks.run(`probe ${id}`, () => warned(`probing ${id}`, () => out(id, () => get(id))));
        infos.push({
          id,
          preset: presetOf(id),
          support: support(id),
          installation: { status: "checking" },
          models: null,
          usage: null,
          skills: null,
          mcpServers: null,
          tools: null,
          stop: "",
          settings: store.settings(id),
          checkedAt: 0,
        });
      }
      return infos;
    },
    refresh,
    info,
    update: async (id, s) => {
      if (!known(id)) return undefined;
      try {
        await store.saveSettings(id, s);
      } catch (e) {
        if (e instanceof ApiError) throw refused(t("server.runtime.notSaved", { id, why: e.message }));
        throw e;
      }
      return refresh(id);
    },
    problemsOf: async (agent) => (await assess(agent)).problems,
    assess,
    candidates,
    choose: async (brief, named, picked) => chooseAgent(await candidates(), brief, named, picked),
    resolve: async (agent) => {
      const runtime = registry.get(agent.runtime);
      if (!runtime) throw refused(t("server.runtime.cannotDrive", { runtime: agent.runtime }));
      const { info: i, settings } = await configuration(agent.runtime);
      const { model, effort, env, missingModel, problems } = sessionOptions(agent, settings, i);
      const problem = problems.find((i) => i.level === "error");
      if (problem) throw refused(t("server.runtime.cannotSend", { name: agent.name, why: problem.text }));
      if (missingModel) core.notice("warn", t("server.runtime.defaultModel", { runtime: runtimeLabel(agent.runtime), model: missingModel, name: agent.name }));
      const observed = held(agent.runtime);
      const installation = observed?.found && observed.info.settings.binPath === settings.binPath ? structuredClone(observed.found) : undefined;
      return {
        runtime,
        ...(installation ? { installation } : {}),
        binPath: settings.binPath,
        model,
        effort,
        env,
      };
    },
    runtime: (id) => registry.get(id),
    quote: (id, model) => {
      const p = price(id, model, piDefault);
      return p ? inCny(p, config.cnyPerUsd) : undefined;
    },
    spend: (id, cny) => {
      if (closed || !daily.spend(id, cny)) return;
      later(`push:${id}`, spendPushAfterMs, async () => {
        const hit = held(id);
        if (hit && !closed) keep(hit);
      });
    },
    usageSoon: (id) => {
      if (closed) return;
      later(`usage:${id}`, usageAfterRunMs, () => warned(`reading the usage of ${id}`, () => refreshUsage(id)));
    },
    close: async () => {
      closed = true;
      await tasks.close();
      await daily.close();
      await owner.close();
    },
  };
}
