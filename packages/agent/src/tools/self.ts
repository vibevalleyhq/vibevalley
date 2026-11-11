import { Effect, type FileSystem, Schema } from "effect";

import { self as selfWords } from "../base/prompts.ts";
import { ToolFailed, toolFailed } from "../core/errors.ts";
import type { Tool } from "../core/loop.ts";
import { schemaEffectTool } from "../core/tool.ts";
import { archiveFiles, fileMemory, type MemoryPort, searchArchive } from "./memory.ts";
import { readSkill, type SkillInfo } from "./skills.ts";

export interface SelfOptions {
  readonly home: string;
  /** The brain's Time: the day a remembered line is dated. */
  readonly now: () => number;
  /** Scanned each time it asks. */
  readonly skills: () => Effect.Effect<SkillInfo[]>;
  readonly memory: boolean | MemoryPort;
  readonly fs?: FileSystem.FileSystem;
}

const searchIn = (home: string, query: string, fs?: FileSystem.FileSystem): Effect.Effect<string, ToolFailed> =>
  Effect.gen(function* () {
    if (query.trim() === "") return yield* ToolFailed.make({ message: selfWords.emptyQuery });
    const files = yield* Effect.mapError(archiveFiles(home, fs), toolFailed);
    if (files.length === 0) return selfWords.noArchive;
    const hits = yield* Effect.mapError(searchArchive(home, query, 0, fs), toolFailed);
    if (hits.length === 0) return selfWords.noHits(query);
    return hits.map((h) => `${h.file}:${h.line}\n${h.text}`).join("\n\n---\n\n");
  });

export function selfTools(o: SelfOptions): Tool[] {
  const memory = o.memory === true ? fileMemory(o.home, o.now, o.fs) : o.memory === false ? undefined : o.memory;
  const loadSkill = schemaEffectTool({
    name: "load_skill",
    description: selfWords.loadSkillDescription,
    parameters: Schema.Struct({ name: Schema.String }),
    run: (p) => Effect.flatMap(o.skills(), (skills) => readSkill(skills, p.name, o.fs)),
  });
  const rememberTool = schemaEffectTool({
    name: "remember",
    description: selfWords.rememberDescription,
    parameters: Schema.Struct({ note: Schema.String }),
    run: (p) => {
      if (!p.note.trim()) return Effect.fail(ToolFailed.make({ message: selfWords.emptyNote }));
      if (!memory) return Effect.fail(ToolFailed.make({ message: "Memory tools are disabled" }));
      return memory.remember(p.note).pipe(Effect.as(selfWords.remembered), Effect.mapError(toolFailed));
    },
  });
  const rewrite = schemaEffectTool({
    name: "rewrite_memory",
    description: selfWords.rewriteMemoryDescription,
    parameters: Schema.Struct({ content: Schema.String }),
    run: (p) =>
      memory
        ? Effect.mapBoth(memory.rewrite(p.content), {
            onSuccess: (n) => selfWords.rewritten(n),
            onFailure: toolFailed,
          })
        : Effect.fail(ToolFailed.make({ message: "Memory tools are disabled" })),
  });
  const search = schemaEffectTool({
    name: "search_archive",
    description: selfWords.searchArchiveDescription,
    parameters: Schema.Struct({ query: Schema.String }),
    run: (p) => searchIn(o.home, p.query, o.fs),
  });
  return [loadSkill, ...(memory ? [rememberTool, rewrite] : []), search];
}

/** Interrupting it calls the subagent back. */
export type Subagent = (brief: string, label: string) => Effect.Effect<string, ToolFailed>;

export const subagentTool = (spawn: Subagent) =>
  schemaEffectTool({
    name: "spawn_agent",
    description: selfWords.spawnAgentDescription,
    parameters: Schema.Struct({ brief: Schema.String, label: Schema.optionalKey(Schema.String) }),
    run: (p) =>
      p.brief.trim() ? spawn(p.brief, p.label ?? [...p.brief].slice(0, 20).join("")) : Effect.fail(ToolFailed.make({ message: selfWords.emptyBrief })),
  });

export const subagentInstructions = selfWords.subagentInstructions;
