// What the orchestrator's patrol reads about each item waiting on the owner (InboxEntry.brief): said to the model, in
// Chinese whatever the owner's locale (the orchestrator answers in the owner's). {ago} is filled with how long it waited.

import type { PatrolNote } from "./patrol.ts";

export const patrolBrief = {
  ask: (who: string, questions: number, question: string) => who + "问了主人 " + questions + " 个问题，{ago}没人回：「" + question + "」",
  review: (who: string, brief: string) => who + "的活做完 {ago}了还没人看：「" + brief + "」",
  fix: (who: string, summary: string) => who + "这一轮没做成，{ago}没人管了：「" + summary + "」",
  interrupted: (who: string, brief: string) => who + "这一轮停在了半路，{ago}没人管了：「" + brief + "」",
  conflict: (who: string, files: number) => who + `的活合进主分支会冲突（${files} 个文件），{ago}没人管了`,
  quiet: (who: string, label: string) => who + "在干活，{ago}没动静了，最后在" + (label !== "" ? "「" + label + "」" : "想事情"),
  cron: (name: string, id: string) => "定时「" + name + "」（" + id + "）等主人同意，{ago}了",
  mention: (name: string, address: string, text: string) => name + " 在 " + address + " 问主人的话，{ago}没人回：「" + text + "」",
};

/** {ago}: hours from two on, minutes before. */
export const patrolAgo = (ms: number) => (ms >= 2 * 60 * 60_000 ? Math.round(ms / (60 * 60_000)) + " 小时" : Math.max(1, Math.round(ms / 60_000)) + " 分钟");

/** How a session is named to the model: its name and its id. */
export const patrolWho = (name: string, id: string) => name + "（" + id + "）";

export const patrolText = (channelName: string, found: readonly PatrolNote[]) =>
  "【巡查】#" +
  channelName +
  " 里有几件事放着没人管：\n" +
  found.map((item) => "- " + item.text).join("\n") +
  "\n\n看看要不要提醒主人（一两句，说在 #" +
  channelName +
  "）、催帮工或者叫停；都不用管就什么也别说。";
