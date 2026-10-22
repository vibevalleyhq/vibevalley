// The tools every agent has on itself. They touch only the agent's own folder; a helper (spawn_agent) cannot send helpers.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { archiveFiles, remember, rewriteMemory, searchArchive } from "./memory.ts";
import { readSkill, type SkillInfo } from "./skills.ts";
import { objectSchema, stringSchema, textTool } from "./tool.ts";

export interface SelfOptions {
  readonly home: string;
  /** Scanned each time it questions. */
  readonly skills: () => SkillInfo[];
  readonly memory: boolean;
}

export function searchIn(home: string, query: string): string {
  if (query.trim() === "") throw new Error("query 是空的。");
  if (archiveFiles(home).length === 0) return "还没有归档的旧对话。";
  const hits = searchArchive(home, query);
  if (hits.length === 0) return "旧对话里没有「" + query + "」。";
  return hits.map((h) => `${h.file}:${h.line}\n${h.text}`).join("\n\n---\n\n");
}

export function selfTools(o: SelfOptions): AgentTool[] {
  const loadSkill = textTool<{ name: string }>({
    name: "load_skill",
    description: "读一个技能的全文（系统提示里「技能」列着有哪些）。要用某个技能之前先读它，再照着做。",
    parameters: objectSchema({ name: stringSchema() }, "name"),
    run: (p) => readSkill(o.skills(), p.name),
  });
  const rememberTool = textTool<{ note: string }>({
    name: "remember",
    description:
      "记下一条以后的对话也要知道的事：用户的偏好、约定、项目的关键事实。一句话，不记临时的事。记下的在下一次整理对话后进系统提示；在那之前，这次的结果就在对话里。",
    parameters: objectSchema({ note: stringSchema() }, "note"),
    run: (p) => {
      if (!p.note?.trim()) throw new Error("note 是空的。");
      remember(o.home, p.note);
      return "记下了。";
    },
  });
  const rewrite = textTool<{ content: string }>({
    name: "rewrite_memory",
    description: "整个重写你的记性（MEMORY.md）：合并重复的、删掉过时或错的。先看系统提示里的「记性」，再给出完整的新内容。",
    parameters: objectSchema({ content: stringSchema() }, "content"),
    run: (p) => `重写好了，现在 ${rewriteMemory(o.home, p.content ?? "").lineCount} 行。`,
  });
  const search = textTool<{ query: string }>({
    name: "search_archive",
    description: "在压缩掉的旧对话原文里搜一个词（不分大小写），返回出现的地方和前后几行。摘要里缺了细节时用。",
    parameters: objectSchema({ query: stringSchema() }, "query"),
    run: (p) => searchIn(o.home, p.query ?? ""),
  });
  return [loadSkill, ...(o.memory ? [rememberTool, rewrite] : []), search];
}

export type Helper = (brief: string, label: string, signal: AbortSignal) => Promise<string>;

export const subagentTool = (spawn: Helper) =>
  textTool<{ brief: string; label?: string }>({
    name: "spawn_agent",
    description:
      "派一个帮手去做一件独立的事（查资料、读一片代码、改一个模块、跑一组检查），它做完把结果汇报给你。它看不到你们的对话：brief 里写清楚要做什么、在哪、做到什么程度算完、汇报什么。几件互不相干的事可以在同一步里派几个，它们会同时做。",
    parameters: objectSchema({ brief: stringSchema(), label: stringSchema() }, "brief"),
    run: (p, tc) => {
      if (!p.brief?.trim()) throw new Error("brief 是空的。");
      return spawn(p.brief, p.label ?? [...p.brief].slice(0, 20).join(""), tc.signal);
    },
  });

export const subagentInstructions = (parent: string) =>
  "你是「" +
  parent +
  "」派出去的帮手，只做下面交代的这一件事，做完就停。\n" +
  "- 不能问问题：信息不够就按最合理的理解去做，在汇报里说明你的理解。\n" +
  "- 最后用一段话汇报：做了什么、结果是什么（要点、改过的文件、关键的数字）、没做成的和原因。你的最后一段话就是交回去的全部内容。";
