import { computed, Scroll, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { Button } from "../../../../design/Button";
import { Icon } from "../../../../design/Icon";
import { IconButton } from "../../../../design/IconButton";
import type { IconName } from "../../../../design/icons";
import { motionClass } from "../../../../design/motion";
import { Bubble } from "../../../../design/Tip";
import { mix } from "../../../../design/tone";
import { type BoardCard, closedShown, type Lane, laneLabel, laneStatus } from "../../model/cards";
import { laneOrder } from "../../model/display";
import { StatusMark } from "../Marks";
import { CardView, DropPlaceholder } from "./CardView";
import { type BoardProps, type Drag, isClosedLane, isOrderLane } from "./dragFsm";

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

export function LaneHeader(props: { lane: Lane; count: number; showNew: boolean; newButtonTestId: string; onNew: () => void }) {
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

function CardListRows(props: { board: BoardProps; lane: Lane; laneKey: string; cards: BoardCard[]; drag: Drag }) {
  const closed = computed(() => isClosedLane(props.lane));
  const compact = computed(() => props.board.density === "compact");
  const folded = computed(() => closed() && !props.board.older && props.cards.length > closedShown);
  const ordered = computed(() => laneOrder(props.lane, props.cards, props.board.ordering));
  const shown = computed(() => (folded() ? ordered().slice(0, closedShown) : ordered()));
  const hidden = computed(() => (folded() ? ordered().length - closedShown : 0));
  const activeGhost = computed(() => {
    const g = props.drag.ghost();
    return g !== undefined && props.drag.overKey() === props.laneKey ? g : undefined;
  });
  const targetBefore = computed(() => (activeGhost() !== undefined ? props.drag.before() : undefined));
  const showTopPlaceholder = computed(() => {
    const g = activeGhost();
    if (!g) return undefined;
    // Auto-sorted / closed / started-issue cross-lane drops have no explicit manual slot -> preview at top.
    return targetBefore() === undefined && g.card.lane !== props.lane ? g : undefined;
  });
  const showEndPlaceholder = computed(() => {
    const g = activeGhost();
    if (!g) return undefined;
    const b = targetBefore();
    if (b === "") return g;
    // Fallback if `before` references a card outside `shown()` (e.g. folded).
    if (b !== undefined && !shown().some((c) => c.id === b)) return g;
    return undefined;
  });
  return (
    <>
      <If when={showTopPlaceholder()}>
        {(g) => <DropPlaceholder lane={props.lane} number={g().number} title={g().title} height={g().h} compact={compact()} />}
      </If>
      <Each of={shown()} key={(c) => c.id}>
        {(c) => (
          <CardView
            card={c()}
            lane={props.lane}
            laneKey={props.laneKey}
            selected={c().id === props.board.selected}
            hierarchy={props.board.hierarchy}
            density={props.board.density}
            fields={props.board.fields}
            allIssues={props.board.allIssues}
            onOpen={props.board.onOpen}
            onRetry={props.board.onRetry}
            onPutBack={props.board.onPutBack}
            drag={props.drag}
            // Non-manual ordering or closed lanes hide manual rank, and started issues reject `before` updates.
            placeable={!closed() && c().kind === "todo" && props.board.ordering === "manual"}
          />
        )}
      </Each>
      <If when={showEndPlaceholder()}>
        {(g) => <DropPlaceholder lane={props.lane} number={g().number} title={g().title} height={g().h} compact={compact()} />}
      </If>
      <If when={hidden() > 0 || (closed() && props.board.older && props.cards.length > closedShown)}>
        <OlderLink hidden={hidden()} onClick={props.board.onOlder} />
      </If>
    </>
  );
}

export function SwimlaneCell(props: { board: BoardProps; groupKey: string; lane: Lane; narrow: boolean; laneWidth: number; cards: BoardCard[]; drag: Drag }) {
  const laneKey = computed(() => `${props.groupKey}:${props.lane}`);
  const over = computed(() => props.drag.overKey() === laneKey());
  const emptyPlaceholderGhost = computed(() => {
    if (props.cards.length > 0 || !over()) return undefined;
    return props.drag.ghost();
  });
  const cellStyle = () => {
    const bg = over() ? { backgroundColor: mix("leaf", 0.14) } : undefined;
    if (props.narrow) return bg;
    return { width: Math.max(props.laneWidth - 16, 176), ...bg };
  };
  const compact = computed(() => props.board.density === "compact");
  return (
    <View
      ref={(r) => props.drag.lane(laneKey(), props.lane, r)}
      testID={`swimlane-${props.groupKey || "none"}-${props.lane}`}
      class={`min-h-14 rounded-lg border ${compact() ? "p-1" : "p-1.5"} ${props.narrow ? "min-w-0 flex-1" : "shrink-0"} ${over() ? "border-leaf" : "border-transparent bg-side"}`}
      style={cellStyle()}
    >
      <If when={emptyPlaceholderGhost()}>
        {(g) => <DropPlaceholder lane={props.lane} number={g().number} title={g().title} height={g().h} compact={compact()} />}
      </If>
      <If when={props.cards.length > 0}>
        <CardListRows board={props.board} lane={props.lane} laneKey={laneKey()} cards={props.cards} drag={props.drag} />
      </If>
    </View>
  );
}

export function LaneView(props: {
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
  const over = computed(() => props.drag.overKey() === props.lane);
  const emptyPlaceholderGhost = computed(() => (over() ? props.drag.ghost() : undefined));
  const guide = () => emptyLaneGuide[props.lane];
  const showHeaderNew = computed(() => isOrderLane(props.lane) && (props.board.loading || props.cards.length > 0));
  const newButtonTestId = computed(() => (props.lane === "todo" ? "issue-new" : `issue-new-${props.lane}`));
  const laneStyle = () => {
    const bg = over() ? { backgroundColor: mix("leaf", 0.14) } : undefined;
    if (props.narrow) return bg;
    return { width: props.laneWidth, ...bg };
  };
  const compact = computed(() => p().density === "compact");
  return (
    <View
      ref={(r) => props.drag.lane(props.lane, props.lane, r)}
      accessibilityLabel={laneLabel[props.lane]}
      testID={`lane-${props.lane}`}
      accessibilityState={{ selected: over() }}
      class={`h-full ${props.narrow ? "min-w-55 flex-1" : "shrink-0"} rounded-xl border ${compact() ? "p-2" : "p-2.5"} ${over() ? "border-leaf" : "border-transparent bg-side"}`}
      style={laneStyle()}
    >
      <View class={compact() ? "mb-1" : "mb-1.5"}>
        <LaneHeader lane={props.lane} count={props.count} showNew={showHeaderNew()} newButtonTestId={newButtonTestId()} onNew={() => p().onNew()} />
      </View>
      <Scroll class="min-h-0 flex-1" contentClass="pb-0.5">
        <If
          when={p().loading}
          else={
            <If
              when={props.cards.length === 0}
              else={<CardListRows board={props.board} lane={props.lane} laneKey={props.lane} cards={props.cards} drag={props.drag} />}
            >
              <If
                when={emptyPlaceholderGhost()}
                else={
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
                }
              >
                {(g) => <DropPlaceholder lane={props.lane} number={g().number} title={g().title} height={g().h} compact={compact()} />}
              </If>
            </If>
          }
        >
          <Text class="px-1 text-xs text-faint">{t("web.issue.reading")}</Text>
        </If>
      </Scroll>
    </View>
  );
}
