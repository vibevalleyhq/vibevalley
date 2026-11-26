import type { Issue, Priority } from "@vibevalley/protocol";
import { omitUndefined } from "@vibevalley/protocol/rules";

import type { BoardCard } from "./cards";
import { formatIsoDate } from "./meta";

export const DAY_MS = 86_400_000;

export type TimelineScale = "week" | "month" | "quarter";
export const timelineScales = ["week", "month", "quarter"] as const satisfies readonly TimelineScale[];

export interface TimelineScaleSpec {
  readonly dayWidth: number;
  readonly minDays: number;
  readonly padBeforeDays: number;
  readonly padAfterDays: number;
}

export const timelineScaleSpec: Record<TimelineScale, TimelineScaleSpec> = {
  week: { dayWidth: 48, minDays: 28, padBeforeDays: 7, padAfterDays: 21 },
  month: { dayWidth: 28, minDays: 45, padBeforeDays: 10, padAfterDays: 30 },
  quarter: { dayWidth: 14, minDays: 98, padBeforeDays: 14, padAfterDays: 60 },
};

/** Normalizes any timestamp (ms) to UTC midnight for deterministic day-grid math. */
export function utcDayStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Shifts a UTC day-start timestamp by `days`. */
export function addUtcDays(dayMs: number, days: number): number {
  return dayMs + days * DAY_MS;
}

/** Signed integer day distance from `startMs` to `endMs` on UTC day boundaries. */
export function utcDayDiff(startMs: number, endMs: number): number {
  return Math.round((utcDayStart(endMs) - utcDayStart(startMs)) / DAY_MS);
}

/** Returns `{ year, month }` (1-based month 1..12) for a timestamp in UTC. */
export function monthDateParts(ms: number): { year: number; month: number } {
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

/** Normalizes and shifts a `(year, month)` pair (1-based month) by `deltaMonths`. */
export function shiftMonth(year: number, month: number, deltaMonths: number): { year: number; month: number } {
  const d = new Date(Date.UTC(year, month - 1 + deltaMonths, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

/** Monday-first weekday index (`0` = Mon .. `6` = Sun) in UTC. */
function monSunDayIndex(dayMs: number): number {
  return (new Date(dayMs).getUTCDay() + 6) % 7;
}

const isPositiveTimestamp = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v) && v > 0;
const isClosedIssue = (issue: Pick<Issue, "status">) => issue.status === "done" || issue.status === "canceled";

export interface ScheduledSpan {
  readonly startMs: number;
  readonly endMs: number;
  readonly durationDays: number;
  readonly hasExplicitStart: boolean;
  readonly hasExplicitDue: boolean;
  readonly rolledUp: boolean;
  readonly overdue: boolean;
}

export interface ScheduledIssueEntry {
  readonly issue: Issue;
  readonly span: ScheduledSpan;
  readonly depth: number;
  readonly isParent: boolean;
  readonly childCount: number;
}

export interface ScheduledCardRow {
  readonly card: BoardCard;
  readonly issue: Issue;
  readonly span: ScheduledSpan;
  readonly depth: number;
  readonly isParent: boolean;
  readonly childCount: number;
}

export interface TimelineTick {
  readonly dayMs: number;
  readonly dateKey: string;
  readonly dayOfMonth: number;
  readonly weekdayIndex: number;
  readonly isMonday: boolean;
  readonly isWeekend: boolean;
  readonly isToday: boolean;
  readonly isFirstOfMonth: boolean;
}

export interface TimelineMonthBand {
  readonly key: string;
  readonly year: number;
  readonly month: number;
  readonly startIndex: number;
  readonly spanDays: number;
}

export interface TimelineGrid {
  readonly rows: ScheduledCardRow[];
  readonly unscheduled: BoardCard[];
  readonly rangeStartMs: number;
  readonly rangeEndMs: number;
  readonly totalDays: number;
  readonly todayDayMs: number;
  readonly ticks: TimelineTick[];
  readonly months: TimelineMonthBand[];
}

export interface MonthCell {
  readonly dayMs: number;
  readonly dateKey: string;
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly weekdayIndex: number;
  readonly inMonth: boolean;
  readonly isToday: boolean;
  readonly isWeekend: boolean;
}

export interface MonthGrid {
  readonly year: number;
  readonly month: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly todayDayMs: number;
  readonly cells: MonthCell[];
  readonly weeks: MonthCell[][];
}

const priorityWeight: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

interface RawBounds {
  readonly startMs: number | undefined;
  readonly endMs: number | undefined;
  readonly hasExplicitStart: boolean;
  readonly hasExplicitDue: boolean;
  readonly rolledUp: boolean;
}

/**
 * Computes schedule bounds for every issue in `issues`, rolling up earliest child start
 * and latest child due onto any parent that lacks its own start/due dates.
 */
function computeIssueSpans(issues: readonly Issue[], now = Date.now()): Map<string, ScheduledSpan> {
  const byId = new Map<string, Issue>();
  const childrenByParent = new Map<string, Issue[]>();
  for (const issue of issues) {
    byId.set(issue.id, issue);
    if (!issue.parent) continue;
    const list = childrenByParent.get(issue.parent) ?? [];
    list.push(issue);
    childrenByParent.set(issue.parent, list);
  }

  const todayDayMs = utcDayStart(now);
  const resolved = new Map<string, RawBounds>();
  const visiting = new Set<string>();

  const resolveBounds = (issue: Issue): RawBounds => {
    const cached = resolved.get(issue.id);
    if (cached) return cached;
    if (visiting.has(issue.id)) {
      return { startMs: undefined, endMs: undefined, hasExplicitStart: false, hasExplicitDue: false, rolledUp: false };
    }
    visiting.add(issue.id);

    const hasExplicitStart = isPositiveTimestamp(issue.startAt);
    const hasExplicitDue = isPositiveTimestamp(issue.dueAt);
    let startMs = hasExplicitStart ? utcDayStart(issue.startAt!) : undefined;
    let endMs = hasExplicitDue ? utcDayStart(issue.dueAt!) : undefined;
    let rolledUp = false;

    const children = childrenByParent.get(issue.id) ?? [];
    if (children.length > 0 && (startMs === undefined || endMs === undefined)) {
      let minChildStart: number | undefined;
      let maxChildDue: number | undefined;
      for (const child of children) {
        const cb = resolveBounds(child);
        const cStart = cb.startMs ?? cb.endMs;
        const cEnd = cb.endMs ?? cb.startMs;
        if (cStart !== undefined && (minChildStart === undefined || cStart < minChildStart)) minChildStart = cStart;
        if (cEnd !== undefined && (maxChildDue === undefined || cEnd > maxChildDue)) maxChildDue = cEnd;
      }
      if (startMs === undefined && minChildStart !== undefined) {
        startMs = minChildStart;
        rolledUp = true;
      }
      if (endMs === undefined && maxChildDue !== undefined) {
        endMs = maxChildDue;
        rolledUp = true;
      }
    }

    visiting.delete(issue.id);
    const out: RawBounds = { startMs, endMs, hasExplicitStart, hasExplicitDue, rolledUp };
    resolved.set(issue.id, out);
    return out;
  };

  for (const issue of issues) resolveBounds(issue);

  const spans = new Map<string, ScheduledSpan>();
  for (const issue of issues) {
    const b = resolved.get(issue.id);
    if (!b || (b.startMs === undefined && b.endMs === undefined)) continue;

    let startMs: number;
    let endMs: number;
    if (b.startMs !== undefined && b.endMs !== undefined) {
      startMs = b.startMs;
      endMs = Math.max(b.startMs, b.endMs);
    } else if (b.startMs !== undefined) {
      startMs = b.startMs;
      const closedDay = isPositiveTimestamp(issue.closedAt) ? utcDayStart(issue.closedAt) : undefined;
      endMs = closedDay !== undefined && closedDay >= startMs ? closedDay : startMs;
    } else {
      // Due-only issues appear as a single-day milestone on their target due date.
      startMs = b.endMs!;
      endMs = b.endMs!;
    }

    const durationDays = Math.max(1, utcDayDiff(startMs, endMs) + 1);
    const dueBasis = b.endMs ?? (b.hasExplicitDue ? endMs : undefined);
    const overdue = !isClosedIssue(issue) && dueBasis !== undefined && dueBasis < todayDayMs;

    spans.set(issue.id, {
      startMs,
      endMs,
      durationDays,
      hasExplicitStart: b.hasExplicitStart,
      hasExplicitDue: b.hasExplicitDue,
      rolledUp: b.rolledUp,
      overdue,
    });
  }

  return spans;
}

function compareScheduledEntries(a: { issue: Issue; span: ScheduledSpan }, b: { issue: Issue; span: ScheduledSpan }): number {
  if (a.span.startMs !== b.span.startMs) return a.span.startMs - b.span.startMs;
  if (a.span.endMs !== b.span.endMs) return a.span.endMs - b.span.endMs;
  const pa = priorityWeight[a.issue.priority];
  const pb = priorityWeight[b.issue.priority];
  if (pa !== pb) return pa - pb;
  return a.issue.number - b.issue.number;
}

function orderHierarchically<T extends { issue: Issue; span: ScheduledSpan }>(
  items: readonly T[],
  childCountOf: (issueId: string) => number,
): (T & { depth: number; isParent: boolean; childCount: number })[] {
  const presentIds = new Set(items.map((x) => x.issue.id));
  const childrenMap = new Map<string, T[]>();
  const roots: T[] = [];

  for (const item of items) {
    const parentId = item.issue.parent;
    if (parentId && presentIds.has(parentId) && parentId !== item.issue.id) {
      const list = childrenMap.get(parentId) ?? [];
      list.push(item);
      childrenMap.set(parentId, list);
    } else {
      roots.push(item);
    }
  }

  roots.sort(compareScheduledEntries);
  for (const list of childrenMap.values()) list.sort(compareScheduledEntries);

  const ordered: (T & { depth: number; isParent: boolean; childCount: number })[] = [];
  const emitted = new Set<string>();

  const emit = (item: T, depth: number) => {
    if (emitted.has(item.issue.id)) return;
    emitted.add(item.issue.id);
    const children = childrenMap.get(item.issue.id) ?? [];
    const totalChildren = Math.max(children.length, childCountOf(item.issue.id));
    ordered.push({ ...item, depth, isParent: totalChildren > 0, childCount: totalChildren });
    for (const child of children) emit(child, Math.min(depth + 1, 3));
  };

  for (const root of roots) emit(root, 0);
  // Safety net for any disconnected parent-cycle fragment.
  for (const item of items) {
    if (!emitted.has(item.issue.id)) emit(item, 0);
  }
  return ordered;
}

/** Pure schedule computation on raw `Issue[]`: returns hierarchically ordered scheduled entries and unscheduled issues. */
export function computeSchedule(
  issues: readonly Issue[],
  now = Date.now(),
): {
  readonly scheduled: ScheduledIssueEntry[];
  readonly unscheduled: Issue[];
  readonly todayDayMs: number;
} {
  const todayDayMs = utcDayStart(now);
  const spans = computeIssueSpans(issues, now);
  const childCounts = new Map<string, number>();
  for (const issue of issues) {
    if (issue.parent) childCounts.set(issue.parent, (childCounts.get(issue.parent) ?? 0) + 1);
  }

  const withSpan: { issue: Issue; span: ScheduledSpan }[] = [];
  const unscheduled: Issue[] = [];
  for (const issue of issues) {
    const span = spans.get(issue.id);
    if (span) withSpan.push({ issue, span });
    else unscheduled.push(issue);
  }

  const scheduled = orderHierarchically(withSpan, (id) => childCounts.get(id) ?? 0);
  unscheduled.sort((a, b) => {
    const pa = priorityWeight[a.priority];
    const pb = priorityWeight[b.priority];
    if (pa !== pb) return pa - pb;
    return a.number - b.number;
  });

  return { scheduled, unscheduled, todayDayMs };
}

/** Builds timeline rows, axis ticks, month bands, and unscheduled cards for `IssueTimeline`. */
export function buildScheduleForCards(cards: readonly BoardCard[], allIssues: readonly Issue[], scale: TimelineScale, now = Date.now()): TimelineGrid {
  const todayDayMs = utcDayStart(now);
  const spec = timelineScaleSpec[scale];

  // Combine all known issues plus any card issues not already in `allIssues` so rollup always has full context.
  const mergedIssuesMap = new Map<string, Issue>();
  for (const issue of allIssues) mergedIssuesMap.set(issue.id, issue);
  for (const card of cards) mergedIssuesMap.set(card.issue.id, card.issue);
  const mergedIssues = [...mergedIssuesMap.values()];

  const spans = computeIssueSpans(mergedIssues, now);
  const childCounts = new Map<string, number>();
  for (const issue of mergedIssues) {
    if (issue.parent) childCounts.set(issue.parent, (childCounts.get(issue.parent) ?? 0) + 1);
  }

  const withSpan: { card: BoardCard; issue: Issue; span: ScheduledSpan }[] = [];
  const unscheduled: BoardCard[] = [];
  for (const card of cards) {
    const span = spans.get(card.issue.id);
    if (span) withSpan.push({ card, issue: card.issue, span });
    else unscheduled.push(card);
  }

  const rows = orderHierarchically(withSpan, (id) => childCounts.get(id) ?? 0);
  unscheduled.sort((a, b) => {
    const pa = priorityWeight[a.issue.priority];
    const pb = priorityWeight[b.issue.priority];
    if (pa !== pb) return pa - pb;
    return a.issue.number - b.issue.number;
  });

  let minDay = todayDayMs;
  let maxDay = todayDayMs;
  for (const row of rows) {
    if (row.span.startMs < minDay) minDay = row.span.startMs;
    if (row.span.endMs > maxDay) maxDay = row.span.endMs;
  }

  let rangeStartMs = addUtcDays(minDay, -spec.padBeforeDays);
  // Align start to Monday on quarter/month scales for crisp week dividers.
  if (scale !== "week") rangeStartMs = addUtcDays(rangeStartMs, -monSunDayIndex(rangeStartMs));

  let rangeEndMs = addUtcDays(maxDay, spec.padAfterDays);
  const rawSpanDays = utcDayDiff(rangeStartMs, rangeEndMs) + 1;
  if (rawSpanDays < spec.minDays) {
    rangeEndMs = addUtcDays(rangeStartMs, spec.minDays - 1);
  }

  const totalDays = Math.max(1, utcDayDiff(rangeStartMs, rangeEndMs) + 1);
  const ticks: TimelineTick[] = [];
  const months: TimelineMonthBand[] = [];

  for (let i = 0; i < totalDays; i++) {
    const dayMs = addUtcDays(rangeStartMs, i);
    const d = new Date(dayMs);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const dayOfMonth = d.getUTCDate();
    const weekdayIndex = monSunDayIndex(dayMs);
    ticks.push({
      dayMs,
      dateKey: formatIsoDate(dayMs),
      dayOfMonth,
      weekdayIndex,
      isMonday: weekdayIndex === 0,
      isWeekend: weekdayIndex >= 5,
      isToday: dayMs === todayDayMs,
      isFirstOfMonth: dayOfMonth === 1,
    });
    const lastBand = months.at(-1);
    if (lastBand && lastBand.year === year && lastBand.month === month) {
      months[months.length - 1] = { ...lastBand, spanDays: lastBand.spanDays + 1 };
    } else {
      months.push({ key: `${year}-${month}`, year, month, startIndex: i, spanDays: 1 });
    }
  }

  return {
    rows,
    unscheduled,
    rangeStartMs,
    rangeEndMs,
    totalDays,
    todayDayMs,
    ticks,
    months,
  };
}

/**
 * Builds a Mon–Sun calendar month grid (`weeks` of 7 `MonthCell`s) for a 1-based `month` (`1..12`).
 */
export function buildMonthGrid(year: number, month: number, now = Date.now()): MonthGrid {
  const normalized = new Date(Date.UTC(year, month - 1, 1));
  const targetYear = normalized.getUTCFullYear();
  const targetMonth = normalized.getUTCMonth() + 1;
  const firstDayMs = normalized.getTime();
  const daysInMonth = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  const leading = monSunDayIndex(firstDayMs);
  const totalCells = Math.ceil((leading + daysInMonth) / 7) * 7;
  const gridStartMs = addUtcDays(firstDayMs, -leading);
  const gridEndMs = addUtcDays(gridStartMs, totalCells - 1);
  const todayDayMs = utcDayStart(now);

  const cells: MonthCell[] = [];
  for (let i = 0; i < totalCells; i++) {
    const dayMs = addUtcDays(gridStartMs, i);
    const d = new Date(dayMs);
    const cellYear = d.getUTCFullYear();
    const cellMonth = d.getUTCMonth() + 1;
    const cellDay = d.getUTCDate();
    const weekdayIndex = monSunDayIndex(dayMs);
    cells.push({
      dayMs,
      dateKey: formatIsoDate(dayMs),
      year: cellYear,
      month: cellMonth,
      day: cellDay,
      weekdayIndex,
      inMonth: cellYear === targetYear && cellMonth === targetMonth,
      isToday: dayMs === todayDayMs,
      isWeekend: weekdayIndex >= 5,
    });
  }

  const weeks: MonthCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7));
  }

  return {
    year: targetYear,
    month: targetMonth,
    startMs: gridStartMs,
    endMs: gridEndMs,
    todayDayMs,
    cells,
    weeks,
  };
}

/** Maps each `dateKey` (`YYYY-MM-DD`) in `grid` to the scheduled rows active on that day. */
export function groupScheduledByDay(grid: MonthGrid, rows: readonly ScheduledCardRow[]): Map<string, ScheduledCardRow[]> {
  const byDay = new Map<string, ScheduledCardRow[]>();
  for (const cell of grid.cells) byDay.set(cell.dateKey, []);

  for (const row of rows) {
    if (row.span.endMs < grid.startMs || row.span.startMs > grid.endMs) continue;
    const clampedStart = Math.max(row.span.startMs, grid.startMs);
    const clampedEnd = Math.min(row.span.endMs, grid.endMs);
    for (let dayMs = clampedStart; dayMs <= clampedEnd; dayMs = addUtcDays(dayMs, 1)) {
      const key = formatIsoDate(dayMs);
      const list = byDay.get(key);
      if (list) list.push(row);
    }
  }

  return byDay;
}

/** Computes shifted `startAt` / `dueAt` timestamps (`deltaDays` days) for quick timeline adjustments. */
export function shiftIssueDates(
  issue: Pick<Issue, "startAt" | "dueAt">,
  deltaDays: number,
  fallbackSpan?: { readonly startMs: number; readonly endMs: number },
): { startAt?: number; dueAt?: number } {
  const hasStart = isPositiveTimestamp(issue.startAt);
  const hasDue = isPositiveTimestamp(issue.dueAt);
  if (!hasStart && !hasDue && fallbackSpan) {
    return {
      startAt: addUtcDays(utcDayStart(fallbackSpan.startMs), deltaDays),
      dueAt: addUtcDays(utcDayStart(fallbackSpan.endMs), deltaDays),
    };
  }
  return omitUndefined({
    startAt: hasStart ? addUtcDays(utcDayStart(issue.startAt!), deltaDays) : undefined,
    dueAt: hasDue ? addUtcDays(utcDayStart(issue.dueAt!), deltaDays) : undefined,
  });
}

export type TimelineDragMode = "move" | "resize-start" | "resize-end";

export interface TimelineDragResult {
  readonly startMs: number;
  readonly endMs: number;
  readonly durationDays: number;
  readonly dates: { startAt?: number; dueAt?: number };
}

/** Computes snapped `[startMs, endMs]` and API date patch for bar drag (`move`) or edge resize (`resize-start` / `resize-end`), clamping `startAt <= dueAt`. */
export function computeTimelineDrag(
  issue: Pick<Issue, "startAt" | "dueAt">,
  span: Pick<ScheduledSpan, "startMs" | "endMs">,
  mode: TimelineDragMode,
  deltaDays: number,
): TimelineDragResult {
  const baseStart = utcDayStart(span.startMs);
  const baseEnd = utcDayStart(span.endMs);
  switch (mode) {
    case "move": {
      const startMs = addUtcDays(baseStart, deltaDays);
      const endMs = addUtcDays(baseEnd, deltaDays);
      return {
        startMs,
        endMs,
        durationDays: Math.max(1, utcDayDiff(startMs, endMs) + 1),
        dates: shiftIssueDates(issue, deltaDays, { startMs: baseStart, endMs: baseEnd }),
      };
    }
    case "resize-start": {
      const startMs = Math.min(baseEnd, addUtcDays(baseStart, deltaDays));
      const endMs = baseEnd;
      return {
        startMs,
        endMs,
        durationDays: Math.max(1, utcDayDiff(startMs, endMs) + 1),
        dates: omitUndefined({
          startAt: startMs,
          dueAt: isPositiveTimestamp(issue.dueAt) ? utcDayStart(issue.dueAt) : baseEnd !== startMs ? baseEnd : undefined,
        }),
      };
    }
    case "resize-end": {
      const startMs = baseStart;
      const endMs = Math.max(baseStart, addUtcDays(baseEnd, deltaDays));
      return {
        startMs,
        endMs,
        durationDays: Math.max(1, utcDayDiff(startMs, endMs) + 1),
        dates: omitUndefined({
          startAt: isPositiveTimestamp(issue.startAt) ? utcDayStart(issue.startAt) : endMs !== baseStart ? baseStart : undefined,
          dueAt: endMs,
        }),
      };
    }
  }
}
