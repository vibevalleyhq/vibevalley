// The profiles (orchestrators and helpers), the skills and each runtime's settings: config.json in the home. A profile
// is made by hand or installed from a template (template.ts); the default orchestrator is installed from its built-in
// template when it is missing, so a farm always has one.

import { join } from "node:path";

import { Context, Effect, FileSystem, Layer, Predicate, Schema } from "effect";

import { list, t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { defaultOrchestrator, orchestratorRuntime, SpeciesValues } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { type ApiError, missing, refused, lookIn } from "@/errors.ts";
import { ServerConfig } from "@/infra/config.ts";
import { keptFile, readOrSetAside } from "@/infra/files.ts";
import { defaultSettings } from "@/runtime/presets.ts";

import { addedTemplates, builtInTemplates, copyTemplate, profileOf, readTemplate, removeTemplate, updatedFrom } from "./template.ts";

interface Stored {
  readonly agents: readonly T.Agent[];
  readonly skills: readonly T.Skill[];
  readonly settings: Readonly<Record<string, T.RuntimeSettings>>;
}

// A profile's look may lack what withCast fills in (a build and a head): config.json from before those existed. They are
// filled first, then the profile is read whole; anything else that does not fit makes the file unreadable.
const readFile = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      agents: Schema.Array(Schema.Unknown),
      skills: Schema.Array(S.Skill),
      settings: Schema.Record(Schema.String, S.RuntimeSettings),
    }),
  ),
);
const readAgent = Schema.decodeUnknownSync(S.Agent);
const lookFilled = (raw: unknown): unknown =>
  Predicate.isObject(raw) && Predicate.isObject(raw.look)
    ? {
        ...raw,
        look: { ...raw.look, build: raw.look.build ?? "biped", head: raw.look.head ?? "rounded" },
      }
    : raw;
const readStored = (text: string): Stored => {
  const file = readFile(text);
  return {
    agents: file.agents.map((a) => readAgent(lookFilled(a))),
    skills: file.skills,
    settings: file.settings,
  };
};

/** Over each code point's first UTF-16 unit, wrapping at 32 bits, as the client counts. */
function castHash(s: string): number {
  let h = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const unit = cp > 0xffff ? 0xd800 + ((cp - 0x10000) >> 10) : cp;
    h = (Math.imul(h, 31) + unit) >>> 0;
  }
  return h;
}

/** Missing appearance fields are filled on load and save: no enum reaches a client as an empty string. */
export function withCast(a: T.Agent): T.Agent {
  const look = { ...a.look };
  look.build ||= "biped";
  look.head ||= "rounded";
  look.species ??= SpeciesValues[castHash(a.id) % SpeciesValues.length]!;
  look.outfit ??= "farmer";
  if (a.role === "orchestrator") look.orchestrator ??= "farmer";
  else delete look.orchestrator;
  return { ...a, look };
}

export class Agent extends Context.Service<
  Agent,
  {
    /** The profiles work is sent to: the helpers. */
    readonly agents: () => T.Agent[];
    /** All the profiles, the orchestrators too. */
    readonly all: () => T.Agent[];
    readonly orchestrators: () => T.Agent[];
    /** A profile with this id is an orchestrator. */
    readonly isOrchestrator: (id: string) => boolean;
    readonly agent: (id: string) => T.Agent | undefined;
    /** A profile work is sent to, by its id or its name, as a person or a model says it. */
    readonly named: (key: string) => T.Agent | undefined;
    readonly skills: () => T.Skill[];
    readonly settings: (runtime: string) => T.RuntimeSettings;
    readonly save: (a: T.Agent) => Effect.Effect<T.Agent, ApiError>;
    readonly create: (draft: T.Agent) => Effect.Effect<T.Agent, ApiError>;
    readonly remove: (id: string) => Effect.Effect<void, ApiError>;
    /** What remove would do, refused as it would be; nothing changes. */
    readonly previewRemove: (id: string) => Effect.Effect<T.Preview, ApiError>;
    readonly saveSkill: (s: T.Skill) => Effect.Effect<T.Skill, ApiError>;
    readonly createSkill: (draft: T.Skill) => Effect.Effect<T.Skill, ApiError>;
    readonly removeSkill: (id: string) => Effect.Effect<void, ApiError>;
    /** What removeSkill would do, refused as it would be; nothing changes. */
    readonly previewRemoveSkill: (id: string) => Effect.Effect<T.Preview, ApiError>;
    readonly saveSettings: (runtime: string, s: T.RuntimeSettings) => Effect.Effect<T.RuntimeSettings, ApiError>;
    /** The built-in templates, then those added on this machine, each with the profiles installed from it. */
    readonly templates: () => Effect.Effect<T.AgentTemplate[]>;
    readonly installTemplate: (id: string) => Effect.Effect<T.Agent, ApiError>;
    readonly updateFromTemplate: (agent: string) => Effect.Effect<T.Agent, ApiError>;
    readonly addTemplate: (path: string) => Effect.Effect<T.AgentTemplate, ApiError>;
    readonly removeTemplate: (id: string) => Effect.Effect<void, ApiError>;
    readonly previewRemoveTemplate: (id: string) => Effect.Effect<T.Preview, ApiError>;
  }
>()("vibevalley/Agent") {
  static readonly layer = Layer.effect(
    Agent,
    Effect.suspend(() => make),
  );
}

/** An id or a name not yet taken: the one wanted, else it with -2, -3… (ids) or 2, 3… (names). */
const free = (want: string, taken: readonly string[], join: string) => {
  if (!taken.includes(want)) return want;
  let n = 2;
  while (taken.includes(`${want}${join}${n}`)) n++;
  return `${want}${join}${n}`;
};

/** A template made into a new profile beside these: its own id and name when free. */
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
  // A new farm: the starters the configuration names, in order; the default orchestrator is added below.
  const starters: T.Agent[] = [];
  for (const id of config.agent.starters) {
    const builtIn = builtInOf(id);
    if (builtIn) starters.push(installed(builtIn, starters));
    else yield* Effect.logWarning(`vibevalley: agent.starters names no built-in template: ${id}`);
  }
  const seed: Stored = { agents: starters, skills: [], settings: {} };
  let s: Stored = seed;
  s = (yield* readOrSetAside(file, readStored, "the profiles start from the starters")) ?? seed;
  // The default orchestrator is always there, and always an orchestrator: a farm is never without one.
  const orchestrator = builtInOf(defaultOrchestrator);
  if (!orchestrator) return yield* Effect.die(new Error(`the built-in template ${defaultOrchestrator} is not in agent/templates`));
  const agents = s.agents.some((a) => a.id === defaultOrchestrator)
    ? s.agents.map((a) => (a.id === defaultOrchestrator ? { ...a, role: "orchestrator" as const } : a))
    : [installed(orchestrator, s.agents, defaultOrchestrator), ...s.agents];
  s = { agents: agents.map(withCast), skills: s.skills, settings: s.settings };
  yield* Effect.orDie(disk.save(JSON.stringify(s)));

  /** A change is kept only once it is on disk: one that cannot be written is refused and leaves the profiles as they were. */
  const change = (f: (s: Stored) => Stored) =>
    Effect.gen(function* () {
      const next = structuredClone(f(structuredClone(s)));
      yield* disk.save(JSON.stringify(next)).pipe(Effect.mapError((e) => refused(t("server.agent.notSaved", { file, why: e.message }))));
      s = next;
    });

  const all = () => structuredClone([...s.agents]);
  const sendable = () => all().filter((a) => a.role === "helper");

  /** Why a profile cannot be kept as it is: an orchestrator runs only on VibeValley's own agent, in the server, where it
   * stays and is reached on a call; the default one stays an orchestrator. "" when it can. */
  const roleProblem = (a: T.Agent): string => {
    if (a.id === defaultOrchestrator && a.role !== "orchestrator") return t("server.agent.defaultStaysOrchestrator");
    if (a.role === "orchestrator" && a.runtime !== orchestratorRuntime) return t("server.agent.orchestratorRuntime", { runtime: orchestratorRuntime });
    return "";
  };

  // The delete and its dry run judge by these, so the dry run is refused exactly when the delete would be.
  const deletableAgent = (id: string) => {
    if (id === defaultOrchestrator) return Effect.fail(refused(t("server.agent.orchestratorStays")));
    const a = s.agents.find((x) => x.id === id);
    return a ? Effect.succeed(a) : Effect.fail(missing(t("server.agent.noAgent", { id }), [lookIn.agent]));
  };
  const deletableSkill = (id: string) => {
    const k = s.skills.find((x) => x.id === id);
    return k ? Effect.succeed(k) : Effect.fail(missing(t("server.agent.noSkill", { id }), [lookIn.skill]));
  };

  // Read again on every ask: an added template is a folder in the home, and copying one in or out changes the list.
  const templates = Effect.fn("Agent.templates")(function* () {
    const added = yield* withFs(addedTemplates(config.home));
    for (const why of added.problems) yield* Effect.logWarning(`vibevalley: an added template is left out: ${why}`);
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
    skills: () => structuredClone([...s.skills]),
    settings: (runtime) => structuredClone(s.settings[runtime]) ?? defaultSettings(),
    orchestrators: () => all().filter((a) => a.role === "orchestrator"),
    isOrchestrator: (id) => s.agents.some((a) => a.id === id && a.role === "orchestrator"),
    save: Effect.fn("Agent.save")(function* (a) {
      const why = roleProblem(a);
      if (why) return yield* Effect.fail(refused(why));
      const cast = withCast(a);
      yield* change((x) => ({ ...x, agents: upsert(x.agents, cast) }));
      return cast;
    }),
    create: Effect.fn("Agent.create")(function* (draft) {
      if (draft.id) return yield* Effect.fail(refused(t("server.agent.newAgentId")));
      const why = roleProblem(draft);
      if (why) return yield* Effect.fail(refused(why));
      let n = 1;
      while (s.agents.some((a) => a.id === `agent-${n}`)) n++;
      const created = withCast({ ...draft, id: `agent-${n}` });
      yield* change((x) => ({ ...x, agents: [...x.agents, created] }));
      return created;
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
      yield* change((x) => ({ ...x, skills: upsert(x.skills, skill) }));
      return skill;
    }),
    createSkill: Effect.fn("Agent.createSkill")(function* (draft) {
      if (draft.id) return yield* Effect.fail(refused(t("server.agent.newSkillId")));
      const stem =
        draft.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/gu, "-")
          .replace(/^-+|-+$/gu, "") || "skill";
      let id = stem;
      for (let n = 2; s.skills.some((k) => k.id === id); n++) id = `${stem}-${n}`;
      const created = { ...draft, id };
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
    templates,
    installTemplate: Effect.fn("Agent.installTemplate")(function* (id) {
      const item = yield* templateOf(id);
      if (!item) return yield* Effect.fail(missing(t("server.agent.template.noTemplate", { id }), [lookIn.template]));
      const made = withCast(installed(item, s.agents));
      yield* change((x) => ({ ...x, agents: [...x.agents, made] }));
      return made;
    }),
    updateFromTemplate: Effect.fn("Agent.updateFromTemplate")(function* (agent) {
      const a = s.agents.find((x) => x.id === agent);
      if (!a) return yield* Effect.fail(missing(t("server.agent.noAgent", { id: agent }), [lookIn.agent]));
      if (!a.from) return yield* Effect.fail(refused(t("server.agent.template.notFrom", { name: a.name })));
      const item = yield* templateOf(a.from.template);
      if (!item) return yield* Effect.fail(refused(t("server.agent.template.gone", { name: a.name, template: a.from.template })));
      const next = withCast(updatedFrom(item, a));
      yield* change((x) => ({ ...x, agents: upsert(x.agents, next) }));
      return next;
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
