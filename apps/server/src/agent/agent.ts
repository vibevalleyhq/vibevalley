// The profiles (orchestrators and workers), the skills and each runtime's settings: config.json in the home. A profile
// is made by hand or installed from a template (template.ts); the default orchestrator is installed from its built-in
// template when it is missing, so a farm always has one.

import { agentWording } from "./words.ts";
import { join } from "node:path";
import {
  type Agent,
  type AgentTemplate,
  defaultOrchestrator,
  orchestratorRuntime,
  type Preview,
  type RuntimeSettings,
  type Skill,
  SpeciesValues,
} from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";
import { defaultSettings } from "./seed.ts";
import { addedTemplates, builtInTemplates, copyTemplate, profileOf, readTemplate, removeTemplate, TemplateProblem, updatedFrom } from "./template.ts";
import { Context, Effect, FiberSet, Layer, Predicate, Schema } from "effect";
import { Settings } from "../base/config.ts";
import { FileWriter, readOrSetAside } from "../base/files.ts";
import { type ApiError, missing, refused, lookIn } from "../errors.ts";

interface Stored {
  readonly agents: readonly Agent[];
  readonly skills: readonly Skill[];
  readonly settings: Readonly<Record<string, RuntimeSettings>>;
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
        look: { ...raw.look, build: raw.look.build || "biped", head: raw.look.head || "rounded" },
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
export function castHash(s: string): number {
  let h = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    const unit = cp > 0xffff ? 0xd800 + ((cp - 0x10000) >> 10) : cp;
    h = (Math.imul(h, 31) + unit) >>> 0;
  }
  return h;
}

/** Missing appearance fields are filled on load and save: no enum reaches a client as an empty string. */
export function withCast(a: Agent): Agent {
  const look = { ...a.look };
  look.build ||= "biped";
  look.head ||= "rounded";
  look.species ??= SpeciesValues[castHash(a.id) % SpeciesValues.length]!;
  look.outfit ??= "farmer";
  if (a.role === "orchestrator") look.orchestrator ??= "farmer";
  else delete look.orchestrator;
  return { ...a, look };
}

export interface AgentShape {
  /** The profiles work is sent to: the workers. */
  readonly agents: () => Agent[];
  /** All the profiles, the orchestrators too. */
  readonly all: () => Agent[];
  readonly orchestrators: () => Agent[];
  /** A profile with this id is an orchestrator. */
  readonly isOrchestrator: (id: string) => boolean;
  readonly agent: (id: string) => Agent | undefined;
  /** A profile work is sent to, by its id or its name, as a person or a model says it. */
  readonly named: (key: string) => Agent | undefined;
  readonly skills: () => Skill[];
  readonly settings: (runtime: string) => RuntimeSettings;
  readonly saveAgent: (a: Agent) => Effect.Effect<Agent, ApiError>;
  readonly createAgent: (draft: Agent) => Effect.Effect<Agent, ApiError>;
  readonly deleteAgent: (id: string) => Effect.Effect<void, ApiError>;
  /** What deleteAgent would do, refused as it would be; nothing changes. */
  readonly previewDeleteAgent: (id: string) => Effect.Effect<Preview, ApiError>;
  readonly saveSkill: (s: Skill) => Effect.Effect<Skill, ApiError>;
  readonly createSkill: (draft: Skill) => Effect.Effect<Skill, ApiError>;
  readonly deleteSkill: (id: string) => Effect.Effect<void, ApiError>;
  /** What deleteSkill would do, refused as it would be; nothing changes. */
  readonly previewDeleteSkill: (id: string) => Effect.Effect<Preview, ApiError>;
  readonly saveSettings: (runtime: string, s: RuntimeSettings) => Effect.Effect<RuntimeSettings, ApiError>;
  /** The built-in templates, then those added on this machine, each with the profiles installed from it. */
  readonly templates: () => AgentTemplate[];
  readonly installTemplate: (id: string) => Effect.Effect<Agent, ApiError>;
  readonly updateFromTemplate: (agent: string) => Effect.Effect<Agent, ApiError>;
  readonly addTemplate: (path: string) => Effect.Effect<AgentTemplate, ApiError>;
  readonly deleteTemplate: (id: string) => Effect.Effect<void, ApiError>;
  readonly previewDeleteTemplate: (id: string) => Effect.Effect<Preview, ApiError>;
}

/** An id or a name not yet taken: the one wanted, else it with -2, -3… (ids) or 2, 3… (names). */
const free = (want: string, taken: readonly string[], join: string) => {
  if (!taken.includes(want)) return want;
  let n = 2;
  while (taken.includes(`${want}${join}${n}`)) n++;
  return `${want}${join}${n}`;
};

/** A template made into a new profile beside these: its own id and name when free. */
const installed = (template: AgentTemplate, beside: readonly Agent[], id?: string): Agent =>
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

export class Agents extends Context.Service<Agents, AgentShape>()("vibevalley/Agent") {}

const upsert = <T extends { id: string }>(list: readonly T[], item: T) =>
  list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item];

export const make = Effect.gen(function* () {
  const config = yield* Settings;
  const file = join(config.home, "config.json");
  const disk = new FileWriter(file);
  const forkHere = yield* FiberSet.makeRuntime<never>();
  const builtIn = builtInTemplates();
  const builtInOf = (id: string) => builtIn.find((item) => item.id === id);
  // A new farm: the starters the configuration names, in order; the default orchestrator is added below.
  const starters: Agent[] = [];
  for (const id of config.agent.starters) {
    const builtIn = builtInOf(id);
    if (builtIn) starters.push(installed(builtIn, starters));
    else yield* Effect.logWarning(`vibevalley: agent.starters names no built-in template: ${id}`);
  }
  const seed: Stored = { agents: starters, skills: [], settings: {} };
  let s: Stored = seed;
  s = (yield* readOrSetAside(file, readStored, "the profiles start from the starters")) ?? seed;
  // The default orchestrator is always there, and always an orchestrator: a farm is never without one.
  const agents = s.agents.some((a) => a.id === defaultOrchestrator)
    ? s.agents.map((a) => (a.id === defaultOrchestrator ? { ...a, role: "orchestrator" as const } : a))
    : [installed(builtInOf(defaultOrchestrator)!, s.agents, defaultOrchestrator), ...s.agents];
  s = { agents: agents.map(withCast), skills: s.skills, settings: s.settings };
  disk.write(() => JSON.stringify(s));

  /** A change is kept only once it is on disk: one that cannot be written is refused and leaves the profiles as they were. */
  const change = (f: (s: Stored) => Stored) =>
    Effect.try({
      try: () => {
        const next = structuredClone(f(structuredClone(s)));
        disk.write(() => JSON.stringify(next));
        s = next;
      },
      catch: (e) => refused(agentWording().notSaved(file, e instanceof Error ? e.message : String(e))),
    });

  const all = () => structuredClone([...s.agents]);
  const sendable = () => all().filter((a) => a.role === "worker");

  /** Why a profile cannot be kept as it is: an orchestrator runs only on VibeValley's own agent, in the server, where it
   * stays and is reached on a call; the default one stays an orchestrator. "" when it can. */
  const roleProblem = (a: Agent): string => {
    if (a.id === defaultOrchestrator && a.role !== "orchestrator") return agentWording().defaultStaysOrchestrator;
    if (a.role === "orchestrator" && a.runtime !== orchestratorRuntime) return agentWording().orchestratorRuntime(orchestratorRuntime);
    return "";
  };

  // The delete and its dry run judge by these, so the dry run is refused exactly when the delete would be.
  const deletableAgent = (id: string) => {
    if (id === defaultOrchestrator) return Effect.fail(refused(agentWording().orchestratorStays));
    const a = s.agents.find((x) => x.id === id);
    return a ? Effect.succeed(a) : Effect.fail(missing(agentWording().noAgent(id), [lookIn.agent]));
  };
  const deletableSkill = (id: string) => {
    const k = s.skills.find((x) => x.id === id);
    return k ? Effect.succeed(k) : Effect.fail(missing(agentWording().noSkill(id), [lookIn.skill]));
  };

  // Read again on every ask: an added template is a folder in the home, and copying one in or out changes the list.
  const templates = (): AgentTemplate[] => {
    const added = addedTemplates(config.home);
    for (const why of added.problems) void forkHere(Effect.logWarning(`vibevalley: an added template is left out: ${why}`));
    return [...builtIn, ...added.templates].map((item) => ({
      ...item,
      installed: s.agents.filter((a) => a.from?.template === item.id).map((a) => a.id),
    }));
  };
  const templateOf = (id: string) => templates().find((template) => template.id === id);
  const deletableTemplate = (id: string) => {
    const item = templateOf(id);
    if (!item) return Effect.fail(missing(agentWording().template.noTemplate(id), [lookIn.template]));
    return item.source === "builtIn" ? Effect.fail(refused(agentWording().template.builtIn(id))) : Effect.succeed(item);
  };

  const shape: AgentShape = {
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
    saveAgent: Effect.fn("Agents.saveAgent")(function* (a) {
      const why = roleProblem(a);
      if (why) return yield* Effect.fail(refused(why));
      const cast = withCast(a);
      yield* change((x) => ({ ...x, agents: upsert(x.agents, cast) }));
      return cast;
    }),
    createAgent: Effect.fn("Agents.createAgent")(function* (draft) {
      if (draft.id) return yield* Effect.fail(refused(agentWording().newAgentId));
      const why = roleProblem(draft);
      if (why) return yield* Effect.fail(refused(why));
      let n = 1;
      while (s.agents.some((a) => a.id === `agent-${n}`)) n++;
      const created = withCast({ ...draft, id: `agent-${n}` });
      yield* change((x) => ({ ...x, agents: [...x.agents, created] }));
      return created;
    }),
    deleteAgent: (id) =>
      Effect.andThen(
        deletableAgent(id),
        change((x) => ({ ...x, agents: x.agents.filter((a) => a.id !== id) })),
      ),
    previewDeleteAgent: (id) =>
      Effect.map(deletableAgent(id), (a) => ({
        does: [agentWording().deleteAgent(a.name, a.id, a.runtime)],
      })),
    saveSkill: (skill) =>
      Effect.as(
        change((x) => ({ ...x, skills: upsert(x.skills, skill) })),
        skill,
      ),
    createSkill: Effect.fn("Agents.createSkill")(function* (draft) {
      if (draft.id) return yield* Effect.fail(refused(agentWording().newSkillId));
      const stem =
        draft.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "") || "skill";
      let id = stem;
      for (let n = 2; s.skills.some((k) => k.id === id); n++) id = `${stem}-${n}`;
      const created = { ...draft, id };
      yield* change((x) => ({ ...x, skills: [...x.skills, created] }));
      return created;
    }),
    deleteSkill: (id) =>
      Effect.andThen(
        deletableSkill(id),
        change((x) => ({
          ...x,
          skills: x.skills.filter((k) => k.id !== id),
          agents: x.agents.map((a) => ({ ...a, skills: a.skills.filter((skill) => skill !== id) })),
        })),
      ),
    previewDeleteSkill: (id) =>
      Effect.map(deletableSkill(id), (k) => {
        const holders = s.agents.filter((a) => a.skills.includes(id)).map((a) => a.name);
        return {
          does: [agentWording().deleteSkill(k.name), ...(holders.length > 0 ? [agentWording().unequip(holders)] : [])],
        };
      }),
    saveSettings: (runtime, settings) =>
      Effect.as(
        change((x) => ({ ...x, settings: { ...x.settings, [runtime]: settings } })),
        settings,
      ),
    templates,
    installTemplate: Effect.fn("Agents.installTemplate")(function* (id) {
      const item = templateOf(id);
      if (!item) return yield* Effect.fail(missing(agentWording().template.noTemplate(id), [lookIn.template]));
      const made = withCast(installed(item, s.agents));
      yield* change((x) => ({ ...x, agents: [...x.agents, made] }));
      return made;
    }),
    updateFromTemplate: Effect.fn("Agents.updateFromTemplate")(function* (agent) {
      const a = s.agents.find((x) => x.id === agent);
      if (!a) return yield* Effect.fail(missing(agentWording().noAgent(agent), [lookIn.agent]));
      if (!a.from) return yield* Effect.fail(refused(agentWording().template.notFrom(a.name)));
      const item = templateOf(a.from.template);
      if (!item) return yield* Effect.fail(refused(agentWording().template.gone(a.name, a.from.template)));
      const next = withCast(updatedFrom(item, a));
      yield* change((x) => ({ ...x, agents: upsert(x.agents, next) }));
      return next;
    }),
    addTemplate: Effect.fn("Agents.addTemplate")(function* (path) {
      const read = Effect.try({
        try: () => readTemplate(path, "added"),
        catch: (e) => refused(e instanceof TemplateProblem ? e.message : String(e)),
      });
      const item = yield* read;
      if (templateOf(item.id)) return yield* Effect.fail(refused(agentWording().template.taken(item.id)));
      yield* Effect.try({
        try: () => copyTemplate(path, config.home, item.id),
        catch: (e) => refused(agentWording().notSaved(path, e instanceof Error ? e.message : String(e))),
      });
      return { ...item, installed: [] };
    }),
    deleteTemplate: (id) =>
      Effect.flatMap(deletableTemplate(id), (item) =>
        Effect.try({
          try: () => removeTemplate(config.home, item.id),
          catch: (e) => refused(agentWording().notSaved(id, e instanceof Error ? e.message : String(e))),
        }),
      ),
    previewDeleteTemplate: (id) => Effect.map(deletableTemplate(id), (item) => ({ does: [agentWording().template.delete(item.name, item.installed.length)] })),
  };
  return shape;
});

export const layer = Layer.effect(Agents, make);
