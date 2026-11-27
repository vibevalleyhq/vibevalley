import { cleanup, signal, untracked, type ViewRef } from "nsh";

import type { BoardSummary, Issue } from "@vibevalley/protocol";

import { type BoardCard, cardMove, type Lane } from "../../model/cards";
import type { BoardDensity, GroupBy, HierarchyMode, IssueFieldVisibility, Ordering } from "../../model/display";

export const isClosedLane = (lane: Lane) => lane === "done" || lane === "canceled";
export const isOrderLane = (lane: Lane) => lane === "backlog" || lane === "todo";

export interface BoardProps {
  cards: BoardCard[];
  allIssues?: readonly Issue[] | undefined;
  summary?: BoardSummary | undefined;
  filtered?: boolean | undefined;
  loading: boolean;
  selected?: string | undefined;
  older: boolean;
  ordering: Ordering;
  groupBy?: GroupBy | undefined;
  hierarchy?: HierarchyMode | undefined;
  density?: BoardDensity | undefined;
  fields?: IssueFieldVisibility | undefined;
  onOlder: () => void;
  onOpen: (id: string) => void;
  onDrop: (card: BoardCard, to: Lane, before?: string) => void;
  /** A card whose move failed: sent again with the same key, or put back in the lane the frame gives it. */
  onRetry: (card: BoardCard) => void;
  onPutBack: (card: BoardCard) => void;
  onPlace: (card: BoardCard, before: string | undefined) => void;
  /** The todo lane's placeholder card. */
  onNew: () => void;
  onClearFilter?: (() => void) | undefined;
}

type DragPoint = { readonly x: number; readonly y: number };
type DragRect = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
export type DragGhost = {
  readonly number?: string | undefined;
  readonly title: string;
  readonly dx: number;
  readonly dy: number;
  readonly w: number;
  readonly h: number;
  readonly origin: DragPoint;
};
type DragLaneRect = readonly [Lane, DragRect] | readonly [Lane, DragRect, string];
type DragCardRect = readonly [string, DragRect] | readonly [string, DragRect, Lane] | readonly [string, DragRect, Lane, string];
export type DragTargets = {
  readonly laneRects: readonly DragLaneRect[];
  readonly cardRects: readonly DragCardRect[];
  readonly boardRect?: DragRect | undefined;
  readonly grouped?: boolean | undefined;
  readonly ordering?: Ordering | undefined;
};

export type DragState =
  | { readonly phase: "idle"; readonly epoch: number }
  | {
      readonly phase: "measuring";
      readonly epoch: number;
      readonly card: BoardCard;
      readonly number?: string | undefined;
      readonly title: string;
      readonly at: DragPoint;
      readonly pendingDrop?: boolean | undefined;
    }
  | {
      readonly phase: "dragging";
      readonly epoch: number;
      readonly card: BoardCard;
      readonly at: DragPoint;
      readonly over: Lane | undefined;
      readonly overKey?: string | undefined;
      readonly before: string | undefined;
      readonly ghost: DragGhost;
      readonly targets: DragTargets;
    };

type DragEvent =
  | { readonly kind: "start"; readonly card: BoardCard; readonly number?: string | undefined; readonly title: string; readonly at: DragPoint }
  | {
      readonly kind: "measured";
      readonly epoch: number;
      readonly ghost: DragGhost;
      readonly targets: DragTargets;
      readonly isPlaceable: (id: string) => boolean;
    }
  | { readonly kind: "move"; readonly at: DragPoint; readonly isPlaceable: (id: string) => boolean }
  | { readonly kind: "release"; readonly at?: DragPoint | undefined; readonly isPlaceable: (id: string) => boolean }
  | { readonly kind: "end" };

type DragDropOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "place"; readonly card: BoardCard; readonly before: string | undefined }
  | { readonly kind: "drop"; readonly card: BoardCard; readonly lane: Lane; readonly before?: string };

export const BOARD_PAD_X = 12;
export const BOARD_LANE_GAP = 10;
const inside = (r: DragRect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
const LANE_GAP_TOLERANCE = Math.ceil(BOARD_LANE_GAP / 2) + 2;

/** Whether dragging `card` into `lane` supports explicit slot placement (midline hit-testing and rank persistence). */
const canManualOrder = (card: BoardCard, lane: Lane, ordering: Ordering | undefined) =>
  (ordering ?? "manual") === "manual" && card.kind === "todo" && !isClosedLane(lane);

/** Whether a lane takes the card: a move the rules allow, or a manually-ordered open lane for reordering. */
const accepts = (c: BoardCard | undefined, lane: Lane, ordering?: Ordering) =>
  c !== undefined && (cardMove(c, lane) !== undefined || (c.lane === lane && canManualOrder(c, lane, ordering)));

function cardRectInTargetLane(entry: DragCardRect, lane: Lane, laneKey: string, laneRect: DragRect): boolean {
  if (entry.length === 4) return entry[3] === laneKey;
  if (entry.length === 3) return entry[2] === lane;
  const cx = entry[1].x + entry[1].w / 2;
  return cx >= laneRect.x && cx <= laneRect.x + laneRect.w;
}

function hitTestDrag(
  card: BoardCard,
  at: DragPoint,
  targets: DragTargets,
  isPlaceable: (id: string) => boolean,
): { readonly over: Lane | undefined; readonly overKey: string | undefined; readonly before: string | undefined } {
  let hit = targets.laneRects.find(([, r]) => inside(r, at.x, at.y));
  if (hit === undefined && targets.laneRects.length > 0) {
    const boardBottom = targets.boardRect ? targets.boardRect.y + targets.boardRect.h : targets.laneRects.reduce((max, [, r]) => Math.max(max, r.y + r.h), 0);
    const candidates = targets.laneRects.filter(([, r]) => {
      const maxY = targets.grouped === true ? r.y + r.h : Math.max(r.y + r.h, boardBottom);
      return at.x >= r.x - LANE_GAP_TOLERANCE && at.x <= r.x + r.w + LANE_GAP_TOLERANCE && at.y >= r.y && at.y <= maxY;
    });
    let bestDist = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      const dist = Math.abs(at.x - (candidate[1].x + candidate[1].w / 2));
      if (dist < bestDist) {
        bestDist = dist;
        hit = candidate;
      }
    }
  }
  const over = hit !== undefined && accepts(card, hit[0], targets.ordering) ? hit[0] : undefined;
  const overKey = over !== undefined ? (hit?.[2] ?? over) : undefined;
  let before: string | undefined;
  if (over !== undefined && hit !== undefined && overKey !== undefined && canManualOrder(card, over, targets.ordering)) {
    const laneCards = targets.cardRects
      .filter((entry) => entry[0] !== card.id && isPlaceable(entry[0]) && cardRectInTargetLane(entry, over, overKey, hit[1]))
      .toSorted((a, b) => a[1].y - b[1].y);
    const next = laneCards.find(([, r]) => at.y < r.y + r.h / 2);
    before = next ? next[0] : "";
  }
  return { over, overKey, before };
}

export function initialDragState(): DragState {
  return { phase: "idle", epoch: 0 };
}

export function dragTransition(state: DragState, event: DragEvent): DragState {
  switch (state.phase) {
    case "idle":
      switch (event.kind) {
        case "start":
          return {
            phase: "measuring",
            epoch: state.epoch + 1,
            card: event.card,
            ...(event.number !== undefined ? { number: event.number } : {}),
            title: event.title,
            at: event.at,
          };
        case "measured":
        case "move":
        case "release":
        case "end":
          return state;
      }
      break;

    case "measuring":
      switch (event.kind) {
        case "start":
          return {
            phase: "measuring",
            epoch: state.epoch + 1,
            card: event.card,
            ...(event.number !== undefined ? { number: event.number } : {}),
            title: event.title,
            at: event.at,
          };
        case "measured": {
          if (event.epoch !== state.epoch) return state;
          const hit = hitTestDrag(state.card, state.at, event.targets, event.isPlaceable);
          return {
            phase: "dragging",
            epoch: state.epoch,
            card: state.card,
            at: state.at,
            over: hit.over,
            ...(hit.overKey !== undefined ? { overKey: hit.overKey } : {}),
            before: hit.before,
            ghost: event.ghost,
            targets: event.targets,
          };
        }
        case "move":
          return { ...state, at: event.at };
        case "release":
          return { ...state, at: event.at ?? state.at, pendingDrop: true };
        case "end":
          return { phase: "idle", epoch: state.epoch + 1 };
      }
      break;

    case "dragging":
      switch (event.kind) {
        case "start":
          return {
            phase: "measuring",
            epoch: state.epoch + 1,
            card: event.card,
            ...(event.number !== undefined ? { number: event.number } : {}),
            title: event.title,
            at: event.at,
          };
        case "measured":
          return state;
        case "move": {
          const hit = hitTestDrag(state.card, event.at, state.targets, event.isPlaceable);
          return {
            ...state,
            at: event.at,
            over: hit.over,
            ...(hit.overKey !== undefined ? { overKey: hit.overKey } : { overKey: undefined }),
            before: hit.before,
          };
        }
        case "release": {
          if (event.at === undefined) return state;
          const hit = hitTestDrag(state.card, event.at, state.targets, event.isPlaceable);
          return {
            ...state,
            at: event.at,
            over: hit.over,
            ...(hit.overKey !== undefined ? { overKey: hit.overKey } : { overKey: undefined }),
            before: hit.before,
          };
        }
        case "end":
          return { phase: "idle", epoch: state.epoch + 1 };
      }
  }
}

export function dragDropOutcome(state: DragState, dropped: boolean): DragDropOutcome {
  if (!dropped) return { kind: "none" };
  switch (state.phase) {
    case "idle":
    case "measuring":
      return { kind: "none" };
    case "dragging":
      if (state.over === undefined) return { kind: "none" };
      if (state.over === state.card.lane) {
        if (state.before === undefined) return { kind: "none" };
        return { kind: "place", card: state.card, before: state.before === "" ? undefined : state.before };
      }
      return {
        kind: "drop",
        card: state.card,
        lane: state.over,
        ...(state.before !== undefined ? { before: state.before } : {}),
      };
  }
}

const BOARD_LANE_MIN = 220;
const BOARD_LANE_FIT_ALL_MIN = 224;
const BOARD_LANE_MAX = 300;

/** Size lanes so all 6 fit cleanly on wide windows (e.g. 1680px) and an integer count of lanes fit cleanly per screen (e.g. 5 at 1280px) without awkward partial clipping. */
export function boardLaneWidth(availableWidth: number, laneCount = 6): number {
  if (availableWidth <= 0 || laneCount <= 1) return 255;
  if (availableWidth >= laneCount * BOARD_LANE_FIT_ALL_MIN + (laneCount - 1) * BOARD_LANE_GAP) {
    return Math.min(BOARD_LANE_MAX, Math.floor((availableWidth - (laneCount - 1) * BOARD_LANE_GAP) / laneCount));
  }
  for (let cols = laneCount - 1; cols >= 2; cols--) {
    const candidate = Math.floor((availableWidth - (cols - 1) * BOARD_LANE_GAP) / cols);
    if (candidate >= BOARD_LANE_MIN) return Math.min(BOARD_LANE_MAX, candidate);
  }
  return BOARD_LANE_MIN;
}

/** A card being dragged: explicit idle/measuring/dragging FSM with epoch cancellation for stale measure() callbacks. */
export function createDrag(board: () => BoardProps) {
  const state = signal<DragState>(initialDragState());
  const laneRefs = new Map<string, { lane: Lane; ref: ViewRef }>();
  const cardRefs = new Map<string, { lane: () => Lane; laneKey: () => string; ref: ViewRef; placeable: () => boolean }>();
  let root: ViewRef | undefined;
  const isPlaceable = (id: string) => cardRefs.get(id)?.placeable() === true;
  const dispatch = (event: DragEvent): DragState => {
    const next = dragTransition(untracked(state), event);
    state.set(next);
    return next;
  };
  const commitOutcome = (outcome: DragDropOutcome) => {
    switch (outcome.kind) {
      case "none":
        return;
      case "place":
        board().onPlace(outcome.card, outcome.before);
        return;
      case "drop":
        board().onDrop(outcome.card, outcome.lane, outcome.before);
        return;
    }
  };
  cleanup(() => dispatch({ kind: "end" }));
  const rectOf = async (ref: ViewRef): Promise<DragRect | undefined> => {
    const m = await ref.measure();
    return m ? { x: m.pagePosition.x, y: m.pagePosition.y, w: m.bounds.size.width, h: m.bounds.size.height } : undefined;
  };
  const dragging = () => {
    const s = state();
    switch (s.phase) {
      case "idle":
        return undefined;
      case "measuring":
      case "dragging":
        return s.card;
    }
  };
  const over = () => {
    const s = state();
    switch (s.phase) {
      case "idle":
      case "measuring":
        return undefined;
      case "dragging":
        return s.over;
    }
  };
  const overKey = () => {
    const s = state();
    switch (s.phase) {
      case "idle":
      case "measuring":
        return undefined;
      case "dragging":
        return s.overKey;
    }
  };
  const before = () => {
    const s = state();
    switch (s.phase) {
      case "idle":
      case "measuring":
        return undefined;
      case "dragging":
        return s.before;
    }
  };
  const ghost = () => {
    const s = state();
    switch (s.phase) {
      case "idle":
      case "measuring":
        return undefined;
      case "dragging":
        return { ...s.ghost, card: s.card, at: s.at };
    }
  };
  return {
    dragging,
    over,
    overKey,
    before,
    ghost,
    setRoot: (r: ViewRef) => (root = r),
    lane: (key: string, lane: Lane, ref: ViewRef) => {
      laneRefs.set(key, { lane, ref });
      cleanup(() => laneRefs.get(key)?.ref === ref && laneRefs.delete(key));
    },
    card: (id: string, lane: () => Lane, laneKey: () => string, ref: ViewRef, placeable: () => boolean) => {
      cardRefs.set(id, { lane, laneKey, ref, placeable });
      cleanup(() => cardRefs.get(id)?.ref === ref && cardRefs.delete(id));
    },
    async start(card: BoardCard, number: string | undefined, title: string, x0: number, y0: number) {
      const started = dispatch({ kind: "start", card, ...(number !== undefined ? { number } : {}), title, at: { x: x0, y: y0 } });
      const epoch = started.epoch;
      const otherCards = [...cardRefs.entries()].filter(([id]) => id !== card.id);
      const [lanesNow, cardsNow, rootRect, own] = await Promise.all([
        Promise.all([...laneRefs.entries()].map(async ([key, { lane, ref }]) => [lane, await rectOf(ref), key] as const)),
        Promise.all(otherCards.map(async ([id, c]) => [id, await rectOf(c.ref), c.lane(), c.laneKey()] as const)),
        root ? rectOf(root) : undefined,
        cardRefs.get(card.id) ? rectOf(cardRefs.get(card.id)!.ref) : undefined,
      ]);
      const cur = untracked(state);
      if (cur.epoch !== epoch) return;
      const shouldCommit = cur.phase === "measuring" && cur.pendingDrop === true;
      dispatch({
        kind: "measured",
        epoch,
        ghost: {
          ...(number !== undefined ? { number } : {}),
          title,
          dx: own ? x0 - own.x : 12,
          dy: own ? y0 - own.y : 12,
          w: own?.w ?? 220,
          h: own?.h ?? 88,
          origin: rootRect ?? { x: 0, y: 0 },
        },
        targets: {
          laneRects: lanesNow.flatMap(([l, r, key]) => (r ? [[l, r, key] as const] : [])),
          cardRects: cardsNow.flatMap(([id, r, l, key]) => (r ? [[id, r, l, key] as const] : [])),
          ...(rootRect ? { boardRect: rootRect } : {}),
          grouped: (board().groupBy ?? "none") !== "none",
          ordering: board().ordering,
        },
        isPlaceable,
      });
      if (shouldCommit) {
        const outcome = dragDropOutcome(untracked(state), true);
        dispatch({ kind: "end" });
        commitOutcome(outcome);
      }
    },
    move: (x: number, y: number) => {
      dispatch({ kind: "move", at: { x, y }, isPlaceable });
    },
    end(dropped: boolean, at?: DragPoint) {
      if (!dropped) {
        dispatch({ kind: "end" });
        return;
      }
      const cur = untracked(state);
      if (cur.phase === "measuring") {
        dispatch({ kind: "release", at, isPlaceable });
        return;
      }
      if (cur.phase === "dragging") {
        if (at !== undefined) dispatch({ kind: "release", at, isPlaceable });
        const outcome = dragDropOutcome(untracked(state), true);
        dispatch({ kind: "end" });
        commitOutcome(outcome);
      }
    },
  };
}

export type Drag = ReturnType<typeof createDrag>;
