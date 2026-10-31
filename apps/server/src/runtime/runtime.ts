import { join } from "node:path";
// The runtimes the farm can run helpers on: oar's, VibeValley's own agent and DeepSeek Harness.
// Each is probed for whether it is installed, its models, its account's quota and what it carries (skills, MCP servers,
// tools); probing runs a runtime's own commands, so the answers are kept and asked again only on a refresh, the quota
// every five minutes and soon after a run. What each runtime spent today is kept in spend.json, and a runtime past its
// day's budget takes no work.

import {
  type AvailableInstallation,
  defaultRuntimes,
  type InstallationSnapshot,
  type InventoryReader,
  type Runtime as OarRuntime,
  RuntimeRegistry,
} from "@botiverse/oar";
import { Cache, Clock, Context, Effect, Exit, FiberMap, FiberSet, FileSystem, Layer, Option, Schedule, Schema } from "effect";

import { Llm } from "@vibevalley/ai/llm";
import { currentLocale, type Locale, t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { Agent } from "@/agent/agent.ts";
import { modelClient } from "@/agent/model.ts";
import { jsonOrNone } from "@/base/json.ts";
import { Core } from "@/core/core.ts";
import { type ApiError, messageOf, refused } from "@/errors.ts";
import { projectsDir, ServerConfig } from "@/infra/config.ts";
import { keptFile } from "@/infra/files.ts";
import { timeHere, withinRealTime } from "@/infra/time.ts";
import { Setting } from "@/setting/setting.ts";

import { dshRuntime } from "./dsh.ts";
import { agentProblems, type Candidate, chooseAgent, sessionOptions } from "./fit.ts";
import { piBalance, type PiDefault, piSettings } from "./pi.ts";
import { factsOf, presetOf, runtimeIds, runtimeLabel } from "./presets.ts";
import { inCny, price, type Rate } from "./price.ts";
import { moneyStop, quotaOf } from "./quota.ts";
import { dbTodoStores } from "./todoStore.ts";
import { vibevalleyRuntimeOf } from "./vibevalley.ts";

/** Past this a probe counts as unknown. */
const probeTimeoutMs = 10_000;
const usageEveryMs = 5 * 60_000;
/** Several runs share one read. */
const usageAfterRunMs = 20_000;
/** A busy session spends every few seconds: the pages hear of it a moment later, with whatever else was spent. */
const spendPushAfterMs = 3_000;

/** Dispatch eligibility with the runtime state that explains it. */
export interface Assessment {
  readonly agent: T.Agent;
  readonly info: T.RuntimeInfo | undefined;
  readonly problems: T.AgentProblem[];
  readonly blocking: T.AgentProblem[];
}

export const usable = (a: Assessment) => a.agent.enabled && a.blocking.length === 0;

/** What a session needs once the profile's choices and the runtime's defaults are reconciled. */
export interface Resolved {
  readonly runtime: OarRuntime;
  /** The installation the last probe found, when it was probed with the binary the settings name now. */
  readonly installation?: AvailableInstallation;
  readonly binPath: string;
  readonly model: string;
  readonly effort: string;
  readonly env: Record<string, string>;
}

export class Runtime extends Context.Service<
  Runtime,
  {
    /** Answers at once: a runtime not looked at yet comes as checking, and its probe's answer follows as a runtime event. */
    readonly list: () => Effect.Effect<T.RuntimeInfo[]>;
    readonly refresh: (id: string) => Effect.Effect<T.RuntimeInfo | undefined>;
    readonly info: (id: string) => Effect.Effect<T.RuntimeInfo | undefined>;
    readonly update: (id: string, s: T.RuntimeSettings) => Effect.Effect<T.RuntimeInfo | undefined, ApiError>;
    /** The profile's problems as it would be dispatched now. */
    readonly problemsOf: (agent: T.Agent) => Effect.Effect<T.AgentProblem[]>;
    readonly assess: (agent: T.Agent) => Effect.Effect<Assessment>;
    /** Every profile, and whether it can be sent now. */
    readonly candidates: Effect.Effect<Candidate[]>;
    /** Who the farm sends for a task now: chooseAgent over the candidates. */
    readonly choose: (brief: string, named: string, picked: string) => Effect.Effect<T.Agent | undefined>;
    /** Validates the effective options on every opening; availability and spending only gate new work. */
    readonly resolve: (agent: T.Agent) => Effect.Effect<Resolved, ApiError>;
    readonly runtime: (id: string) => OarRuntime | undefined;
    readonly quote: (id: string, model: string) => Rate | undefined;
    readonly spend: (id: string, cny: number) => void;
    /** Reads the runtime's quota a little after a run, several runs sharing one read. */
    readonly usageSoon: (id: string) => void;
  }
>()("vibevalley/Runtime") {
  static readonly layer = (options: RuntimeOptions = {}) =>
    Layer.effect(
      Runtime,
      Effect.gen(function* () {
        if (options.registry) return yield* make(options);
        const config = yield* ServerConfig;
        const keys = yield* Setting;
        const time = yield* timeHere;
        const service = yield* Llm;
        // It reads the DeepSeek key each session, so one saved meanwhile is used. The sessions' brains run on this service's
        // fibers, in scopes of its own: they end with it at the latest.
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

/** What reads a runtime's account usage; tests put their own. */
export type UsageOf = (id: string, runtime: OarRuntime, found: AvailableInstallation, settings: T.RuntimeSettings) => Promise<T.AccountUsage | null>;

export interface RuntimeOptions {
  /** The runtimes; oar's defaults when none. */
  registry?: RuntimeRegistry;
  /** Answers a probe without asking the runtime: tests never ask this machine's runtimes. */
  probe?: (id: string) => Promise<T.RuntimeInfo>;
  usageOf?: UsageOf;
  /** The background reads (the first probe of every runtime, the quota every five minutes); off in tests. */
  background?: boolean;
}

/** The farm's runtimes: oar's and those the farm adds (VibeValley's own agent, DeepSeek Harness); one added with oar's id takes its place. */
export function registryOf(extra: readonly OarRuntime[] = []) {
  const added = new Set(extra.map((r) => r.id));
  return new RuntimeRegistry([...defaultRuntimes.list().filter((r) => !added.has(r.id)), ...extra]);
}

/** One accepted probe owns both what is shown and the installation later reads of its usage use. */
interface Observation {
  info: T.RuntimeInfo;
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
export function probeInstallation(runtime: OarRuntime, binPath: string): Promise<InstallationSnapshot> {
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

/** An oar read, given up on after probeTimeoutMs of real time: fallback then, and when it fails. */
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

/** Only what is there. */

export const make = (options: RuntimeOptions = {}) =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig;
    const core = yield* Core;
    const store = yield* Agent;
    const registry = options.registry ?? registryOf();
    // Fibers started from callbacks belong to this service: they end with it and keep its services (the logger).
    const forkHere = yield* FiberSet.makeRuntime();
    const emit = (e: Effect.Effect<void>) => void forkHere(e);
    /** null when the read fails. */
    const usageOf = (id: string, runtime: OarRuntime, found: AvailableInstallation, settings: T.RuntimeSettings) =>
      !options.usageOf && id === "pi"
        ? piBalance(settings)
        : Effect.orElseSucceed(
            Effect.tryPromise({ try: () => (options.usageOf ?? defaultUsageOf)(id, runtime, found, settings), catch: messageOf }),
            () => null,
          );

    /** pi's own default model, read again whenever pi is looked at: what a quote for pi's default prices. */
    const readPiDefault = Effect.promise(piSettings);
    let piDefault: PiDefault = yield* readPiDefault;
    /** Runtimes being looked at again in a new language: one probe each, the old words shown until it lands. */
    const relabeling = new Set<string>();
    /** Each full probe's number, per runtime: a usage read merges into the probe it read from, only while that one is held. */
    const probes = new Map<string, number>();
    /** Runtimes with a probe out: a refresh's is not in the cache until it lands (the old value is shown meanwhile), so a
     * list that finds nothing held asks for none of its own while one is out. */
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
    /** Usage reads asked and the latest one taken, per runtime: an older answer arriving late does not undo a newer. */
    const usageAsked = new Map<string, number>();
    const usageTaken = new Map<string, number>();
    // The waits started from spend and usageSoon: one fiber per key, all ended with the service.
    const timers = yield* FiberMap.make<string>();
    const later = yield* FiberMap.runtime(timers)();
    let closed = false;

    const spendFile = join(config.home, "spend.json");
    // The tally is written a second after the first spend, the ones in between joining it, and as the service closes.
    const disk = yield* keptFile(spendFile, { soonMs: 1000 });
    let spent: Spent = { day: dayOf(yield* Clock.currentTimeMillis), byRuntime: {} };
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
        Effect.sync(() => disk.soon(() => JSON.stringify(spent))),
      ),
    );

    function withSpend(info: T.RuntimeInfo): T.RuntimeInfo {
      const { spentToday: _, ...rest } = info;
      const cny = tally()[info.id];
      const out: T.RuntimeInfo = { ...rest, ...(cny !== undefined ? { spentToday: cny } : {}) };
      return { ...out, stop: moneyStop(out), quota: quotaOf(out.usage) };
    }

    /** What the runtime takes: seeds.json's facts, with what it refuses taken from the adapter and the farm's policy laid over it. */
    function facts(id: string) {
      const f = factsOf(id);
      return {
        ...f,
        refused: { ...registry.get(id)?.refusedSessionOptions, ...f.refused } as Record<string, string>,
      };
    }

    /** What a probe found, as the farm shows it: its preset, facts and today's spend laid over. */
    const shown = (next: Observation): Observation => {
      const id = next.info.id;
      return { ...next, info: withSpend({ ...next.info, preset: presetOf(id), facts: facts(id) }), locale: currentLocale() };
    };

    const probe = Effect.fnUntraced(function* (id: string): Effect.fn.Return<Observation> {
      if (id === "pi") piDefault = yield* readPiDefault;
      const settings = store.settings(id);
      const info: T.RuntimeInfo = {
        id,
        preset: presetOf(id),
        facts: facts(id),
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
            description: s.description ?? "",
            source: s.path || s.source || "",
            ...(s.enabled !== undefined ? { enabled: s.enabled } : {}),
          })),
          inventory(runtime.mcpServers, found, cwd, (m) => {
            const parts = [m.status, m.toolCount !== undefined ? t("server.runtime.tools", { n: m.toolCount }) : ""].filter(Boolean);
            return {
              name: m.name,
              description: parts.join(" · "),
              source: m.source ?? "",
              ...(m.enabled !== undefined ? { enabled: m.enabled } : {}),
            };
          }),
          inventory(runtime.tools, found, cwd, (item) => ({
            name: item.name,
            description: item.description ?? "",
            source: item.mcpServerId || item.source || "",
            ...(item.enabled !== undefined ? { enabled: item.enabled } : {}),
          })),
        ],
        { concurrency: "unbounded" },
      );
      return { info: { ...info, models, usage, skills, mcpServers, tools }, found, read: 0 };
    });

    const known = (id: string) => runtimeIds().includes(id);

    // One probe per runtime at a time, shared by whoever asks meanwhile; a refresh starts a new one, and the one started
    // last is the one kept, so a slow full refresh never overwrites a newer one. A probe that failed is not kept: the
    // next ask probes again.
    const cache = yield* Cache.makeWith(
      (id: string) =>
        Effect.gen(function* () {
          const read = (probes.get(id) ?? 0) + 1;
          probes.set(id, read);
          // The settings are the farm's own, whatever stands in for the machine.
          const next = options.probe
            ? yield* Effect.map(
                Effect.promise(() => options.probe!(id)),
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
    /** The observation held, laid over again (a new total spent, a usage read) and told. */
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
      // A runtime switched off is not asked: claude's reading, for one, calls its API every time.
      if (closed || !runtime || !before?.found || !before.info.settings.enabled) return;
      const asked = (usageAsked.get(id) ?? 0) + 1;
      usageAsked.set(id, asked);
      const usage = yield* usageOf(id, runtime, before.found, before.info.settings);
      // Kept unless a newer full probe replaced the one it read from, or a usage read asked later already landed. The
      // cached observation itself may have been rebuilt meanwhile (a spend pushes a new total): that is no reason to drop it.
      const now = yield* held(id);
      if (closed || !now || now.read !== before.read || (usageTaken.get(id) ?? 0) > asked) return;
      usageTaken.set(id, asked);
      if (JSON.stringify(usage) === JSON.stringify(now.info.usage)) return;
      yield* keep({ ...now, info: { ...now.info, usage, checkedAt: yield* Clock.currentTimeMillis } });
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

    const assess = Effect.fn("Runtime.assess")(function* (agent: T.Agent): Effect.fn.Return<Assessment> {
      const { info: i } = yield* configuration(agent.runtime);
      const problems = agentProblems(agent, i);
      return { agent, info: i, problems, blocking: problems.filter((x) => x.level === "error") };
    });

    const candidates = Effect.suspend(() => Effect.forEach(store.agents(), (agent) => Effect.map(assess(agent), (a) => ({ agent, usable: usable(a) }))));

    const shape = Runtime.of({
      list: Effect.fn("Runtime.list")(function* () {
        return yield* Effect.forEach(runtimeIds(), (id) =>
          Effect.gen(function* () {
            const hit = yield* held(id);
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
            // In the service's own fiber set: one probe however many lists ask, and none outlives the service.
            if (!closed && !probing.has(id)) emit(Effect.ignoreCause(out(id, Cache.get(cache, id))));
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
        return chooseAgent(yield* candidates, brief, named, picked);
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
        if (!(cny > 0) || closed) return;
        tally()[id] = (tally()[id] ?? 0) + cny;
        // The runtime's new total is pushed once per window.
        disk.soon(() => JSON.stringify(spent));
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
        later(`usage:${id}`, Effect.delay(Effect.ignoreCause(refreshUsage(id)), usageAfterRunMs), { onlyIfMissing: true });
      },
    });
    return Object.assign(shape, {
      refreshUsage,
      /** The observation held for a runtime, none before its first probe lands. */
      cached: held,
      spent: () => spent,
      setSpent: (s: Spent) => (spent = s),
    });
  });

/** The farm's: VibeValley's own agent among them, unless options name the runtimes. */
