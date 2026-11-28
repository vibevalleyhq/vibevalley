import { computed, Scroll, signal, Text, untracked, View, windowSize } from "nsh";

import { t } from "@vibevalley/i18n";

import { Button } from "../../../design/Button";
import { type BoardCard, type Lane, laneCountOf, laneLabel, lanes } from "../model/cards";
import { type GroupBy, groupCards } from "../model/display";
import { useIssues } from "../model/history";
import { CardSurface } from "./board/CardView";
import {
  BOARD_LANE_GAP,
  BOARD_PAD_X,
  boardLaneWidth,
  type BoardProps,
  createDrag,
  type DragGhost,
  type DragState,
  type DragTargets,
  dragDropOutcome,
  dragTransition,
  initialDragState,
  isOrderLane,
} from "./board/dragFsm";
import { EmptyNote, LaneHeader, LaneView, OlderLink, SwimlaneCell } from "./board/LaneView";
import { IssueGroupHeader, useGroupLabel } from "./IssueMetaControls";

export {
  BOARD_LANE_GAP,
  BOARD_PAD_X,
  boardLaneWidth,
  type BoardProps,
  type DragGhost,
  type DragState,
  type DragTargets,
  dragDropOutcome,
  dragTransition,
  EmptyNote,
  initialDragState,
  OlderLink,
};

/** Six lanes to drag between; narrower than 700, one lane at a time behind tabs. */
export function IssueBoard(props: BoardProps) {
  const lane = signal<Lane>(props.cards.find((card) => card.id === props.selected)?.lane ?? "backlog");
  const narrow = computed(() => windowSize().width < 700);
  const scrollWidth = signal<number | undefined>(undefined);
  const folded = signal<ReadonlySet<string>>(new Set());
  const issues = useIssues();
  const groupLabel = useGroupLabel();
  const effectiveGroupBy = computed<GroupBy>(() => props.groupBy ?? "none");
  const compact = computed(() => props.density === "compact");
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
  const primaryEmptyLane = computed<Lane | undefined>(() => {
    const byLane = cardsByLane();
    if (byLane.todo.length === 0) return "todo";
    return lanes.find((l) => byLane[l].length === 0);
  });
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
                      emptyMode={l() === primaryEmptyLane() ? "full" : "quiet"}
                      showClear={props.filtered === true && props.cards.length === 0 && props.onClearFilter !== undefined && l() === primaryEmptyLane()}
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
            class={`absolute overflow-hidden rounded-lg border border-accent bg-elevated shadow-float ${compact() ? "px-2.5 py-1.5" : "px-3 py-2.5"}`}
            style={{
              left: g().at.x - g().origin.x - g().dx,
              top: g().at.y - g().origin.y - g().dy,
              width: g().w,
              minHeight: g().h,
              opacity: 0.96,
              pointerEvents: "none",
            }}
          >
            <CardSurface
              card={g().card}
              hierarchy={props.hierarchy}
              density={props.density}
              fields={props.fields}
              allIssues={props.allIssues}
              interactive={false}
            />
          </View>
        )}
      </If>
    </View>
  );
}
