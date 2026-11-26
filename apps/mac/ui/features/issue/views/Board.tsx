import { cleanup, computed, Image, PanResponder, Scroll, signal, Text, untracked, View, windowSize, type JSX, type ViewRef } from "nsh";

import { t } from "@vibevalley/i18n";
import type { BoardSummary, Issue } from "@vibevalley/protocol";

import { Button } from "../../../design/Button";
import { Icon } from "../../../design/Icon";
import { IconButton } from "../../../design/IconButton";
import type { IconName } from "../../../design/icons";
import { motionClass, motionDuration, motionOff } from "../../../design/motion";
import { Bubble } from "../../../design/Tip";
import { mix, tone } from "../../../design/tone";
import { fileUrl, useAttachmentFile } from "../../../infra/attachmentFile";
import {
  type BoardCard,
  cardAgent,
  cardLook,
  cardMove,
  type CardPreview,
  cardPreviewOf,
  cardRepo,
  cardUrgencyTone,
  closedShown,
  type Lane,
  laneCountOf,
  laneLabel,
  lanes,
  laneStatus,
  ownStatus,
} from "../model/cards";
import { type GroupBy, groupCards, type HierarchyMode, laneOrder, type Ordering } from "../model/display";
import { useIssues, useNameOf } from "../model/history";
import { childIssuesOf } from "../model/meta";
import { CardChildRows, IssueGroupHeader, ParentBadge, TagPills, useGroupLabel } from "./IssueMetaControls";
import { CardFace, FlagChip, PriorityMark, ProgressMark, StatusMark } from "./Marks";

/** Under the closed ones: how many older are folded away, or back to the recent ones. */
export function OlderLink(props: { hidden: number; onClick: () => void }) {
  return (
    <View
      onPress={() => props.onClick()}
      role="button"
      class={`self-center rounded-md px-2.5 py-1 ${motionClass("transition-transform duration-120 ease-out")} hover:bg-hover active:translate-y-px`}
    >
      <Text class="text-xs font-medium text-water">{props.hidden > 0 ? t("web.issue.board.earlier", { n: props.hidden }) : t("web.issue.board.recent")}</Text>
    </View>
  );
}

export function EmptyNote(props: { children: string }) {
  return <Text class="px-3 text-xs text-faint">{props.children}</Text>;
}

const isClosedLane = (lane: Lane) => lane === "done" || lane === "canceled";
const isOrderLane = (lane: Lane) => lane === "backlog" || lane === "todo";

const emptyText: Record<Lane, string> = {
  backlog: t("web.issue.board.empty.backlog"),
  todo: t("web.issue.board.empty.todo"),
  in_progress: t("web.issue.board.empty.in_progress"),
  in_review: t("web.issue.board.empty.in_review"),
  done: t("web.issue.board.empty.done"),
  canceled: t("web.issue.board.empty.canceled"),
};

interface EmptyLaneGuide {
  readonly icon: IconName;
  readonly titleKey:
    | "web.issue.board.emptyGuide.backlogTitle"
    | "web.issue.board.emptyGuide.todoTitle"
    | "web.issue.board.emptyGuide.in_progressTitle"
    | "web.issue.board.emptyGuide.in_reviewTitle"
    | "web.issue.board.emptyGuide.doneTitle"
    | "web.issue.board.emptyGuide.canceledTitle";
  readonly bodyKey:
    | "web.issue.board.emptyGuide.backlogBody"
    | "web.issue.board.emptyGuide.todoBody"
    | "web.issue.board.emptyGuide.in_progressBody"
    | "web.issue.board.emptyGuide.in_reviewBody"
    | "web.issue.board.emptyGuide.doneBody"
    | "web.issue.board.emptyGuide.canceledBody";
}

const emptyLaneGuide: Record<Lane, EmptyLaneGuide> = {
  backlog: {
    icon: "inbox",
    titleKey: "web.issue.board.emptyGuide.backlogTitle",
    bodyKey: "web.issue.board.emptyGuide.backlogBody",
  },
  todo: {
    icon: "add",
    titleKey: "web.issue.board.emptyGuide.todoTitle",
    bodyKey: "web.issue.board.emptyGuide.todoBody",
  },
  in_progress: {
    icon: "play",
    titleKey: "web.issue.board.emptyGuide.in_progressTitle",
    bodyKey: "web.issue.board.emptyGuide.in_progressBody",
  },
  in_review: {
    icon: "diff",
    titleKey: "web.issue.board.emptyGuide.in_reviewTitle",
    bodyKey: "web.issue.board.emptyGuide.in_reviewBody",
  },
  done: {
    icon: "check",
    titleKey: "web.issue.board.emptyGuide.doneTitle",
    bodyKey: "web.issue.board.emptyGuide.doneBody",
  },
  canceled: {
    icon: "close",
    titleKey: "web.issue.board.emptyGuide.canceledTitle",
    bodyKey: "web.issue.board.emptyGuide.canceledBody",
  },
};

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
  onOlder: () => void;
  onOpen: (id: string) => void;
  onDrop: (card: BoardCard, to: Lane) => void;
  /** A card whose move failed: sent again with the same key, or put back in the lane the frame gives it. */
  onRetry: (card: BoardCard) => void;
  onPutBack: (card: BoardCard) => void;
  onPlace: (card: BoardCard, before: string | undefined) => void;
  /** The todo lane's placeholder card. */
  onNew: () => void;
  onClearFilter?: (() => void) | undefined;
}

export type DragPoint = { readonly x: number; readonly y: number };
export type DragRect = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
export type DragGhost = { readonly title: string; readonly dx: number; readonly dy: number; readonly w: number; readonly origin: DragPoint };
export type DragTargets = {
  readonly laneRects: readonly (readonly [Lane, DragRect])[];
  readonly cardRects: readonly (readonly [string, DragRect])[];
};

export type DragState =
  | { readonly phase: "idle"; readonly epoch: number }
  | {
      readonly phase: "measuring";
      readonly epoch: number;
      readonly card: BoardCard;
      readonly title: string;
      readonly at: DragPoint;
    }
  | {
      readonly phase: "dragging";
      readonly epoch: number;
      readonly card: BoardCard;
      readonly at: DragPoint;
      readonly over: Lane | undefined;
      readonly before: string | undefined;
      readonly ghost: DragGhost;
      readonly targets: DragTargets;
    };

export type DragEvent =
  | { readonly kind: "start"; readonly card: BoardCard; readonly title: string; readonly at: DragPoint }
  | {
      readonly kind: "measured";
      readonly epoch: number;
      readonly ghost: DragGhost;
      readonly targets: DragTargets;
      readonly isPlaceable: (id: string) => boolean;
    }
  | { readonly kind: "move"; readonly at: DragPoint; readonly isPlaceable: (id: string) => boolean }
  | { readonly kind: "end" };

export type DragDropOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "place"; readonly card: BoardCard; readonly before: string }
  | { readonly kind: "drop"; readonly card: BoardCard; readonly lane: Lane };

const inside = (r: DragRect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/** Whether a lane takes the card: a move the rules allow, or a backlog/todo dropped back on its own ordered lane. */
const accepts = (c: BoardCard | undefined, lane: Lane) =>
  c !== undefined && (cardMove(c, lane) !== undefined || (isOrderLane(lane) && c.kind === "todo" && c.lane === lane));

export function initialDragState(): DragState {
  return { phase: "idle", epoch: 0 };
}

function hitTestDrag(
  card: BoardCard,
  at: DragPoint,
  targets: DragTargets,
  isPlaceable: (id: string) => boolean,
): { readonly over: Lane | undefined; readonly before: string | undefined } {
  const lane = targets.laneRects.find(([, r]) => inside(r, at.x, at.y))?.[0];
  const over = lane !== undefined && accepts(card, lane) ? lane : undefined;
  const before = card.kind === "todo" ? targets.cardRects.find(([id, r]) => id !== card.id && inside(r, at.x, at.y) && isPlaceable(id))?.[0] : undefined;
  return { over, before };
}

export function dragTransition(state: DragState, event: DragEvent): DragState {
  switch (state.phase) {
    case "idle":
      switch (event.kind) {
        case "start":
          return { phase: "measuring", epoch: state.epoch + 1, card: event.card, title: event.title, at: event.at };
        case "measured":
        case "move":
        case "end":
          return state;
      }
      break;

    case "measuring":
      switch (event.kind) {
        case "start":
          return { phase: "measuring", epoch: state.epoch + 1, card: event.card, title: event.title, at: event.at };
        case "measured": {
          if (event.epoch !== state.epoch) return state;
          const hit = hitTestDrag(state.card, state.at, event.targets, event.isPlaceable);
          return {
            phase: "dragging",
            epoch: state.epoch,
            card: state.card,
            at: state.at,
            over: hit.over,
            before: hit.before,
            ghost: event.ghost,
            targets: event.targets,
          };
        }
        case "move":
          return { ...state, at: event.at };
        case "end":
          return { phase: "idle", epoch: state.epoch + 1 };
      }
      break;

    case "dragging":
      switch (event.kind) {
        case "start":
          return { phase: "measuring", epoch: state.epoch + 1, card: event.card, title: event.title, at: event.at };
        case "measured":
          return state;
        case "move": {
          const hit = hitTestDrag(state.card, event.at, state.targets, event.isPlaceable);
          return { ...state, at: event.at, over: hit.over, before: hit.before };
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
      if (state.before !== undefined) return { kind: "place", card: state.card, before: state.before };
      if (state.over !== undefined) return { kind: "drop", card: state.card, lane: state.over };
      return { kind: "none" };
  }
}

export const BOARD_PAD_X = 12;
export const BOARD_LANE_GAP = 10;
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
function createDrag(board: () => BoardProps) {
  const state = signal<DragState>(initialDragState());
  const laneRefs = new Map<string, { lane: Lane; ref: ViewRef }>();
  const cardRefs = new Map<string, { ref: ViewRef; placeable: () => boolean }>();
  let root: ViewRef | undefined;
  const isPlaceable = (id: string) => cardRefs.get(id)?.placeable() === true;
  const dispatch = (event: DragEvent): DragState => {
    const next = dragTransition(untracked(state), event);
    state.set(next);
    return next;
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
        return { ...s.ghost, at: s.at };
    }
  };
  return {
    dragging,
    over,
    before,
    ghost,
    setRoot: (r: ViewRef) => (root = r),
    lane: (key: string, lane: Lane, ref: ViewRef) => {
      laneRefs.set(key, { lane, ref });
      cleanup(() => laneRefs.get(key)?.ref === ref && laneRefs.delete(key));
    },
    card: (id: string, ref: ViewRef, placeable: () => boolean) => {
      cardRefs.set(id, { ref, placeable });
      cleanup(() => cardRefs.get(id)?.ref === ref && cardRefs.delete(id));
    },
    async start(card: BoardCard, title: string, x0: number, y0: number) {
      const started = dispatch({ kind: "start", card, title, at: { x: x0, y: y0 } });
      const epoch = started.epoch;
      const [lanesNow, cardsNow, rootRect, own] = await Promise.all([
        Promise.all([...laneRefs.values()].map(async ({ lane, ref }) => [lane, await rectOf(ref)] as const)),
        Promise.all([...cardRefs].map(async ([id, c]) => [id, await rectOf(c.ref)] as const)),
        root ? rectOf(root) : undefined,
        cardRefs.get(card.id) ? rectOf(cardRefs.get(card.id)!.ref) : undefined,
      ]);
      if (untracked(state).epoch !== epoch) return;
      dispatch({
        kind: "measured",
        epoch,
        ghost: { title, dx: own ? x0 - own.x : 12, dy: own ? y0 - own.y : 12, w: own?.w ?? 220, origin: rootRect ?? { x: 0, y: 0 } },
        targets: {
          laneRects: lanesNow.flatMap(([l, r]) => (r ? [[l, r] as const] : [])),
          cardRects: cardsNow.flatMap(([id, r]) => (r ? [[id, r] as const] : [])),
        },
        isPlaceable,
      });
    },
    move: (x: number, y: number) => {
      dispatch({ kind: "move", at: { x, y }, isPlaceable });
    },
    end(dropped: boolean) {
      const outcome = dragDropOutcome(untracked(state), dropped);
      dispatch({ kind: "end" });
      switch (outcome.kind) {
        case "none":
          return;
        case "place":
          board().onPlace(outcome.card, outcome.before);
          return;
        case "drop":
          board().onDrop(outcome.card, outcome.lane);
          return;
      }
    },
  };
}
type Drag = ReturnType<typeof createDrag>;

/** Six lanes to drag between; narrower than 700, one lane at a time behind tabs. */
export function IssueBoard(props: BoardProps) {
  const lane = signal<Lane>(props.cards.find((card) => card.id === props.selected)?.lane ?? "backlog");
  const narrow = computed(() => windowSize().width < 700);
  const scrollWidth = signal<number | undefined>(undefined);
  const folded = signal<ReadonlySet<string>>(new Set());
  const issues = useIssues();
  const groupLabel = useGroupLabel();
  const effectiveGroupBy = computed<GroupBy>(() => props.groupBy ?? "none");
  const fold = (key: string) => {
    const next = new Set(folded());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    folded.set(next);
  };
  const availableBoardWidth = computed(() => {
    const measured = scrollWidth();
    if (measured !== undefined && measured > 0) return measured;
    const w = windowSize().width;
    const railW = w < 640 ? 68 : 76;
    return Math.max(240, w - railW - BOARD_PAD_X * 2);
  });
  const laneWidth = computed(() => boardLaneWidth(availableBoardWidth(), lanes.length));
  const drag = createDrag(() => props);
  const cardsByLane = computed<Record<Lane, BoardCard[]>>(() => {
    const grouped: Record<Lane, BoardCard[]> = { backlog: [], todo: [], in_progress: [], in_review: [], done: [], canceled: [] };
    for (const c of props.cards) grouped[c.lane].push(c);
    return grouped;
  });
  const groups = computed(() => (effectiveGroupBy() === "none" ? [] : groupCards(props.cards, effectiveGroupBy(), props.allIssues ?? issues())));
  const laneCounts = computed<Record<Lane, number>>(() => ({
    backlog: laneCountOf("backlog", props.cards, props.summary, props.filtered === true, props.older),
    todo: laneCountOf("todo", props.cards, props.summary, props.filtered === true, props.older),
    in_progress: laneCountOf("in_progress", props.cards, props.summary, props.filtered === true, props.older),
    in_review: laneCountOf("in_review", props.cards, props.summary, props.filtered === true, props.older),
    done: laneCountOf("done", props.cards, props.summary, props.filtered === true, props.older),
    canceled: laneCountOf("canceled", props.cards, props.summary, props.filtered === true, props.older),
  }));
  return (
    <View testID="issue-board" ref={drag.setRoot} class="min-h-0 flex-1 px-3 py-3">
      <If when={narrow()}>
        <View accessibilityLabel={t("web.issue.board.whichLane")} class="mb-2.5 flex-row gap-0.5 rounded-md border border-line bg-side p-0.5">
          <Each of={lanes} key={(l) => l}>
            {(l) => (
              <View
                testID={`board-lane-tab-${l()}`}
                onPress={() => lane.set(l())}
                role="tab"
                accessibilityState={{ selected: lane() === l() }}
                class={`h-7 flex-1 flex-row items-center justify-center gap-1 rounded-sm px-1.5 ${lane() === l() ? "bg-elevated shadow-raise" : "hover:bg-hover"}`}
              >
                <Text class={`truncate text-xs font-medium ${lane() === l() ? "text-ink" : "text-muted"}`}>{laneLabel[l()]}</Text>
                <Text
                  testID={`board-lane-tab-count-${l()}`}
                  class={`text-2xs ${lane() === l() ? "text-muted" : "text-faint"}`}
                  style={{ fontVariant: ["tabular-nums"] }}
                >
                  {String(laneCounts()[l()])}
                </Text>
              </View>
            )}
          </Each>
        </View>
      </If>
      <If
        when={effectiveGroupBy() !== "none"}
        else={
          <If
            when={narrow()}
            else={
              <Scroll
                testID="board-scroll"
                horizontal
                onLayout={(e) => {
                  const w = Math.floor(e.bounds.size.width);
                  if (w > 0 && w !== untracked(scrollWidth)) scrollWidth.set(w);
                }}
                class="min-h-0 flex-1"
                contentClass="min-h-full flex-row gap-2.5"
              >
                <Each of={lanes} key={(l) => l}>
                  {(l) => (
                    <LaneView
                      board={props}
                      lane={l()}
                      narrow={false}
                      laneWidth={laneWidth()}
                      cards={cardsByLane()[l()]}
                      count={laneCounts()[l()]}
                      showClear={props.filtered === true && props.cards.length === 0 && props.onClearFilter !== undefined && l() === "backlog"}
                      drag={drag}
                    />
                  )}
                </Each>
              </Scroll>
            }
          >
            <View class="min-h-0 flex-1 flex-row gap-2.5">
              <Each of={lanes} key={(l) => l}>
                {(l) => (
                  <If when={l() === lane()}>
                    <LaneView
                      board={props}
                      lane={l()}
                      narrow
                      laneWidth={laneWidth()}
                      cards={cardsByLane()[l()]}
                      count={laneCounts()[l()]}
                      showClear={props.filtered === true && props.cards.length === 0 && props.onClearFilter !== undefined && l() === lane()}
                      drag={drag}
                    />
                  </If>
                )}
              </Each>
            </View>
          </If>
        }
      >
        <Scroll
          testID="board-scroll"
          horizontal={!narrow()}
          onLayout={(e) => {
            const w = Math.floor(e.bounds.size.width);
            if (w > 0 && w !== untracked(scrollWidth)) scrollWidth.set(w);
          }}
          class="min-h-0 flex-1"
          contentClass="min-h-full flex-col gap-2"
        >
          <If when={!narrow()}>
            <View class="shrink-0 flex-row gap-2.5">
              <Each of={lanes} key={(l) => l}>
                {(l) => (
                  <View class="rounded-lg bg-side px-2.5 py-0.5" style={{ width: laneWidth() }}>
                    <LaneHeader
                      lane={l()}
                      count={laneCounts()[l()]}
                      showNew={isOrderLane(l()) && (props.loading || props.cards.length > 0)}
                      newButtonTestId={l() === "todo" ? "issue-new" : `issue-new-${l()}`}
                      onNew={props.onNew}
                    />
                  </View>
                )}
              </Each>
            </View>
          </If>
          <Scroll testID="board-grouped-scroll" class="min-h-0 flex-1" contentClass="gap-2.5 pb-2">
            <If when={!props.loading} else={<Text class="px-1 text-xs text-faint">{t("web.issue.reading")}</Text>}>
              <If
                when={groups().length > 0}
                else={
                  <View testID="board-grouped-empty" class="items-start gap-2 rounded-lg border border-line bg-side px-4 py-6">
                    <Text class="text-xs text-muted">{props.filtered === true ? t("web.issue.board.emptyGuide.filtered") : t("web.issue.list.empty")}</Text>
                    <If when={props.filtered === true && props.onClearFilter !== undefined}>
                      <Button size="compact" tone="plain" icon="close" testID="board-clear-filter" onPress={() => props.onClearFilter?.()}>
                        {t("web.issue.page.clear")}
                      </Button>
                    </If>
                  </View>
                }
              >
                <Each of={groups()} key={(g) => g.key}>
                  {(g) => {
                    const isFolded = computed(() => folded().has(g().key));
                    const label = computed(() => groupLabel()(effectiveGroupBy(), g().key, g().parent, g().owner));
                    const groupByLane = computed<Record<Lane, BoardCard[]>>(() => {
                      const map: Record<Lane, BoardCard[]> = { backlog: [], todo: [], in_progress: [], in_review: [], done: [], canceled: [] };
                      for (const c of g().cards) map[c.lane].push(c);
                      return map;
                    });
                    return (
                      <View testID="issue-group" accessibilityLabel={label()} class="overflow-hidden rounded-xl border border-line bg-page">
                        <View class={`h-8.5 flex-row items-center ${!isFolded() ? "border-b border-line bg-side" : "rounded-xl bg-side"}`}>
                          <IssueGroupHeader
                            testid={`issue-group-${g().key || "none"}`}
                            label={label()}
                            count={g().cards.length}
                            expanded={!isFolded()}
                            empty={g().cards.length === 0}
                            groupBy={effectiveGroupBy()}
                            groupKey={g().key}
                            owner={g().owner}
                            priority={g().priority}
                            onToggle={() => fold(g().key)}
                          />
                        </View>
                        <If when={!isFolded()}>
                          <View testID="issue-group-body" class="flex-row gap-2.5 p-2">
                            <If
                              when={narrow()}
                              else={
                                <Each of={lanes} key={(l) => l}>
                                  {(l) => (
                                    <SwimlaneCell
                                      board={props}
                                      groupKey={g().key}
                                      lane={l()}
                                      narrow={false}
                                      laneWidth={laneWidth()}
                                      cards={groupByLane()[l()]}
                                      drag={drag}
                                    />
                                  )}
                                </Each>
                              }
                            >
                              <SwimlaneCell
                                board={props}
                                groupKey={g().key}
                                lane={lane()}
                                narrow
                                laneWidth={laneWidth()}
                                cards={groupByLane()[lane()]}
                                drag={drag}
                              />
                            </If>
                          </View>
                        </If>
                      </View>
                    );
                  }}
                </Each>
              </If>
            </If>
          </Scroll>
        </Scroll>
      </If>
      <If when={drag.ghost()}>
        {(g) => (
          <View
            testID="drag-ghost"
            class="absolute rounded-lg border border-line bg-elevated px-2.5 py-2 shadow-float"
            style={{
              left: g().at.x - g().origin.x - g().dx,
              top: g().at.y - g().origin.y - g().dy,
              width: g().w,
              opacity: 0.92,
              pointerEvents: "none",
            }}
          >
            <Text class="line-clamp-2 text-sm font-medium text-ink">{g().title}</Text>
          </View>
        )}
      </If>
    </View>
  );
}

function LaneHeader(props: { lane: Lane; count: number; showNew: boolean; newButtonTestId: string; onNew: () => void }) {
  return (
    <View class="h-7 shrink-0 flex-row items-center gap-1.5 px-1">
      <View class="min-w-0 flex-row items-center gap-1.5" tooltip={<Bubble text={emptyText[props.lane]} />}>
        <StatusMark status={laneStatus[props.lane]} size={14} />
        <Text role="header" class="shrink-0 text-xs font-semibold text-ink">
          {laneLabel[props.lane]}
        </Text>
      </View>
      <View class="shrink-0 rounded-full bg-hover px-1.5 py-0.5">
        <Text testID={`lane-count-${props.lane}`} class="text-2xs font-medium text-muted tabular-nums">
          {String(props.count)}
        </Text>
      </View>
      <If when={props.showNew}>
        <View class="ml-auto shrink-0">
          <IconButton testid={props.newButtonTestId} icon="add" size={14} label={t("web.issue.new.title")} onClick={() => props.onNew()} />
        </View>
      </If>
    </View>
  );
}

function CardListRows(props: { board: BoardProps; lane: Lane; cards: BoardCard[]; drag: Drag }) {
  const closed = computed(() => isClosedLane(props.lane));
  const folded = computed(() => closed() && !props.board.older && props.cards.length > closedShown);
  const ordered = computed(() => laneOrder(props.lane, props.cards, props.board.ordering));
  const shown = computed(() => (folded() ? ordered().slice(0, closedShown) : ordered()));
  const hidden = computed(() => (folded() ? ordered().length - closedShown : 0));
  return (
    <>
      <Each of={shown()} key={(c) => c.id}>
        {(c) => (
          <CardView
            card={c()}
            selected={c().id === props.board.selected}
            hierarchy={props.board.hierarchy}
            allIssues={props.board.allIssues}
            onOpen={props.board.onOpen}
            onRetry={props.board.onRetry}
            onPutBack={props.board.onPutBack}
            drag={props.drag}
            // Anything but manual hides the user's order of todo, so a card cannot be dropped between two there.
            placeable={c().kind === "todo" && props.board.ordering === "manual"}
          />
        )}
      </Each>
      <If when={hidden() > 0 || (closed() && props.board.older && props.cards.length > closedShown)}>
        <OlderLink hidden={hidden()} onClick={props.board.onOlder} />
      </If>
    </>
  );
}

function SwimlaneCell(props: { board: BoardProps; groupKey: string; lane: Lane; narrow: boolean; laneWidth: number; cards: BoardCard[]; drag: Drag }) {
  const over = computed(() => props.drag.over() === props.lane);
  const cellStyle = () => {
    const bg = over() ? { backgroundColor: mix("leaf", 0.14) } : undefined;
    if (props.narrow) return bg;
    return { width: Math.max(props.laneWidth - 16, 176), ...bg };
  };
  return (
    <View
      ref={(r) => props.drag.lane(`${props.groupKey}:${props.lane}`, props.lane, r)}
      testID={`swimlane-${props.groupKey || "none"}-${props.lane}`}
      class={`min-h-14 gap-2 rounded-lg border p-1.5 ${props.narrow ? "min-w-0 flex-1" : "shrink-0"} ${over() ? "border-leaf" : "border-transparent bg-side"}`}
      style={cellStyle()}
    >
      <If when={props.cards.length > 0}>
        <CardListRows board={props.board} lane={props.lane} cards={props.cards} drag={props.drag} />
      </If>
    </View>
  );
}

function LaneView(props: {
  board: BoardProps;
  lane: Lane;
  narrow: boolean;
  laneWidth: number;
  cards: BoardCard[];
  count: number;
  showClear: boolean;
  drag: Drag;
}) {
  const p = () => props.board;
  const over = computed(() => props.drag.over() === props.lane);
  const guide = () => emptyLaneGuide[props.lane];
  const showHeaderNew = computed(() => isOrderLane(props.lane) && (props.board.loading || props.cards.length > 0));
  const newButtonTestId = computed(() => (props.lane === "todo" ? "issue-new" : `issue-new-${props.lane}`));
  const laneStyle = () => {
    const bg = over() ? { backgroundColor: mix("leaf", 0.14) } : undefined;
    if (props.narrow) return bg;
    return { width: props.laneWidth, ...bg };
  };
  return (
    <View
      ref={(r) => props.drag.lane(props.lane, props.lane, r)}
      accessibilityLabel={laneLabel[props.lane]}
      testID={`lane-${props.lane}`}
      accessibilityState={{ selected: over() }}
      class={`max-h-full ${props.narrow ? "min-w-55 flex-1" : "shrink-0"} rounded-xl border p-2.5 ${over() ? "border-leaf" : "border-transparent bg-side"}`}
      style={laneStyle()}
    >
      <View class="mb-1.5">
        <LaneHeader lane={props.lane} count={props.count} showNew={showHeaderNew()} newButtonTestId={newButtonTestId()} onNew={() => p().onNew()} />
      </View>
      <Scroll class="min-h-0 shrink" contentClass="gap-2 pb-0.5">
        <If
          when={p().loading}
          else={
            <If when={props.cards.length === 0} else={<CardListRows board={props.board} lane={props.lane} cards={props.cards} drag={props.drag} />}>
              <View testID="lane-empty" class={`justify-center rounded-lg border px-3 py-8 ${over() ? "border-dashed border-leaf" : "border-transparent"}`}>
                <View testID={`lane-empty-${props.lane}`} class="items-center gap-2">
                  <View class="size-8 items-center justify-center rounded-full bg-hover">
                    <Icon name={guide().icon} size={14} tone="faint" />
                  </View>
                  <If
                    when={p().filtered === true}
                    else={
                      <>
                        <Text class="text-center text-xs font-medium text-muted">{t(guide().titleKey)}</Text>
                        <Text class="text-center text-2xs leading-relaxed text-faint">{t(guide().bodyKey)}</Text>
                      </>
                    }
                  >
                    <Text class="text-center text-2xs leading-relaxed text-faint">{t("web.issue.board.emptyGuide.filtered")}</Text>
                  </If>
                  <If when={isOrderLane(props.lane) || props.showClear}>
                    <View class="flex-row flex-wrap items-center justify-center gap-1.5 pt-1">
                      <If when={isOrderLane(props.lane)}>
                        <Button size="compact" icon="add" testID={newButtonTestId()} onPress={() => p().onNew()}>
                          {t("web.issue.new.card")}
                        </Button>
                      </If>
                      <If when={props.showClear}>
                        <Button size="compact" tone="plain" icon="close" testID="board-clear-filter" onPress={() => p().onClearFilter?.()}>
                          {t("web.issue.page.clear")}
                        </Button>
                      </If>
                    </View>
                  </If>
                </View>
              </View>
            </If>
          }
        >
          <Text class="px-1 text-xs text-faint">{t("web.issue.reading")}</Text>
        </If>
      </Scroll>
    </View>
  );
}

function SmallIconButton(props: { label: string; icon: IconName; onPress: () => void; testID?: string }): JSX.Element {
  return (
    <View
      onPress={props.onPress}
      role="button"
      testID={props.testID}
      accessibilityLabel={props.label}
      tooltip={<Bubble text={props.label} />}
      class={`h-6 w-6 shrink-0 items-center justify-center rounded-md ${motionClass("transition-transform duration-120 ease-out")} hover:bg-selected active:translate-y-px`}
    >
      <Icon name={props.icon} size={14} tone="muted" />
    </View>
  );
}

function CardThumbnail(props: { preview: CardPreview }) {
  const file = useAttachmentFile(() => props.preview.attachmentId ?? "");
  const src = computed(() => {
    if (props.preview.url !== undefined && props.preview.url !== "") return props.preview.url;
    const f = file();
    return f ? fileUrl(f.path) : undefined;
  });
  return (
    <If when={src()}>
      {(url) => (
        <View testID="card-preview" class="relative mt-2 h-24 w-full overflow-hidden rounded-md border border-line bg-side">
          <Image testID="card-preview-image" src={url()} class="h-full w-full object-cover" />
          <If when={props.preview.isCompare}>
            <View
              testID="card-preview-compare"
              class="pointer-events-none absolute right-1.5 bottom-1.5 flex-row items-center gap-1 rounded-sm border border-line px-1.5 py-0.5"
              style={{ backgroundColor: mix("elevated", 0.9) }}
            >
              <Icon name="diff" size={10} tone="ink" />
              <Text class="text-2xs font-medium text-ink">{t("web.issue.peek.compareBadge")}</Text>
            </View>
          </If>
        </View>
      )}
    </If>
  );
}

function CardView(props: {
  card: BoardCard;
  selected: boolean;
  hierarchy?: HierarchyMode | undefined;
  allIssues?: readonly Issue[] | undefined;
  onOpen: (id: string) => void;
  onRetry: (card: BoardCard) => void;
  onPutBack: (card: BoardCard) => void;
  drag: Drag;
  placeable: boolean;
}) {
  const nameOf = useNameOf();
  const issues = useIssues();
  const resolvedIssues = computed(() => [...(props.allIssues ?? issues())]);
  const look = computed(() => cardLook(props.card, nameOf(), resolvedIssues(), Date.now()));
  const repo = computed(() => cardRepo(props.card));
  const preview = computed(() => cardPreviewOf(props.card));
  const loud = computed(() => {
    const pr = look().priority;
    return pr === "urgent" || pr === "high" ? pr : undefined;
  });
  const hasFace = computed(() => Boolean(cardAgent(props.card)) || props.card.kind === "orchestrator");
  const hasTopRow = computed(() => Boolean(look().number || repo() || loud() || hasFace()));
  const showsStatus = computed(() => ownStatus(props.card.lane, look().status));
  const unassignedTodo = computed(
    () => props.card.kind === "todo" && props.card.lane === "todo" && props.card.issue.status !== "backlog" && !cardAgent(props.card),
  );
  const parentIssue = computed(() => (props.card.issue.parent ? resolvedIssues().find((item) => item.id === props.card.issue.parent) : undefined));
  const childIssues = computed(() =>
    props.hierarchy === "top_level" || props.hierarchy === "parents_only" ? childIssuesOf(props.card.issue.id, resolvedIssues()) : [],
  );
  const tags = computed(() => props.card.issue.tags ?? []);
  const attachmentCount = computed(() => props.card.issue.attachments?.length ?? 0);
  const marks = computed(
    () =>
      showsStatus() ||
      unassignedTodo() ||
      Boolean(look().progress) ||
      Boolean(parentIssue()) ||
      tags().length > 0 ||
      attachmentCount() > 0 ||
      look().flags.length > 0,
  );
  const draggable = computed(() => props.card.kind !== "orchestrator" && props.card.kind !== "missing" && props.card.move?.state !== "moving");
  // Dragging sends a synthetic press on mouse-up; suppress opening the card right after a drag ends.
  let suppressPressUntil = 0;
  const pan = PanResponder.create({
    // A press opens the card; only a move of a few points starts a drag.
    onMoveShouldSetPanResponder: (_, g) => draggable() && Math.abs(g.dx) + Math.abs(g.dy) > 4,
    onPanResponderGrant: (_, g) => {
      suppressPressUntil = Number.POSITIVE_INFINITY;
      void props.drag.start(props.card, look().title, g.x0, g.y0);
    },
    onPanResponderMove: (_, g) => props.drag.move(g.moveX, g.moveY),
    onPanResponderRelease: () => {
      suppressPressUntil = Date.now() + 300;
      props.drag.end(true);
    },
    onPanResponderTerminate: () => {
      suppressPressUntil = Date.now() + 300;
      props.drag.end(false);
    },
  });
  const before = computed(() => props.drag.before() === props.card.id);
  const urgency = computed(() => cardUrgencyTone(props.card));
  const cardStyle = () => (motionOff() ? undefined : { transitionProperty: "shadow", transitionDuration: motionDuration(180) });
  return (
    <View ref={(r) => props.drag.card(props.card.id, r, () => props.placeable)}>
      <If when={before()}>
        <View testID="drop-before" class="mb-1 h-0.5 rounded-full bg-leaf" />
      </If>
      <View
        {...pan.panHandlers}
        ref={(el) => {
          if (props.selected)
            requestAnimationFrame(() => {
              el.reveal({ vertical: "nearest" });
              el.focus();
            });
        }}
        onPress={() => {
          if (props.drag.dragging() !== undefined || Date.now() < suppressPressUntil) return;
          props.onOpen(props.card.id);
        }}
        role="button"
        testID="issue-card"
        accessibilityLabel={look().title}
        accessibilityState={{ selected: props.selected, busy: props.card.move?.state === "moving" }}
        tooltip={<If when={look().detail}>{(d) => <Bubble text={d()} />}</If>}
        class={[
          "relative overflow-hidden rounded-lg border px-3 py-2.5 focus-visible:outline-2 focus-visible:outline-focus",
          props.selected ? "border-accent bg-selected" : "border-line bg-elevated hover:border-line-strong hover:shadow-raise",
          props.card.move?.state === "moving" ? "opacity-70" : props.drag.dragging()?.id === props.card.id ? "opacity-40" : "",
        ].join(" ")}
        style={cardStyle()}
      >
        <If when={urgency()}>{(u) => <View class="pointer-events-none absolute inset-y-0 left-0 w-0.75" style={{ backgroundColor: tone(u()) }} />}</If>
        <If when={hasTopRow()}>
          <View class="flex-row items-center justify-between gap-2">
            <View class="min-w-0 flex-1 flex-row items-center gap-1">
              <If when={look().number}>{(num) => <Text class="shrink-0 font-mono text-2xs font-medium text-faint tabular-nums">{num()}</Text>}</If>
              <If when={look().number && repo()}>
                <Text class="shrink-0 text-2xs text-faint">·</Text>
              </If>
              <If when={repo()}>{(r) => <Text class="min-w-0 flex-1 truncate text-2xs text-faint">{r()}</Text>}</If>
            </View>
            <If when={loud() || hasFace()}>
              <View class="shrink-0 flex-row items-center gap-1.5">
                <If when={loud()}>{(pr) => <PriorityMark priority={pr()} size={12} />}</If>
                <If when={hasFace()}>
                  <CardFace card={props.card} size={18} />
                </If>
              </View>
            </If>
          </View>
        </If>
        <Text class={`${hasTopRow() ? "mt-1.5 " : ""}line-clamp-2 text-sm leading-[19px] font-medium text-ink`}>{look().title}</Text>
        <If when={look().wait}>{(wait) => <Text class="mt-1 line-clamp-1 text-xs text-water">{wait()}</Text>}</If>
        <If when={preview()}>{(pv) => <CardThumbnail preview={pv()} />}</If>
        {/* Only what differs from the lane's default: its own status, unassigned todo, progress, attachments, flags. */}
        <If when={marks()}>
          <View testID="card-marks" class="mt-2 flex-row flex-wrap items-center gap-1.5">
            <If when={showsStatus()}>
              <StatusMark status={look().status} tone={look().statusTone} size={13} />
            </If>
            <If when={unassignedTodo()}>
              <View
                testID="card-unassigned"
                accessibilityLabel={t("web.issue.card.assignHelper")}
                class="flex-row items-center gap-1 rounded-sm border border-dashed border-line bg-side px-1.5 py-0.5"
              >
                <Icon name="agents" size={11} tone="muted" />
                <Text class="text-2xs font-medium text-muted">{t("web.issue.card.assignHelper")}</Text>
              </View>
            </If>
            <If when={look().progress}>{(pg) => <ProgressMark done={pg().done} total={pg().total} />}</If>
            <If when={parentIssue()}>{(p) => <ParentBadge parent={p()} onOpen={props.onOpen} testid="card-parent-badge" />}</If>
            <TagPills tags={tags()} max={3} testid="card-tags" />
            <If when={attachmentCount() > 0}>
              <View
                testID="card-attachments"
                accessibilityLabel={t("web.issue.attachments.count", { n: attachmentCount() })}
                tooltip={<Bubble text={t("web.issue.attachments.count", { n: attachmentCount() })} />}
                class="flex-row items-center gap-0.5"
              >
                <Icon name="attach" size={12} tone="muted" />
                <Text class="text-2xs text-muted tabular-nums">{String(attachmentCount())}</Text>
              </View>
            </If>
            <Each of={look().flags} key={(f) => `${f.tone}:${f.text}`}>
              {(f) => <FlagChip text={f().text} tone={f().tone} />}
            </Each>
          </View>
        </If>
        <If when={childIssues().length > 0}>
          <CardChildRows
            children={childIssues()}
            onBeforeChildPress={() => {
              // Suppress the enclosing card's synthetic press when a compact child row is clicked.
              suppressPressUntil = Date.now() + 250;
            }}
            onOpenChild={props.onOpen}
          />
        </If>
      </View>
      <If when={props.card.move?.state === "failed" ? props.card.move : undefined}>
        {(m) => (
          <View testID="move-failed" class="mt-1 flex-row items-center gap-1 px-1">
            <Text class="min-w-0 flex-1 truncate text-xs text-berry">{m().reason ?? t("web.issue.board.moveFailed")}</Text>
            <SmallIconButton testID="move-retry" label={t("web.issue.board.retryMove")} icon="retry" onPress={() => props.onRetry(props.card)} />
            <SmallIconButton testID="move-put-back" label={t("web.issue.board.putBack")} icon="undo" onPress={() => props.onPutBack(props.card)} />
          </View>
        )}
      </If>
    </View>
  );
}
