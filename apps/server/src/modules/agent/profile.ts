import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { frontMatter, skillBody } from "@vibevalley/agent/skills";
import type { Clock } from "@vibevalley/async";
import { currentLocale, list, t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { defaultOrchestrator, orchestratorRuntime, SpeciesValues } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { serverFile } from "#/base/assets.ts";
import { BizCode, errnoOf, Inconsistent, lookIn, messageOf, missing, refuseIn } from "#/base/errors.ts";
import { jsonOf, jsonText } from "#/base/json.ts";
import type { ServerConfig } from "#/infra/config.ts";
import { keptFile, readOrSetAside } from "#/infra/files.ts";
import type { Logger } from "#/infra/log.ts";

import { defaultSettings } from "./presets.ts";
import { addedTemplates, builtInTemplates, copyTemplate, profileOf, readTemplate, removeTemplate, TemplateProblem, updatedFrom } from "./template.ts";

const refused = refuseIn(BizCode.AgentRefused);

interface Stored {
  readonly agents: readonly T.Agent[];
  readonly skills: readonly T.Skill[];
  readonly settings: Readonly<Record<string, T.RuntimeSettings>>;
}

// Backfill `build` and `head` before schema decoding for config.json files written prior to those fields.
const readFileJson = jsonOf(
  z.object({
    agents: z.array(z.unknown()),
    skills: z.array(S.Skill),
    settings: z.record(z.string(), S.RuntimeSettings),
  }),
);
const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;
const lookFilled = (raw: unknown): unknown =>
  isObject(raw) && isObject(raw.look)
    ? {
        ...raw,
        look: { species: null, outfit: null, orchestrator: null, ...raw.look, build: raw.look.build ?? "biped", head: raw.look.head ?? "rounded" },
      }
    : raw;
const readStored = (text: string): Stored => {
  const file = readFileJson(text);
  const agents = file.agents.map((a) => S.Agent.parse(lookFilled(a)));
  return { agents, skills: file.skills, settings: file.settings };
};

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

/** The profiles, skills and runtime settings kept in config.json, and the templates profiles are installed from. */
export interface ProfileStore {
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
  readonly save: (a: T.Agent) => Promise<T.Agent>;
  readonly create: (draft: T.Agent) => Promise<T.Agent>;
  readonly remove: (id: string) => Promise<void>;
  readonly previewRemove: (id: string) => Promise<T.Preview>;
  readonly saveSkill: (s: T.Skill) => Promise<T.Skill>;
  readonly createSkill: (draft: T.Skill) => Promise<T.Skill>;
  readonly removeSkill: (id: string) => Promise<void>;
  readonly previewRemoveSkill: (id: string) => Promise<T.Preview>;
  readonly saveSettings: (runtime: string, s: T.RuntimeSettings) => Promise<T.RuntimeSettings>;
  /** Registers an invariant hook run before `save`/`create` returns; a failure aborts the call. */
  readonly whenKept: (keep: (agent: T.Agent) => Promise<void>) => void;
  readonly templates: () => Promise<T.AgentTemplate[]>;
  readonly installTemplate: (id: string) => Promise<T.Agent>;
  readonly updateFromTemplate: (agent: string) => Promise<T.Agent>;
  readonly addTemplate: (path: string) => Promise<T.AgentTemplate>;
  readonly removeTemplate: (id: string) => Promise<void>;
  readonly previewRemoveTemplate: (id: string) => Promise<T.Preview>;
  readonly close: () => Promise<void>;
}

export interface ProfileStoreDeps {
  readonly config: ServerConfig;
  readonly clock: Clock;
  readonly log: Logger;
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

const builtInSkillsDir = serverFile("src/modules/agent/skills");
const readBuiltInSkills = async (): Promise<T.Skill[]> => {
  const ids = (await readdir(builtInSkillsDir)).toSorted();
  const en = currentLocale() === "en";
  const out: T.Skill[] = [];
  for (const id of ids) {
    const english = join(builtInSkillsDir, id, "SKILL.en.md");
    const englishText = en ? await readFile(english, "utf8").catch((e: unknown) => (errnoOf(e) === "ENOENT" ? undefined : Promise.reject(e))) : undefined;
    const text = englishText ?? (await readFile(join(builtInSkillsDir, id, "SKILL.md"), "utf8"));
    const head = frontMatter(text);
    out.push({ id, name: head.name ?? id, description: head.description ?? "", body: skillBody(text), builtIn: true });
  }
  return out;
};

const upsert = <T extends { id: string }>(list: readonly T[], item: T) =>
  list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item];

export async function makeProfileStore(deps: ProfileStoreDeps): Promise<ProfileStore> {
  const { config } = deps;
  const log = deps.log.child("agent");
  const file = join(config.home, "config.json");
  const disk = keptFile(file, deps);
  const builtIn = await builtInTemplates();
  const builtInOf = (id: string) => builtIn.find((item) => item.id === id);
  const ownSkills = await readBuiltInSkills();
  const builtInSkillOf = (id: string) => ownSkills.find((k) => k.id === id);
  const isBuiltInSkill = (id: string) => builtInSkillOf(id) !== undefined;
  for (const item of builtIn)
    for (const id of item.skills) if (!isBuiltInSkill(id)) throw new Inconsistent(`the built-in template ${item.id} names ${id}, not in agent/skills`);
  const starters: T.Agent[] = [];
  for (const id of config.agent.starters) {
    const builtIn = builtInOf(id);
    if (builtIn) starters.push(installed(builtIn, starters));
    else log.warn(`vibevalley: agent.starters names no built-in template: ${id}`);
  }
  const seed: Stored = { agents: starters, skills: [], settings: {} };
  let s: Stored = (await readOrSetAside(file, readStored, "the profiles start from the starters", { clock: deps.clock, log })) ?? seed;
  // The default orchestrator is always there, and always an orchestrator: a farm is never without one.
  const orchestrator = builtInOf(defaultOrchestrator);
  if (!orchestrator) throw new Inconsistent(`the built-in template ${defaultOrchestrator} is not in agent/templates`);
  const agents = s.agents.some((a) => a.id === defaultOrchestrator)
    ? s.agents.map((a) => (a.id === defaultOrchestrator ? { ...a, role: "orchestrator" as const } : a))
    : [installed(orchestrator, s.agents, defaultOrchestrator), ...s.agents];
  s = { agents: agents.map(withCast), skills: s.skills, settings: s.settings };
  await disk.save(jsonText(s));

  const keeps: ((agent: T.Agent) => Promise<void>)[] = [];
  const saved = async (agent: T.Agent) => {
    for (const keep of keeps) await keep(agent);
    return agent;
  };

  /** A change is kept only once it is on disk: one that cannot be written is refused and leaves the profiles as they were. */
  const change = async (f: (s: Stored) => Stored) => {
    const next = structuredClone(f(structuredClone(s)));
    try {
      await disk.save(jsonText(next));
    } catch (e) {
      throw refused(t("server.agent.notSaved", { file, why: messageOf(e) }));
    }
    s = next;
  };

  const all = () => structuredClone([...s.agents]);
  const sendable = () => all().filter((a) => a.role === "worker");
  const isOrchestrator = (id: string) => s.agents.some((a) => a.id === id && a.role === "orchestrator");

  /** Why a profile cannot be kept as it is: an orchestrator runs only on VibeValley's own agent, in the server, where it stays and is reached on a call. */
  const roleProblem = (a: T.Agent): string => {
    if (a.id === defaultOrchestrator && a.role !== "orchestrator") return t("server.agent.defaultStaysOrchestrator");
    if (a.role === "orchestrator" && a.runtime !== orchestratorRuntime) return t("server.agent.orchestratorRuntime", { runtime: orchestratorRuntime });
    return "";
  };

  const deletableAgent = (id: string): T.Agent => {
    if (id === defaultOrchestrator) throw refused(t("server.agent.orchestratorStays"));
    const a = s.agents.find((x) => x.id === id);
    if (!a) throw missing(t("server.agent.noAgent", { id }), [lookIn.agent]);
    return a;
  };
  const notBuiltIn = (id: string) => {
    const k = builtInSkillOf(id);
    if (k !== undefined) throw refused(t("server.agent.builtInSkill", { name: k.name }));
  };
  const deletableSkill = (id: string): T.Skill => {
    notBuiltIn(id);
    const k = s.skills.find((x) => x.id === id);
    if (!k) throw missing(t("server.agent.noSkill", { id }), [lookIn.skill]);
    return k;
  };

  // Re-read from disk on each call so templates added or removed directly in `home` appear immediately.
  const templates = async () => {
    const added = await addedTemplates(config.home);
    for (const why of added.problems) log.warn(`vibevalley: an added template is left out: ${why}`);
    return [...builtIn, ...added.templates].map((item) => ({
      ...item,
      installed: s.agents.filter((a) => a.from?.template === item.id).map((a) => a.id),
    }));
  };
  const templateOf = async (id: string) => (await templates()).find((template) => template.id === id);
  const deletableTemplate = async (id: string) => {
    const item = await templateOf(id);
    if (!item) throw missing(t("server.agent.template.noTemplate", { id }), [lookIn.template]);
    if (item.source === "builtIn") throw refused(t("server.agent.template.builtIn", { id }));
    return item;
  };

  return {
    agents: () => sendable(),
    all,
    agent: (id) => all().find((a) => a.id === id),
    named: (key) => {
      const k = key.trim();
      return sendable().find((a) => a.id === k) ?? sendable().find((a) => a.name === k);
    },
    // Built-in skills shadow any legacy user skill saved under the same id before the built-in shipped.
    skills: () => structuredClone([...ownSkills, ...s.skills.filter((k) => !isBuiltInSkill(k.id))]),
    settings: (runtime) => structuredClone(s.settings[runtime]) ?? defaultSettings(),
    orchestrators: () => all().filter((a) => a.role === "orchestrator"),
    isOrchestrator,
    isHosted: isOrchestrator,
    save: async (a) => {
      const why = roleProblem(a);
      if (why) throw refused(why);
      const cast = withCast(a);
      await change((x) => ({ ...x, agents: upsert(x.agents, cast) }));
      return saved(cast);
    },
    create: async (draft) => {
      if (draft.id) throw refused(t("server.agent.newAgentId"));
      const why = roleProblem(draft);
      if (why) throw refused(why);
      let n = 1;
      while (s.agents.some((a) => a.id === `agent-${n}`)) n++;
      const created = withCast({ ...draft, id: `agent-${n}` });
      await change((x) => ({ ...x, agents: [...x.agents, created] }));
      return saved(created);
    },
    remove: async (id) => {
      deletableAgent(id);
      await change((x) => ({ ...x, agents: x.agents.filter((a) => a.id !== id) }));
    },
    previewRemove: async (id) => {
      const a = deletableAgent(id);
      return { does: [t("server.agent.removeAgent", { name: a.name, id: a.id, runtime: a.runtime })] };
    },
    saveSkill: async (skill) => {
      notBuiltIn(skill.id);
      const { builtIn: _, ...kept } = skill;
      await change((x) => ({ ...x, skills: upsert(x.skills, kept) }));
      return kept;
    },
    createSkill: async (draft) => {
      if (draft.id) throw refused(t("server.agent.newSkillId"));
      const stem =
        draft.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/gu, "-")
          .replace(/^-+|-+$/gu, "") || "skill";
      let id = stem;
      const taken = (x: string) => isBuiltInSkill(x) || s.skills.some((k) => k.id === x);
      for (let n = 2; taken(id); n++) id = `${stem}-${n}`;
      const { builtIn: _, ...words } = draft;
      const created = { ...words, id };
      await change((x) => ({ ...x, skills: [...x.skills, created] }));
      return created;
    },
    removeSkill: async (id) => {
      deletableSkill(id);
      await change((x) => ({
        ...x,
        skills: x.skills.filter((k) => k.id !== id),
        agents: x.agents.map((a) => ({ ...a, skills: a.skills.filter((skill) => skill !== id) })),
      }));
    },
    previewRemoveSkill: async (id) => {
      const k = deletableSkill(id);
      const holders = s.agents.filter((a) => a.skills.includes(id)).map((a) => a.name);
      return {
        does: [
          t("server.agent.removeSkill", { name: k.name }),
          ...(holders.length > 0 ? [t("server.agent.unequip", { holders: list(holders.map((name) => t("server.agent.quoted", { name }))) })] : []),
        ],
      };
    },
    saveSettings: async (runtime, settings) => {
      await change((x) => ({ ...x, settings: { ...x.settings, [runtime]: settings } }));
      return settings;
    },
    whenKept: (keep) => void keeps.push(keep),
    templates,
    installTemplate: async (id) => {
      const item = await templateOf(id);
      if (!item) throw missing(t("server.agent.template.noTemplate", { id }), [lookIn.template]);
      const made = withCast(installed(item, s.agents));
      await change((x) => ({ ...x, agents: [...x.agents, made] }));
      return saved(made);
    },
    updateFromTemplate: async (agent) => {
      const a = s.agents.find((x) => x.id === agent);
      if (!a) throw missing(t("server.agent.noAgent", { id: agent }), [lookIn.agent]);
      if (!a.from) throw refused(t("server.agent.template.notFrom", { name: a.name }));
      const item = await templateOf(a.from.template);
      if (!item) throw refused(t("server.agent.template.gone", { name: a.name, template: a.from.template }));
      const next = withCast(updatedFrom(item, a));
      await change((x) => ({ ...x, agents: upsert(x.agents, next) }));
      return saved(next);
    },
    addTemplate: async (path) => {
      let item: T.AgentTemplate;
      try {
        item = await readTemplate(path, "added");
      } catch (e) {
        if (e instanceof TemplateProblem) throw refused(e.message);
        throw e;
      }
      if (await templateOf(item.id)) throw refused(t("server.agent.template.taken", { id: item.id }));
      try {
        await copyTemplate(path, config.home, item.id);
      } catch (e) {
        throw refused(t("server.agent.notSaved", { file: path, why: messageOf(e) }));
      }
      return { ...item, installed: [] };
    },
    removeTemplate: async (id) => {
      const item = await deletableTemplate(id);
      try {
        await removeTemplate(config.home, item.id);
      } catch (e) {
        throw refused(t("server.agent.notSaved", { file: id, why: messageOf(e) }));
      }
    },
    previewRemoveTemplate: async (id) => {
      const item = await deletableTemplate(id);
      return {
        does: [
          item.installed.length > 0
            ? t("server.agent.template.deleteKept", { name: item.name, installed: item.installed.length })
            : t("server.agent.template.delete", { name: item.name }),
        ],
      };
    },
    close: () => disk.close(),
  };
}

export const noDeepSeekKey = () => t("server.agent.noDeepSeekKey");
