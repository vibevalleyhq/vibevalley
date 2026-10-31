// A profile's template: a folder of agent.json (what it is), agent.en.json (its words in English), persona.md and
// persona.en.md, read in the farm's language. The built-in ones are templates/ beside this file, in the order of
// templates/index.json; those added on this machine are copies in the home's agent-templates/.

import { join } from "node:path";

import { Effect, FileSystem, Schema } from "effect";

import { t, currentLocale } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { AgentRoleValues, orchestratorRuntime, OrchestratorLookValues } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

export const builtInDir = join(import.meta.dirname, "templates");
const addedDir = (home: string) => join(home, "agent-templates");

/** The files a template is made of: nothing else in its folder is read or copied. */
const files = ["agent.json", "agent.en.json", "persona.md", "persona.en.md"] as const;

/** Lowercase letters, digits and -, as a profile's id is written in a path and after an @. */
const idPattern = /^[a-z0-9][a-z0-9-]{0,31}$/u;

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
export class TemplateProblem extends Schema.TaggedError<TemplateProblem, { readonly brand: unique symbol }>()("TemplateProblem", { message: Schema.String }) {}

/** A file's text, or none when there is no such file. */
export type TextOf = (path: string) => Effect.Effect<string | undefined, TemplateProblem>;

const textOnDisk =
  (fs: FileSystem.FileSystem): TextOf =>
  (path) =>
    fs.readFileString(path).pipe(
      Effect.map((text): string | undefined => text),
      Effect.catchIf(
        (e) => e.reason._tag === "NotFound",
        () => Effect.succeed(undefined),
      ),
      Effect.mapError((e) => new TemplateProblem({ message: t("server.agent.template.unreadable", { file: path, why: e.message }) })),
    );

const readJson = <S extends Schema.Codec<unknown, unknown>>(textOf: TextOf, schema: S, dir: string, file: string) =>
  Effect.gen(function* () {
    const path = join(dir, file);
    const text = yield* textOf(path);
    if (text === undefined) return undefined;
    return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(
      Effect.mapError((e) => new TemplateProblem({ message: t("server.agent.template.unreadable", { file: path, why: e.message }) })),
    );
  });

/** A template folder read in the farm's language (English falls back to the Chinese file by file) through textOf; it
 * fails with a TemplateProblem when it is not one. installed is filled in by who lists it. */
export const templateFrom = (textOf: TextOf, dir: string, source: T.AgentTemplateSource): Effect.Effect<T.AgentTemplate, TemplateProblem> =>
  Effect.gen(function* () {
    const item = yield* readJson(textOf, TemplateFile, dir, "agent.json");
    const problem = (message: string) => Effect.fail(new TemplateProblem({ message }));
    if (!item) return yield* problem(t("server.agent.template.noFile", { file: join(dir, "agent.json") }));
    if (!idPattern.test(item.id)) return yield* problem(t("server.agent.template.badId", { file: join(dir, "agent.json"), id: item.id }));
    if (item.version < 1) return yield* problem(t("server.agent.template.badVersion", { file: join(dir, "agent.json") }));
    // An orchestrator always runs on VibeValley's own agent: its template names no other runtime.
    if (item.role === "orchestrator" && item.runtime !== undefined && item.runtime !== orchestratorRuntime)
      return yield* problem(t("server.agent.orchestratorRuntime", { runtime: orchestratorRuntime }));
    if (item.role === "helper" && !item.runtime) return yield* problem(t("server.agent.template.noRuntime", { file: join(dir, "agent.json") }));
    const en = currentLocale() === "en";
    const words = en ? yield* readJson(textOf, WordsFile, dir, "agent.en.json") : undefined;
    const text = (file: string) => Effect.map(textOf(join(dir, file)), (x) => x?.trim());
    const persona = (en ? yield* text("persona.en.md") : undefined) ?? (yield* text("persona.md")) ?? "";
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
      worktree: item.worktree ?? item.role === "helper",
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
    } satisfies T.AgentTemplate;
  });

/** A template folder on disk (templateFrom). */
export const readTemplate = (dir: string, source: T.AgentTemplateSource): Effect.Effect<T.AgentTemplate, TemplateProblem, FileSystem.FileSystem> =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => templateFrom(textOnDisk(fs), dir, source));

/** The ids of the built-in templates, in the order they are listed and installed. */
export const builtInIds = Effect.gen(function* () {
  const text = yield* Effect.orDie((yield* FileSystem.FileSystem).readFileString(join(builtInDir, "index.json")));
  return [...(yield* Effect.orDie(Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(text)))];
});

/** Every built-in template; one that does not read is a broken build (templates.test.ts keeps them readable). */
export const builtInTemplates = Effect.flatMap(builtInIds, (ids) => Effect.forEach(ids, (id) => Effect.orDie(readTemplate(join(builtInDir, id), "builtIn"))));

/** The templates added on this machine, by id; a folder that no longer reads (edited by hand) is left out and said why. */
export const addedTemplates = (home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const names = yield* fs.readDirectory(addedDir(home)).pipe(Effect.orElseSucceed((): string[] => []));
    const read = yield* Effect.forEach(names.toSorted(), (name) => Effect.result(readTemplate(join(addedDir(home), name), "added")));
    return {
      templates: read.flatMap((r) => (r._tag === "Success" ? [r.success] : [])),
      problems: read.flatMap((r) => (r._tag === "Failure" ? [r.failure.message] : [])),
    };
  });

/** A folder copied in as an added template, once it reads as one: only a template's own files go. */
export const copyTemplate = (from: string, home: string, id: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const to = join(addedDir(home), id);
    yield* fs.makeDirectory(to, { recursive: true });
    yield* Effect.forEach(files, (f) => Effect.flatMap(fs.exists(join(from, f)), (there) => (there ? fs.copyFile(join(from, f), join(to, f)) : Effect.void)), {
      discard: true,
    });
  });

export const removeTemplate = (home: string, id: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(join(addedDir(home), id), { recursive: true, force: true }));

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
export const updatedFrom = (item: T.AgentTemplate, a: T.Agent): T.Agent => ({
  ...a,
  duty: item.duty,
  tags: [...item.tags],
  persona: item.persona,
  personaMode: item.personaMode,
  worktree: item.worktree,
  from: { template: item.id, version: item.version },
});
