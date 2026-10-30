import { t } from "@vibevalley/i18n";

import { createSignal, For, Match, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";
import { maxRunning } from "@vibevalley/protocol";
import type { Ordering } from "./display";
import { type BoardCard, cardAgent, cardLook, cardMove, cardProject, laneOrder } from "./cards";
import { closedShown, type Lane, laneLabel, lanes, laneStatus, ownStatus } from "./lanes";
import { autofocus } from "@/base/util";
import { Hint } from "@/ui/Tip";
import { Segmented } from "@/ui/Segmented";
import { useGraphs, useNameOf } from "./queries";
import { CardFace, FlagChip, PriorityMark, ProgressMark, StatusMark } from "./Marks";

/** One sentence, enter, and it is a 待办: the board's lane and the list's groups both use it. */
export function QuickAdd(props: { onAdd: (text: string) => void; ref?: (el: HTMLInputElement) => void; autofocus?: boolean }) {
  const [text, setText] = createSignal("");
  const focus = autofocus();
  const submit = (e: KeyboardEvent) => {
    if (e.key !== "Enter" || e.isComposing) return;
    const t = text().trim();
    if (!t) return;
    setText("");
    props.onAdd(t);
  };
  return (
    <input
      ref={(el) => {
        props.ref?.(el);
        if (props.autofocus) focus(el);
      }}
      value={text()}
      onInput={(e) => setText(e.currentTarget.value)}
      onKeyDown={submit}
      data-testid="quick-add"
      placeholder={t("web.issue.board.add")}
      aria-label={t("web.issue.board.addLabel")}
      class="h-8 w-full rounded-md border border-dashed border-line bg-page/70 px-2.5 text-sm outline-none placeholder:text-faint hover:border-faint focus:border-solid focus:border-focus focus:bg-page"
    />
  );
}

/** Under the closed ones: how many older are folded away, or back to the recent ones. */
export function OlderLink(props: { hidden: number; onClick: () => void }) {
  return (
    <button type="button" onClick={() => props.onClick()} class="mx-auto block cursor-pointer py-1 text-sm text-water hover:underline">
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

export interface BoardProps {
  cards: BoardCard[];
  loading: boolean;
  selected?: string | undefined;
  older: boolean;
  ordering: Ordering;
  onOlder: () => void;
  onOpen: (id: string) => void;
  onDrop: (card: BoardCard, to: Lane) => void;
  onPlace: (card: BoardCard, before: string | undefined) => void;
  onAdd: (text: string) => void;
  onWrite: () => void;
}

type Drag = { dragging: () => BoardCard | undefined; setDragging: (c: BoardCard | undefined) => void };

/** Four lanes to drag between; narrower than 700, one lane at a time behind tabs. */
export function IssueBoard(props: BoardProps) {
  const [lane, setLane] = createSignal<Lane>("todo");
  const [dragging, setDragging] = createSignal<BoardCard>();
  let addInput: HTMLInputElement | undefined;
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
      <div class="flex min-h-0 flex-1 gap-2.5 overflow-x-auto">
        <For each={lanes}>
          {(l) => (
            <LaneView
              board={props}
              lane={l}
              shownNarrow={l === lane()}
              cards={props.cards.filter((c) => c.lane === l)}
              drag={drag}
              addRef={(el) => (addInput = el)}
              focusAdd={() => addInput?.focus()}
            />
          )}
        </For>
      </div>
    </div>
  );
}

function LaneView(props: {
  board: BoardProps;
  lane: Lane;
  cards: BoardCard[];
  shownNarrow: boolean;
  drag: Drag;
  addRef: (el: HTMLInputElement) => void;
  focusAdd: () => void;
}) {
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
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
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
      <header class="flex h-7 items-center gap-2 px-1">
        <StatusMark status={laneStatus[props.lane]} />
        <h2 class="text-sm font-semibold">{laneLabel[props.lane]}</h2>
        <span class="text-xs text-muted">{head()}</span>
        <Hint text={emptyText[props.lane]} />
      </header>
      <Show when={props.lane === "todo"}>
        <div class="mt-1.5">
          <QuickAdd onAdd={(t) => p().onAdd(t)} ref={props.addRef} />
        </div>
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
                    drag={props.drag}
                    // Anything but manual hides the owner's order of 待办, so a card cannot be dropped between two there.
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
            <p class="px-1 text-xs text-faint">{t("web.issue.reading")}</p>
          </Match>
          <Match when={props.cards.length === 0}>
            <div data-testid="lane-empty" class={["h-12 rounded-md border border-dashed", over() ? "border-leaf" : "border-line"]} />
          </Match>
        </Switch>
      </div>
    </section>
  );
}

function CardView(props: { card: BoardCard; selected: boolean; onOpen: (id: string) => void; drag: Drag; onPlace?: ((moved: BoardCard) => void) | undefined }) {
  const nameOf = useNameOf();
  const graphs = useGraphs();
  const look = () => cardLook(props.card, nameOf(), graphs(), Date.now());
  const [before, setBefore] = createSignal(false);
  const where = () => [look().number, cardProject(props.card)].filter(Boolean).join(" · ");
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
        <div class="mb-1 h-0.5 rounded-full bg-leaf" />
      </Show>
      <div
        role="button"
        tabindex={0}
        data-testid="issue-card"
        data-key={props.card.id}
        data-kind={props.card.kind}
        aria-label={look().title}
        aria-current={props.selected ? "true" : undefined}
        title={look().detail}
        draggable={props.card.kind !== "task" && props.card.kind !== "orchestrator" && props.card.kind !== "missing" ? "true" : "false"}
        onDragStart={(e) => {
          e.dataTransfer!.effectAllowed = "move";
          e.dataTransfer!.setData("text/plain", props.card.id);
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
          { "opacity-40": props.drag.dragging()?.id === props.card.id },
        ]}
      >
        <Show when={where()}>
          <div class="truncate text-2xs leading-[14px] text-muted">{where()}</div>
        </Show>
        <div class="mt-0.5 line-clamp-2 text-sm font-medium break-words">{look().title}</div>
        {/* Only what differs from the lane's default: its own status, a high priority, who works it, how far, its flags. */}
        <Show when={marks()}>
          <div data-testid="card-marks" class="mt-2 flex flex-wrap items-center gap-1.5">
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
    </div>
  );
}

export function EmptyNote(props: { children: JSX.Element }) {
  return <p class="px-3 text-xs text-faint">{props.children}</p>;
}
