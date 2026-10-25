// An issue's title in one short line, and its state in words, as the board, the phone, the tools and the orchestrator say them.

import type { Deliverable, Delivery, Issue, IssueCanceled, IssueStatus, Priority } from "../shapes";

const titleMax = 40;

/** One short line for a title: its first line, and of a long one, the first sentence, else up to its last pause that fits;
 * failing those, cut. Lengths are characters. */
export function shortTitle(text: string): string {
  const line = (text.split("\n").find((l) => l.trim() !== "") ?? "").trim();
  const chars = [...line];
  if (chars.length <= titleMax) return line;
  const head = chars.slice(0, titleMax + 1).join("");
  const sentence = /^(.{4,}?)[。！？!?；;]/u.exec(head)?.[1];
  if (sentence) return sentence.trim();
  const pause = Math.max(...[..."：:，,、"].map((p) => head.lastIndexOf(p)));
  if (pause >= 4) return head.slice(0, pause).trim();
  return chars.slice(0, titleMax - 1).join("") + "…";
}

// ── an issue's state in words: the one word list the board, the page, the tools and the orchestrator say ──

export const statusLabel: Readonly<Record<IssueStatus, string>> = {
  backlog: "备选",
  todo: "待办",
  in_progress: "处理中",
  in_review: "等你看",
  done: "已完成",
  canceled: "已取消",
};

export const priorityLabel: Readonly<Record<Priority, string>> = {
  urgent: "紧急",
  high: "高",
  medium: "普通",
  low: "低",
};

/** What an issue is to deliver, as the owner picks it. */
export const deliverableLabel: Readonly<Record<Deliverable, string>> = {
  change: "改动，合进项目",
  answer: "结论，只查不改代码",
};

/** What a done issue delivered. */
export const deliveredLabel: Readonly<Record<Delivery, string>> = {
  merged: "合进了主分支",
  merged_into_parent: "合进了计划的分支",
  pull_request: "PR 合进去了",
  kept: "分支留着没合",
  none: "没有改动要合",
};

/** Why a canceled issue was. dismissed is the owner's (a pull request closed unmerged too). */
export const canceledLabel: Readonly<Record<IssueCanceled, string>> = {
  dismissed: "取消了",
  lost: "干活的目录丢了",
};

/** What its close says: done with what it delivered, or canceled and why. */
export const closedText = (t: Pick<Issue, "status" | "delivered" | "canceled">): string =>
  t.delivered ? "已完成，" + deliveredLabel[t.delivered] : t.canceled ? "已取消，" + canceledLabel[t.canceled] : statusLabel[t.status];
