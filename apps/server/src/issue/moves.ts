// Where an issue may be moved, and what each move does: the table the board, the command line, the manager's tools and
// the server's refusals all go by. Worked out with the issue's status and attention in reduce (withIssueStatuses), so a
// round that ends changes what the issue may do at once, wherever it is read.

import { type Issue, type IssueStatus, IssueStatusValues } from "@vibevalley/protocol";
import { isForManager } from "./state.ts";

/** What moving an issue to a status does. in_progress and in_review are the session's to reach, never the owner's. */
export type Move =
  | "none"
  /** backlog → todo: sent out now, or waits in todo for room */
  | "start"
  /** todo → backlog */
  | "unqueue"
  /** in_review → todo: another round, with the owner's words */
  | "round"
  /** done, canceled → todo: a new session picks it up, with the owner's words */
  | "reopen"
  /** canceled before it was ever sent → backlog */
  | "revive"
  /** in_review → done */
  | "merge"
  /** in_progress, in_review → canceled: its session goes home */
  | "cancel"
  /** backlog, todo → canceled: never sent */
  | "drop"
  /** the manager's issue, in_review → done: the owner takes its answer */
  | "answered"
  /** the manager's issue, in_review → canceled */
  | "putAway";

export const statusWords: Readonly<Record<IssueStatus, string>> = {
  backlog: "备选",
  todo: "待办",
  in_progress: "处理中",
  in_review: "等你看",
  done: "已完成",
  canceled: "已取消",
};

/** The whole table; the reason says why when there is no move. */
export function statusMove(t: Issue, to: IssueStatus): [Move, string] {
  const from = t.status;
  if (isForManager(t)) return managerMove(t, to);
  if (t.graph || t.task || t.closed === "merged_into_graph") return ["none", "这是种植计划的工单，跟着计划走：在计划里改"];
  if (from === to) return ["none", "它已经是这个状态了"];
  if (to === "in_progress" || to === "in_review") return ["none", "处理中和等你看是帮工干出来的：挪到待办，它就开工"];
  const sent = t.sessions.length > 0;
  switch (from) {
    case "backlog":
      if (to === "todo") return t.refining ? ["none", t.refining.name + " 正在起草：等它交回来再开工"] : ["start", ""];
      if (to === "canceled") return ["drop", ""];
      break;
    case "todo":
      if (to === "backlog") return ["unqueue", ""];
      if (to === "canceled") return ["drop", ""];
      break;
    case "in_progress":
      return to === "canceled" ? ["cancel", ""] : ["none", "帮工还在干：等它交回来，或者挪到已取消让它回家"];
    case "in_review":
      if (to === "todo") return ["round", ""];
      // Every issue has an acceptance; a glance one is passed by this harvest itself, so a round that failed is never
      // harvested: done is what was asked for, not how the round ended.
      if (to === "done") {
        if (t.attention.stuck === "failed") return ["none", "这一轮没做成：带句话再干一轮，或者关掉"];
        return t.review === "required" && t.reviewedAt === undefined ? ["none", "这张工单要先过验收：验收通过才能收获"] : ["merge", ""];
      }
      if (to === "canceled") return ["cancel", ""];
      break;
    case "done":
    case "canceled":
      if (to === "todo" && sent) return ["reopen", ""];
      if (to === "backlog" && !sent) return ["revive", ""];
      return sent ? ["none", "关上的工单挪回待办，就是带一句话重开"] : ["none", "没开过工就取消的工单，挪回备选再说"];
  }
  return ["none", "不能从" + statusWords[from] + "挪到" + statusWords[to]];
}

/** The manager closes nothing: it answers, and the owner takes the answer as done or puts it away. */
function managerMove(t: Issue, to: IssueStatus): [Move, string] {
  if (t.status === "in_progress") return ["none", "管家还在答：等它答完"];
  if (t.status !== "in_review") return ["none", "这是派给管家的工单：再问管家一次就开了"];
  if (to === "canceled") return ["putAway", ""];
  if (to !== "done") return ["none", "管家答完的工单只能挪到已完成或已取消；要它接着做，在串里跟管家说"];
  if (t.handedBack && t.handedBack.outcome !== "completed") return ["none", "管家这一轮没答成：再问它一次，或者挪到已取消"];
  return ["answered", ""];
}

export const statusMoves = (t: Issue): IssueStatus[] => IssueStatusValues.filter((to) => statusMove(t, to)[0] !== "none");
