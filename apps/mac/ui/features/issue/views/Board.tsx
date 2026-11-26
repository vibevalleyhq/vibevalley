import { cleanup, computed, Image, PanResponder, Scroll, signal, Text, View, windowSize, type JSX, type ViewRef } from "nsh";

import { t } from "@vibevalley/i18n";
import type { BoardSummary } from "@vibevalley/protocol";

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
import { laneOrder, type Ordering } from "../model/display";
import { useIssues, useNameOf } from "../model/history";
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

const emptyText: Record<Lane, string> = {
  todo: t("web.issue.board.empty.todo"),
  working: t("web.issue.board.empty.working"),
  waiting: t("web.issue.board.empty.waiting"),
  closed: t("web.issue.board.empty.closed"),
};

interface EmptyLaneGuide {
  readonly icon: IconName;
  readonly titleKey:
    | "web.issue.board.emptyGuide.todoTitle"
    | "web.issue.board.emptyGuide.workingTitle"
    | "web.issue.board.emptyGuide.waitingTitle"
    | "web.issue.board.emptyGuide.closedTitle";
  readonly bodyKey:
    | "web.issue.board.emptyGuide.todoBody"
    | "web.issue.board.emptyGuide.workingBody"
    | "web.issue.board.emptyGuide.waitingBody"
    | "web.issue.board.emptyGuide.closedBody";
}

const emptyLaneGuide: Record<Lane, EmptyLaneGuide> = {
  todo: {
    icon: "add",
    titleKey: "web.issue.board.emptyGuide.todoTitle",
    bodyKey: "web.issue.board.emptyGuide.todoBody",
  },
  working: {
    icon: "play",
    titleKey: "web.issue.board.emptyGuide.workingTitle",
    bodyKey: "web.issue.board.emptyGuide.workingBody",
  },
  waiting: {
    icon: "diff",
    titleKey: "web.issue.board.emptyGuide.waitingTitle",
    bodyKey: "web.issue.board.emptyGuide.waitingBody",
  },
  closed: {
    icon: "check",
    titleKey: "web.issue.board.emptyGuide.closedTitle",
    bodyKey: "web.issue.board.emptyGuide.closedBody",
  },
};

export interface BoardProps {
  cards: BoardCard[];
  summary?: BoardSummary | undefined;
  filtered?: boolean | undefined;
  loading: boolean;
  selected?: string | undefined;
  older: boolean;
  ordering: Ordering;
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

type Rect = { x: number; y: number; w: number; h: number };
const inside = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/** Whether a lane takes the card: a move the rules allow, or a todo dropped back on todo. */
const accepts = (c: BoardCard | undefined, lane: Lane) => c !== undefined && (cardMove(c, lane) !== undefined || (lane === "todo" && c.kind === "todo"));

/** A card being dragged: what is under the pointer, and where everything was when it started. */
function createDrag(board: () => BoardProps) {
  const dragging = signal<BoardCard | undefined>(undefined);
  const at = signal<{ x: number; y: number } | undefined>(undefined);
  const over = signal<Lane | undefined>(undefined);
  const before = signal<string | undefined>(undefined);
  const ghost = signal<{ title: string; dx: number; dy: number; w: number; origin: { x: number; y: number } } | undefined>(undefined);
  const laneRefs = new Map<Lane, ViewRef>();
  const cardRefs = new Map<string, { ref: ViewRef; placeable: () => boolean }>();
  let root: ViewRef | undefined;
  let laneRects: [Lane, Rect][] = [];
  let cardRects: [string, Rect][] = [];
  const rectOf = async (ref: ViewRef): Promise<Rect | undefined> => {
    const m = await ref.measure();
    return m ? { x: m.pagePosition.x, y: m.pagePosition.y, w: m.bounds.size.width, h: m.bounds.size.height } : undefined;
  };
  const move = (x: number, y: number) => {
    at.set({ x, y });
    const d = dragging();
    const lane = laneRects.find(([, r]) => inside(r, x, y))?.[0];
    over.set(lane !== undefined && accepts(d, lane) ? lane : undefined);
    const card = d?.kind === "todo" ? cardRects.find(([id, r]) => id !== d.id && inside(r, x, y) && cardRefs.get(id)?.placeable() === true)?.[0] : undefined;
    before.set(card);
  };
  return {
    dragging,
    at,
    over,
    before,
    ghost,
    setRoot: (r: ViewRef) => (root = r),
    lane: (lane: Lane, ref: ViewRef) => {
      laneRefs.set(lane, ref);
      cleanup(() => laneRefs.get(lane) === ref && laneRefs.delete(lane));
    },
    card: (id: string, ref: ViewRef, placeable: () => boolean) => {
      cardRefs.set(id, { ref, placeable });
      cleanup(() => cardRefs.get(id)?.ref === ref && cardRefs.delete(id));
    },
    async start(card: BoardCard, title: string, x0: number, y0: number) {
      dragging.set(card);
      const [lanesNow, cardsNow, rootRect, own] = await Promise.all([
        Promise.all([...laneRefs].map(async ([l, r]) => [l, await rectOf(r)] as const)),
        Promise.all([...cardRefs].map(async ([id, c]) => [id, await rectOf(c.ref)] as const)),
        root ? rectOf(root) : undefined,
        cardRefs.get(card.id) ? rectOf(cardRefs.get(card.id)!.ref) : undefined,
      ]);
      if (dragging() !== card) return;
      laneRects = lanesNow.flatMap(([l, r]) => (r ? [[l, r] as [Lane, Rect]] : []));
      cardRects = cardsNow.flatMap(([id, r]) => (r ? [[id, r] as [string, Rect]] : []));
      ghost.set({ title, dx: own ? x0 - own.x : 12, dy: own ? y0 - own.y : 12, w: own?.w ?? 220, origin: rootRect ?? { x: 0, y: 0 } });
      if (!at()) at.set({ x: x0, y: y0 });
      move(at()!.x, at()!.y);
    },
    move,
    end(dropped: boolean) {
      const d = dragging();
      const lane = over();
      const place = before();
      dragging.set(undefined);
      at.set(undefined);
      over.set(undefined);
      before.set(undefined);
      ghost.set(undefined);
      if (!dropped || !d) return;
      if (place !== undefined) board().onPlace(d, place);
      else if (lane !== undefined) board().onDrop(d, lane);
    },
  };
}
type Drag = ReturnType<typeof createDrag>;

/** Four lanes to drag between; narrower than 700, one lane at a time behind tabs. */
export function IssueBoard(props: BoardProps) {
  const lane = signal<Lane>(props.cards.find((card) => card.id === props.selected)?.lane ?? "todo");
  const narrow = computed(() => windowSize().width < 700);
  const drag = createDrag(() => props);
  const cardsByLane = computed<Record<Lane, BoardCard[]>>(() => {
    const grouped: Record<Lane, BoardCard[]> = { todo: [], working: [], waiting: [], closed: [] };
    for (const c of props.cards) grouped[c.lane].push(c);
    return grouped;
  });
  const laneCounts = computed<Record<Lane, number>>(() => ({
    todo: laneCountOf("todo", props.cards, props.summary, props.filtered === true, props.older),
    working: laneCountOf("working", props.cards, props.summary, props.filtered === true, props.older),
    waiting: laneCountOf("waiting", props.cards, props.summary, props.filtered === true, props.older),
    closed: laneCountOf("closed", props.cards, props.summary, props.filtered === true, props.older),
  }));
  return (
    <View ref={drag.setRoot} class="min-h-0 flex-1 px-4 py-3">
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
      <View class="min-h-0 flex-1 flex-row gap-3">
        <Each of={lanes} key={(l) => l}>
          {(l) => (
            <If when={!narrow() || l() === lane()}>
              <LaneView
                board={props}
                lane={l()}
                cards={cardsByLane()[l()]}
                count={laneCounts()[l()]}
                showClear={
                  props.filtered === true && props.cards.length === 0 && props.onClearFilter !== undefined && (narrow() ? l() === lane() : l() === "todo")
                }
                drag={drag}
              />
            </If>
          )}
        </Each>
      </View>
      <If when={drag.ghost()}>
        {(g) => (
          <View
            testID="drag-ghost"
            class="absolute rounded-lg border border-line bg-elevated px-2.5 py-2 shadow-float"
            style={{
              left: (drag.at()?.x ?? 0) - g().origin.x - g().dx,
              top: (drag.at()?.y ?? 0) - g().origin.y - g().dy,
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

function LaneView(props: { board: BoardProps; lane: Lane; cards: BoardCard[]; count: number; showClear: boolean; drag: Drag }) {
  const p = () => props.board;
  const over = computed(() => props.drag.over() === props.lane);
  const folded = computed(() => props.lane === "closed" && !props.board.older && props.cards.length > closedShown);
  const ordered = computed(() => laneOrder(props.lane, props.cards, props.board.ordering));
  const shown = computed(() => (folded() ? ordered().slice(0, closedShown) : ordered()));
  const hidden = computed(() => (folded() ? ordered().length - closedShown : 0));
  const guide = () => emptyLaneGuide[props.lane];
  const showHeaderNew = computed(() => props.lane === "todo" && (props.board.loading || props.cards.length > 0));
  return (
    <View
      ref={(r) => props.drag.lane(props.lane, r)}
      accessibilityLabel={laneLabel[props.lane]}
      testID={`lane-${props.lane}`}
      accessibilityState={{ selected: over() }}
      class={`max-h-full min-w-55 flex-1 rounded-xl border px-2.5 pt-2.5 pb-2.5 ${over() ? "border-leaf" : "border-transparent bg-side"}`}
      style={over() ? { backgroundColor: mix("leaf", 0.14) } : undefined}
    >
      <View class="mb-1.5 h-7 shrink-0 flex-row items-center gap-1.5 px-1">
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
        <If when={showHeaderNew()}>
          <View class="ml-auto shrink-0">
            <IconButton testid="issue-new" icon="add" size={14} label={t("web.issue.new.title")} onClick={() => p().onNew()} />
          </View>
        </If>
      </View>
      <Scroll class="min-h-0 shrink" contentClass="gap-2 pb-0.5">
        <If
          when={p().loading}
          else={
            <If
              when={props.cards.length === 0}
              else={
                <>
                  <Each of={shown()} key={(c) => c.id}>
                    {(c) => (
                      <CardView
                        card={c()}
                        selected={c().id === p().selected}
                        onOpen={p().onOpen}
                        onRetry={p().onRetry}
                        onPutBack={p().onPutBack}
                        drag={props.drag}
                        // Anything but manual hides the user's order of todo, so a card cannot be dropped between two there.
                        placeable={c().kind === "todo" && p().ordering === "manual"}
                      />
                    )}
                  </Each>
                  <If when={hidden() > 0 || (props.lane === "closed" && p().older && props.cards.length > closedShown)}>
                    <OlderLink hidden={hidden()} onClick={p().onOlder} />
                  </If>
                </>
              }
            >
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
                  <If when={props.lane === "todo" || props.showClear}>
                    <View class="flex-row flex-wrap items-center justify-center gap-1.5 pt-1">
                      <If when={props.lane === "todo"}>
                        <Button size="compact" icon="add" testID="issue-new" onPress={() => p().onNew()}>
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
  onOpen: (id: string) => void;
  onRetry: (card: BoardCard) => void;
  onPutBack: (card: BoardCard) => void;
  drag: Drag;
  placeable: boolean;
}) {
  const nameOf = useNameOf();
  const issues = useIssues();
  const look = computed(() => cardLook(props.card, nameOf(), issues(), Date.now()));
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
  const attachmentCount = computed(() => props.card.issue.attachments?.length ?? 0);
  const marks = computed(() => showsStatus() || unassignedTodo() || !!look().progress || attachmentCount() > 0 || look().flags.length > 0);
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
