// The tools every agent has on itself. They touch only the agent's own folder; a subagent (spawn_agent) cannot send subagents.

import { Effect, Schema } from "effect";

import { ToolFailed } from "./core/errors.ts";
import type { Tool } from "./core/loop.ts";
import { schemaEffectTool, schemaTool } from "./core/tool.ts";
import { archiveFiles, remember, rewriteMemory, searchArchive } from "./memory.ts";
import { self as selfWords } from "./prompts.ts";
import { readSkill, type SkillInfo } from "./skills.ts";

export interface SelfOptions {
  readonly home: string;
  /** The brain's Time: the day a remembered line is dated. */
  readonly now: () => number;
  /** Scanned each time it asks. */
  readonly skills: () => SkillInfo[];
  readonly memory: boolean;
}

function searchIn(home: string, query: string): string {
  if (query.trim() === "") throw new Error(selfWords.emptyQuery);
  if (archiveFiles(home).length === 0) return selfWords.noArchive;
  const hits = searchArchive(home, query);
  if (hits.length === 0) return selfWords.noHits(query);
  return hits.map((h) => `${h.file}:${h.line}\n${h.text}`).join("\n\n---\n\n");
}

export function selfTools(o: SelfOptions): Tool[] {
  const loadSkill = schemaTool({
    name: "load_skill",
    description: selfWords.loadSkillDescription,
    parameters: Schema.Struct({ name: Schema.String }),
    run: (p) => readSkill(o.skills(), p.name),
  });
  const rememberTool = schemaTool({
    name: "remember",
    description: selfWords.rememberDescription,
    parameters: Schema.Struct({ note: Schema.String }),
    run: (p) => {
      if (!p.note.trim()) throw new Error(selfWords.emptyNote);
      remember(o.home, p.note, new Date(o.now()));
      return selfWords.remembered;
    },
  });
  const rewrite = schemaTool({
    name: "rewrite_memory",
    description: selfWords.rewriteMemoryDescription,
    parameters: Schema.Struct({ content: Schema.String }),
    run: (p) => selfWords.rewritten(rewriteMemory(o.home, p.content).lineCount),
  });
  const search = schemaTool({
    name: "search_archive",
    description: selfWords.searchArchiveDescription,
    parameters: Schema.Struct({ query: Schema.String }),
    run: (p) => searchIn(o.home, p.query),
  });
  return [loadSkill, ...(o.memory ? [rememberTool, rewrite] : []), search];
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
