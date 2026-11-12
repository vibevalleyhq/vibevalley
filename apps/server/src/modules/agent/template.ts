import { copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { t, currentLocale } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { AgentRoleValues, orchestratorRuntime, OrchestratorLookValues } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { serverFile } from "#/base/assets.ts";
import { errnoOf, messageOf } from "#/base/errors.ts";
import { problemOf } from "#/base/json.ts";

export const builtInDir = serverFile("src/modules/agent/templates");
const addedDir = (home: string) => join(home, "agent-templates");

/** The files a template is made of: nothing else in its folder is read or copied. */
const files = ["agent.json", "agent.en.json", "persona.md", "persona.en.md"] as const;

/** Lowercase letters, digits and -, as a profile's id is written in a path and after an @. */
const idPattern = /^[a-z0-9][a-z0-9-]{0,31}$/u;

const LookFile = z.object({
  species: z.exactOptional(S.Species),
  outfit: z.exactOptional(S.Outfit),
  orchestrator: z.exactOptional(z.enum(OrchestratorLookValues)),
  build: z.exactOptional(S.Build),
  head: z.exactOptional(S.Head),
  body: z.exactOptional(z.string()),
  trim: z.exactOptional(z.string()),
  hat: z.exactOptional(z.string()),
  eye: z.exactOptional(z.string()),
});

const TemplateFile = z.object({
  id: z.string(),
  version: z.number().int(),
  role: z.enum(AgentRoleValues),
  name: z.string(),
  duty: z.exactOptional(z.string()),
  tags: z.exactOptional(z.array(z.string())),
  runtime: z.exactOptional(z.string()),
  model: z.exactOptional(z.string()),
  effort: z.exactOptional(z.string()),
  personaMode: z.exactOptional(S.PersonaMode),
  worktree: z.exactOptional(z.boolean()),
  look: z.exactOptional(LookFile),
  /** Built-in skills (agent/skills/<id>) a profile from it has ticked. */
  skills: z.exactOptional(z.array(z.string())),
});

const WordsFile = z.object({
  name: z.exactOptional(z.string()),
  duty: z.exactOptional(z.string()),
  tags: z.exactOptional(z.array(z.string())),
});

/** Why a folder is not a template, in the user's words: which file, and what in it. */
export class TemplateProblem extends Error {
  override readonly name = "TemplateProblem";
}

/** A file's text, or none when there is no such file; a file that is there and cannot be read throws TemplateProblem. */
export type TextOf = (path: string) => string | undefined;

const unreadable = (path: string, why: string) => new TemplateProblem(t("server.agent.template.unreadable", { file: path, why }));

const readJson = <A>(textOf: TextOf, schema: z.ZodType<A>, dir: string, file: string): A | undefined => {
  const path = join(dir, file);
  const text = textOf(path);
  if (text === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw unreadable(path, messageOf(e));
  }
  const got = schema.safeParse(raw);
  if (!got.success) throw unreadable(path, problemOf(got.error));
  return got.data;
};

/** A template folder read in the farm's language (English falls back to the Chinese file by file) through textOf. Throws
 * TemplateProblem. */
export const templateFrom = (textOf: TextOf, dir: string, source: T.AgentTemplate["source"]): T.AgentTemplate => {
  const item = readJson(textOf, TemplateFile, dir, "agent.json");
  const problem = (message: string) => new TemplateProblem(message);
  if (!item) throw problem(t("server.agent.template.noFile", { file: join(dir, "agent.json") }));
  if (!idPattern.test(item.id)) throw problem(t("server.agent.template.badId", { file: join(dir, "agent.json"), id: item.id }));
  if (item.version < 1) throw problem(t("server.agent.template.badVersion", { file: join(dir, "agent.json") }));
  // An orchestrator always runs on VibeValley's own agent: its template names no other runtime.
  if (item.role === "orchestrator" && item.runtime !== undefined && item.runtime !== orchestratorRuntime)
    throw problem(t("server.agent.orchestratorRuntime", { runtime: orchestratorRuntime }));
  if (item.role === "worker" && !item.runtime) throw problem(t("server.agent.template.noRuntime", { file: join(dir, "agent.json") }));
  const en = currentLocale() === "en";
  const words = en ? readJson(textOf, WordsFile, dir, "agent.en.json") : undefined;
  const text = (file: string) => textOf(join(dir, file))?.trim();
  const persona = (en ? text("persona.en.md") : undefined) ?? text("persona.md") ?? "";
  const look = item.look ?? {};
  return {
    id: item.id,
    version: item.version,
    role: item.role,
    name: words?.name ?? item.name,
    duty: words?.duty ?? item.duty ?? "",
    tags: [...(words?.tags ?? item.tags ?? [])],
    runtime: item.role === "orchestrator" ? orchestratorRuntime : (item.runtime ?? orchestratorRuntime),
    model: item.model ?? "",
    effort: item.effort ?? "",
    personaMode: item.personaMode ?? "append",
    worktree: item.worktree ?? item.role === "worker",
    look: {
      ...look,
      species: look.species ?? null,
      outfit: look.outfit ?? null,
      orchestrator: look.orchestrator ?? null,
      build: look.build ?? "biped",
      head: look.head ?? "rounded",
      body: look.body ?? "",
      trim: look.trim ?? "",
      hat: look.hat ?? "",
      eye: look.eye ?? "",
    },
    persona,
    source,
    skills: [...(item.skills ?? [])],
    installed: [],
  } satisfies T.AgentTemplate;
};

/** A template folder on disk (templateFrom): its own files are read first, a missing one read as none. Throws TemplateProblem. */
export const readTemplate = async (dir: string, source: T.AgentTemplate["source"]): Promise<T.AgentTemplate> => {
  const texts = new Map<string, string>();
  for (const file of files) {
    const path = join(dir, file);
    try {
      texts.set(path, await readFile(path, "utf8"));
    } catch (e) {
      if (errnoOf(e) !== "ENOENT") throw unreadable(path, messageOf(e));
    }
  }
  return templateFrom((path) => texts.get(path), dir, source);
};

/** The ids of the built-in templates, in the order they are listed and installed. */
export const builtInIds = async (): Promise<string[]> => z.array(z.string()).parse(JSON.parse(await readFile(join(builtInDir, "index.json"), "utf8")));

/** Every built-in template; one that does not read is a broken build (templates.test.ts keeps them readable). */
export const builtInTemplates = async (): Promise<T.AgentTemplate[]> => {
  const out: T.AgentTemplate[] = [];
  for (const id of await builtInIds()) out.push(await readTemplate(join(builtInDir, id), "builtIn"));
  return out;
};

/** The templates added on this machine, by id; a folder that no longer reads (edited by hand) is left out and said why. */
export const addedTemplates = async (home: string): Promise<{ templates: T.AgentTemplate[]; problems: string[] }> => {
  let names: string[];
  try {
    names = await readdir(addedDir(home));
  } catch (e) {
    // No folder yet: no templates were added on this machine.
    if (errnoOf(e) !== "ENOENT" && errnoOf(e) !== "ENOTDIR") throw e;
    names = [];
  }
  const templates: T.AgentTemplate[] = [];
  const problems: string[] = [];
  for (const name of names.toSorted()) {
    try {
      templates.push(await readTemplate(join(addedDir(home), name), "added"));
    } catch (e) {
      if (!(e instanceof TemplateProblem)) throw e;
      problems.push(e.message);
    }
  }
  return { templates, problems };
};

/** A folder copied in as an added template, once it reads as one: only a template's own files go. */
export const copyTemplate = async (from: string, home: string, id: string): Promise<void> => {
  const to = join(addedDir(home), id);
  await mkdir(to, { recursive: true });
  for (const f of files) {
    try {
      await copyFile(join(from, f), join(to, f));
    } catch (e) {
      if (errnoOf(e) !== "ENOENT") throw e;
    }
  }
};

export const removeTemplate = (home: string, id: string): Promise<void> => rm(join(addedDir(home), id), { recursive: true, force: true });

/** A new profile from a template, under the id and name given (both free among the profiles). */
export const profileOf = (item: T.AgentTemplate, id: string, name: string): T.Agent => ({
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
  skills: [...item.skills],
  mcpServers: [],
  disallowedTools: [],
  env: {},
  workdir: "",
  worktree: item.worktree,
  tags: [...item.tags],
  look: structuredClone(item.look),
  from: { template: item.id, version: item.version },
});

/** A profile made again from its template's version now: what the template says of the work (duty, tags, persona and how it is given) is replaced. */
export const updatedFrom = (item: T.AgentTemplate, a: T.Agent): T.Agent => ({
  ...a,
  duty: item.duty,
  tags: [...item.tags],
  persona: item.persona,
  personaMode: item.personaMode,
  worktree: item.worktree,
  // The template's skills are ticked again; the ones the user ticked besides stay.
  skills: [...new Set([...a.skills, ...item.skills])],
  from: { template: item.id, version: item.version },
});
