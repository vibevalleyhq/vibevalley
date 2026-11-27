import type { BoardSchedule, BoardSummary, Issue, IssueScheduleSpan } from "@vibevalley/protocol";
import { omitUndefined } from "@vibevalley/protocol/rules";
import { BoardSchedule as BoardScheduleSchema, jsonString } from "@vibevalley/protocol/schema";

import { coreBridge } from "../../../infra/rich";
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

export type ScheduledSpan = IssueScheduleSpan;

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

function projectScheduleViaNative(issues: readonly Issue[], now: number): BoardSchedule | undefined {
  const json = coreBridge()?.computeSchedule?.(JSON.stringify(issues), now);
  if (!json) return undefined;
  const parsed = jsonString(BoardScheduleSchema).safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

/** Builds timeline rows from Rust-projected `BoardSummary.schedule` (or `VvCore`) plus pure UTC axis ticks and month bands. */
export function buildScheduleForCards(
  cards: readonly BoardCard[],
  allIssues: readonly Issue[],
  scale: TimelineScale,
  now = Date.now(),
  summary?: BoardSummary,
): TimelineGrid {
  const todayDayMs = utcDayStart(now);
  const spec = timelineScaleSpec[scale];

  let boardSchedule = summary?.schedule;
  if (!boardSchedule) {
    const mergedIssuesMap = new Map<string, Issue>();
    for (const issue of allIssues) mergedIssuesMap.set(issue.id, issue);
    for (const card of cards) mergedIssuesMap.set(card.issue.id, card.issue);
    boardSchedule = projectScheduleViaNative([...mergedIssuesMap.values()], now);
  }

  const cardById = new Map(cards.map((c) => [c.issue.id, c]));
  const rows: ScheduledCardRow[] = [];
  const unscheduled: BoardCard[] = [];
  const seen = new Set<string>();

  if (boardSchedule) {
    for (const entry of boardSchedule.scheduled) {
      const card = cardById.get(entry.issueId);
      if (!card) continue;
      seen.add(card.issue.id);
      let span = entry.span;
      // Preserve optimistic local date edits (e.g. Gantt drag / schedule-today) before the server pushes the updated BoardSlice.
      if (!span.rolledUp) {
        const startRaw = isPositiveTimestamp(card.issue.startAt) ? utcDayStart(card.issue.startAt) : undefined;
        const dueRaw = isPositiveTimestamp(card.issue.dueAt) ? utcDayStart(card.issue.dueAt) : undefined;
        const nextStart = startRaw ?? dueRaw;
        const nextEnd = dueRaw ?? startRaw;
        if (nextStart !== undefined && nextEnd !== undefined) {
          const clampedEnd = Math.max(nextStart, nextEnd);
          if (clampedEnd !== span.endMs || nextStart !== span.startMs) {
            span = {
              ...span,
              startMs: nextStart,
              endMs: clampedEnd,
              durationDays: utcDayDiff(nextStart, clampedEnd) + 1,
              hasExplicitStart: startRaw !== undefined,
              hasExplicitDue: dueRaw !== undefined,
            };
          }
        }
      }
      rows.push({
        card,
        issue: card.issue,
        span,
        depth: entry.depth,
        isParent: entry.isParent,
        childCount: entry.childCount,
      });
    }
    for (const id of boardSchedule.unscheduledIds) {
      const card = cardById.get(id);
      if (!card) continue;
      seen.add(id);
      const startRaw = isPositiveTimestamp(card.issue.startAt) ? utcDayStart(card.issue.startAt) : undefined;
      const dueRaw = isPositiveTimestamp(card.issue.dueAt) ? utcDayStart(card.issue.dueAt) : undefined;
      const nextStart = startRaw ?? dueRaw;
      const nextEnd = dueRaw ?? startRaw;
      if (nextStart !== undefined && nextEnd !== undefined) {
        const clampedEnd = Math.max(nextStart, nextEnd);
        const closed = card.issue.status === "done" || card.issue.status === "canceled";
        rows.push({
          card,
          issue: card.issue,
          span: {
            startMs: nextStart,
            endMs: clampedEnd,
            durationDays: utcDayDiff(nextStart, clampedEnd) + 1,
            hasExplicitStart: startRaw !== undefined,
            hasExplicitDue: dueRaw !== undefined,
            rolledUp: false,
            overdue: !closed && clampedEnd < todayDayMs,
          },
          depth: 0,
          isParent: false,
          childCount: 0,
        });
      } else {
        unscheduled.push(card);
      }
    }
  }
  for (const card of cards) {
    if (!seen.has(card.issue.id)) unscheduled.push(card);
  }

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
