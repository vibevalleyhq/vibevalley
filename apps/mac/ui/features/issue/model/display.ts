import { z } from "zod";

import { t } from "@vibevalley/i18n";
import type { ActorRef, Issue, Priority } from "@vibevalley/protocol";
import { assignedAgentOf, omitUndefined } from "@vibevalley/protocol/rules";

import { compareText, or } from "../../../infra/base/search";
import { defineStored, orFallback } from "../../../infra/state/stored";
import { type BoardCard, type Lane, lanes } from "./cards";
import { endedAt } from "./issue";
import { formatIsoDate } from "./meta";

export type BoardView = "board" | "list" | "timeline" | "calendar";
export const boardViews = ["board", "list", "timeline", "calendar"] as const satisfies readonly BoardView[];
export const viewLabel: Record<BoardView, string> = {
  board: t("web.issue.boardLabels.view.board"),
  list: t("web.issue.boardLabels.view.list"),
  timeline: t("web.issue.boardLabels.view.timeline"),
  calendar: t("web.issue.boardLabels.view.calendar"),
};

/** Groups of the list view. The board keeps its status lanes whatever this is: a drag between lanes moves status. */
export type Grouping = "status" | "repo" | "agent" | "none";
export const groupings = ["status", "repo", "agent", "none"] as const satisfies readonly Grouping[];

/** Multi-dimensional toolbar grouping across Kanban and List views. */
export type GroupBy = "none" | "repo" | "owner" | "agent" | "priority" | "parent";
export const groupBys = ["none", "repo", "owner", "agent", "priority", "parent"] as const satisfies readonly GroupBy[];

/** Hierarchy visibility mode across Kanban and List views. */
export type HierarchyMode = "all" | "top_level" | "parents_only";
export const hierarchyModes = ["all", "top_level", "parents_only"] as const satisfies readonly HierarchyMode[];

/** `manual` keeps the order the rows came in: the history's, which for todo is the user's own order. */
export type Ordering = "manual" | "priority" | "updated" | "created";
export const orderings = ["manual", "priority", "updated", "created"] as const satisfies readonly Ordering[];

/** Visual density across Board, List, Timeline, and Calendar views. */
export type BoardDensity = "comfortable" | "compact";
export const boardDensities = ["comfortable", "compact"] as const satisfies readonly BoardDensity[];

/** Toggleable issue metadata slots controlled by DisplayMenu across issue views. */
export const issueFieldKeys = ["number", "priority", "repo", "owner", "agent", "tags", "dates", "progress", "preview"] as const;
export type IssueFieldKey = (typeof issueFieldKeys)[number];
export type IssueFieldVisibility = Record<IssueFieldKey, boolean>;

export const defaultFields: IssueFieldVisibility = {
  number: true,
  priority: true,
  repo: true,
  owner: true,
  agent: true,
  tags: true,
  dates: true,
  progress: true,
  preview: true,
};

export interface BoardLook {
  view: BoardView;
  grouping: Grouping;
  ordering: Ordering;
  groupBy: GroupBy;
  hierarchy: HierarchyMode;
  density: BoardDensity;
  fields: IssueFieldVisibility;
}

export const defaultLook: BoardLook = {
  view: "board",
  grouping: "status",
  ordering: "manual",
  groupBy: "none",
  hierarchy: "all",
  density: "comfortable",
  fields: defaultFields,
};

const fieldsSchema = z.object({
  number: orFallback(z.boolean(), defaultFields.number),
  priority: orFallback(z.boolean(), defaultFields.priority),
  repo: orFallback(z.boolean(), defaultFields.repo),
  owner: orFallback(z.boolean(), defaultFields.owner),
  agent: orFallback(z.boolean(), defaultFields.agent),
  tags: orFallback(z.boolean(), defaultFields.tags),
  dates: orFallback(z.boolean(), defaultFields.dates),
  progress: orFallback(z.boolean(), defaultFields.progress),
  preview: orFallback(z.boolean(), defaultFields.preview),
});

// How the board looks on this machine: kept across reloads (state/stored.ts), each part falling back on its own.
export const boardLook = defineStored(
  "board.look",
  z.object({
    view: orFallback(z.literal(boardViews), defaultLook.view),
    grouping: orFallback(z.literal(groupings), defaultLook.grouping),
    ordering: orFallback(z.literal(orderings), defaultLook.ordering),
    groupBy: orFallback(z.literal(groupBys), defaultLook.groupBy),
    hierarchy: orFallback(z.literal(hierarchyModes), defaultLook.hierarchy),
    density: orFallback(z.literal(boardDensities), defaultLook.density),
    fields: orFallback(fieldsSchema, defaultFields),
  }),
  defaultLook,
);

/** Whether any display setting (excluding active view tab) differs from `defaultLook`. */
export function isLookCustomized(look: BoardLook): boolean {
  return (
    look.grouping !== defaultLook.grouping ||
    look.ordering !== defaultLook.ordering ||
    (look.groupBy ?? defaultLook.groupBy) !== defaultLook.groupBy ||
    (look.hierarchy ?? defaultLook.hierarchy) !== defaultLook.hierarchy ||
    (look.density ?? defaultLook.density) !== defaultLook.density ||
    issueFieldKeys.some((k) => (look.fields?.[k] ?? true) !== defaultFields[k])
  );
}

/** Toggles one field visibility flag cleanly while preserving all other display settings. */
export function toggleBoardField(look: BoardLook, key: IssueFieldKey): BoardLook {
  const current = look.fields ?? defaultFields;
  return {
    ...look,
    fields: {
      ...current,
      [key]: !current[key],
    },
  };
}

/** Resets all DisplayMenu presentation settings to defaults while preserving the active view tab. */
export function resetBoardLook(look: BoardLook): BoardLook {
  return {
    ...defaultLook,
    view: look.view,
  };
}

/** Compact `MM-DD` label for an issue's due/start date badge when present. */
export function formatCompactDateLabel(issue: Pick<Issue, "startAt" | "dueAt">): string | undefined {
  const target = issue.dueAt !== undefined && issue.dueAt > 0 ? issue.dueAt : issue.startAt !== undefined && issue.startAt > 0 ? issue.startAt : undefined;
  if (target === undefined) return undefined;
  return formatIsoDate(target).slice(5);
}

export function encodeActorRef(owner: ActorRef | undefined): string {
  if (!owner) return "";
  return `${owner.kind}:${owner.id}`;
}

export function decodeActorRef(raw: string): ActorRef | undefined {
  if (raw === "") return undefined;
  const idx = raw.indexOf(":");
  if (idx <= 0) return undefined;
  const kind = raw.slice(0, idx);
  const id = raw.slice(idx + 1);
  if (kind === "user") return { kind: "user", id };
  if (kind === "agent") return { kind: "agent", id };
  return undefined;
}

export function hierarchyShows(mode: HierarchyMode, card: BoardCard, allIssues: readonly Issue[]): boolean {
  switch (mode) {
    case "all":
      return true;
    case "top_level":
      return !card.issue.parent;
    case "parents_only":
      return !card.issue.parent && (card.kind === "family" || allIssues.some((item) => item.parent === card.issue.id));
  }
}

export interface CardGroup {
  readonly key: string;
  readonly owner?: ActorRef | undefined;
  readonly priority?: Priority | undefined;
  readonly parent?: Issue | undefined;
  readonly cards: BoardCard[];
}

function ownerGroupSortRank(key: string): number {
  if (key === "") return 3;
  if (key === "user:self") return 0;
  if (key.startsWith("user:")) return 1;
  return 2;
}

function asPriority(key: string): Priority | undefined {
  switch (key) {
    case "urgent":
    case "high":
    case "medium":
    case "low":
      return key;
    default:
      return undefined;
  }
}

/** Shared multi-dimensional grouping across Kanban and List views. */
export function groupCards(cards: readonly BoardCard[], groupBy: GroupBy, allIssues: readonly Issue[]): CardGroup[] {
  if (groupBy === "none") return [{ key: "", cards: [...cards] }];
  const byKey = new Map<string, BoardCard[]>();
  for (const c of cards) {
    const k =
      groupBy === "repo"
        ? (c.issue.repo ?? "")
        : groupBy === "owner"
          ? encodeActorRef(c.issue.owner)
          : groupBy === "agent"
            ? (assignedAgentOf(c.issue) ?? "")
            : groupBy === "priority"
              ? c.issue.priority
              : (c.issue.parent ?? "");
    const existing = byKey.get(k);
    if (existing) existing.push(c);
    else byKey.set(k, [c]);
  }
  const parentMap = groupBy === "parent" ? new Map<string, Issue>(allIssues.map((i) => [i.id, i])) : undefined;
  return [...byKey]
    .toSorted(([a], [b]) => {
      switch (groupBy) {
        case "priority":
          return priorityRank(asPriority(a)) - priorityRank(asPriority(b));
        case "owner":
          return or(ownerGroupSortRank(a) - ownerGroupSortRank(b), compareText(a, b));
        case "parent": {
          const emptyDiff = Number(a === "") - Number(b === "");
          if (emptyDiff !== 0) return emptyDiff;
          const pa = parentMap?.get(a);
          const pb = parentMap?.get(b);
          if (pa && pb) return pa.number - pb.number;
          return compareText(a, b);
        }
        case "repo":
        case "agent":
          return or(Number(a === "") - Number(b === ""), compareText(a, b));
      }
    })
    .map(([key, groupCards]) => {
      if (groupBy === "owner") {
        const owner = decodeActorRef(key);
        return owner ? { key, owner, cards: groupCards } : { key, cards: groupCards };
      }
      if (groupBy === "priority") {
        const priority = asPriority(key);
        return priority ? { key, priority, cards: groupCards } : { key, cards: groupCards };
      }
      if (groupBy === "parent") {
        const parent = parentMap?.get(key);
        return parent ? { key, parent, cards: groupCards } : { key, cards: groupCards };
      }
      return { key, cards: groupCards };
    });
}

/** What grouping and ordering read from a row. A task has no priority of its own: undefined sorts after low. */
export interface RowKeys {
  lane: Lane;
  priority?: Priority;
  createdAt: number;
  updatedAt: number;
  repo?: string;
  agent?: string;
}

const rank: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const priorityRank = (p: Priority | undefined) => (p === undefined ? 4 : rank[p]);

/** Stable: rows that tie keep the order they came in. */
export function orderRows<T>(rows: T[], ordering: Ordering, facts: (row: T) => RowKeys): T[] {
  if (ordering === "manual") return rows;
  const key = (a: RowKeys, b: RowKeys) => {
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

/** `key` is the lane, the repo, the agent id, or "" for rows without one (and for the single group of `none`). */
export interface RowGroup<T> {
  key: string;
  lane?: Lane;
  rows: T[];
}

/** By status every lane is a group, even empty, in lane order. by repo or agent the named groups come by name and the rows without one last. */
export function groupRows<T>(rows: T[], grouping: Grouping, facts: (row: T) => RowKeys): RowGroup<T>[] {
  switch (grouping) {
    case "none":
      return [{ key: "", rows }];
    case "status":
      return lanes.map((lane) => ({ key: lane, lane, rows: rows.filter((r) => facts(r).lane === lane) }));
    case "repo":
    case "agent": {
      const by = new Map<string, T[]>();
      for (const r of rows) {
        const f = facts(r);
        const k = (grouping === "repo" ? f.repo : f.agent) ?? "";
        by.set(k, [...(by.get(k) ?? []), r]);
      }
      return [...by].toSorted(([a], [b]) => or(Number(a === "") - Number(b === ""), compareText(a, b))).map(([key, rows]) => ({ key, rows }));
    }
  }
}

const issueUpdated = (i: Issue) => Math.max(i.createdAt, i.queuedAt ?? 0, i.closedAt ?? 0, i.reviewedAt ?? 0);

export function rowKeys(c: BoardCard): RowKeys {
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
        repo: c.issue.repo,
        agent: assignedAgentOf(c.issue),
      });
    case "issue":
      return omitUndefined({
        lane: c.lane,
        priority: c.issue.priority,
        createdAt: c.issue.createdAt,
        updatedAt: Math.max(issueUpdated(c.issue), ...c.sessions.flatMap((s) => [s.hiredAt, s.lastRun?.at ?? 0, endedAt(s) ?? 0])),
        repo: c.issue.repo,
        agent: assignedAgentOf(c.issue),
      });
  }
}

function closedAt(c: BoardCard) {
  switch (c.kind) {
    case "issue":
      return c.issue.closedAt ?? c.sessions.at(-1)?.hiredAt ?? c.issue.createdAt;
    default:
      return c.issue.closedAt ?? c.issue.createdAt;
  }
}

/** A lane's cards in the order the user picked; done and canceled by default newest closed first. */
export function laneOrder(lane: Lane, cards: BoardCard[], ordering: Ordering) {
  if ((lane === "done" || lane === "canceled") && ordering === "manual") return [...cards].toSorted((a, b) => closedAt(b) - closedAt(a));
  return orderRows(cards, ordering, rowKeys);
}
