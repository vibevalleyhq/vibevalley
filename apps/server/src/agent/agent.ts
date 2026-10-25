// The profiles work is sent to, the skills and each runtime's settings: config.json in
// the home. The orchestrator is a profile every farm has, built in, never deleted, on VibeValley's own agent.

import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { type Agent, orchestratorAgent, type Preview, type RuntimeSettings, type Skill, SpeciesValues } from "@vibevalley/protocol";
import { defaultSettings, seedAgents } from "./seed.ts";
import { Clock, Context, Effect, Layer, Result, Schema } from "effect";
import * as S from "@vibevalley/protocol/schema";
import { Settings } from "../base/config.ts";
import { FileWriter } from "../base/files.ts";
import { type ApiError, missing, refused, lookIn } from "../errors.ts";

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

/** config.json as the profiles are kept: skills and settings may be missing (a file from before they were). */
const readStored = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Struct({
      agents: Schema.Array(S.Agent),
      skills: Schema.optionalKey(Schema.Array(S.Skill)),
      settings: Schema.optionalKey(Schema.Record(Schema.String, S.RuntimeSettings)),
    }),
  ),
);

export const make = Effect.gen(function* () {
  const config = yield* Settings;
  const file = join(config.home, "config.json");
  const disk = new FileWriter(file);
  const seed: Stored = { agents: seedAgents(), skills: [], settings: {} };
  let s: Stored = seed;
  if (existsSync(file)) {
    const read = readStored(readFileSync(file, "utf8"));
    if (Result.isSuccess(read)) s = { agents: read.success.agents, skills: read.success.skills ?? [], settings: read.success.settings ?? {} };
    else {
      const e = read.failure;
      // A file that does not read (not JSON, or not the profiles' shape) is kept aside, never written over: one that cannot be
      // moved stops the start.
      const aside = `${file}.unreadable-${yield* Clock.currentTimeMillis}`;
      try {
        renameSync(file, aside);
      } catch (moved) {
        return yield* Effect.die(new Error(`${file} cannot be read, and could not be kept aside as ${aside}: ${String(moved)}`));
      }
      yield* Effect.logWarning(`${file} could not be read (${e.message}): kept as ${aside}, the profiles start from the seeds`);
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

  // The delete and its dry run judge by these, so the dry run is refused exactly when the delete would be.
  const deletableAgent = (id: string) => {
    if (id === orchestratorAgent) return Effect.fail(refused("管家删不了：每个工作区都有一个"));
    const a = s.agents.find((x) => x.id === id);
    return a ? Effect.succeed(a) : Effect.fail(missing(`没有 ${id} 这个档案`, [lookIn.agent]));
  };
  const deletableSkill = (id: string) => {
    const k = s.skills.find((x) => x.id === id);
    return k ? Effect.succeed(k) : Effect.fail(missing(`没有 ${id} 这个技能`, [lookIn.skill]));
  };

  const shape = Agents.of({
    agents: () => sendable(),
    all,
    agent: (id) => all().find((a) => a.id === id),
    named: (key) => {
      const k = key.trim();
      return sendable().find((a) => a.id === k) ?? sendable().find((a) => a.name === k);
    },
    skills: () => structuredClone([...s.skills]),
    settings: (runtime) => structuredClone(s.settings[runtime]) ?? defaultSettings(),
    saveAgent: Effect.fn("Agents.saveAgent")(function* (a) {
      if (a.id === orchestratorAgent && a.runtime !== orchestratorRuntime)
        return yield* refused("管家只在 VibeValley 自己的 agent 上跑：农机留着 " + orchestratorRuntime);
      const cast = withCast(a);
      yield* change((x) => ({ ...x, agents: upsert(x.agents, cast) }));
      return cast;
    }),
    createAgent: Effect.fn("Agents.createAgent")(function* (draft) {
      if (draft.id) return yield* refused("新档案的 id 要留空；指定 id 请用保存");
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
      Effect.map(deletableAgent(id), (a) => ({ does: [`删掉档案「${a.name}」（${a.id}，跑在 ${a.runtime} 上）：已经派给它的工单不跟着改`] })),
    saveSkill: (skill) =>
      Effect.as(
        change((x) => ({ ...x, skills: upsert(x.skills, skill) })),
        skill,
      ),
    createSkill: Effect.fn("Agents.createSkill")(function* (draft) {
      if (draft.id) return yield* refused("新技能的 id 要留空；指定 id 请用保存");
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
        const holders = s.agents.filter((a) => a.skills.includes(id)).map((a) => `「${a.name}」`);
        return { does: [`删掉技能「${k.name}」`, ...(holders.length > 0 ? [`从 ${holders.join("、")} 的档案里摘掉它`] : [])] };
      }),
    saveSettings: (runtime, settings) =>
      Effect.as(
        change((x) => ({ ...x, settings: { ...x.settings, [runtime]: settings } })),
        settings,
      ),
  });
  return shape;
});

export const layer = Layer.effect(Agents, make);

/** A profile's role and the work it suits, in words: 「职责：…；适合的活：…」, without a half that is not filled in. 适合的活
 * is its tags, which chooseAgent matches and the prompts tell a model to pick by. */
export const traitsOf = (a: Agent) =>
  [...(a.role ? ["职责：" + a.role] : []), ...((a.tags ?? []).length > 0 ? ["适合的活：" + a.tags!.join("、")] : [])].join("；");
