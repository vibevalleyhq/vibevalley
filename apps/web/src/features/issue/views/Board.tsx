import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Match, Show, Switch } from "solid-js";

import { t } from "@vibevalley/i18n";
import { maxRunning } from "@vibevalley/protocol";

import {
  type BoardCard,
  cardAgent,
  cardLook,
  cardMove,
  cardRepo,
  closedShown,
  type Lane,
  laneLabel,
  lanes,
  laneStatus,
  ownStatus,
} from "#/features/issue/model/cards.ts";
import { laneOrder, type Ordering } from "#/features/issue/model/display.ts";
import { useIssues, useNameOf } from "#/features/issue/model/history.ts";
import { Icon } from "#/ui/Icon.tsx";
import { styleProps } from "#/ui/positioner.ts";
import { Segmented } from "#/ui/Segmented.tsx";
import { Hint } from "#/ui/Tip.tsx";

import { CardFace, FlagChip, PriorityMark, ProgressMark, StatusMark } from "./Marks";

const cardStyles = stylex.create({
  card: {
    cursor: "pointer",
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: "1px",
    paddingInline: "0.625rem",
    paddingTop: "0.5rem",
    paddingBottom: "0.5rem",
    transitionProperty: "color, background-color, border-color",
    transitionTimingFunction: "var(--ease-out)",
    transitionDuration: "180ms",
  },
  selected: {
    borderColor: "var(--wb-line)",
    backgroundColor: "var(--wb-selected)",
  },
  idle: {
    borderColor: {
      default: "var(--wb-line)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-ink)",
        "@supports (color:color-mix(in lab, red, red))": {
          default: null,
          ":hover": "color-mix(in oklab, var(--wb-ink) 18%, transparent)",
        },
      },
    },
    backgroundColor: "var(--wb-page)",
    boxShadow: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--shadow-raise)",
      },
    },
  },
  dragging: {
    opacity: ".4",
  },
  moving: {
    opacity: ".7",
  },
});

const styles = stylex.create({
  issueBoardDiv: {
    marginBottom: "0.5rem",
    display: {
      default: null,
      "@container (width>=700px)": "none",
    },
  },
  laneViewSection: {
    height: "fit-content",
    maxHeight: "100%",
    minWidth: "220px",
    flex: "1",
    flexDirection: "column",
    alignSelf: "flex-start",
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: "1px",
    paddingInline: "0.5rem",
    paddingTop: "0.375rem",
    paddingBottom: "0.5rem",
  },
  laneViewSectionPrimary: {
    display: {
      default: "none",
      "@container (width>=700px)": "flex",
    },
  },
  laneViewSectionSecondary: {
    display: "flex",
  },
  laneViewSectionStateA: {
    borderColor: "transparent",
    backgroundColor: "var(--color-hover)",
  },
  laneViewSectionStateB: {
    borderColor: "var(--color-leaf)",
    backgroundColor: {
      default: "var(--color-leaf)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-leaf) 15%, transparent)",
    },
  },
  laneViewButton: {
    marginTop: "0.375rem",
    display: "flex",
    height: "2.25rem",
    width: "100%",
    cursor: "pointer",
    alignItems: "center",
    justifyContent: "center",
    gap: "0.375rem",
    borderRadius: "var(--radius-md)",
    borderStyle: "dashed",
    borderWidth: "1px",
    borderColor: {
      default: "var(--color-line)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-faint)",
        "@supports (color:color-mix(in lab, red, red))": {
          default: null,
          ":hover": "color-mix(in oklab, var(--color-faint) 50%, transparent)",
        },
      },
    },
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: {
      default: "var(--color-faint)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-muted)",
      },
    },
    transitionProperty: "color, background-color, border-color",
    transitionTimingFunction: "var(--ease-out)",
    transitionDuration: "120ms",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-page)",
      },
    },
  },
  issueBoardDiv2: {
    containerType: "inline-size",
    display: "flex",
    minHeight: "0",
    flex: "1",
    flexDirection: "column",
    paddingInline: "0.75rem",
    paddingBottom: "0.75rem",
  },
  laneViewDiv: {
    marginTop: "0.5rem",
    display: "flex",
    minHeight: "0",
    flex: "1",
    flexDirection: "column",
    gap: "0.375rem",
    overflowY: "auto",
  },
  laneViewDiv2: {
    height: "3rem",
    borderRadius: "var(--radius-md)",
    borderStyle: "dashed",
    borderWidth: "1px",
  },
  laneViewDivTone: {
    borderColor: "var(--color-leaf)",
  },
  laneViewDivAlt: {
    borderColor: "var(--color-line)",
  },
  cardViewDiv: {
    marginTop: "0.125rem",
    WebkitLineClamp: "2",
    WebkitBoxOrient: "vertical",
    display: "-webkit-box",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    fontWeight: "var(--font-weight-medium)",
    overflowWrap: "break-word",
  },
  olderLinkButton: {
    marginInline: "auto",
    display: "block",
    cursor: "pointer",
    paddingBlock: "0.25rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-water)",
    textDecorationLine: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "underline",
      },
    },
  },
  issueBoardDiv3: {
    display: "flex",
    minHeight: "0",
    flex: "1",
    gap: "0.625rem",
    overflowX: "auto",
  },
  laneViewHeader: {
    display: "flex",
    height: "1.75rem",
    alignItems: "center",
    gap: "0.5rem",
    paddingInline: "0.25rem",
  },
  laneViewH2: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    fontWeight: "var(--font-weight-semibold)",
  },
  laneViewSpan: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  laneViewP: {
    paddingInline: "0.25rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-faint)",
  },
  cardViewDiv2: {
    marginBottom: "0.25rem",
    height: "0.125rem",
    borderRadius: "9999px",
    backgroundColor: "var(--color-leaf)",
  },
  cardViewDiv22: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-2xs)",
    lineHeight: "14px",
    color: "var(--color-muted)",
  },
  cardMarks: {
    marginTop: "0.5rem",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.375rem",
  },
  moveFailed: {
    marginTop: "0.25rem",
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
    paddingInline: "0.25rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-berry)",
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
    width: "1.5rem",
    height: "1.5rem",
    cursor: "pointer",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-md)",
    color: {
      default: "var(--color-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-ink)",
      },
    },
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  emptyNoteP: {
    paddingInline: "0.75rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-faint)",
  },
});

/** Under the closed ones: how many older are folded away, or back to the recent ones. */
export function OlderLink(props: { hidden: number; onClick: () => void }) {
  return (
    <button type="button" onClick={() => props.onClick()} {...stylex.attrs(styles.olderLinkButton)}>
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
    <div {...stylex.attrs(styles.issueBoardDiv2)}>
      <div {...stylex.attrs(styles.issueBoardDiv)}>
        <Segmented
          label={t("web.issue.board.whichLane")}
          block
          value={lane()}
          onChange={setLane}
          options={lanes.map((l) => ({ value: l, label: `${laneLabel[l]} ${props.cards.filter((c) => c.lane === l).length}` }))}
        />
      </div>
      <div {...stylex.attrs(styles.issueBoardDiv3)}>
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
      {...stylex.attrs(
        styles.laneViewSection,
        props.shownNarrow ? styles.laneViewSectionSecondary : styles.laneViewSectionPrimary,
        over() ? styles.laneViewSectionStateB : styles.laneViewSectionStateA,
      )}
    >
      <header {...stylex.attrs(styles.laneViewHeader)}>
        <StatusMark status={laneStatus[props.lane]} />
        <h2 {...stylex.attrs(styles.laneViewH2)}>{laneLabel[props.lane]}</h2>
        <span {...stylex.attrs(styles.laneViewSpan)}>{head()}</span>
        <Hint text={emptyText[props.lane]} />
      </header>
      <Show when={props.lane === "todo"}>
        <button
          type="button"
          data-testid="issue-new"
          onClick={() => p().onNew()}
          aria-label={t("web.issue.new.title")}
          {...stylex.attrs(styles.laneViewButton)}
        >
          <Icon name="add" size={14} />
          {t("web.issue.new.card")}
        </button>
      </Show>
      <div {...stylex.attrs(styles.laneViewDiv)}>
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
                    // Anything but manual hides the user's order of todo, so a card cannot be dropped between two there.
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
            <p {...stylex.attrs(styles.laneViewP)}>{t("web.issue.reading")}</p>
          </Match>
          {/* The todo lane has its placeholder card: no second empty box under it. */}
          <Match when={props.cards.length === 0 && props.lane !== "todo"}>
            <div data-testid="lane-empty" {...stylex.attrs(styles.laneViewDiv2, over() ? styles.laneViewDivTone : styles.laneViewDivAlt)} />
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
        <div {...stylex.attrs(styles.cardViewDiv2)} />
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
        {...styleProps([
          stylex.defaultMarker(),
          cardStyles.card,
          props.selected ? cardStyles.selected : cardStyles.idle,
          props.drag.dragging()?.id === props.card.id && cardStyles.dragging,
          props.card.move?.state === "moving" && cardStyles.moving,
        ])}
      >
        <Show when={where()}>
          <div {...stylex.attrs(styles.cardViewDiv22)}>{where()}</div>
        </Show>
        <div {...stylex.attrs(styles.cardViewDiv)}>{look().title}</div>
        {/* Only what differs from the lane's default: its own status, a high priority, who works it, how far, its flags. */}
        <Show when={marks()}>
          <div data-testid="card-marks" {...stylex.attrs(styles.cardMarks)}>
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
          <div data-testid="move-failed" {...stylex.attrs(styles.moveFailed)}>
            <span {...stylex.attrs(styles.cardViewSpan)} title={m().reason}>
              {m().reason ?? t("web.issue.board.moveFailed")}
            </span>
            <button
              type="button"
              data-testid="move-retry"
              aria-label={t("web.issue.board.retryMove")}
              title={t("web.issue.board.retryMove")}
              onClick={() => props.onRetry(props.card)}
              {...stylex.attrs(styles.moveRetry)}
            >
              <Icon name="retry" size={14} />
            </button>
            <button
              type="button"
              data-testid="move-put-back"
              aria-label={t("web.issue.board.putBack")}
              title={t("web.issue.board.putBack")}
              onClick={() => props.onPutBack(props.card)}
              {...stylex.attrs(styles.moveRetry)}
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
  return <p {...stylex.attrs(styles.emptyNoteP)}>{props.children}</p>;
}
