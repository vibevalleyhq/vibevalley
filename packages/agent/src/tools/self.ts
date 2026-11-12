import { z } from "zod";

import { self as selfWords } from "../base/prompts.ts";
import { ToolFailed, toolFailed } from "../core/errors.ts";
import type { Tool } from "../core/loop.ts";
import { schemaEffectTool } from "../core/tool.ts";
import type { AgentFs } from "../infra/fs.ts";
import { type AgentLog, consoleLog } from "../infra/log.ts";
import { archiveFiles, fileMemory, type MemoryPort, searchArchive } from "./memory.ts";
import { readSkill, type SkillInfo } from "./skills.ts";

export interface SelfOptions {
  readonly home: string;
  /** The brain's Time: the day a remembered line is dated. */
  readonly now: () => number;
  /** Scanned each time it asks. */
  readonly skills: () => Promise<SkillInfo[]>;
  readonly memory: boolean | MemoryPort;
  readonly fs?: AgentFs;
  readonly log?: AgentLog;
}

/** f, what it throws a ToolFailed. */
async function asTool<A>(f: () => Promise<A>): Promise<A> {
  try {
    return await f();
  } catch (e) {
    throw toolFailed(e);
  }
}

async function searchIn(home: string, query: string, fs?: AgentFs): Promise<string> {
  if (query.trim() === "") throw new ToolFailed(selfWords.emptyQuery);
  const files = await asTool(() => archiveFiles(home, fs));
  if (files.length === 0) return selfWords.noArchive;
  const hits = await asTool(() => searchArchive(home, query, 0, fs));
  if (hits.length === 0) return selfWords.noHits(query);
  return hits.map((h) => `${h.file}:${h.line}\n${h.text}`).join("\n\n---\n\n");
}

export function selfTools(o: SelfOptions): Tool[] {
  const memory = o.memory === true ? fileMemory(o.home, o.now, o.fs, o.log ?? consoleLog) : o.memory === false ? undefined : o.memory;
  const loadSkill = schemaEffectTool({
    name: "load_skill",
    description: selfWords.loadSkillDescription,
    parameters: z.object({ name: z.string() }),
    run: async (p) => readSkill(await o.skills(), p.name, o.fs),
  });
  const rememberTool = schemaEffectTool({
    name: "remember",
    description: selfWords.rememberDescription,
    parameters: z.object({ note: z.string() }),
    run: async (p) => {
      if (!p.note.trim()) throw new ToolFailed(selfWords.emptyNote);
      if (!memory) throw new ToolFailed("Memory tools are disabled");
      await asTool(() => memory.remember(p.note));
      return selfWords.remembered;
    },
  });
  const rewrite = schemaEffectTool({
    name: "rewrite_memory",
    description: selfWords.rewriteMemoryDescription,
    parameters: z.object({ content: z.string() }),
    run: async (p) => {
      if (!memory) throw new ToolFailed("Memory tools are disabled");
      return selfWords.rewritten(await asTool(() => memory.rewrite(p.content)));
    },
  });
  const search = schemaEffectTool({
    name: "search_archive",
    description: selfWords.searchArchiveDescription,
    parameters: z.object({ query: z.string() }),
    run: (p) => searchIn(o.home, p.query, o.fs),
  });
  return [loadSkill, ...(memory ? [rememberTool, rewrite] : []), search];
}

/** Throws a ToolFailed for a subagent that did not answer; the signal calls the subagent back. */
export type Subagent = (brief: string, label: string, signal?: AbortSignal) => Promise<string>;

export const subagentTool = (spawn: Subagent) =>
  schemaEffectTool({
    name: "spawn_agent",
    description: selfWords.spawnAgentDescription,
    parameters: z.object({ brief: z.string(), label: z.exactOptional(z.string()) }),
    run: async (p, signal) => {
      if (!p.brief.trim()) throw new ToolFailed(selfWords.emptyBrief);
      return spawn(p.brief, p.label ?? [...p.brief].slice(0, 20).join(""), signal);
    },
  });

export const subagentInstructions = selfWords.subagentInstructions;
