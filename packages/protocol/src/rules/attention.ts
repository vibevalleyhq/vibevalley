// Where an issue stands for the owner: one state out of the issue's status, its session's phase, the questions, a
// conflict and the acceptance, with the one thing the owner is asked to do. The board, the farm and the page all say it.

import type { IssueAct, Attention } from "../shapes";

export const attentionLabel: Record<Attention, string> = {
  draft: "草稿",
  queued: "排队",
  working: "在做",
  asking: "等你回答",
  reviewing: "等你验收",
  stuck: "卡住了",
  harvested: "收获了",
  closed: "关了",
};

/** What each act is called, on its button and in a refusal. */
export const actLabel: Record<IssueAct, string> = {
  start: "开工",
  answer: "回答",
  accept: "验收通过",
  reject: "打回",
  harvest: "收获",
  keep: "完成，分支留着",
  acknowledge: "知道了",
  resolve: "让它解决冲突",
  resume: "接着做",
  cure: "接着修",
  tell: "带话",
  stop: "叫停这一轮",
  close: "关上",
  reopen: "重开",
};

/** Questions the owner for something: the page leads with it, the board flags it. */
export const attentionWantsOwner = (s: Attention) => s === "asking" || s === "reviewing" || s === "stuck";
