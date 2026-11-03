import { Schema } from "effect";

import { t } from "@vibevalley/i18n";
import type { Issue, Priority } from "@vibevalley/protocol";
import { assignedAgentOf, omitUndefined } from "@vibevalley/protocol/rules";

import { compareText, or } from "@/base/search";
import { defineStored, orFallback } from "@/state/stored";

import { type BoardCard, type Lane, lanes } from "./cards";
import { endedAt } from "./issue";

type BoardView = "board" | "list";
export const boardViews = ["board", "list"] as const satisfies readonly BoardView[];
export const viewLabel: Record<BoardView, string> = { board: t("web.issue.boardLabels.view.board"), list: t("web.issue.boardLabels.view.list") };

/** Groups of the list view. The board keeps its status lanes whatever this is: a drag between lanes moves status. */
export type Grouping = "status" | "project" | "agent" | "none";
export const groupings = ["status", "project", "agent", "none"] as const satisfies readonly Grouping[];
export const groupingLabel: Record<Grouping, string> = {
  status: t("web.issue.boardLabels.grouping.status"),
  project: t("web.issue.boardLabels.grouping.project"),
  agent: t("web.issue.boardLabels.grouping.agent"),
  none: t("web.issue.boardLabels.grouping.none"),
};

/** `manual` keeps the order the rows came in: the history's, which for 待办 is the owner's own order. */
export type Ordering = "manual" | "priority" | "updated" | "created";
export const orderings = ["manual", "priority", "updated", "created"] as const satisfies readonly Ordering[];
export const orderingLabel: Record<Ordering, string> = {
  manual: t("web.issue.boardLabels.ordering.manual"),
  priority: t("web.issue.boardLabels.ordering.priority"),
  updated: t("web.issue.boardLabels.ordering.updated"),
  created: t("web.issue.boardLabels.ordering.created"),
};

export interface BoardLook {
  view: BoardView;
  grouping: Grouping;
  ordering: Ordering;
}

export const defaultLook: BoardLook = { view: "board", grouping: "status", ordering: "manual" };

// How the board looks on this machine: kept across reloads (state/stored.ts), each part falling back on its own.
export const boardLook = defineStored(
  "board.look",
  Schema.Struct({
    view: orFallback(Schema.Literals(boardViews), defaultLook.view),
    grouping: orFallback(Schema.Literals(groupings), defaultLook.grouping),
    ordering: orFallback(Schema.Literals(orderings), defaultLook.ordering),
  }),
  defaultLook,
);

/** What grouping and ordering read from a row. A task has no priority of its own: undefined sorts after low. */
export interface RowFacts {
  lane: Lane;
  priority?: Priority;
  createdAt: number;
  updatedAt: number;
  project?: string;
  agent?: string;
}

const rank: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const priorityRank = (p: Priority | undefined) => (p === undefined ? 4 : rank[p]);

/** Stable: rows that tie keep the order they came in. */
export function orderRows<T>(rows: T[], ordering: Ordering, facts: (row: T) => RowFacts): T[] {
  if (ordering === "manual") return rows;
  const key = (a: RowFacts, b: RowFacts) => {
    switch (ordering) {
      case "priority":
        return priorityRank(a.priority) - priorityRank(b.priority);
      case "updated":
        return b.updatedAt - a.updatedAt;
      case "created":
        return b.createdAt - a.createdAt;
    }
  };
  return rows
    .map((row, i) => ({ row, i, f: facts(row) }))
    .toSorted((a, b) => or(key(a.f, b.f), a.i - b.i))
    .map((e) => e.row);
}

/** `key` is the lane, the project, the agent id, or "" for rows without one (and for the single group of `none`). */
export interface RowGroup<T> {
  key: string;
  lane?: Lane;
  rows: T[];
}

/** By status every lane is a group, even empty, in lane order; by project or agent the named groups come by name and
 * the rows without one last. Rows keep their order inside a group. */
export function groupRows<T>(rows: T[], grouping: Grouping, facts: (row: T) => RowFacts): RowGroup<T>[] {
  switch (grouping) {
    case "none":
      return [{ key: "", rows }];
    case "status":
      return lanes.map((lane) => ({ key: lane, lane, rows: rows.filter((r) => facts(r).lane === lane) }));
    case "project":
    case "agent": {
      const by = new Map<string, T[]>();
      for (const r of rows) {
        const f = facts(r);
        const k = (grouping === "project" ? f.project : f.agent) ?? "";
        by.set(k, [...(by.get(k) ?? []), r]);
      }
      return [...by].toSorted(([a], [b]) => or(Number(a === "") - Number(b === ""), compareText(a, b))).map(([key, rows]) => ({ key, rows }));
    }
  }
}

const issueUpdated = (i: Issue) => Math.max(i.createdAt, i.queuedAt ?? 0, i.closedAt ?? 0, i.reviewedAt ?? 0);

export function rowFacts(c: BoardCard): RowFacts {
  switch (c.kind) {
    case "family":
    case "todo":
    case "orchestrator":
    case "missing":
      return omitUndefined({
        lane: c.lane,
        priority: c.issue.priority,
        createdAt: c.issue.createdAt,
        updatedAt: issueUpdated(c.issue),
        project: c.issue.project,
        agent: assignedAgentOf(c.issue),
      });
    case "issue":
      return omitUndefined({
        lane: c.lane,
        priority: c.issue.priority,
        createdAt: c.issue.createdAt,
        updatedAt: Math.max(issueUpdated(c.issue), ...c.sessions.flatMap((s) => [s.hiredAt, s.lastRun?.at ?? 0, endedAt(s) ?? 0])),
        project: c.issue.project,
        agent: assignedAgentOf(c.issue),
      });
  }
}

function closedAt(c: BoardCard) {
  switch (c.kind) {
    case "issue":
      return c.issue.closedAt ?? c.sessions[c.sessions.length - 1]!.hiredAt;
    default:
      return c.issue.closedAt ?? c.issue.createdAt;
  }
}

/** A lane's cards in the order the owner picked; the closed lane by default newest closed first. */
export function laneOrder(lane: Lane, cards: BoardCard[], ordering: Ordering) {
  if (lane === "closed" && ordering === "manual") return [...cards].toSorted((a, b) => closedAt(b) - closedAt(a));
  return orderRows(cards, ordering, rowFacts);
}
