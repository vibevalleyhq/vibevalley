import { t } from "@vibevalley/i18n";
import type { Priority } from "@vibevalley/protocol";

import { compareText, or } from "@/base/order";

import { type Lane, lanes } from "./lanes";

export type BoardView = "board" | "list";
export const boardViews: BoardView[] = ["board", "list"];
export const viewLabel: Record<BoardView, string> = { board: t("web.issue.boardLabels.view.board"), list: t("web.issue.boardLabels.view.list") };

/** Groups of the list view. The board keeps its status lanes whatever this is: a drag between lanes moves status. */
export type Grouping = "status" | "project" | "agent" | "none";
export const groupings: Grouping[] = ["status", "project", "agent", "none"];
export const groupingLabel: Record<Grouping, string> = {
  status: t("web.issue.boardLabels.grouping.status"),
  project: t("web.issue.boardLabels.grouping.project"),
  agent: t("web.issue.boardLabels.grouping.agent"),
  none: t("web.issue.boardLabels.grouping.none"),
};

/** `manual` keeps the order the rows came in: the history's, which for 待办 is the owner's own order. */
export type Ordering = "manual" | "priority" | "updated" | "created";
export const orderings: Ordering[] = ["manual", "priority", "updated", "created"];
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

/** Saved as three names; an unknown name falls back to its default. */
export const lookToList = (look: BoardLook) => [look.view, look.grouping, look.ordering];

export function lookFromList(raw: unknown): BoardLook {
  const list = Array.isArray(raw) ? raw : [];
  const pick = <T extends string>(all: T[], i: number, fallback: T) => all.find((v) => v === list[i]) ?? fallback;
  return {
    view: pick(boardViews, 0, defaultLook.view),
    grouping: pick(groupings, 1, defaultLook.grouping),
    ordering: pick(orderings, 2, defaultLook.ordering),
  };
}

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
