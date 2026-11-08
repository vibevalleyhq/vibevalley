import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Match, Show, Switch } from "solid-js";

import { t } from "@vibevalley/i18n";
import { maxRunning } from "@vibevalley/protocol";

import { Icon } from "#/ui/Icon.tsx";
import { Segmented } from "#/ui/Segmented.tsx";
import { Hint } from "#/ui/Tip.tsx";

import { type BoardCard, cardAgent, cardLook, cardMove, cardRepo, closedShown, type Lane, laneLabel, lanes, laneStatus, ownStatus } from "./cards";
import { laneOrder, type Ordering } from "./display";
import { useIssues, useNameOf } from "./history";
import { CardFace, FlagChip, PriorityMark, ProgressMark, StatusMark } from "./Marks";

const viewStyles = stylex.create({
  olderLinkButton: {
    marginInline: "auto",
    display: "block",
    cursor: "pointer",
    paddingBlock: "var(--spacing)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--wb-water)",
    textDecorationLine: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "underline",
      },
    },
  },
  issueBoardDiv: {
    display: "flex",
    minHeight: "0",
    flex: "1",
    gap: "calc(var(--spacing) * 2.5)",
    overflowX: "auto",
  },
  laneViewHeader: {
    display: "flex",
    height: "calc(var(--spacing) * 7)",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    paddingInline: "var(--spacing)",
  },
  laneViewH2: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  laneViewSpan: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-muted)",
  },
  laneViewP: {
    paddingInline: "var(--spacing)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-faint)",
  },
  cardViewDiv: {
    marginBottom: "var(--spacing)",
    height: "calc(var(--spacing) * .5)",
    borderRadius: "2147483647px",
    backgroundColor: "var(--wb-leaf)",
  },
  cardViewDiv2: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-2xs)",
    lineHeight: "14px",
    color: "var(--wb-muted)",
  },
  cardMarks: {
    marginTop: "calc(var(--spacing) * 2)",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
  },
  moveFailed: {
    marginTop: "var(--spacing)",
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
    paddingInline: "var(--spacing)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-berry)",
  },
  cardViewSpan: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  moveRetry: {
    display: "inline-flex",
    width: "calc(var(--spacing) * 6)",
    height: "calc(var(--spacing) * 6)",
    cursor: "pointer",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-md)",
    color: {
      default: "var(--wb-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-ink)",
      },
    },
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-hover)",
      },
    },
  },
  emptyNoteP: {
    paddingInline: "calc(var(--spacing) * 3)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-faint)",
  },
});

/** Under the closed ones: how many older are folded away, or back to the recent ones. */
export function OlderLink(props: { hidden: number; onClick: () => void }) {
  return (
    <button type="button" onClick={() => props.onClick()} {...stylex.attrs(viewStyles.olderLinkButton)}>
      {props.hidden > 0 ? t("web.issue.board.earlier", { n: props.hidden }) : t("web.issue.board.recent")}
    </button>
  );
}

const emptyText: Record<Lane, string> = {
  todo: t("web.issue.board.empty.todo"),
  working: t("web.issue.board.empty.working"),
  waiting: t("web.issue.board.empty.waiting"),
  closed: t("web.issue.board.empty.closed"),
};

interface BoardProps {
  cards: BoardCard[];
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

type Drag = { dragging: () => BoardCard | undefined; setDragging: (c: BoardCard | undefined) => void };

/** Four lanes to drag between; narrower than 700, one lane at a time behind tabs. */
export function IssueBoard(props: BoardProps) {
  const [lane, setLane] = createSignal<Lane>("todo");
  const [dragging, setDragging] = createSignal<BoardCard>();
  const drag: Drag = { dragging, setDragging: (c) => setDragging(() => c) };
  return (
    <div class="@container flex min-h-0 flex-1 flex-col px-3 pb-3">
      <div class="mb-2 @min-[700px]:hidden">
        <Segmented
          label={t("web.issue.board.whichLane")}
          block
          value={lane()}
          onChange={setLane}
          options={lanes.map((l) => ({ value: l, label: `${laneLabel[l]} ${props.cards.filter((c) => c.lane === l).length}` }))}
        />
      </div>
      <div {...stylex.attrs(viewStyles.issueBoardDiv)}>
        <For each={lanes}>
          {(l) => <LaneView board={props} lane={l} shownNarrow={l === lane()} cards={props.cards.filter((c) => c.lane === l)} drag={drag} />}
        </For>
      </div>
    </div>
  );
}

function LaneView(props: { board: BoardProps; lane: Lane; cards: BoardCard[]; shownNarrow: boolean; drag: Drag }) {
  const [over, setOver] = createSignal(false);
  const p = () => props.board;
  const folded = () => props.lane === "closed" && !p().older && props.cards.length > closedShown;
  const ordered = () => laneOrder(props.lane, props.cards, p().ordering);
  const shown = () => (folded() ? ordered().slice(0, closedShown) : ordered());
  const hidden = () => (folded() ? ordered().length - closedShown : 0);
  const accepts = (c: BoardCard | undefined) => c !== undefined && (cardMove(c, props.lane) !== undefined || (props.lane === "todo" && c.kind === "todo"));
  const head = () =>
    props.lane === "working"
      ? t("web.issue.board.spots", { taken: props.cards.filter((c) => c.kind === "issue").length, of: maxRunning })
      : `${props.cards.length}`;
  return (
    <section
      aria-label={laneLabel[props.lane]}
      data-testid="lane"
      data-key={props.lane}
      onDragOver={(e) => {
        if (!accepts(props.drag.dragging())) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget instanceof Node ? e.relatedTarget : null)) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const d = props.drag.dragging();
        if (d && accepts(d)) p().onDrop(d, props.lane);
        props.drag.setDragging(undefined);
      }}
      class={[
        // As tall as what it holds: an empty lane is its head and a place to drop, not a column of nothing.
        "h-fit max-h-full min-w-[220px] flex-1 flex-col self-start rounded-lg border px-2 pt-1.5 pb-2",
        props.shownNarrow ? "flex" : "hidden @min-[700px]:flex",
        over() ? "border-leaf bg-leaf/15" : "border-transparent bg-hover",
      ]}
    >
      <header {...stylex.attrs(viewStyles.laneViewHeader)}>
        <StatusMark status={laneStatus[props.lane]} />
        <h2 {...stylex.attrs(viewStyles.laneViewH2)}>{laneLabel[props.lane]}</h2>
        <span {...stylex.attrs(viewStyles.laneViewSpan)}>{head()}</span>
        <Hint text={emptyText[props.lane]} />
      </header>
      <Show when={props.lane === "todo"}>
        <button
          type="button"
          data-testid="issue-new"
          onClick={() => p().onNew()}
          aria-label={t("web.issue.new.title")}
          class="mt-1.5 flex h-9 w-full cursor-pointer items-center justify-center gap-1.5 rounded-md border border-dashed border-line text-sm text-faint transition-colors duration-120 hover:border-faint/50 hover:bg-page hover:text-muted"
        >
          <Icon name="add" size={14} />
          {t("web.issue.new.card")}
        </button>
      </Show>
      <div class="mt-2 flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
        <Switch
          fallback={
            <>
              <For each={shown()} keyed={(c) => c.id}>
                {(c) => (
                  <CardView
                    card={c()}
                    selected={c().id === p().selected}
                    onOpen={p().onOpen}
                    onRetry={p().onRetry}
                    onPutBack={p().onPutBack}
                    drag={props.drag}
                    // Anything but manual hides the owner's order of todo, so a card cannot be dropped between two there.
                    onPlace={c().kind === "todo" && p().ordering === "manual" ? (moved) => p().onPlace(moved, c().id) : undefined}
                  />
                )}
              </For>
              <Show when={hidden() > 0 || (props.lane === "closed" && p().older && props.cards.length > closedShown)}>
                <OlderLink hidden={hidden()} onClick={p().onOlder} />
              </Show>
            </>
          }
        >
          <Match when={p().loading}>
            <p {...stylex.attrs(viewStyles.laneViewP)}>{t("web.issue.reading")}</p>
          </Match>
          {/* The todo lane has its placeholder card: no second empty box under it. */}
          <Match when={props.cards.length === 0 && props.lane !== "todo"}>
            <div data-testid="lane-empty" class={["h-12 rounded-md border border-dashed", over() ? "border-leaf" : "border-line"]} />
          </Match>
        </Switch>
      </div>
    </section>
  );
}

function CardView(props: {
  card: BoardCard;
  selected: boolean;
  onOpen: (id: string) => void;
  onRetry: (card: BoardCard) => void;
  onPutBack: (card: BoardCard) => void;
  drag: Drag;
  onPlace?: ((moved: BoardCard) => void) | undefined;
}) {
  const nameOf = useNameOf();
  const issues = useIssues();
  const look = () => cardLook(props.card, nameOf(), issues(), Date.now());
  const [before, setBefore] = createSignal(false);
  const where = () => [look().number, cardRepo(props.card)].filter(Boolean).join(" · ");
  const loud = () => {
    const pr = look().priority;
    return pr === "urgent" || pr === "high" ? pr : undefined;
  };
  const showsStatus = () => ownStatus(props.card.lane, look().status);
  const marks = () =>
    showsStatus() || !!loud() || !!cardAgent(props.card) || props.card.kind === "orchestrator" || !!look().progress || look().flags.length > 0;
  const placing = () => {
    const d = props.drag.dragging();
    return !!props.onPlace && d?.kind === "todo" && d.id !== props.card.id;
  };
  return (
    <div
      onDragOver={(e) => {
        if (!placing()) return;
        e.preventDefault();
        e.stopPropagation();
        setBefore(true);
      }}
      onDragLeave={() => setBefore(false)}
      onDrop={(e) => {
        const d = props.drag.dragging();
        if (!placing() || !d) return;
        e.preventDefault();
        e.stopPropagation();
        setBefore(false);
        props.onPlace?.(d);
        props.drag.setDragging(undefined);
      }}
    >
      <Show when={before()}>
        <div {...stylex.attrs(viewStyles.cardViewDiv)} />
      </Show>
      <div
        role="button"
        tabindex={0}
        data-testid="issue-card"
        data-key={props.card.id}
        data-kind={props.card.kind}
        data-state={props.card.move?.state}
        aria-busy={props.card.move?.state === "moving" ? "true" : undefined}
        aria-label={look().title}
        aria-current={props.selected ? "true" : undefined}
        title={look().detail}
        draggable={props.card.kind !== "orchestrator" && props.card.kind !== "missing" && props.card.move?.state !== "moving" ? "true" : "false"}
        onDragStart={(e) => {
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", props.card.id);
          }
          props.drag.setDragging(props.card);
        }}
        onDragEnd={() => props.drag.setDragging(undefined)}
        onClick={() => props.onOpen(props.card.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            props.onOpen(props.card.id);
          }
        }}
        class={[
          "group cursor-pointer rounded-lg border px-2.5 pt-2 pb-2 transition-colors",
          props.selected ? "border-line bg-selected" : "border-line bg-page hover:border-ink/18 hover:shadow-raise",
          { "opacity-40": props.drag.dragging()?.id === props.card.id, "opacity-70": props.card.move?.state === "moving" },
        ]}
      >
        <Show when={where()}>
          <div {...stylex.attrs(viewStyles.cardViewDiv2)}>{where()}</div>
        </Show>
        <div class="mt-0.5 line-clamp-2 text-sm font-medium break-words">{look().title}</div>
        {/* Only what differs from the lane's default: its own status, a high priority, who works it, how far, its flags. */}
        <Show when={marks()}>
          <div data-testid="card-marks" {...stylex.attrs(viewStyles.cardMarks)}>
            <Show when={showsStatus()}>
              <StatusMark status={look().status} tone={look().statusTone} size={13} />
            </Show>
            <Show when={loud()}>{(pr) => <PriorityMark priority={pr()} size={13} />}</Show>
            <Show when={cardAgent(props.card) || props.card.kind === "orchestrator"}>
              <CardFace card={props.card} size={18} />
            </Show>
            <Show when={look().progress}>{(pg) => <ProgressMark done={pg().done} total={pg().total} />}</Show>
            <For each={look().flags}>{(f) => <FlagChip text={f.text} tone={f.tone} />}</For>
          </div>
        </Show>
      </div>
      <Show when={props.card.move?.state === "failed" ? props.card.move : undefined}>
        {(m) => (
          <div data-testid="move-failed" {...stylex.attrs(viewStyles.moveFailed)}>
            <span {...stylex.attrs(viewStyles.cardViewSpan)} title={m().reason}>
              {m().reason ?? t("web.issue.board.moveFailed")}
            </span>
            <button
              type="button"
              data-testid="move-retry"
              aria-label={t("web.issue.board.retryMove")}
              title={t("web.issue.board.retryMove")}
              onClick={() => props.onRetry(props.card)}
              {...stylex.attrs(viewStyles.moveRetry)}
            >
              <Icon name="retry" size={14} />
            </button>
            <button
              type="button"
              data-testid="move-put-back"
              aria-label={t("web.issue.board.putBack")}
              title={t("web.issue.board.putBack")}
              onClick={() => props.onPutBack(props.card)}
              {...stylex.attrs(viewStyles.moveRetry)}
            >
              <Icon name="undo" size={14} />
            </button>
          </div>
        )}
      </Show>
    </div>
  );
}

export function EmptyNote(props: { children: JSX.Element }) {
  return <p {...stylex.attrs(viewStyles.emptyNoteP)}>{props.children}</p>;
}
