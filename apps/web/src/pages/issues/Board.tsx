import { createSignal, For, Match, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";
import { maxRunning } from "@vibevalley/protocol";
import type { Ordering } from "../../rules/board";
import { type BoardCard, cardLook, cardMove, cardProject, laneOrder } from "../../rules/cards";
import { closedShown, type Lane, laneLabel, lanes, laneStatus } from "../../rules/issues";
import { autofocus } from "../../app/util";
import { Icon } from "../../ui/Icon";
import { Segmented } from "../../ui/Segmented";
import { useGraphs, useNameOf } from "./hooks";
import { CardFace, FlagChip, PriorityMark, ProgressMark, StatusMark } from "./Marks";

export function IconButton(props: { icon: string; label: string; onClick: () => void; size?: number }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      onClick={() => props.onClick()}
      class="inline-flex size-6 cursor-pointer items-center justify-center rounded-md hover:bg-selected"
    >
      <Icon name={props.icon} size={props.size ?? 14} />
    </button>
  );
}

/** One sentence, enter, and it is a 待办: the board's lane and the list's groups both use it. */
export function QuickAdd(props: { onAdd: (text: string) => void; ref?: (el: HTMLInputElement) => void; autofocus?: boolean }) {
  const [text, setText] = createSignal("");
  const focus = autofocus<HTMLInputElement>();
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
      placeholder="＋ 写一张，回车存下"
      aria-label="写一张待办"
      class="h-8 w-full rounded-md border border-dashed border-line bg-page/70 px-2.5 text-sm outline-none placeholder:text-faint hover:border-faint focus:border-solid focus:border-focus focus:bg-page"
    />
  );
}

/** Under the closed ones: how many older are folded away, or back to the recent ones. */
export function OlderLink(props: { hidden: number; onClick: () => void }) {
  return (
    <button type="button" onClick={() => props.onClick()} class="mx-auto block cursor-pointer py-1 text-sm text-water hover:underline">
      {props.hidden > 0 ? `更早的 ${props.hidden} 张` : "只看最近的"}
    </button>
  );
}

const emptyText: Record<Lane, string> = {
  todo: "想到要做的先写在这里，拖到「处理中」就派人开工；上下拖排先后。",
  working: "没有在干的活。",
  waiting: "做完的、没做成的在这里等你看；拖到「已关」完成或取消。",
  closed: "已完成、已取消的工单；拖回「处理中」重开。",
};

export interface BoardProps {
  cards: BoardCard[];
  loading: boolean;
  selected?: string;
  older: boolean;
  ordering: Ordering;
  onOlder: () => void;
  onOpen: (id: string) => void;
  onDrop: (card: BoardCard, to: Lane) => void;
  onPlace: (card: BoardCard, before: string | undefined) => void;
  onAdd: (text: string) => void;
  onWrite: () => void;
}

type Drag = { dragging: () => BoardCard | null; setDragging: (c: BoardCard | null) => void };

/** Four lanes to drag between; narrower than 700, one lane at a time behind tabs. */
export function IssueBoard(props: BoardProps) {
  const [lane, setLane] = createSignal<Lane>("todo");
  const [dragging, setDragging] = createSignal<BoardCard | null>(null);
  let addInput: HTMLInputElement | undefined;
  const drag: Drag = { dragging, setDragging: (c) => setDragging(() => c) };
  return (
    <div class="@container flex min-h-0 flex-1 flex-col px-3 pb-3">
      <div class="mb-2 @min-[700px]:hidden">
        <Segmented
          label="看哪一列"
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
  const accepts = (c: BoardCard | null) => c !== null && (cardMove(c, props.lane) !== undefined || (props.lane === "todo" && c.kind === "todo"));
  const head = () => (props.lane === "working" ? `${props.cards.filter((c) => c.kind === "issue").length} / ${maxRunning} 个空位` : `${props.cards.length}`);
  return (
    <section
      aria-label={laneLabel[props.lane]}
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
        props.drag.setDragging(null);
      }}
      class={[
        "min-w-[220px] flex-1 flex-col rounded-[10px] border px-2 pt-1.5 pb-2",
        props.shownNarrow ? "flex" : "hidden @min-[700px]:flex",
        over() ? "border-leaf bg-leaf/15" : "border-transparent bg-hover",
      ]}
    >
      <header class="flex h-7 items-center gap-2 px-1">
        <StatusMark status={laneStatus[props.lane]} />
        <h2 class="text-sm font-semibold">{laneLabel[props.lane]}</h2>
        <span class="text-xs text-muted">{head()}</span>
        <Show when={props.lane === "todo"}>
          <span class="ml-auto flex">
            <IconButton icon="button-add" label="写一张" onClick={props.focusAdd} />
            <IconButton icon="button-edit" label="详细写一张" onClick={p().onWrite} />
          </span>
        </Show>
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
            <p class="px-1 text-xs text-faint">在读……</p>
          </Match>
          <Match when={props.cards.length === 0}>
            <p class="px-1 text-xs leading-relaxed text-faint">{emptyText[props.lane]}</p>
          </Match>
        </Switch>
      </div>
    </section>
  );
}

function CardView(props: { card: BoardCard; selected: boolean; onOpen: (id: string) => void; drag: Drag; onPlace?: (moved: BoardCard) => void }) {
  const nameOf = useNameOf();
  const graphs = useGraphs();
  const look = () => cardLook(props.card, nameOf(), graphs(), Date.now());
  const [before, setBefore] = createSignal(false);
  const where = () => [look().number, cardProject(props.card)].filter(Boolean).join(" · ");
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
        props.drag.setDragging(null);
      }}
    >
      <Show when={before()}>
        <div class="mb-1 h-0.5 rounded-full bg-leaf" />
      </Show>
      <div
        role="button"
        tabindex={0}
        aria-label={look().title}
        aria-current={props.selected ? "true" : undefined}
        title={look().detail}
        draggable={props.card.kind !== "task" && props.card.kind !== "orchestrator" && props.card.kind !== "missing" ? "true" : "false"}
        onDragStart={(e) => {
          e.dataTransfer!.effectAllowed = "move";
          e.dataTransfer!.setData("text/plain", props.card.id);
          props.drag.setDragging(props.card);
        }}
        onDragEnd={() => props.drag.setDragging(null)}
        onClick={() => props.onOpen(props.card.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            props.onOpen(props.card.id);
          }
        }}
        class={[
          "group cursor-pointer rounded-lg border px-2.5 pt-2 pb-2 transition-colors",
          props.selected ? "border-line bg-selected" : "border-line bg-page hover:border-[#2f1f132e] hover:shadow-[0_1px_3px_#2f1f1314]",
          { "opacity-40": props.drag.dragging()?.id === props.card.id },
        ]}
      >
        <Show when={where()}>
          <div class="truncate text-[11px] leading-[14px] text-muted">{where()}</div>
        </Show>
        <div class="mt-0.5 line-clamp-2 text-sm font-medium break-words">{look().title}</div>
        <div class="mt-2 flex flex-wrap items-center gap-1.5">
          <StatusMark status={look().status} tone={look().statusTone} size={13} />
          <Show when={look().priority}>{(pr) => <PriorityMark priority={pr()} size={13} />}</Show>
          <CardFace card={props.card} size={18} />
          <Show when={look().progress}>{(pg) => <ProgressMark done={pg().done} total={pg().total} />}</Show>
          <For each={look().flags}>{(f) => <FlagChip text={f.text} tone={f.tone} />}</For>
        </div>
      </div>
    </div>
  );
}

export function EmptyNote(props: { children: JSX.Element }) {
  return <p class="px-3 text-xs text-faint">{props.children}</p>;
}
