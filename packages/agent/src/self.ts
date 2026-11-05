import { Effect, Schema } from "effect";

import { ToolFailed, toolFailed } from "./core/errors.ts";
import type { Tool } from "./core/loop.ts";
import { schemaEffectTool, schemaTool } from "./core/tool.ts";
import { archiveFiles, fileMemory, type MemoryPort, searchArchive } from "./memory.ts";
import { self as selfWords } from "./prompts.ts";
import { readSkill, type SkillInfo } from "./skills.ts";

interface SelfOptions {
  readonly home: string;
  /** The brain's Time: the day a remembered line is dated. */
  readonly now: () => number;
  /** Scanned each time it asks. */
  readonly skills: () => Promise<SkillInfo[]>;
  readonly memory: boolean | MemoryPort;
}

async function searchIn(home: string, query: string): Promise<string> {
  if (query.trim() === "") throw new Error(selfWords.emptyQuery);
  if ((await archiveFiles(home)).length === 0) return selfWords.noArchive;
  const hits = await searchArchive(home, query);
  if (hits.length === 0) return selfWords.noHits(query);
  return hits.map((h) => `${h.file}:${h.line}\n${h.text}`).join("\n\n---\n\n");
}

export function selfTools(o: SelfOptions): Tool[] {
  const memory = o.memory === true ? fileMemory(o.home, o.now) : o.memory === false ? undefined : o.memory;
  const loadSkill = schemaTool({
    name: "load_skill",
    description: selfWords.loadSkillDescription,
    parameters: Schema.Struct({ name: Schema.String }),
    run: async (p) => readSkill(await o.skills(), p.name),
  });
  const rememberTool = schemaEffectTool({
    name: "remember",
    description: selfWords.rememberDescription,
    parameters: Schema.Struct({ note: Schema.String }),
    run: (p) => {
      if (!p.note.trim()) return Effect.fail(new ToolFailed({ message: selfWords.emptyNote }));
      if (!memory) return Effect.fail(new ToolFailed({ message: "Memory tools are disabled" }));
      return memory.remember(p.note).pipe(Effect.as(selfWords.remembered), Effect.mapError(toolFailed));
    },
  });
  const rewrite = schemaEffectTool({
    name: "rewrite_memory",
    description: selfWords.rewriteMemoryDescription,
    parameters: Schema.Struct({ content: Schema.String }),
    run: (p) =>
      memory
        ? memory.rewrite(p.content).pipe(
            Effect.map((n) => selfWords.rewritten(n)),
            Effect.mapError(toolFailed),
          )
        : Effect.fail(new ToolFailed({ message: "Memory tools are disabled" })),
  });
  const search = schemaTool({
    name: "search_archive",
    description: selfWords.searchArchiveDescription,
    parameters: Schema.Struct({ query: Schema.String }),
    run: (p) => searchIn(o.home, p.query),
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
      p.brief.trim() ? spawn(p.brief, p.label ?? [...p.brief].slice(0, 20).join("")) : Effect.fail(new ToolFailed({ message: selfWords.emptyBrief })),
  });

export const subagentInstructions = selfWords.subagentInstructions;
