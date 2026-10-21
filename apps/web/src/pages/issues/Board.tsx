import { maxRunning } from "@vibevalley/protocol";
import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import type { Ordering } from "../../rules/board";
import { type BoardCard, cardLook, cardMove, cardProject, laneOrder } from "../../rules/cards";
import { closedShown, type Lane, laneLabel, lanes, laneStatus } from "../../rules/issues";
import { Icon } from "../../ui/Icon";
import { CardFace, FlagChip, PriorityMark, ProgressMark, StatusMark } from "./Marks";
import { useNameOf, useGraphs } from "./hooks";
import { Segmented } from "../../ui/Segmented";

export function IconButton({ icon, label, onClick, size = 14 }: { icon: string; label: string; onClick: () => void; size?: number }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md hover:bg-selected"
    >
      <Icon name={icon} size={size} />
    </button>
  );
}

/** One sentence, enter, and it is a 待办: the board's lane and the list's groups both use it. */
export function QuickAdd({
  onAdd,
  inputRef,
  autoFocus = false,
}: {
  onAdd: (text: string) => void;
  inputRef?: React.Ref<HTMLInputElement>;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  const submit = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    const t = text.trim();
    if (!t) return;
    setText("");
    onAdd(t);
  };
  return (
    <input
      ref={inputRef}
      value={text}
      autoFocus={autoFocus}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={submit}
      placeholder="＋ 写一张，回车存下"
      aria-label="写一张待办"
      className="h-8 w-full rounded-md border border-dashed border-line bg-page/70 px-2.5 text-sm outline-none placeholder:text-faint hover:border-faint focus:border-solid focus:border-focus focus:bg-page"
    />
  );
}

/** Under the closed ones: how many older are folded away, or back to the recent ones. */
export function OlderLink({ hidden, onClick }: { hidden: number; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="mx-auto block cursor-pointer py-1 text-sm text-water hover:underline">
      {hidden > 0 ? `更早的 ${hidden} 张` : "只看最近的"}
    </button>
  );
}

const emptyText: Record<Lane, string> = {
  todo: "想到要做的先写在这里，拖到「处理中」就派人开工；上下拖排先后。",
  working: "没有在干的活。",
  waiting: "做完的、没做成的在这里等你看；拖到「已关」收获或收工。",
  closed: "关了的工单；拖回「处理中」重开。",
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

/** Four lanes to drag between; narrower than 700, one lane at a time behind tabs. */
export function IssueBoard(props: BoardProps) {
  const [lane, setLane] = useState<Lane>("todo");
  const [dragging, setDragging] = useState<BoardCard | null>(null);
  const addRef = useRef<HTMLInputElement>(null);
  return (
    <div className="@container flex min-h-0 flex-1 flex-col px-3 pb-3">
      <div className="mb-2 @min-[700px]:hidden">
        <Segmented
          label="看哪一列"
          block
          value={lane}
          onChange={setLane}
          options={lanes.map((l) => ({ value: l, label: `${laneLabel[l]} ${props.cards.filter((c) => c.lane === l).length}` }))}
        />
      </div>
      <div className="flex min-h-0 flex-1 gap-2.5 overflow-x-auto">
        {lanes.map((l) => (
          <LaneView
            key={l}
            {...props}
            lane={l}
            shownNarrow={l === lane}
            cards={props.cards.filter((c) => c.lane === l)}
            dragging={dragging}
            setDragging={setDragging}
            addRef={addRef}
          />
        ))}
      </div>
    </div>
  );
}

function LaneView({
  lane,
  cards,
  shownNarrow,
  dragging,
  setDragging,
  addRef,
  ...p
}: BoardProps & {
  lane: Lane;
  shownNarrow: boolean;
  dragging: BoardCard | null;
  setDragging: (c: BoardCard | null) => void;
  addRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [over, setOver] = useState(false);
  let shown = laneOrder(lane, cards, p.ordering);
  let hidden = 0;
  if (lane === "closed" && !p.older && shown.length > closedShown) {
    hidden = shown.length - closedShown;
    shown = shown.slice(0, closedShown);
  }
  const accepts = (c: BoardCard | null) => c !== null && (cardMove(c, lane) !== undefined || (lane === "todo" && c.kind === "todo"));
  const head = lane === "working" ? `${cards.filter((c) => c.kind === "issue").length} / ${maxRunning} 块地` : `${cards.length}`;
  return (
    <section
      aria-label={laneLabel[lane]}
      onDragOver={(e) => {
        if (!accepts(dragging)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (dragging && accepts(dragging)) p.onDrop(dragging, lane);
        setDragging(null);
      }}
      className={`min-w-[220px] flex-1 flex-col rounded-[10px] border px-2 pt-1.5 pb-2 ${shownNarrow ? "flex" : "hidden @min-[700px]:flex"} ${over ? "border-leaf bg-leaf/15" : "border-transparent bg-hover"}`}
    >
      <header className="flex h-7 items-center gap-2 px-1">
        <StatusMark status={laneStatus[lane]} />
        <h2 className="text-sm font-semibold">{laneLabel[lane]}</h2>
        <span className="text-xs text-muted">{head}</span>
        {lane === "todo" && (
          <span className="ml-auto flex">
            <IconButton icon="button-add" label="写一张" onClick={() => addRef.current?.focus()} />
            <IconButton icon="button-edit" label="详细写一张" onClick={p.onWrite} />
          </span>
        )}
      </header>
      {lane === "todo" && (
        <div className="mt-1.5">
          <QuickAdd onAdd={p.onAdd} inputRef={addRef} />
        </div>
      )}
      <div className="mt-2 flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
        {p.loading ? (
          <p className="px-1 text-xs text-faint">在读……</p>
        ) : cards.length === 0 ? (
          <p className="px-1 text-xs leading-relaxed text-faint">{emptyText[lane]}</p>
        ) : (
          <>
            {shown.map((c) => (
              <CardView
                key={c.id}
                card={c}
                selected={c.id === p.selected}
                onOpen={p.onOpen}
                dragging={dragging}
                setDragging={setDragging}
                // Anything but manual hides the owner's order of 待办, so a card cannot be dropped between two there.
                onPlace={c.kind === "todo" && p.ordering === "manual" ? (moved) => p.onPlace(moved, c.id) : undefined}
              />
            ))}
            {(hidden > 0 || (lane === "closed" && p.older && cards.length > closedShown)) && <OlderLink hidden={hidden} onClick={p.onOlder} />}
          </>
        )}
      </div>
    </section>
  );
}

function CardView({
  card,
  selected,
  onOpen,
  dragging,
  setDragging,
  onPlace,
}: {
  card: BoardCard;
  selected: boolean;
  onOpen: (id: string) => void;
  dragging: BoardCard | null;
  setDragging: (c: BoardCard | null) => void;
  onPlace?: (moved: BoardCard) => void;
}) {
  const nameOf = useNameOf();
  const graphs = useGraphs();
  const look = cardLook(card, nameOf, graphs, Date.now());
  const [before, setBefore] = useState(false);
  const where = [look.number, cardProject(card)].filter(Boolean).join(" · ");
  const placing = onPlace && dragging?.kind === "todo" && dragging.id !== card.id;
  return (
    <div
      onDragOver={(e) => {
        if (!placing) return;
        e.preventDefault();
        e.stopPropagation();
        setBefore(true);
      }}
      onDragLeave={() => setBefore(false)}
      onDrop={(e) => {
        if (!placing || !dragging) return;
        e.preventDefault();
        e.stopPropagation();
        setBefore(false);
        onPlace(dragging);
        setDragging(null);
      }}
    >
      {before && <div className="mb-1 h-0.5 rounded-full bg-leaf" />}
      <div
        role="button"
        tabIndex={0}
        aria-label={look.title}
        aria-current={selected || undefined}
        title={look.detail}
        draggable={card.kind !== "task" && card.kind !== "manager" && card.kind !== "missing"}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", card.id);
          setDragging(card);
        }}
        onDragEnd={() => setDragging(null)}
        onClick={() => onOpen(card.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen(card.id);
          }
        }}
        className={`group cursor-pointer rounded-lg border px-2.5 pt-2 pb-2 transition-colors ${
          selected ? "border-line bg-selected" : "border-line bg-page hover:border-[#2f1f132e] hover:shadow-[0_1px_3px_#2f1f1314]"
        } ${dragging?.id === card.id ? "opacity-40" : ""}`}
      >
        {where && <div className="truncate text-[11px] leading-[14px] text-muted">{where}</div>}
        <div className="mt-0.5 line-clamp-2 text-sm font-medium break-words">{look.title}</div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <StatusMark status={look.status} tone={look.statusTone} size={13} />
          {look.priority && <PriorityMark priority={look.priority} size={13} />}
          <CardFace card={card} size={18} />
          {look.progress && <ProgressMark {...look.progress} />}
          {look.flags.map((f) => (
            <FlagChip key={f.text} {...f} />
          ))}
        </div>
      </div>
    </div>
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="px-3 text-xs text-faint">{children}</p>;
}
