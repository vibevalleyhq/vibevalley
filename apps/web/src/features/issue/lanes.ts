import { t } from "@vibevalley/i18n";

import type { IssueStatus } from "@vibevalley/protocol";
export type Lane = "todo" | "working" | "waiting" | "closed";

export const lanes: Lane[] = ["todo", "working", "waiting", "closed"];

export const laneLabel: Record<Lane, string> = {
  todo: t("web.issue.boardLabels.lane.todo"),
  working: t("web.issue.boardLabels.lane.working"),
  waiting: t("web.issue.boardLabels.lane.waiting"),
  closed: t("web.issue.boardLabels.lane.closed"),
};

/** The status a lane's header is drawn with: the one its cards mostly have. */
export const laneStatus: Record<Lane, IssueStatus> = { todo: "todo", working: "in_progress", waiting: "in_review", closed: "done" };

/** A card says its own status only where its lane does not: a draft in 待办 says so by its 草稿 flag instead. */
export const ownStatus = (lane: Lane, status: IssueStatus) => status !== laneStatus[lane] && !(lane === "todo" && status === "backlog");

export function laneOf(s: IssueStatus): Lane {
  if (s === "backlog" || s === "todo") return "todo";
  if (s === "in_progress") return "working";
  if (s === "in_review") return "waiting";
  return "closed";
}

export type Move = "start" | "close" | "reopen";

/** A drop between lanes, if the server lets the issue go there (`Issue.moves`). A task's issue has no moves. */
export function moveOf(from: Lane, to: Lane, moves: IssueStatus[]): Move | undefined {
  if (from === "todo" && to === "working" && moves.includes("todo")) return "start";
  if ((from === "working" || from === "waiting") && to === "closed" && (moves.includes("done") || moves.includes("canceled"))) return "close";
  if (from === "closed" && to === "working" && moves.includes("todo")) return "reopen";
  return undefined;
}

export const closedShown = 15;
