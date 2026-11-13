// The issue views' words in English and Chinese, from VibeValley's
// `web.issue` catalog (locales/{en,zh}/web.issue.json) where it had them.
// Shared by IssueBoard, IssueDetail and DecisionInbox so an act or a stage
// reads the same everywhere. The language follows nsh's `locale()`.
import { locale } from "nsh";

import type { Act, InboxKind, IssueStatus, StageKind, StuckReason } from "./shapes";

export type Lane = "todo" | "working" | "waiting" | "closed";

const en = {
  lane: { todo: "To do", working: "In progress", waiting: "Needs you", closed: "Closed" } as Record<Lane, string>,
  laneEmpty: {
    todo: "Write down what to do here; Start sends it to a helper.",
    working: "Nothing is being worked on.",
    waiting: "Finished and failed rounds wait here for you.",
    closed: "Done and canceled issues show up here.",
  } as Record<Lane, string>,
  stage: {
    draft: "Draft",
    queued: "Queued",
    working: "Working",
    asking: "Asking you",
    reviewing: "Ready for review",
    stuck: "Stuck",
    done: "Done",
    canceled: "Canceled",
  } as Record<StageKind, string>,
  stuck: { failed: "This round failed", conflict: "Merging would conflict", interrupted: "Stopped halfway", quiet: "Quiet for a while" } as Record<
    StuckReason,
    string
  >,
  act: {
    start: "Start",
    answer: "Answer",
    reject: "Send back",
    complete: "Complete",
    acknowledge: "Got it",
    resolve: "Let it resolve",
    resume: "Resume",
    cure: "Keep fixing",
    tell: "Tell",
    stop: "Stop",
    close: "Close",
    reopen: "Reopen",
  } as Record<Act, string>,
  /** The short confirmation after an act was chosen. */
  done: {
    start: "Started",
    answer: "Answered",
    reject: "Sent back",
    complete: "Completed",
    acknowledge: "Acknowledged",
    resolve: "Resolving",
    resume: "Resumed",
    cure: "Fixing again",
    tell: "Sent",
    stop: "Stopped",
    close: "Closed",
    reopen: "Reopened",
  } as Record<Act, string>,
  status: { backlog: "Backlog", todo: "To do", in_progress: "In progress", in_review: "In review", done: "Done", canceled: "Canceled" } as Record<
    IssueStatus,
    string
  >,
  inbox: {
    review: "Handed back for review",
    ask: "Has a question",
    fix: "The last round failed",
    interrupted: "Stopped halfway",
    conflict: "Merge conflict",
    quiet: "No sign of life for a while",
  } as Record<InboxKind, string>,
  conflictFiles: (n: number) => (n === 1 ? "1 file conflicts" : `${n.toLocaleString()} files conflict`),
  open: "Open",
  openTerminal: "Open terminal",
  answerMore: "Answer…",
  noRepo: "No repository",
};

const zh: typeof en = {
  lane: { todo: "待办", working: "处理中", waiting: "等你看", closed: "已关" },
  laneEmpty: {
    todo: "想到要做的先写在这里，点开始就派人开工。",
    working: "没有在干的活。",
    waiting: "做完的、没做成的在这里等你看。",
    closed: "已完成、已取消的工单。",
  },
  stage: {
    draft: "草稿",
    queued: "排队中",
    working: "在做",
    asking: "等你回答",
    reviewing: "等你验收",
    stuck: "卡住了",
    done: "做完了",
    canceled: "已取消",
  },
  stuck: { failed: "这一轮没做成", conflict: "合并会冲突", interrupted: "这一轮停在半路", quiet: "很久没动静了" },
  act: {
    start: "开始",
    answer: "回答",
    reject: "打回",
    complete: "完成",
    acknowledge: "知道了",
    resolve: "让它解决冲突",
    resume: "继续",
    cure: "接着修",
    tell: "带话",
    stop: "叫停",
    close: "关闭",
    reopen: "重开",
  },
  done: {
    start: "开工了",
    answer: "回答了",
    reject: "打回了",
    complete: "完成了",
    acknowledge: "知道了",
    resolve: "去解决了",
    resume: "继续了",
    cure: "接着修了",
    tell: "带到了",
    stop: "叫停了",
    close: "关掉了",
    reopen: "重开了",
  },
  status: { backlog: "草稿", todo: "待办", in_progress: "处理中", in_review: "等你看", done: "已完成", canceled: "已取消" },
  inbox: {
    review: "交回来了，等你验收",
    ask: "有问题要问你",
    fix: "这一轮没做成",
    interrupted: "这一轮停在半路",
    conflict: "合并会冲突",
    quiet: "很久没动静了",
  },
  conflictFiles: (n: number) => `${n} 个文件冲突`,
  open: "打开",
  openTerminal: "打开终端",
  answerMore: "回答…",
  noRepo: "没有仓库",
};

/** The words in the language shown now (reactive through `locale()`). */
export function words(): typeof en {
  return locale().toLowerCase().startsWith("zh") ? zh : en;
}

/** The board column an issue sits in: its status, as VibeValley's `laneOf`. */
export function laneOf(status: IssueStatus): Lane {
  if (status === "backlog" || status === "todo") return "todo";
  if (status === "in_progress") return "working";
  if (status === "in_review") return "waiting";
  return "closed";
}

export const lanes: Lane[] = ["todo", "working", "waiting", "closed"];
