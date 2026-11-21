// Ported from VibeValley apps/web/src/features/issue/views/Board.tsx.
// Same lanes, cards, marks and words; the model (cards.ts, display.ts,
// history.ts) is VibeValley's own, vendored. Dragging is a pan gesture on
// the card (nsh has no HTML drag and drop): where the lanes and cards are
// is measured as it starts, the card follows the pointer as a ghost, and
// the lane under it (or the todo card it would go before) is marked as
// VibeValley's dragover marks it.
import { cleanup, PanResponder, Scroll, signal, Text, View, windowSize, type JSX, type ViewRef } from "nsh";

import { t } from "@vibevalley/i18n";
import { type BoardSummary, maxRunning } from "@vibevalley/protocol";

import { Icon } from "../../../ui/Icon";
import type { IconName } from "../../../ui/icons";
import { Bubble, Hint } from "../../../ui/Tip";
import { mix, tone } from "../../../ui/tone";
import {
  type BoardCard,
  cardAgent,
  cardLook,
  cardMove,
  cardRepo,
  cardUrgencyTone,
  closedShown,
  type Lane,
  laneCountOf,
  laneLabel,
  lanes,
  laneStatus,
  ownStatus,
  runningSlotsOf,
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
      class="self-center rounded-md px-2.5 py-1 transition duration-120 ease-out hover:bg-hover active:translate-y-px"
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
  const narrow = () => windowSize().width < 700;
  const drag = createDrag(() => props);
  const countOf = (l: Lane) => laneCountOf(l, props.cards, props.summary, props.filtered === true, props.older);
  const workingSlots = () => runningSlotsOf(props.cards, props.summary, props.filtered === true, maxRunning);
  return (
    <View ref={drag.setRoot} class="min-h-0 flex-1 px-3 pb-3">
      <If when={narrow()}>
        <View accessibilityLabel={t("web.issue.board.whichLane")} class="mb-2 flex-row gap-0.5 rounded-md border border-line bg-side p-0.5">
          <Each of={lanes}>
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
                  {String(countOf(l()))}
                </Text>
              </View>
            )}
          </Each>
        </View>
      </If>
      <View class="min-h-0 flex-1 flex-row gap-2.5">
        <Each of={lanes}>
          {(l) => (
            <If when={!narrow() || l() === lane()}>
              <LaneView
                board={props}
                lane={l()}
                cards={props.cards.filter((c) => c.lane === l())}
                count={countOf(l())}
                slots={l() === "working" ? workingSlots() : undefined}
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
            <Text class="text-sm font-medium text-ink" style={{ numberOfLines: 2 }}>
              {g().title}
            </Text>
          </View>
        )}
      </If>
    </View>
  );
}

function LaneView(props: { board: BoardProps; lane: Lane; cards: BoardCard[]; count: number; slots?: { taken: number; of: number } | undefined; drag: Drag }) {
  const p = () => props.board;
  const over = () => props.drag.over() === props.lane;
  const folded = () => props.lane === "closed" && !p().older && props.cards.length > closedShown;
  const ordered = () => laneOrder(props.lane, props.cards, p().ordering);
  const shown = () => (folded() ? ordered().slice(0, closedShown) : ordered());
  const hidden = () => (folded() ? ordered().length - closedShown : 0);
  const hasBody = () => p().loading || props.cards.length > 0 || props.lane !== "todo";
  return (
    <View
      ref={(r) => props.drag.lane(props.lane, r)}
      accessibilityLabel={laneLabel[props.lane]}
      testID={`lane-${props.lane}`}
      accessibilityState={{ selected: over() }}
      class={`max-h-full min-w-55 flex-1 self-start rounded-lg border px-2 pt-1.5 pb-2 ${over() ? "border-leaf" : "border-transparent bg-side"}`}
      style={over() ? { backgroundColor: mix("leaf", 0.15) } : undefined}
    >
      <View class="h-7 shrink-0 flex-row items-center gap-1.5 px-1">
        <StatusMark status={laneStatus[props.lane]} />
        <Text role="header" class="shrink-0 text-sm font-semibold text-ink">
          {laneLabel[props.lane]}
        </Text>
        <Text testID={`lane-count-${props.lane}`} class="shrink-0 text-xs text-muted" style={{ fontVariant: ["tabular-nums"] }}>
          {String(props.count)}
        </Text>
        <If when={props.slots}>
          {(slots) => (
            <Text testID="lane-working-slots" class="min-w-0 shrink truncate text-2xs text-faint" style={{ fontVariant: ["tabular-nums"], numberOfLines: 1 }}>
              {`· ${t("web.issue.board.spots", slots())}`}
            </Text>
          )}
        </If>
        <View class="ml-auto shrink-0">
          <Hint text={emptyText[props.lane]} />
        </View>
      </View>
      <If when={props.lane === "todo"}>
        <View
          onPress={() => p().onNew()}
          role="button"
          testID="issue-new"
          accessibilityLabel={t("web.issue.new.title")}
          class="group mt-1.5 h-9 w-full shrink-0 flex-row items-center justify-center gap-1.5 rounded-md border border-dashed border-line transition duration-120 ease-out hover:border-faint hover:bg-page active:translate-y-px"
        >
          <Icon name="add" size={14} tone="muted" />
          <Text class="text-sm font-medium text-muted group-hover:text-ink">{t("web.issue.new.card")}</Text>
        </View>
      </If>
      <If when={hasBody()}>
        <Scroll class="mt-2 min-h-0 shrink" contentClass="gap-1.5 pb-0.5">
          {p().loading ? (
            <Text class="px-1 text-xs text-faint">{t("web.issue.reading")}</Text>
          ) : props.cards.length === 0 ? (
            <View testID="lane-empty" class={`h-12 rounded-md border border-dashed ${over() ? "border-leaf" : "border-line"}`} />
          ) : (
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
          )}
        </Scroll>
      </If>
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
      class="h-6 w-6 shrink-0 items-center justify-center rounded-md transition duration-120 ease-out hover:bg-selected active:translate-y-px"
    >
      <Icon name={props.icon} size={14} tone="muted" />
    </View>
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
  const look = () => cardLook(props.card, nameOf(), issues(), Date.now());
  const repo = () => cardRepo(props.card);
  const hasMeta = () => Boolean(look().number || repo());
  const loud = () => {
    const pr = look().priority;
    return pr === "urgent" || pr === "high" ? pr : undefined;
  };
  const showsStatus = () => ownStatus(props.card.lane, look().status);
  const marks = () =>
    showsStatus() || !!loud() || !!cardAgent(props.card) || props.card.kind === "orchestrator" || !!look().progress || look().flags.length > 0;
  const draggable = () => props.card.kind !== "orchestrator" && props.card.kind !== "missing" && props.card.move?.state !== "moving";
  const pan = PanResponder.create({
    // A press opens the card; only a move of a few points starts a drag.
    onMoveShouldSetPanResponder: (_, g) => draggable() && Math.abs(g.dx) + Math.abs(g.dy) > 4,
    onPanResponderGrant: (_, g) => void props.drag.start(props.card, look().title, g.x0, g.y0),
    onPanResponderMove: (_, g) => props.drag.move(g.moveX, g.moveY),
    onPanResponderRelease: () => props.drag.end(true),
    onPanResponderTerminate: () => props.drag.end(false),
  });
  const before = () => props.drag.before() === props.card.id;
  const urgency = () => cardUrgencyTone(props.card);
  const cardStyle = () => ({
    transitionProperty: "colors,shadow",
    transitionDuration: 180,
  });
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
        onPress={() => props.onOpen(props.card.id)}
        role="button"
        testID="issue-card"
        accessibilityLabel={look().title}
        accessibilityState={{ selected: props.selected, busy: props.card.move?.state === "moving" }}
        tooltip={look().detail ? <Bubble text={look().detail} /> : undefined}
        class={[
          "relative overflow-hidden rounded-lg border px-2.5 py-2 focus-visible:outline-2 focus-visible:outline-focus",
          props.selected ? "border-accent bg-selected" : "border-line bg-elevated hover:border-faint hover:shadow-raise",
          props.card.move?.state === "moving" ? "opacity-70" : props.drag.dragging()?.id === props.card.id ? "opacity-40" : "",
        ].join(" ")}
        style={cardStyle()}
      >
        <If when={urgency()}>{(u) => <View class="pointer-events-none absolute inset-y-0 left-0 w-0.75" style={{ backgroundColor: tone(u()) }} />}</If>
        <If when={hasMeta()}>
          <View class="flex-row items-center gap-1">
            <If when={look().number}>
              {(num) => (
                <Text class="shrink-0 font-mono text-2xs text-muted" style={{ fontVariant: ["tabular-nums"] }}>
                  {num()}
                </Text>
              )}
            </If>
            <If when={look().number && repo()}>
              <Text class="shrink-0 text-2xs text-faint">·</Text>
            </If>
            <If when={repo()}>
              {(r) => (
                <Text class="min-w-0 flex-1 truncate text-2xs text-muted" style={{ numberOfLines: 1 }}>
                  {r()}
                </Text>
              )}
            </If>
          </View>
        </If>
        <Text class={`${hasMeta() ? "mt-1" : ""} text-sm leading-snug font-medium text-ink`} style={{ numberOfLines: 2 }}>
          {look().title}
        </Text>
        <If when={look().wait}>
          {(wait) => (
            <Text class="mt-1 text-xs leading-snug text-water" style={{ numberOfLines: 2 }}>
              {wait()}
            </Text>
          )}
        </If>
        {/* Only what differs from the lane's default: its own status, a high priority, who works it, how far, its flags. */}
        <If when={marks()}>
          <View testID="card-marks" class="mt-2 flex-row flex-wrap items-center gap-1.5">
            <If when={showsStatus()}>
              <StatusMark status={look().status} tone={look().statusTone} size={13} />
            </If>
            <If when={loud()}>{(pr) => <PriorityMark priority={pr()} size={13} />}</If>
            <If when={cardAgent(props.card) || props.card.kind === "orchestrator"}>
              <CardFace card={props.card} size={18} />
            </If>
            <If when={look().progress}>{(pg) => <ProgressMark done={pg().done} total={pg().total} />}</If>
            <Each of={look().flags}>{(f) => <FlagChip text={f().text} tone={f().tone} />}</Each>
          </View>
        </If>
      </View>
      <If when={props.card.move?.state === "failed" ? props.card.move : undefined}>
        {(m) => (
          <View testID="move-failed" class="mt-1 flex-row items-center gap-1 px-1">
            <Text class="min-w-0 flex-1 text-xs text-berry" style={{ numberOfLines: 1 }}>
              {m().reason ?? t("web.issue.board.moveFailed")}
            </Text>
            <SmallIconButton testID="move-retry" label={t("web.issue.board.retryMove")} icon="retry" onPress={() => props.onRetry(props.card)} />
            <SmallIconButton testID="move-put-back" label={t("web.issue.board.putBack")} icon="undo" onPress={() => props.onPutBack(props.card)} />
          </View>
        )}
      </If>
    </View>
  );
}
