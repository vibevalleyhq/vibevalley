import { join } from "node:path";

import { Array as Arr, Context, Effect, FileSystem, Layer, Option, Order, Predicate, Redacted, Schema } from "effect";

import { frontMatter, skillBody } from "@vibevalley/agent/skills";
import { deepseek, MissingKey, type ModelClient } from "@vibevalley/ai/client";
import type { Llm } from "@vibevalley/ai/llm";
import { currentLocale, list, t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { defaultOrchestrator, orchestratorRuntime, SpeciesValues } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { serverFile } from "#/base/assets.ts";
import { type ApiError, Inconsistent, lookIn, missing, refused } from "#/base/errors.ts";
import { jsonText } from "#/base/json.ts";
import { ServerConfig } from "#/infra/config.ts";
import { keptFile, readOrSetAside } from "#/infra/files.ts";
import { defaultSettings } from "#/runtime/presets.ts";

import { addedTemplates, builtInTemplates, copyTemplate, profileOf, readTemplate, removeTemplate, updatedFrom } from "./template.ts";

interface Stored {
  readonly agents: readonly T.Agent[];
  readonly skills: readonly T.Skill[];
  readonly settings: Readonly<Record<string, T.RuntimeSettings>>;
}

// Backfill `build` and `head` before schema decoding for config.json files written prior to those fields.
const readFile = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      agents: Schema.Array(Schema.Unknown),
      skills: Schema.Array(S.Skill),
      settings: Schema.Record(Schema.String, S.RuntimeSettings),
    }),
  ),
);
const readAgent = Schema.decodeUnknownEffect(S.Agent);
const lookFilled = (raw: unknown): unknown =>
  Predicate.isObject(raw) && Predicate.isObject(raw.look)
    ? {
        ...raw,
        look: { species: null, outfit: null, orchestrator: null, ...raw.look, build: raw.look.build ?? "biped", head: raw.look.head ?? "rounded" },
      }
    : raw;
const readStored = Effect.fnUntraced(function* (text: string) {
  const file = yield* readFile(text);
  const agents = yield* Effect.forEach(file.agents, (a) => readAgent(lookFilled(a)));
  return { agents, skills: file.skills, settings: file.settings } satisfies Stored;
});

/** Hashes each code point's leading UTF-16 code unit (32-bit unsigned) to match client avatar selection. */
function castHash(s: string): number {
  let h = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    const unit = cp > 0xffff ? 0xd800 + ((cp - 0x10000) >> 10) : cp;
    h = (Math.imul(h, 31) + unit) >>> 0;
  }
  return h;
}

export function withCast(a: T.Agent): T.Agent {
  const look = { ...a.look };
  look.build ||= "biped";
  look.head ||= "rounded";
  look.species ??= SpeciesValues[castHash(a.id) % SpeciesValues.length] ?? "cat";
  look.outfit ??= "farmer";
  look.orchestrator = a.role === "orchestrator" ? (look.orchestrator ?? "farmer") : null;
  return { ...a, look };
}

export class Agent extends Context.Service<
  Agent,
  {
    /** Helper profiles only. */
    readonly agents: () => T.Agent[];
    readonly all: () => T.Agent[];
    readonly orchestrators: () => T.Agent[];
    readonly isOrchestrator: (id: string) => boolean;
    /** True when the profile runs in-process via `Session.host` rather than on an external runtime. */
    readonly isHosted: (id: string) => boolean;
    readonly agent: (id: string) => T.Agent | undefined;
    readonly named: (key: string) => T.Agent | undefined;
    readonly skills: () => T.Skill[];
    readonly settings: (runtime: string) => T.RuntimeSettings;
    readonly save: (a: T.Agent) => Effect.Effect<T.Agent, ApiError>;
    readonly create: (draft: T.Agent) => Effect.Effect<T.Agent, ApiError>;
    readonly remove: (id: string) => Effect.Effect<void, ApiError>;
    readonly previewRemove: (id: string) => Effect.Effect<T.Preview, ApiError>;
    readonly saveSkill: (s: T.Skill) => Effect.Effect<T.Skill, ApiError>;
    readonly createSkill: (draft: T.Skill) => Effect.Effect<T.Skill, ApiError>;
    readonly removeSkill: (id: string) => Effect.Effect<void, ApiError>;
    readonly previewRemoveSkill: (id: string) => Effect.Effect<T.Preview, ApiError>;
    readonly saveSettings: (runtime: string, s: T.RuntimeSettings) => Effect.Effect<T.RuntimeSettings, ApiError>;
    /** Registers an invariant hook run before `save`/`create` returns; a failure aborts the call. */
    readonly whenKept: (keep: (agent: T.Agent) => Effect.Effect<void, ApiError>) => void;
    readonly templates: () => Effect.Effect<T.AgentTemplate[]>;
    readonly installTemplate: (id: string) => Effect.Effect<T.Agent, ApiError>;
    readonly updateFromTemplate: (agent: string) => Effect.Effect<T.Agent, ApiError>;
    readonly addTemplate: (path: string) => Effect.Effect<T.AgentTemplate, ApiError>;
    readonly removeTemplate: (id: string) => Effect.Effect<void, ApiError>;
    readonly previewRemoveTemplate: (id: string) => Effect.Effect<T.Preview, ApiError>;
  }
>()("@vibevalley/server/agent/agent") {
  static readonly layer = Layer.effect(
    Agent,
    Effect.suspend(() => make),
  );
}

const free = (want: string, taken: readonly string[], join: string) => {
  if (!taken.includes(want)) return want;
  let n = 2;
  while (taken.includes(`${want}${join}${n}`)) n++;
  return `${want}${join}${n}`;
};

const installed = (template: T.AgentTemplate, beside: readonly T.Agent[], id?: string): T.Agent =>
  profileOf(
    template,
    id ??
      free(
        template.id,
        beside.map((a) => a.id),
        "-",
      ),
    free(
      template.name,
      beside.map((a) => a.name),
      " ",
    ),
  );

const builtInSkillsDir = serverFile("src/agent/skills");
const readBuiltInSkills = (fs: FileSystem.FileSystem) =>
  Effect.orDie(
    Effect.gen(function* () {
      const folders = yield* fs.readDirectory(builtInSkillsDir);
      const ids = Arr.sort(folders, Order.String);
      const en = currentLocale() === "en";
      return yield* Effect.forEach(ids, (id) =>
        Effect.gen(function* () {
          const english = join(builtInSkillsDir, id, "SKILL.en.md");
          const inEnglish = en && (yield* fs.exists(english));
          const text = yield* fs.readFileString(inEnglish ? english : join(builtInSkillsDir, id, "SKILL.md"));
          const head = frontMatter(text);
          return { id, name: head.name ?? id, description: head.description ?? "", body: skillBody(text), builtIn: true } satisfies T.Skill;
        }),
      );
    }),
  );

const upsert = <T extends { id: string }>(list: readonly T[], item: T) =>
  list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item];

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const file = join(config.home, "config.json");
  const fs = yield* FileSystem.FileSystem;
  const withFs = Effect.provideService(FileSystem.FileSystem, fs);
  const disk = yield* keptFile(file);
  const builtIn = yield* builtInTemplates;
  const builtInOf = (id: string) => builtIn.find((item) => item.id === id);
  const ownSkills = yield* readBuiltInSkills(fs);
  const builtInSkillOf = (id: string) => Arr.findFirst(ownSkills, (k) => k.id === id);
  const isBuiltInSkill = (id: string) => Option.isSome(builtInSkillOf(id));
  for (const item of builtIn)
    for (const id of item.skills)
      if (!isBuiltInSkill(id)) return yield* Effect.die(Inconsistent.make({ message: `the built-in template ${item.id} names ${id}, not in agent/skills` }));
  const starters: T.Agent[] = [];
  yield* Effect.forEach(
    config.agent.starters,
    (id) =>
      Effect.gen(function* () {
        const builtIn = builtInOf(id);
        if (builtIn) starters.push(installed(builtIn, starters));
        else yield* Effect.logWarning(`vibevalley: agent.starters names no built-in template: ${id}`);
      }),
    { discard: true },
  );
  const seed: Stored = { agents: starters, skills: [], settings: {} };
  let s: Stored = seed;
  s = (yield* readOrSetAside(file, readStored, "the profiles start from the starters")) ?? seed;
  // The default orchestrator is always there, and always an orchestrator: a farm is never without one.
  const orchestrator = builtInOf(defaultOrchestrator);
  if (!orchestrator) return yield* Effect.die(Inconsistent.make({ message: `the built-in template ${defaultOrchestrator} is not in agent/templates` }));
  const agents = s.agents.some((a) => a.id === defaultOrchestrator)
    ? s.agents.map((a) => (a.id === defaultOrchestrator ? { ...a, role: "orchestrator" as const } : a))
    : [installed(orchestrator, s.agents, defaultOrchestrator), ...s.agents];
  s = { agents: agents.map(withCast), skills: s.skills, settings: s.settings };
  yield* Effect.orDie(Effect.flatMap(jsonText(s), disk.save));

  const keeps: ((agent: T.Agent) => Effect.Effect<void, ApiError>)[] = [];
  const saved = (agent: T.Agent) =>
    Effect.as(
      Effect.forEach(keeps, (keep) => keep(agent), { discard: true }),
      agent,
    );

  /** A change is kept only once it is on disk: one that cannot be written is refused and leaves the profiles as they were. */
  const change = (f: (s: Stored) => Stored) =>
    Effect.gen(function* () {
      const next = structuredClone(f(structuredClone(s)));
      yield* Effect.flatMap(jsonText(next), disk.save).pipe(Effect.mapError((e) => refused(t("server.agent.notSaved", { file, why: e.message }))));
      s = next;
    });

  const all = () => structuredClone([...s.agents]);
  const sendable = () => all().filter((a) => a.role === "worker");
  const isOrchestrator = (id: string) => s.agents.some((a) => a.id === id && a.role === "orchestrator");

  /** Why a profile cannot be kept as it is: an orchestrator runs only on VibeValley's own agent, in the server, where it stays and is reached on a call. */
  const roleProblem = (a: T.Agent): string => {
    if (a.id === defaultOrchestrator && a.role !== "orchestrator") return t("server.agent.defaultStaysOrchestrator");
    if (a.role === "orchestrator" && a.runtime !== orchestratorRuntime) return t("server.agent.orchestratorRuntime", { runtime: orchestratorRuntime });
    return "";
  };

  const deletableAgent = (id: string) => {
    if (id === defaultOrchestrator) return Effect.fail(refused(t("server.agent.orchestratorStays")));
    const a = s.agents.find((x) => x.id === id);
    return a ? Effect.succeed(a) : Effect.fail(missing(t("server.agent.noAgent", { id }), [lookIn.agent]));
  };
  const builtInRefusal = (id: string) =>
    Option.getOrUndefined(Option.map(builtInSkillOf(id), (k) => refused(t("server.agent.builtInSkill", { name: k.name }))));
  const notBuiltIn = (id: string) => {
    const no = builtInRefusal(id);
    return no === undefined ? Effect.void : Effect.fail(no);
  };
  const deletableSkill = (id: string) => {
    const no = builtInRefusal(id);
    if (no !== undefined) return Effect.fail(no);
    const k = s.skills.find((x) => x.id === id);
    return k ? Effect.succeed(k) : Effect.fail(missing(t("server.agent.noSkill", { id }), [lookIn.skill]));
  };

  // Re-read from disk on each call so templates added or removed directly in `home` appear immediately.
  const templates = Effect.fn("Agent.templates")(function* () {
    const added = yield* withFs(addedTemplates(config.home));
    yield* Effect.forEach(added.problems, (why) => Effect.logWarning(`vibevalley: an added template is left out: ${why}`), { discard: true });
    return [...builtIn, ...added.templates].map((item) => ({
      ...item,
      installed: s.agents.filter((a) => a.from?.template === item.id).map((a) => a.id),
    }));
  });
  const templateOf = (id: string) => Effect.map(templates(), (all) => all.find((template) => template.id === id));
  const deletableTemplate = Effect.fnUntraced(function* (id: string) {
    const item = yield* templateOf(id);
    if (!item) return yield* Effect.fail(missing(t("server.agent.template.noTemplate", { id }), [lookIn.template]));
    return item.source === "builtIn" ? yield* Effect.fail(refused(t("server.agent.template.builtIn", { id }))) : item;
  });

  const shape = Agent.of({
    agents: () => sendable(),
    all,
    agent: (id) => all().find((a) => a.id === id),
    named: (key) => {
      const k = key.trim();
      return sendable().find((a) => a.id === k) ?? sendable().find((a) => a.name === k);
    },
    // Built-in skills shadow any legacy user skill saved under the same id before the built-in shipped.
    skills: () => structuredClone([...ownSkills, ...Arr.filter(s.skills, (k) => !isBuiltInSkill(k.id))]),
    settings: (runtime) => structuredClone(s.settings[runtime]) ?? defaultSettings(),
    orchestrators: () => all().filter((a) => a.role === "orchestrator"),
    isOrchestrator,
    isHosted: isOrchestrator,
    save: Effect.fn("Agent.save")(function* (a) {
      const why = roleProblem(a);
      if (why) return yield* Effect.fail(refused(why));
      const cast = withCast(a);
      yield* change((x) => ({ ...x, agents: upsert(x.agents, cast) }));
      return yield* saved(cast);
    }),
    create: Effect.fn("Agent.create")(function* (draft) {
      if (draft.id) return yield* Effect.fail(refused(t("server.agent.newAgentId")));
      const why = roleProblem(draft);
      if (why) return yield* Effect.fail(refused(why));
      let n = 1;
      while (s.agents.some((a) => a.id === `agent-${n}`)) n++;
      const created = withCast({ ...draft, id: `agent-${n}` });
      yield* change((x) => ({ ...x, agents: [...x.agents, created] }));
      return yield* saved(created);
    }),
    remove: Effect.fn("Agent.remove")(function* (id) {
      yield* deletableAgent(id);
      return yield* change((x) => ({ ...x, agents: x.agents.filter((a) => a.id !== id) }));
    }),
    previewRemove: Effect.fn("Agent.previewRemove")(function* (id) {
      const a = yield* deletableAgent(id);
      return { does: [t("server.agent.removeAgent", { name: a.name, id: a.id, runtime: a.runtime })] };
    }),
    saveSkill: Effect.fn("Agent.saveSkill")(function* (skill) {
      yield* notBuiltIn(skill.id);
      const { builtIn: _, ...kept } = skill;
      yield* change((x) => ({ ...x, skills: upsert(x.skills, kept) }));
      return kept;
    }),
    createSkill: Effect.fn("Agent.createSkill")(function* (draft) {
      if (draft.id) return yield* Effect.fail(refused(t("server.agent.newSkillId")));
      const stem =
        draft.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/gu, "-")
          .replace(/^-+|-+$/gu, "") || "skill";
      let id = stem;
      const taken = (x: string) => isBuiltInSkill(x) || Arr.some(s.skills, (k) => k.id === x);
      for (let n = 2; taken(id); n++) id = `${stem}-${n}`;
      const { builtIn: _, ...words } = draft;
      const created = { ...words, id };
      yield* change((x) => ({ ...x, skills: [...x.skills, created] }));
      return created;
    }),
    removeSkill: Effect.fn("Agent.removeSkill")(function* (id) {
      yield* deletableSkill(id);
      return yield* change((x) => ({
        ...x,
        skills: x.skills.filter((k) => k.id !== id),
        agents: x.agents.map((a) => ({ ...a, skills: a.skills.filter((skill) => skill !== id) })),
      }));
    }),
    previewRemoveSkill: Effect.fn("Agent.previewRemoveSkill")(function* (id) {
      const k = yield* deletableSkill(id);
      const holders = s.agents.filter((a) => a.skills.includes(id)).map((a) => a.name);
      return {
        does: [
          t("server.agent.removeSkill", { name: k.name }),
          ...(holders.length > 0 ? [t("server.agent.unequip", { holders: list(holders.map((name) => t("server.agent.quoted", { name }))) })] : []),
        ],
      };
    }),
    saveSettings: Effect.fn("Agent.saveSettings")(function* (runtime, settings) {
      yield* change((x) => ({ ...x, settings: { ...x.settings, [runtime]: settings } }));
      return settings;
    }),
    whenKept: (keep) => void keeps.push(keep),
    templates,
    installTemplate: Effect.fn("Agent.installTemplate")(function* (id) {
      const item = yield* templateOf(id);
      if (!item) return yield* Effect.fail(missing(t("server.agent.template.noTemplate", { id }), [lookIn.template]));
      const made = withCast(installed(item, s.agents));
      yield* change((x) => ({ ...x, agents: [...x.agents, made] }));
      return yield* saved(made);
    }),
    updateFromTemplate: Effect.fn("Agent.updateFromTemplate")(function* (agent) {
      const a = s.agents.find((x) => x.id === agent);
      if (!a) return yield* Effect.fail(missing(t("server.agent.noAgent", { id: agent }), [lookIn.agent]));
      if (!a.from) return yield* Effect.fail(refused(t("server.agent.template.notFrom", { name: a.name })));
      const item = yield* templateOf(a.from.template);
      if (!item) return yield* Effect.fail(refused(t("server.agent.template.gone", { name: a.name, template: a.from.template })));
      const next = withCast(updatedFrom(item, a));
      yield* change((x) => ({ ...x, agents: upsert(x.agents, next) }));
      return yield* saved(next);
    }),
    addTemplate: Effect.fn("Agent.addTemplate")(function* (path) {
      const item = yield* withFs(readTemplate(path, "added")).pipe(Effect.mapError((e) => refused(e.message)));
      if (yield* templateOf(item.id)) return yield* Effect.fail(refused(t("server.agent.template.taken", { id: item.id })));
      yield* withFs(copyTemplate(path, config.home, item.id)).pipe(Effect.mapError((e) => refused(t("server.agent.notSaved", { file: path, why: e.message }))));
      return { ...item, installed: [] };
    }),
    removeTemplate: Effect.fn("Agent.removeTemplate")(function* (id) {
      const item = yield* deletableTemplate(id);
      return yield* withFs(removeTemplate(config.home, item.id)).pipe(
        Effect.mapError((e) => refused(t("server.agent.notSaved", { file: id, why: e.message }))),
      );
    }),
    previewRemoveTemplate: Effect.fn("Agent.previewRemoveTemplate")(function* (id) {
      const item = yield* deletableTemplate(id);
      return {
        does: [
          item.installed.length > 0
            ? t("server.agent.template.deleteKept", { name: item.name, installed: item.installed.length })
            : t("server.agent.template.delete", { name: item.name }),
        ],
      };
    }),
  });
  return shape;
});

export const noDeepSeekKey = () => t("server.agent.noDeepSeekKey");

/** Unwraps `Redacted` lazily per request so the plaintext key is not retained in closures. */
export function modelClient(id: string, key: Redacted.Redacted | (() => Redacted.Redacted | undefined), service: Llm["Service"]): ModelClient {
  const plain = Redacted.isRedacted(key)
    ? () => Redacted.value(key)
    : () => {
        const current = key();
        return current === undefined ? undefined : Redacted.value(current);
      };
  try {
    return deepseek(id, plain, service);
  } catch (e) {
    if (Schema.is(MissingKey)(e)) throw new Error(noDeepSeekKey(), { cause: e });
    throw e;
  }
}
