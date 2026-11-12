import { z } from "zod";

import { self as selfWords } from "../base/prompts.ts";
import { ToolFailed, toolFailed } from "../core/errors.ts";
import { schemaTool, type Tool } from "../core/tool.ts";
import type { AgentFs } from "../infra/fs.ts";
import { type AgentLog, consoleLog } from "../infra/log.ts";
import { fileMemory, type MemoryPort } from "./memory.ts";
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

export function selfTools(o: SelfOptions): Tool[] {
  const memory = o.memory === true ? fileMemory(o.home, o.now, o.fs, o.log ?? consoleLog) : o.memory === false ? undefined : o.memory;
  const loadSkill = schemaTool({
    name: "load_skill",
    description: selfWords.loadSkillDescription,
    parameters: z.object({ name: z.string() }),
    run: async (p) => readSkill(await o.skills(), p.name, o.fs),
  });
  const rememberTool = schemaTool({
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
  const rewrite = schemaTool({
    name: "rewrite_memory",
    description: selfWords.rewriteMemoryDescription,
    parameters: z.object({ content: z.string() }),
    run: async (p) => {
      if (!memory) throw new ToolFailed("Memory tools are disabled");
      return selfWords.rewritten(await asTool(() => memory.rewrite(p.content)));
    },
  });
  return [loadSkill, ...(memory ? [rememberTool, rewrite] : [])];
}

/** Throws a ToolFailed for a subagent that did not answer; the signal calls the subagent back. */
type Subagent = (brief: string, label: string, signal?: AbortSignal) => Promise<string>;

export const subagentTool = (spawn: Subagent) =>
  schemaTool({
    name: "spawn_agent",
    description: selfWords.spawnAgentDescription,
    parameters: z.object({ brief: z.string(), label: z.exactOptional(z.string()) }),
    run: async (p, signal) => {
      if (!p.brief.trim()) throw new ToolFailed(selfWords.emptyBrief);
      return spawn(p.brief, p.label ?? [...p.brief].slice(0, 20).join(""), signal);
    },
  });

export const subagentInstructions = selfWords.subagentInstructions;
