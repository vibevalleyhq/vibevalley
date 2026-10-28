// What the memories (记性) say to the owner: the sources' names and why one is off, what a search could not cover, why
// a note or a forget is refused, and what a forget would do.

import { localized } from "@vibevalley/protocol/words";

const zh = {
  source: { local: "本地", nowledge: "Nowledge Mem", everos: "EverOS" } as Readonly<Record<string, string>>,
  noUrl: "没填地址",
  off: "没打开",
  unknownSource: "不认识这种来源",
  stopped: "记性来源已经停下",
  forgetThere: (source: string) => `${source} 里的记忆到它自己那里删`,
  coverage: {
    failed: "读取失败、已取消或超时，未包含此来源",
    everosAcross: "不支持跨项目检索，请指定一个项目；本次未包含 EverOS",
    everosAgent: "此查询需要指定档案，本次未包含 EverOS",
    unconfirmed: "有命中的项目范围未经确认，已从本项目检索中排除",
    note: (source: string, note: string) => `${source}：${note}`,
  },
  everosList: "EverOS 的记忆不在这里列出",
  everosForget: "EverOS 里的记忆到 EverOS 里删",
  nowledgeForget: "Nowledge Mem 里的记忆到 Nowledge Mem 里删",
  empty: "要记的话是空的",
  dbFailed: "没记下来：数据库写不进去",
  fileFailed: "没记下来：MEMORY.md 写不进去",
  noMemory: (agent: string, id: string) => `${agent} 的记性里没有 ${id}`,
  forgetOrchestrator: (text: string) => `从管家的 MEMORY.md 删掉这一行：「${text}」`,
  forget: (agent: string, text: string) => `从 ${agent} 的记性里忘掉：「${text}」`,
  orchestratorRecall: "管家不靠想起：它每次带着整份记性",
};

const en: typeof zh = {
  source: { local: "Local", nowledge: "Nowledge Mem", everos: "EverOS" },
  noUrl: "no address",
  off: "off",
  unknownSource: "unknown kind of source",
  stopped: "The memory sources have stopped",
  forgetThere: (source) => `Memories in ${source} are deleted there`,
  coverage: {
    failed: "reading failed, was canceled or timed out; this source is not included",
    everosAcross: "searching across projects is not supported: name a project; EverOS is not included this time",
    everosAgent: "this search needs a profile; EverOS is not included this time",
    unconfirmed: "some hits' project could not be confirmed and were left out of this project's search",
    note: (source, note) => `${source}: ${note}`,
  },
  everosList: "EverOS memories are not listed here",
  everosForget: "EverOS memories are deleted in EverOS",
  nowledgeForget: "Nowledge Mem memories are deleted in Nowledge Mem",
  empty: "There is nothing to remember",
  dbFailed: "Not remembered: the database could not be written",
  fileFailed: "Not remembered: MEMORY.md could not be written",
  noMemory: (agent, id) => `${agent}'s memory has no ${id}`,
  forgetOrchestrator: (text) => `Delete this line from the manager's MEMORY.md: "${text}"`,
  forget: (agent, text) => `Forget from ${agent}'s memory: "${text}"`,
  orchestratorRecall: "The manager does not recall: it always carries its whole memory",
};

export const memoryWording = localized({ zh, en });
