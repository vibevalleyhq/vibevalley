// The profiles work is sent to, the skills and each runtime's settings: config.json in
// the home. The orchestrator is a profile every farm has, built in, never deleted, on VibeValley's own agent.

import { agentWording } from "./words.ts";
import { join } from "node:path";
import { type Agent, defaultOrchestrator, type Preview, type RuntimeSettings, type Skill, SpeciesValues } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";
import { defaultSettings, seedAgents } from "./seed.ts";
import { Context, Effect, Layer, Predicate, Schema } from "effect";
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

/** The runtime id of VibeValley's own agent, the one the orchestrator runs on. */
export const orchestratorRuntime = "vibevalley";

const orchestratorProfile = (): Agent => ({
  id: defaultOrchestrator,
  name: agentWording().orchestrator.name,
  role: "orchestrator",
  duty: agentWording().orchestrator.duty,
  enabled: true,
  runtime: orchestratorRuntime,
  model: "",
  effort: "",
  persona: "",
  personaMode: "append",
  skills: [],
  mcpServers: [],
  disallowedTools: [],
  env: {},
  workdir: "",
  worktree: false,
  tags: [],
  look: { build: "biped", head: "rounded", body: "", trim: "", hat: "", eye: "", manager: "farmer" },
});

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
  if (a.role === "orchestrator") look.manager ??= "farmer";
  else delete look.manager;
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
}

export class Agents extends Context.Service<Agents, AgentShape>()("vibevalley/Agent") {}

const upsert = <T extends { id: string }>(list: readonly T[], item: T) =>
  list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item];

export const make = Effect.gen(function* () {
  const config = yield* Settings;
  const file = join(config.home, "config.json");
  const disk = new FileWriter(file);
  const seed: Stored = { agents: seedAgents(), skills: [], settings: {} };
  let s: Stored = seed;
  s = (yield* readOrSetAside(file, readStored, "the profiles start from the seeds")) ?? seed;
  // The default orchestrator is always there, and always an orchestrator: a farm is never without one.
  const agents = s.agents.some((a) => a.id === defaultOrchestrator)
    ? s.agents.map((a) => (a.id === defaultOrchestrator ? { ...a, role: "orchestrator" as const } : a))
    : [...s.agents, orchestratorProfile()];
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
  /** The profiles work is sent to: the workers. */
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
  };
  return shape;
});

export const layer = Layer.effect(Agents, make);
