import type { Issue } from "@vibevalley/protocol";

import { type BoardCard, closedShown, type Lane, lanes } from "./cards";
import { type BoardLook, groupCards, groupRows, laneOrder, orderRows, rowKeys } from "./display";
import { buildScheduleForCards } from "./schedule";

const isClosedLane = (lane: Lane) => lane === "done" || lane === "canceled";

function visibleLaneCards(lane: Lane, cards: readonly BoardCard[], ordering: BoardLook["ordering"], older: boolean): BoardCard[] {
  const ordered = laneOrder(lane, [...cards], ordering);
  return isClosedLane(lane) && !older && ordered.length > closedShown ? ordered.slice(0, closedShown) : ordered;
}

/** Visible issue ids in display order, composing with Group By, Hierarchy, View, Ordering, and closed-lane folding. */
export function orderedVisibleCardIds(cards: readonly BoardCard[], look: BoardLook, allIssues: readonly Issue[], older: boolean, nowMs = Date.now()): string[] {
  if (cards.length === 0) return [];
  const groupBy = look.groupBy ?? "none";

  switch (look.view) {
    case "board": {
      if (groupBy === "none") {
        const byLane: Record<Lane, BoardCard[]> = { backlog: [], todo: [], in_progress: [], in_review: [], done: [], canceled: [] };
        for (const c of cards) byLane[c.lane].push(c);
        return lanes.flatMap((l) => visibleLaneCards(l, byLane[l], look.ordering, older).map((c) => c.id));
      }
      return groupCards(cards, groupBy, allIssues).flatMap((g) => {
        const byLane: Record<Lane, BoardCard[]> = { backlog: [], todo: [], in_progress: [], in_review: [], done: [], canceled: [] };
        for (const c of g.cards) byLane[c.lane].push(c);
        return lanes.flatMap((l) => visibleLaneCards(l, byLane[l], look.ordering, older).map((c) => c.id));
      });
    }
    case "list": {
      if (groupBy !== "none") {
        return groupCards(cards, groupBy, allIssues).flatMap((g) => orderRows(g.cards, look.ordering, rowKeys).map((c) => c.id));
      }
      return groupRows([...cards], look.grouping, rowKeys).flatMap((g) => {
        if (g.lane) return visibleLaneCards(g.lane, g.rows, look.ordering, older).map((c) => c.id);
        return orderRows(g.rows, look.ordering, rowKeys).map((c) => c.id);
      });
    }
    case "timeline": {
      const timeline = buildScheduleForCards(cards, allIssues, "month", nowMs);
      return [...timeline.rows.map((r) => r.card.id), ...timeline.unscheduled.map((c) => c.id)];
    }
    case "calendar":
      return cards.map((c) => c.id);
  }
}

/** Moves focus by +1 / -1 through `orderedIds`, starting from first (for +1) or last (for -1) when unfocused. */
export function stepFocusId(orderedIds: readonly string[], current: string | undefined, delta: 1 | -1): string | undefined {
  if (orderedIds.length === 0) return undefined;
  if (current === undefined) return delta === 1 ? orderedIds[0] : orderedIds.at(-1);
  const idx = orderedIds.indexOf(current);
  if (idx === -1) return delta === 1 ? orderedIds[0] : orderedIds.at(-1);
  const next = Math.max(0, Math.min(orderedIds.length - 1, idx + delta));
  return orderedIds[next];
}

/** Toggles `id` inside a multi-selection set. */
export function toggleSelection(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Selects the inclusive range from `anchor` to `target` in `orderedIds`, merging into `selected`. */
export function selectRange(selected: ReadonlySet<string>, orderedIds: readonly string[], anchor: string | undefined, target: string): Set<string> {
  const next = new Set(selected);
  const targetIdx = orderedIds.indexOf(target);
  const anchorIdx = anchor !== undefined ? orderedIds.indexOf(anchor) : -1;
  if (targetIdx === -1) {
    next.add(target);
    return next;
  }
  if (anchorIdx === -1) {
    next.add(target);
    return next;
  }
  const start = Math.min(anchorIdx, targetIdx);
  const end = Math.max(anchorIdx, targetIdx);
  for (let i = start; i <= end; i++) {
    const id = orderedIds[i];
    if (id !== undefined) next.add(id);
  }
  return next;
}
