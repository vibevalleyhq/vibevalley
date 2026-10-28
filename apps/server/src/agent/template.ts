// A profile's template: a folder of agent.json (what it is), agent.en.json (its words in English), persona.md and
// persona.en.md, read in the farm's language. The built-in ones are templates/ beside this file, in the order of
// templates/index.json; those added on this machine are copies in the home's agent-templates/.

import { agentWording } from "./words.ts";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Agent, type AgentTemplate, type AgentTemplateSource, AgentRoleValues, orchestratorRuntime, OrchestratorLookValues } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";
import { currentLocale } from "@vibevalley/protocol/words";
import { Schema } from "effect";

export const builtInDir = join(import.meta.dirname, "templates");
export const addedDir = (home: string) => join(home, "agent-templates");

/** The files a template is made of: nothing else in its folder is read or copied. */
const files = ["agent.json", "agent.en.json", "persona.md", "persona.en.md"] as const;

/** Lowercase letters, digits and -, as a profile's id is written in a path and after an @. */
const idPattern = /^[a-z0-9][a-z0-9-]{0,31}$/;

const LookFile = Schema.Struct({
  species: Schema.optionalKey(S.Species),
  outfit: Schema.optionalKey(S.Outfit),
  orchestrator: Schema.optionalKey(Schema.Literals(OrchestratorLookValues)),
  build: Schema.optionalKey(S.Build),
  head: Schema.optionalKey(S.Head),
  body: Schema.optionalKey(Schema.String),
  trim: Schema.optionalKey(Schema.String),
  hat: Schema.optionalKey(Schema.String),
  eye: Schema.optionalKey(Schema.String),
});

const TemplateFile = Schema.Struct({
  id: Schema.String,
  version: Schema.Int,
  role: Schema.Literals(AgentRoleValues),
  name: Schema.String,
  duty: Schema.optionalKey(Schema.String),
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
  runtime: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Schema.String),
  personaMode: Schema.optionalKey(S.PersonaMode),
  worktree: Schema.optionalKey(Schema.Boolean),
  look: Schema.optionalKey(LookFile),
});

const WordsFile = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  duty: Schema.optionalKey(Schema.String),
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
});

/** Why a folder is not a template, in the owner's words: which file, and what in it. */
export class TemplateProblem extends Error {}

const readJson = <S extends Schema.Codec<unknown, unknown>>(schema: S, dir: string, file: string): S["Type"] | undefined => {
  const path = join(dir, file);
  if (!existsSync(path)) return undefined;
  try {
    return Schema.decodeUnknownSync(Schema.fromJsonString(schema))(readFileSync(path, "utf8"));
  } catch (e) {
    throw new TemplateProblem(agentWording().template.unreadable(path, e instanceof Error ? e.message : String(e)));
  }
};

const readText = (dir: string, file: string) => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8").trim() : undefined);

/** A template folder read in the farm's language (English falls back to the Chinese file by file); it throws a
 * TemplateProblem when it is not one. installed is filled in by who lists it. */
export function readTemplate(dir: string, source: AgentTemplateSource): AgentTemplate {
  const item = readJson(TemplateFile, dir, "agent.json");
  if (!item) throw new TemplateProblem(agentWording().template.noFile(join(dir, "agent.json")));
  if (!idPattern.test(item.id)) throw new TemplateProblem(agentWording().template.badId(join(dir, "agent.json"), item.id));
  if (item.version < 1) throw new TemplateProblem(agentWording().template.badVersion(join(dir, "agent.json")));
  // An orchestrator always runs on VibeValley's own agent: its template names no other runtime.
  if (item.role === "orchestrator" && item.runtime !== undefined && item.runtime !== orchestratorRuntime)
    throw new TemplateProblem(agentWording().orchestratorRuntime(orchestratorRuntime));
  if (item.role === "worker" && !item.runtime) throw new TemplateProblem(agentWording().template.noRuntime(join(dir, "agent.json")));
  const en = currentLocale() === "en";
  const words = en ? readJson(WordsFile, dir, "agent.en.json") : undefined;
  const persona = (en ? readText(dir, "persona.en.md") : undefined) ?? readText(dir, "persona.md") ?? "";
  const look = item.look ?? {};
  return {
    id: item.id,
    version: item.version,
    role: item.role,
    name: words?.name ?? item.name,
    duty: words?.duty ?? item.duty ?? "",
    tags: [...(words?.tags ?? item.tags ?? [])],
    runtime: item.role === "orchestrator" ? orchestratorRuntime : item.runtime!,
    model: item.model ?? "",
    effort: item.effort ?? "",
    personaMode: item.personaMode ?? "append",
    worktree: item.worktree ?? item.role === "worker",
    look: {
      ...look,
      build: look.build ?? "biped",
      head: look.head ?? "rounded",
      body: look.body ?? "",
      trim: look.trim ?? "",
      hat: look.hat ?? "",
      eye: look.eye ?? "",
    },
    persona,
    source,
    installed: [],
  };
}

/** The ids of the built-in templates, in the order they are listed and installed. */
export const builtInIds = (): string[] =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(readFileSync(join(builtInDir, "index.json"), "utf8")) as string[];

/** Every built-in template; one that does not read is a broken build (templates.test.ts keeps them readable). */
export const builtInTemplates = (): AgentTemplate[] => builtInIds().map((id) => readTemplate(join(builtInDir, id), "builtIn"));

/** The templates added on this machine, by id; a folder that no longer reads (edited by hand) is left out and said why. */
export function addedTemplates(home: string): { readonly templates: AgentTemplate[]; readonly problems: string[] } {
  const root = addedDir(home);
  if (!existsSync(root)) return { templates: [], problems: [] };
  const templates: AgentTemplate[] = [];
  const problems: string[] = [];
  for (const name of readdirSync(root).sort()) {
    try {
      templates.push(readTemplate(join(root, name), "added"));
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { templates, problems };
}

/** A folder copied in as an added template, once it reads as one: only a template's own files go. */
export function copyTemplate(from: string, home: string, id: string) {
  const to = join(addedDir(home), id);
  mkdirSync(to, { recursive: true });
  for (const f of files) if (existsSync(join(from, f))) cpSync(join(from, f), join(to, f));
}

export const removeTemplate = (home: string, id: string) => rmSync(join(addedDir(home), id), { recursive: true, force: true });

/** A new profile from a template, under the id and name given (both free among the profiles). */
export const profileOf = (item: AgentTemplate, id: string, name: string): Agent => ({
  id,
  name,
  role: item.role,
  duty: item.duty,
  enabled: true,
  runtime: item.runtime,
  model: item.model,
  effort: item.effort,
  persona: item.persona,
  personaMode: item.personaMode,
  skills: [],
  mcpServers: [],
  disallowedTools: [],
  env: {},
  workdir: "",
  worktree: item.worktree,
  tags: [...item.tags],
  look: structuredClone(item.look),
  from: { template: item.id, version: item.version },
});

/** A profile made again from its template's version now: what the template says of the work (duty, tags, persona and
 * how it is given) is replaced; its name, look, machine and model, and what is this machine's, stay. */
export const updatedFrom = (item: AgentTemplate, a: Agent): Agent => ({
  ...a,
  duty: item.duty,
  tags: [...item.tags],
  persona: item.persona,
  personaMode: item.personaMode,
  worktree: item.worktree,
  from: { template: item.id, version: item.version },
});
