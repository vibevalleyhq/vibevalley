// Where an issue stands for the owner: one state out of the issue's status, its session's phase, the questions, a
// conflict and the acceptance, with the one thing the owner is asked to do. The board, the farm and the page all say it.

import type { IssueAct, Attention, StuckReason } from "../shapes";

export const attentionLabel: Record<Attention, string> = {
  draft: "草稿",
  queued: "排队",
  working: "在做",
  asking: "等你回答",
  reviewing: "等你验收",
  stuck: "卡住了",
  done: "已完成",
  canceled: "已取消",
};

/** Why an issue is stuck, in a word or two. */
export const stuckLabel: Record<StuckReason, string> = {
  conflict: "有冲突",
  failed: "没做成",
  interrupted: "停在半路",
  quiet: "没动静",
};

/** What each act is called, on its button and in a refusal. */
export const actLabel: Record<IssueAct, string> = {
  start: "开工",
  answer: "回答",
  accept: "验收通过",
  reject: "打回",
  complete: "完成",
  keep: "完成，分支留着",
  acknowledge: "知道了",
  resolve: "让它解决冲突",
  resume: "接着做",
  cure: "接着修",
  tell: "带话",
  stop: "叫停这一轮",
  close: "取消",
  reopen: "重开",
};

/** Questions the owner for something: the page leads with it, the board flags it. */
export const attentionWantsOwner = (s: Attention) => s === "asking" || s === "reviewing" || s === "stuck";
