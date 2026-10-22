// The profiles work is sent to, the skills and each runtime's settings: config.json in
// the home. The orchestrator is a profile every farm has, built in, never deleted, on VibeValley's own agent.

import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { type Agent, orchestratorAgent, type RuntimeSettings, type Skill, SpeciesValues } from "@vibevalley/protocol";
import { defaultSettings, seedAgents } from "./seed.ts";
import { Context, Effect, Layer } from "effect";
import { Settings } from "../base/config.ts";
import { FileWriter } from "../base/files.ts";
import { type ApiError, refused } from "../errors.ts";

interface Stored {
  readonly agents: readonly Agent[];
  readonly skills: readonly Skill[];
  readonly settings: Readonly<Record<string, RuntimeSettings>>;
}

/** The runtime id of VibeValley's own agent, the one the orchestrator runs on. */
export const orchestratorRuntime = "vibevalley";

const orchestratorProfile = (): Agent => ({
  id: orchestratorAgent,
  name: "管家",
  role: "替主人派活、转告结果",
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
  look: { body: "", trim: "", hat: "", eye: "" } as Agent["look"],
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
  return { ...a, look };
}

export interface AgentShape {
  /** The profiles work is sent to: every one but the orchestrator's. */
  readonly agents: () => Agent[];
  /** All the profiles, the orchestrator's too. */
  readonly all: () => Agent[];
  readonly agent: (id: string) => Agent | undefined;
  /** A profile work is sent to, by its id or its name, as a person or a model says it. */
  readonly named: (key: string) => Agent | undefined;
  readonly skills: () => Skill[];
  readonly settings: (runtime: string) => RuntimeSettings;
  readonly saveAgent: (a: Agent) => Effect.Effect<Agent, ApiError>;
  readonly createAgent: (draft: Agent) => Effect.Effect<Agent, ApiError>;
  readonly deleteAgent: (id: string) => Effect.Effect<void, ApiError>;
  readonly saveSkill: (s: Skill) => Effect.Effect<Skill, ApiError>;
  readonly createSkill: (draft: Skill) => Effect.Effect<Skill, ApiError>;
  readonly deleteSkill: (id: string) => Effect.Effect<void, ApiError>;
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
  if (existsSync(file)) {
    try {
      s = JSON.parse(readFileSync(file, "utf8")) as Stored;
    } catch (e) {
      // An unreadable file is kept aside, never written over: one that cannot be moved stops the start.
      const aside = `${file}.unreadable-${Date.now()}`;
      try {
        renameSync(file, aside);
      } catch (moved) {
        return yield* Effect.die(new Error(`${file} cannot be read, and could not be kept aside as ${aside}: ${String(moved)}`));
      }
      yield* Effect.logWarning(`${file} could not be read (${String(e)}): kept as ${aside}, the profiles start from the seeds`);
      s = seed;
    }
  }
  const agents = s.agents.some((a) => a.id === orchestratorAgent) ? s.agents : [...s.agents, orchestratorProfile()];
  s = { agents: agents.map(withCast), skills: s.skills ?? [], settings: s.settings ?? {} };
  disk.write(() => JSON.stringify(s));

  /** A change is kept only once it is on disk: one that cannot be written is refused and leaves the profiles as they were. */
  const change = (f: (s: Stored) => Stored) =>
    Effect.try({
      try: () => {
        const next = structuredClone(f(structuredClone(s)));
        disk.write(() => JSON.stringify(next));
        s = next;
      },
      catch: (e) => refused(`没存下来：${file} 写不进去（${e instanceof Error ? e.message : String(e)}）`),
    });

  const all = () => structuredClone([...s.agents]);
  /** The profiles work is sent to: every one but the orchestrator's. */
  const sendable = () => all().filter((a) => a.id !== orchestratorAgent);

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
    saveAgent: (a) =>
      Effect.gen(function* () {
        if (a.id === orchestratorAgent && a.runtime !== orchestratorRuntime)
          return yield* Effect.fail(refused("管家只在 VibeValley 自己的 agent 上跑：农机留着 " + orchestratorRuntime));
        const cast = withCast(a);
        yield* change((x) => ({ ...x, agents: upsert(x.agents, cast) }));
        return cast;
      }),
    createAgent: (draft) =>
      Effect.gen(function* () {
        if (draft.id) return yield* Effect.fail(refused("新档案的 id 要留空；指定 id 请用保存"));
        let n = 1;
        while (s.agents.some((a) => a.id === `agent-${n}`)) n++;
        const created = withCast({ ...draft, id: `agent-${n}` });
        yield* change((x) => ({ ...x, agents: [...x.agents, created] }));
        return created;
      }),
    deleteAgent: (id) =>
      id === orchestratorAgent ? Effect.fail(refused("管家是每个农场都有的，删不了")) : change((x) => ({ ...x, agents: x.agents.filter((a) => a.id !== id) })),
    saveSkill: (skill) =>
      Effect.as(
        change((x) => ({ ...x, skills: upsert(x.skills, skill) })),
        skill,
      ),
    createSkill: (draft) =>
      Effect.gen(function* () {
        if (draft.id) return yield* Effect.fail(refused("新技能的 id 要留空；指定 id 请用保存"));
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
      change((x) => ({
        ...x,
        skills: x.skills.filter((k) => k.id !== id),
        agents: x.agents.map((a) => ({ ...a, skills: a.skills.filter((skill) => skill !== id) })),
      })),
    saveSettings: (runtime, settings) =>
      Effect.as(
        change((x) => ({ ...x, settings: { ...x.settings, [runtime]: settings } })),
        settings,
      ),
  };
  return shape;
});

export const layer = Layer.effect(Agents, make);

/** A profile's role and the work it suits, in words: 「职责：…；适合的活：…」, without a half that is not filled in. 适合的活
 * is its tags, which chooseAgent matches and the prompts tell a model to pick by. */
export const traitsOf = (a: Agent) =>
  [...(a.role ? ["职责：" + a.role] : []), ...((a.tags ?? []).length > 0 ? ["适合的活：" + a.tags!.join("、")] : [])].join("；");
