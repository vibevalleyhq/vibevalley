import {
  type AvailableInstallation,
  defaultRuntimes,
  type InstallationSnapshot,
  type InventoryReader,
  type Runtime as OarRuntime,
  RuntimeRegistry,
} from "@botiverse/oar";
import { Cache, Clock, Context, Effect, Equal, Exit, FiberMap, FiberSet, FileSystem, Layer, Option, Schedule } from "effect";

import { Llm } from "@vibevalley/ai/llm";
import { currentLocale, type Locale, t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { Agent, modelClient } from "#/agent/agent.ts";
import { type ApiError, messageOf, refused } from "#/base/errors.ts";
import { Core } from "#/core/core.ts";
import { reposDir, ServerConfig } from "#/infra/config.ts";
import { timeHere, withinRealTime } from "#/infra/time.ts";
import { Setting } from "#/setting/setting.ts";

import { dshRuntime } from "./dsh.ts";
import { piBalance, type PiDefault, piSettings } from "./pi.ts";
import { agentProblems, type Candidate, chooseAgent, supportOf, moneyStop, presetOf, runtimeIds, runtimeLabel, sessionOptions } from "./presets.ts";
import { inCny, price, type Rate, spending } from "./price.ts";
import { quotaOf } from "./quota.ts";
import { dbTodoStores, vibevalleyRuntimeOf } from "./vibevalley.ts";

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

export class Runtime extends Context.Service<
  Runtime,
  {
    /** Returns immediately with `checking` placeholders while background probes run. */
    readonly list: () => Effect.Effect<T.RuntimeInfo[]>;
    readonly refresh: (id: string) => Effect.Effect<T.RuntimeInfo | undefined>;
    readonly info: (id: string) => Effect.Effect<T.RuntimeInfo | undefined>;
    readonly update: (id: string, s: T.RuntimeSettings) => Effect.Effect<T.RuntimeInfo | undefined, ApiError>;
    readonly problemsOf: (agent: T.Agent) => Effect.Effect<T.AgentProblem[]>;
    readonly assess: (agent: T.Agent) => Effect.Effect<Assessment>;
    readonly candidates: Effect.Effect<Candidate[]>;
    readonly choose: (brief: string, named: string, picked: string) => Effect.Effect<T.Agent | undefined>;
    readonly resolve: (agent: T.Agent) => Effect.Effect<Resolved, ApiError>;
    readonly runtime: (id: string) => OarRuntime | undefined;
    readonly quote: (id: string, model: string) => Rate | undefined;
    readonly spend: (id: string, cny: number) => void;
    readonly usageSoon: (id: string) => void;
  }
>()("@vibevalley/server/runtime/runtime") {
  static readonly layer = (options: RuntimeOptions = {}) =>
    Layer.effect(
      Runtime,
      Effect.gen(function* () {
        if (options.registry) return yield* make(options);
        const config = yield* ServerConfig;
        const keys = yield* Setting;
        const time = yield* timeHere;
        const service = yield* Llm;
        const own = vibevalleyRuntimeOf({
          home: () => config.home,
          llm: (model) => modelClient(model, keys.deepseekApiKey, service),
          time,
          owner: { run: yield* FiberSet.makeRuntimePromise(), scope: yield* Effect.scope },
          todos: yield* dbTodoStores,
        });
        return yield* make({ ...options, registry: registryOf([own, dshRuntime]) });
      }),
    );
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

const oarRead = <A, B>(read: () => Promise<A>, fallback: B): Effect.Effect<A | B> =>
  Effect.promise(() => withinRealTime<A | B>(read(), probeTimeoutMs, fallback));

const inventory = <T>(
  read: InventoryReader<T> | undefined,
  found: AvailableInstallation,
  cwd: string,
  entry: (item: T) => T.InventoryEntry,
): Effect.Effect<T.InventoryEntry[] | null> =>
  read
    ? Effect.map(
        oarRead(() => read(found, { cwd, timeoutMs: probeTimeoutMs }), undefined),
        (result) => (result?.kind === "ok" ? result.items.map(entry) : null),
      )
    : Effect.succeed(null);

const defaultUsageOf: UsageOf = async (_id, runtime, found) => {
  if (!runtime.accountUsage) return null;
  const usage = await withinRealTime(runtime.accountUsage(found, { timeoutMs: probeTimeoutMs }), probeTimeoutMs, undefined);
  return usage ? fromOar(usage) : null;
};

const make = (options: RuntimeOptions = {}) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const core = yield* Core;
    const store = yield* Agent;
    const registry = options.registry ?? registryOf();
    const forkHere = yield* FiberSet.makeRuntime();
    const emit = (e: Effect.Effect<void>) => void forkHere(e);
    const usageOf = (id: string, runtime: OarRuntime, found: AvailableInstallation, settings: T.RuntimeSettings) =>
      !options.usageOf && id === "pi"
        ? piBalance(fs, settings)
        : Effect.orElseSucceed(
            Effect.tryPromise({ try: () => (options.usageOf ?? defaultUsageOf)(id, runtime, found, settings), catch: messageOf }),
            () => null,
          );

    const readPiDefault = piSettings(fs);
    let piDefault: PiDefault = yield* readPiDefault;
    const relabeling = new Set<string>();
    const probes = new Map<string, number>();
    // Track in-flight `Cache.refresh` calls so concurrent `list()` calls do not spawn duplicate probes before the cache populates.
    const probing = new Map<string, number>();
    const out = <A, E>(id: string, e: Effect.Effect<A, E>) =>
      Effect.suspend(() => {
        probing.set(id, (probing.get(id) ?? 0) + 1);
        return Effect.ensuring(
          e,
          Effect.sync(() => {
            const n = (probing.get(id) ?? 1) - 1;
            if (n > 0) probing.set(id, n);
            else probing.delete(id);
          }),
        );
      });
    const usageAsked = new Map<string, number>();
    const usageTaken = new Map<string, number>();
    const timers = yield* FiberMap.make<string>();
    const later = yield* FiberMap.runtime(timers)();
    let closed = false;

    const daily = yield* spending;
    const tally = daily.tally;
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        closed = true;
        return FiberMap.clear(timers);
      }),
    );

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

    const probe = Effect.fnUntraced(function* (id: string): Effect.fn.Return<Observation> {
      if (id === "pi") piDefault = yield* readPiDefault;
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
        checkedAt: yield* Clock.currentTimeMillis,
      };
      const runtime = registry.get(id);
      if (!runtime) {
        const reason = id === "cursor" ? t("server.runtime.cursor") : t("server.runtime.oarUnknown");
        return { info: { ...info, installation: { status: "unsupported", reason } }, read: 0 };
      }
      const notFound: InstallationSnapshot = { kind: "not_found" };
      const snapshot = yield* oarRead(() => probeInstallation(runtime, settings.binPath), notFound);
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
      const [models, usage, skills, mcpServers, tools] = yield* Effect.all(
        [
          listModels
            ? Effect.map(
                oarRead(() => listModels(found, { timeoutMs: probeTimeoutMs }), undefined),
                (m) =>
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
            : Effect.succeed(null),
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
        ],
        { concurrency: 4 },
      );
      return { info: { ...info, models, usage, skills, mcpServers, tools }, found, read: 0 };
    });

    const known = (id: string) => runtimeIds().includes(id);

    const cache = yield* Cache.makeWith(
      (id: string) =>
        Effect.gen(function* () {
          const read = (probes.get(id) ?? 0) + 1;
          probes.set(id, read);
          const customProbe = options.probe;
          const next = customProbe
            ? yield* Effect.map(
                Effect.promise(() => customProbe(id)),
                (i): Observation => ({ info: { ...i, settings: store.settings(id) }, read: 0 }),
              )
            : yield* probe(id);
          const kept = shown({ ...next, read });
          yield* core.runtime(kept.info);
          return kept;
        }),
      { capacity: 64, timeToLive: (exit) => (Exit.isFailure(exit) ? 0 : Infinity) },
    );
    const held = (id: string) => Effect.map(Cache.getSuccess(cache, id), Option.getOrUndefined);
    const keep = (next: Observation) =>
      Effect.gen(function* () {
        const kept = shown(next);
        yield* Cache.set(cache, next.info.id, kept);
        yield* core.runtime(kept.info);
      });

    const refresh = Effect.fnUntraced(function* (id: string): Effect.fn.Return<T.RuntimeInfo | undefined> {
      if (!known(id) || closed) return undefined;
      const next = yield* out(id, Cache.refresh(cache, id));
      return closed ? undefined : next.info;
    });

    const info = Effect.fnUntraced(function* (id: string) {
      const hit = yield* held(id);
      return hit && hit.locale === currentLocale() ? withSpend(hit.info) : yield* refresh(id);
    });

    const refreshUsage = Effect.fnUntraced(function* (id: string) {
      const runtime = registry.get(id);
      const before = yield* held(id);
      // Skip disabled runtimes because quota checks can hit rate-limited vendor APIs (e.g. Claude).
      if (closed || !runtime || !before?.found || !before.info.settings.enabled) return;
      const asked = (usageAsked.get(id) ?? 0) + 1;
      usageAsked.set(id, asked);
      const usage = yield* usageOf(id, runtime, before.found, before.info.settings);
      // Drop stale quota results superseded by a newer full probe (`read`) or a newer `refreshUsage` (`asked`).
      const now = yield* held(id);
      if (closed || !now || now.read !== before.read || (usageTaken.get(id) ?? 0) > asked) return;
      usageTaken.set(id, asked);
      if (Equal.equals(usage, now.info.usage)) return;
      yield* keep({ ...now, info: { ...now.info, usage, checkedAt: yield* Clock.currentTimeMillis } });
    });

    const each = (f: (id: string) => Effect.Effect<unknown>) =>
      Effect.forEach(runtimeIds(), (id) => Effect.ignoreCause(f(id), { log: "Warn" }), { concurrency: 4, discard: true });

    if (options.background ?? true)
      yield* Effect.forkScoped(
        Effect.andThen(each(refresh), each(refreshUsage).pipe(Effect.repeat(Schedule.spaced(usageEveryMs)), Effect.delay(usageEveryMs))),
      );

    // Overlay live `store.settings` onto cached probe results so newly saved settings apply before re-probe completes.
    const configuration = (id: string) =>
      Effect.map(info(id), (observed) => {
        const settings = store.settings(id);
        return { settings, info: observed ? withSpend({ ...observed, settings }) : undefined };
      });

    const assess = Effect.fn("Runtime.assess")(function* (agent: T.Agent): Effect.fn.Return<Assessment> {
      const { info: i } = yield* configuration(agent.runtime);
      const problems = agentProblems(agent, i);
      return { agent, info: i, problems, blocking: problems.filter((x) => x.level === "error") };
    });

    const candidates = Effect.suspend(() => Effect.forEach(store.agents(), (agent) => Effect.map(assess(agent), (a) => ({ agent, usable: usable(a) }))));

    return Runtime.of({
      list: Effect.fn("Runtime.list")(function* () {
        return yield* Effect.forEach(runtimeIds(), (id) =>
          Effect.gen(function* () {
            const hit = yield* held(id);
            if (hit && hit.locale !== currentLocale() && !closed && !relabeling.has(id)) {
              relabeling.add(id);
              emit(
                Effect.ensuring(
                  Effect.ignoreCause(refresh(id), { log: "Warn" }),
                  Effect.sync(() => relabeling.delete(id)),
                ),
              );
            }
            if (hit) return withSpend(hit.info);
            if (!closed && !probing.has(id)) emit(Effect.ignoreCause(out(id, Cache.get(cache, id)), { log: "Warn" }));
            return {
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
            } satisfies T.RuntimeInfo;
          }),
        );
      }),
      refresh,
      info,
      update: Effect.fn("Runtime.update")(function* (id, s) {
        if (!known(id)) return undefined;
        yield* store.saveSettings(id, s).pipe(Effect.catchTag("Refused", (e) => Effect.fail(refused(t("server.runtime.notSaved", { id, why: e.reason })))));
        return yield* refresh(id);
      }),
      problemsOf: Effect.fn("Runtime.problemsOf")(function* (agent) {
        return (yield* assess(agent)).problems;
      }),
      assess,
      candidates,
      choose: Effect.fn("Runtime.choose")(function* (brief, named, picked) {
        const candidates2 = yield* candidates;
        return chooseAgent(candidates2, brief, named, picked);
      }),
      resolve: Effect.fn("Runtime.resolve")(function* (agent) {
        const runtime = registry.get(agent.runtime);
        if (!runtime) return yield* Effect.fail(refused(t("server.runtime.cannotDrive", { runtime: agent.runtime })));
        const { info: i, settings } = yield* configuration(agent.runtime);
        const { model, effort, env, missingModel, problems } = sessionOptions(agent, settings, i);
        const problem = problems.find((i) => i.level === "error");
        if (problem) return yield* Effect.fail(refused(t("server.runtime.cannotSend", { name: agent.name, why: problem.text })));
        if (missingModel)
          yield* core.notice("warn", t("server.runtime.defaultModel", { runtime: runtimeLabel(agent.runtime), model: missingModel, name: agent.name }));
        const observed = yield* held(agent.runtime);
        const installation = observed?.found && observed.info.settings.binPath === settings.binPath ? structuredClone(observed.found) : undefined;
        return {
          runtime,
          ...(installation ? { installation } : {}),
          binPath: settings.binPath,
          model,
          effort,
          env,
        };
      }),
      runtime: (id) => registry.get(id),
      quote: (id, model) => {
        const p = price(id, model, piDefault);
        return p ? inCny(p, config.cnyPerUsd) : undefined;
      },
      spend: (id, cny) => {
        if (closed || !daily.spend(id, cny)) return;
        later(
          `push:${id}`,
          Effect.delay(
            Effect.flatMap(held(id), (hit) => (hit && !closed ? keep(hit) : Effect.void)),
            spendPushAfterMs,
          ),
          { onlyIfMissing: true },
        );
      },
      usageSoon: (id) => {
        if (closed) return;
        later(`usage:${id}`, Effect.delay(Effect.ignoreCause(refreshUsage(id), { log: "Warn" }), usageAfterRunMs), { onlyIfMissing: true });
      },
    });
  });
