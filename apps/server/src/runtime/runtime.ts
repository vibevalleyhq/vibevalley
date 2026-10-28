import { currentLocale, type Locale, t } from "@vibevalley/i18n";
// The runtimes the farm can run helpers on: oar's, VibeValley's own agent and DeepSeek Harness.
// Each is probed for whether it is installed, its models, its account's quota and what it carries (skills, MCP servers,
// tools); probing runs a runtime's own commands, so the answers are kept and asked again only on a refresh, the quota
// every five minutes and soon after a run. What each runtime spent today is kept in spend.json, and a runtime past its
// day's budget takes no work.

import { join } from "node:path";
import { type AvailableInstallation, defaultRuntimes, type InstallationSnapshot, type InventoryReader, type Runtime, RuntimeRegistry } from "@botiverse/oar";
import type { AccountUsage, Agent, AgentProblem, InventoryEntry, RuntimeInfo, RuntimeSettings } from "@vibevalley/protocol";
import { factsOf, presetOf, runtimeIds, runtimeLabel } from "../agent/seed.ts";
import { Clock, Context, Effect, FiberMap, FiberSet, FileSystem, Layer, Option, Schedule, Schema } from "effect";
import { Agents } from "../agent/agent.ts";
import { modelClient } from "../agent/model.ts";
import { Llm } from "../ai/llm.ts";
import { vibevalleyRuntimeOf } from "./vibevalley.ts";
import { dshRuntime } from "./dsh.ts";
import { Setting } from "../setting/setting.ts";
import { dbStores } from "../agent/taskStore.ts";
import { projectsDir, Settings } from "../base/config.ts";
import { FileWriter } from "../base/files.ts";
import { jsonOrNone } from "../base/json.ts";
import { Core } from "../core/core.ts";
import { type ApiError, refused } from "../errors.ts";
import { piBalance } from "./pi.ts";
import { inCny, price, type Rate } from "./price.ts";
import { agentProblems, type Candidate, chooseAgent, moneyStop, quotaOf, sessionOptions } from "./rules.ts";
import { callbackLog } from "../base/log.ts";
import { timeHere, withinRealTime } from "../base/time.ts";

/** Past this a probe counts as unknown. */
const probeTimeoutMs = 10_000;
const usageEveryMs = 5 * 60_000;
/** Several runs share one read. */
const usageAfterRunMs = 20_000;
/** A busy session spends every few seconds: the pages hear of it a moment later, with whatever else was spent. */
const spendPushAfterMs = 3_000;

/** Dispatch eligibility with the runtime state that explains it. */
export interface Assessment {
  readonly agent: Agent;
  readonly info: RuntimeInfo | undefined;
  readonly problems: AgentProblem[];
  readonly blocking: AgentProblem[];
}

export const usable = (a: Assessment) => a.agent.enabled && a.blocking.length === 0;

/** What a session needs once the profile's choices and the runtime's defaults are reconciled. */
export interface Resolved {
  readonly runtime: Runtime;
  /** The installation the last probe found, when it was probed with the binary the settings name now. */
  readonly installation?: AvailableInstallation;
  readonly binPath: string;
  readonly model: string;
  readonly effort: string;
  readonly env: Record<string, string>;
}

export interface RuntimeShape {
  /** Answers at once: a runtime not looked at yet comes as checking, and its probe's answer follows as a runtime event. */
  readonly list: () => RuntimeInfo[];
  readonly refresh: (id: string) => Effect.Effect<RuntimeInfo | undefined>;
  readonly info: (id: string) => Effect.Effect<RuntimeInfo | undefined>;
  readonly update: (id: string, s: RuntimeSettings) => Effect.Effect<RuntimeInfo | undefined, ApiError>;
  /** The profile's problems as it would be dispatched now. */
  readonly check: (agent: Agent) => Effect.Effect<AgentProblem[]>;
  readonly assess: (agent: Agent) => Effect.Effect<Assessment>;
  /** Every profile, and whether it can be sent now. */
  readonly candidates: Effect.Effect<Candidate[]>;
  /** Who the farm sends for a task now: chooseAgent over the candidates. */
  readonly choose: (task: string, named: string, picked: string) => Effect.Effect<Agent | undefined>;
  /** Validates the effective options on every opening; availability and spending only gate new work. */
  readonly resolve: (agent: Agent) => Effect.Effect<Resolved, ApiError>;
  readonly runtime: (id: string) => Runtime | undefined;
  readonly quote: (id: string, model: string) => Rate | undefined;
  readonly spend: (id: string, cny: number) => void;
  /** Reads the runtime's quota a little after a run, several runs sharing one read. */
  readonly usageSoon: (id: string) => void;
}

export class Runtimes extends Context.Service<Runtimes, RuntimeShape>()("vibevalley/Runtime") {}

/** What reads a runtime's account usage; tests put their own. */
export type UsageOf = (id: string, runtime: Runtime, found: AvailableInstallation, settings: RuntimeSettings) => Promise<AccountUsage | null>;

export interface RuntimeOptions {
  /** The runtimes; oar's defaults when none. */
  registry?: RuntimeRegistry;
  /** Answers a probe without asking the runtime: tests never ask this machine's runtimes. */
  probe?: (id: string) => Promise<RuntimeInfo>;
  usageOf?: UsageOf;
  /** The background reads (the first probe of every runtime, the quota every five minutes); off in tests. */
  background?: boolean;
}

/** The farm's runtimes: oar's and those the farm adds (VibeValley's own agent, DeepSeek Harness); one added with oar's id takes its place. */
export function registryOf(extra: readonly Runtime[] = []) {
  const added = new Set(extra.map((r) => r.id));
  return new RuntimeRegistry([...defaultRuntimes.list().filter((r) => !added.has(r.id)), ...extra]);
}

/** One accepted probe owns both what is shown and the installation later reads of its usage use. */
interface Observation {
  info: RuntimeInfo;
  found?: AvailableInstallation;
  read: number;
  /** The info holds words (why a runtime is unsupported, its quota): one probed in another language is probed again. */
  locale?: Locale;
}

interface Spent {
  day: string;
  byRuntime: Record<string, number>;
}

const SpentSchema: Schema.Codec<Spent> = Schema.Struct({
  day: Schema.String,
  byRuntime: Schema.Record(Schema.String, Schema.Finite),
});

/** The local day of now, as the spend tally keys it. */
const dayOf = (now: number) => {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * oar's installation probes read the binary from OAR_<ID>_BIN as they start: it is set for that moment only, so two
 * runtimes (or two farms in one process) never see each other's. An empty path looks on PATH, ignoring the variable.
 */
export function probeInstallation(runtime: Runtime, binPath: string): Promise<InstallationSnapshot> {
  if (!runtime.installation) return Promise.resolve({ kind: "not_found" });
  const name = `OAR_${runtime.id.toUpperCase()}_BIN`;
  const before = process.env[name];
  process.env[name] = binPath;
  try {
    return runtime.installation();
  } finally {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
}

function fromOar(usage: Awaited<ReturnType<NonNullable<Runtime["accountUsage"]>>>): AccountUsage {
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

/** An oar read, given up on after probeTimeoutMs of real time: fallback then, and when it fails. */
const oarRead = <A, B>(read: () => Promise<A>, fallback: B): Effect.Effect<A | B> =>
  Effect.promise(() => withinRealTime<A | B>(read(), probeTimeoutMs, fallback));

const inventory = <T>(
  read: InventoryReader<T> | undefined,
  found: AvailableInstallation,
  cwd: string,
  entry: (item: T) => InventoryEntry,
): Effect.Effect<InventoryEntry[] | null> =>
  read
    ? Effect.map(
        oarRead(() => read(found, { cwd, timeoutMs: probeTimeoutMs }), undefined),
        (result) => (result?.kind === "ok" ? result.items.map(entry) : null),
      )
    : Effect.succeed(null);

const defaultUsageOf: UsageOf = async (id, runtime, found, settings) => {
  if (id === "pi") return piBalance(settings);
  if (!runtime.accountUsage) return null;
  const usage = await withinRealTime(runtime.accountUsage(found, { timeoutMs: probeTimeoutMs }), probeTimeoutMs, undefined);
  return usage ? fromOar(usage) : null;
};

/** Only what is there. */
const optional = <K extends string>(key: K, v: string | undefined) => (v ? ({ [key]: v } as Record<K, string>) : {});

export const make = (options: RuntimeOptions = {}) =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const fs = yield* FileSystem.FileSystem;
    const logs = yield* callbackLog;
    const config = yield* Settings;
    const core = yield* Core;
    const store = yield* Agents;
    const registry = options.registry ?? registryOf();
    // Fibers started from callbacks belong to this service: they end with it and keep its services (the logger).
    const forkHere = yield* FiberSet.makeRuntime<never>();
    const emit = (e: Effect.Effect<void>) => void forkHere(e);
    /** null when the read fails. */
    const usageOf = (id: string, runtime: Runtime, found: AvailableInstallation, settings: RuntimeSettings) =>
      Effect.orElseSucceed(
        Effect.tryPromise(() => (options.usageOf ?? defaultUsageOf)(id, runtime, found, settings)),
        () => null,
      );

    const cache = new Map<string, Observation>();
    const relabeling = new Set<string>();
    /**
     * Each full probe takes the next number as it starts; the cache keeps the number of the probe it holds, and a probe
     * that started before it is dropped, so a slow full refresh never overwrites a newer one. Usage reads merge into the
     * observation of the full probe they started from (its number), and only while it is still the one held.
     */
    const reads = new Map<string, number>();
    /** Usage reads asked and the latest one taken, per runtime: an older answer arriving late does not undo a newer. */
    const usageAsked = new Map<string, number>();
    const usageTaken = new Map<string, number>();
    // The waits started from spend and usageSoon: one fiber per key, all ended with the service.
    const timers = yield* FiberMap.make<string>();
    const later = yield* FiberMap.runtime(timers)<never>();
    let closed = false;

    const spendFile = join(config.home, "spend.json");
    const disk = new FileWriter(spendFile);
    let spent: Spent = { day: dayOf(clock.currentTimeMillisUnsafe()), byRuntime: {} };
    // An unreadable tally, or yesterday's, starts the day again.
    const kept = jsonOrNone(SpentSchema)(Option.getOrUndefined(yield* Effect.option(fs.readFileString(spendFile))));
    if (kept && kept.day === spent.day) spent = kept;
    /** A new day starts from nothing. */
    const tally = () => {
      if (spent.day !== dayOf(clock.currentTimeMillisUnsafe())) spent = { day: dayOf(clock.currentTimeMillisUnsafe()), byRuntime: {} };
      return spent.byRuntime;
    };

    yield* Effect.addFinalizer(() =>
      Effect.andThen(
        Effect.suspend(() => {
          closed = true;
          return FiberMap.clear(timers);
        }),
        Effect.sync(() => {
          try {
            disk.finish(() => JSON.stringify(spent));
          } catch (e) {
            logs.warn(`vibevalley: could not save spend.json: ${String(e)}`);
          }
        }),
      ),
    );

    function withSpend(info: RuntimeInfo): RuntimeInfo {
      const { spentToday: _, stop: __, ...rest } = info;
      const cny = tally()[info.id];
      const out: RuntimeInfo = { ...rest, ...(cny !== undefined ? { spentToday: cny } : {}) };
      const stop = moneyStop(out);
      return { ...out, ...(stop ? { stop } : {}), quota: quotaOf(out.usage) };
    }

    /** What the runtime takes: seeds.json's facts, with what it refuses taken from the adapter and the farm's policy laid over it. */
    function facts(id: string) {
      const f = factsOf(id);
      return {
        ...f,
        refused: { ...registry.get(id)?.refusedSessionOptions, ...f.refused } as Record<string, string>,
      };
    }

    const begin = (id: string) => {
      const n = (reads.get(id) ?? 0) + 1;
      reads.set(id, n);
      return n;
    };

    function remember(next: Observation, read: number): RuntimeInfo {
      const id = next.info.id;
      const held = cache.get(id);
      if (held && read < held.read) return held.info;
      const info = withSpend({ ...next.info, preset: presetOf(id), facts: facts(id) });
      cache.set(id, { ...next, info, read, locale: currentLocale() });
      emit(core.runtime(info));
      return info;
    }

    const probe = Effect.fnUntraced(function* (id: string): Effect.fn.Return<Observation> {
      const settings = store.settings(id);
      const info: RuntimeInfo = {
        id,
        preset: presetOf(id),
        facts: facts(id),
        installation: { status: "checking" },
        models: null,
        usage: null,
        skills: null,
        mcpServers: null,
        tools: null,
        settings,
        checkedAt: clock.currentTimeMillisUnsafe(),
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
      const cwd = projectsDir(config);
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
            ...optional("description", s.description),
            ...optional("source", s.path || s.source),
            ...(s.enabled !== undefined ? { enabled: s.enabled } : {}),
          })),
          inventory(runtime.mcpServers, found, cwd, (m) => {
            const parts = [m.status, m.toolCount !== undefined ? t("server.runtime.tools", { n: m.toolCount }) : ""].filter(Boolean);
            return {
              name: m.name,
              ...optional("description", parts.join(" · ")),
              ...optional("source", m.source),
              ...(m.enabled !== undefined ? { enabled: m.enabled } : {}),
            };
          }),
          inventory(runtime.tools, found, cwd, (item) => ({
            name: item.name,
            ...optional("description", item.description),
            ...optional("source", item.mcpServerId || item.source),
            ...(item.enabled !== undefined ? { enabled: item.enabled } : {}),
          })),
        ],
        { concurrency: "unbounded" },
      );
      return { info: { ...info, models, usage, skills, mcpServers, tools }, found, read: 0 };
    });

    const known = (id: string) => runtimeIds().includes(id);

    const refresh = Effect.fnUntraced(function* (id: string): Effect.fn.Return<RuntimeInfo | undefined> {
      if (!known(id) || closed) return undefined;
      const read = begin(id);
      // The settings are the farm's own, whatever stands in for the machine.
      const looked = options.probe
        ? Effect.map(
            Effect.promise(() => options.probe!(id)),
            (i): Observation => ({ info: { ...i, settings: store.settings(id) }, read: 0 }),
          )
        : probe(id);
      return yield* Effect.ensuring(
        Effect.map(looked, (next) => (closed ? undefined : remember(next, read))),
        // A probe that failed leaves nothing cached: the next list asks again instead of showing "checking" for good.
        Effect.sync(() => {
          if (!cache.has(id) && reads.get(id) === read) reads.delete(id);
        }),
      );
    });

    const info = (id: string) =>
      Effect.suspend(() => {
        const hit = cache.get(id);
        return hit && hit.locale === currentLocale() ? Effect.succeed(withSpend(hit.info)) : refresh(id);
      });

    const refreshUsage = Effect.fnUntraced(function* (id: string) {
      const runtime = registry.get(id);
      const before = cache.get(id);
      // A runtime switched off is not asked: claude's reading, for one, calls its API every time.
      if (closed || !runtime || !before?.found || !before.info.settings.enabled) return;
      const asked = (usageAsked.get(id) ?? 0) + 1;
      usageAsked.set(id, asked);
      const usage = yield* usageOf(id, runtime, before.found, before.info.settings);
      // Kept unless a newer full probe replaced the one it read from, or a usage read asked later already landed. The
      // cached observation itself may have been rebuilt meanwhile (a spend pushes a new total): that is no reason to drop it.
      const now = cache.get(id);
      if (closed || !now || now.read !== before.read || (usageTaken.get(id) ?? 0) > asked) return;
      usageTaken.set(id, asked);
      if (JSON.stringify(usage) === JSON.stringify(now.info.usage)) return;
      remember({ ...now, info: { ...now.info, usage, checkedAt: clock.currentTimeMillisUnsafe() } }, now.read);
    });

    const each = (f: (id: string) => Effect.Effect<unknown>) =>
      Effect.forEach(runtimeIds(), (id) => Effect.ignoreCause(f(id)), { concurrency: 4, discard: true });

    // In the background, so the first page load does not wait on every runtime.
    if (options.background ?? true)
      yield* Effect.forkScoped(
        Effect.andThen(each(refresh), each(refreshUsage).pipe(Effect.repeat(Schedule.spaced(usageEveryMs)), Effect.delay(usageEveryMs))),
      );

    // A saved setting applies before its probe finishes; checks and resolution read the same current settings.
    const configuration = (id: string) =>
      Effect.map(info(id), (observed) => {
        const settings = store.settings(id);
        return { settings, info: observed ? withSpend({ ...observed, settings }) : undefined };
      });

    const assess = (agent: Agent) =>
      Effect.map(configuration(agent.runtime), ({ info: i }): Assessment => {
        const problems = agentProblems(agent, i);
        return { agent, info: i, problems, blocking: problems.filter((x) => x.level === "error") };
      });

    const candidates = Effect.suspend(() => Effect.forEach(store.agents(), (agent) => Effect.map(assess(agent), (a) => ({ agent, usable: usable(a) }))));

    const shape: RuntimeShape = {
      list: () =>
        runtimeIds().map((id) => {
          const hit = cache.get(id);
          // Shown as it was until the probe in the new language lands.
          if (hit && hit.locale !== currentLocale() && !closed && !relabeling.has(id)) {
            relabeling.add(id);
            emit(
              Effect.ensuring(
                Effect.ignoreCause(refresh(id)),
                Effect.sync(() => relabeling.delete(id)),
              ),
            );
          }
          if (hit) return withSpend(hit.info);
          // In the service's own fiber set: a probe that fails is retried by the next list, and none outlives the service.
          if (!closed && !reads.has(id)) emit(Effect.ignoreCause(refresh(id)));
          return {
            id,
            preset: presetOf(id),
            facts: facts(id),
            installation: { status: "checking" },
            models: null,
            usage: null,
            skills: null,
            mcpServers: null,
            tools: null,
            settings: store.settings(id),
            checkedAt: 0,
          };
        }),
      refresh,
      info,
      update: (id, s) =>
        known(id)
          ? Effect.andThen(
              store.saveSettings(id, s).pipe(Effect.mapError((e) => (e._tag === "Refused" ? refused(t("server.runtime.notSaved", { id, why: e.reason })) : e))),
              refresh(id),
            )
          : Effect.succeed(undefined),
      check: (agent) => Effect.map(assess(agent), (a) => a.problems),
      assess,
      candidates,
      choose: (task, named, picked) => Effect.map(candidates, (c) => chooseAgent(c, task, named, picked)),
      resolve: Effect.fn("Runtimes.resolve")(function* (agent) {
        const runtime = registry.get(agent.runtime);
        if (!runtime) return yield* Effect.fail(refused(t("server.runtime.cannotDrive", { runtime: agent.runtime })));
        const { info: i, settings } = yield* configuration(agent.runtime);
        const { model, effort, env, missingModel, problems } = sessionOptions(agent, settings, i);
        const problem = problems.find((i) => i.level === "error");
        if (problem) return yield* Effect.fail(refused(t("server.runtime.cannotSend", { name: agent.name, why: problem.text })));
        if (missingModel)
          yield* core.notice("warn", t("server.runtime.defaultModel", { runtime: runtimeLabel(agent.runtime), model: missingModel, name: agent.name }));
        const observed = cache.get(agent.runtime);
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
        const p = price(id, model);
        return p ? inCny(p, config.cnyPerUsd) : undefined;
      },
      spend: (id, cny) => {
        if (!(cny > 0) || closed) return;
        tally()[id] = (tally()[id] ?? 0) + cny;
        // The tally is written a second after the last spend; the runtime's new total is pushed once per window.
        later(
          "save",
          Effect.delay(
            Effect.sync(() => {
              try {
                disk.write(() => JSON.stringify(spent));
              } catch (e) {
                logs.warn(`vibevalley: could not save spend.json: ${String(e)}`);
              }
            }),
            1000,
          ),
        );
        later(
          `push:${id}`,
          Effect.delay(
            Effect.sync(() => {
              const held = cache.get(id);
              if (held && !closed) remember(held, held.read);
            }),
            spendPushAfterMs,
          ),
          { onlyIfMissing: true },
        );
      },
      usageSoon: (id) => {
        if (closed) return;
        later(`usage:${id}`, Effect.delay(Effect.ignoreCause(refreshUsage(id)), usageAfterRunMs), { onlyIfMissing: true });
      },
    };
    return Object.assign(shape, {
      refreshUsage,
      cached: cache,
      spent: () => spent,
      setSpent: (s: Spent) => (spent = s),
    });
  });

/** The farm's: VibeValley's own agent among them, unless options name the runtimes. */
export const layer = (options: RuntimeOptions = {}) =>
  Layer.effect(
    Runtimes,
    Effect.gen(function* () {
      if (options.registry) return yield* make(options);
      const config = yield* Settings;
      const keys = yield* Setting;
      const time = yield* timeHere;
      const service = yield* Llm;
      // It reads the DeepSeek key each session, so one saved meanwhile is used. The sessions' brains run on this service's
      // fibers, in scopes of its own: they end with it at the latest.
      const own = vibevalleyRuntimeOf({
        home: () => config.home,
        llm: (model) => modelClient(model, keys.deepseekApiKey, service),
        time,
        owner: { run: yield* FiberSet.makeRuntimePromise<never>(), scope: yield* Effect.scope },
        tasks: yield* dbStores,
      });
      return yield* make({ ...options, registry: registryOf([own, dshRuntime]) });
    }),
  );
