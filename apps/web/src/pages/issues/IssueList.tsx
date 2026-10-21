import { managerAgent } from "@vibevalley/protocol";
import { useState } from "react";
import { type Grouping, groupRows, type Ordering, orderRows, type RowGroup } from "../../rules/board";
import { type BoardCard, cardLook, cardProject, laneOrder, rowFacts } from "../../rules/cards";
import { closedShown, laneLabel, laneStatus } from "../../rules/issues";
import { ago } from "../../rules/time";
import { ManagerFace } from "../../ui/Face";
import { Icon } from "../../ui/Icon";
import { EmptyNote, IconButton, OlderLink, QuickAdd } from "./Board";
import { AgentFaceOf, CardFace, FlagChip, NoFaceMark, PriorityMark, ProgressMark, StatusMark } from "./Marks";
import { useGraphs, useNameOf } from "./hooks";

/** The quick add, with the group's project or helper when grouped by one. */
export type ListAdd = (text: string, where: { project?: string; agent?: string }) => void;

/** The issues as rows, grouped as the owner picked: Linear's list. A row opens the issue as a card does. */
export function IssueList({
  cards,
  loading,
  selected,
  older,
  grouping,
  ordering,
  onOlder,
  onOpen,
  onAdd,
}: {
  cards: BoardCard[];
  loading: boolean;
  selected?: string;
  older: boolean;
  grouping: Grouping;
  ordering: Ordering;
  onOlder: () => void;
  onOpen: (id: string) => void;
  onAdd: ListAdd;
}) {
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<string | null>(null);
  const nameOf = useNameOf();
  if (loading) return <EmptyNote>在读……</EmptyNote>;

  // Only where a new 待办 belongs: the 待办 group, a project's, a helper's (not the manager's), or the one group.
  const canAdd = (g: RowGroup<BoardCard>) => (grouping === "status" ? g.lane === "todo" : grouping === "agent" ? g.key !== managerAgent : true);
  const add = (g: RowGroup<BoardCard>, text: string) => {
    setAdding(null);
    onAdd(text, grouping === "project" ? { project: g.key } : grouping === "agent" ? { agent: g.key } : {});
  };
  const fold = (key: string) =>
    setFolded((f) => {
      const n = new Set(f);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  return (
    <div className="@container min-h-0 flex-1 overflow-y-auto px-3 pb-3">
      {groupRows(cards, grouping, rowFacts).map((g) => {
        let rows = g.lane ? laneOrder(g.lane, g.rows, ordering) : orderRows(g.rows, ordering, rowFacts);
        let hidden = 0;
        if (g.lane === "closed" && !older && rows.length > closedShown) {
          hidden = rows.length - closedShown;
          rows = rows.slice(0, closedShown);
        }
        const isFolded = folded.has(g.key);
        const [label, icon] =
          grouping === "status"
            ? [laneLabel[g.lane!], <StatusMark status={laneStatus[g.lane!]} />]
            : grouping === "project"
              ? [g.key || "没有项目", <Icon name="button-folder" size={14} />]
              : grouping === "agent"
                ? [
                    g.key ? nameOf(g.key) : "还没选帮工",
                    !g.key ? <NoFaceMark size={14} /> : g.key === managerAgent ? <ManagerFace size={16} /> : <AgentFaceOf agent={g.key} size={16} />,
                  ]
                : ["全部工单", null];
        return (
          <section key={g.key || "_"} aria-label={label} className="mb-1">
            <header className="sticky top-0 z-10 mt-1.5 flex h-[34px] items-center rounded-md bg-side pr-1">
              <button
                type="button"
                onClick={() => fold(g.key)}
                aria-label={isFolded ? `展开 ${label}` : `收起 ${label}`}
                className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2.5 px-2.5 text-left"
              >
                <Icon name="button-next" size={10} className={isFolded ? "" : "rotate-90"} />
                {icon}
                <span className="truncate text-sm font-semibold">{label}</span>
                <span className="text-xs text-muted">{g.rows.length}</span>
              </button>
              {canAdd(g) && <IconButton icon="button-add" label={`在「${label}」写一张`} onClick={() => setAdding(adding === g.key ? null : g.key)} />}
            </header>
            {!isFolded && (
              <>
                {adding === g.key && (
                  <div className="px-3 py-1.5">
                    <QuickAdd autoFocus onAdd={(t) => add(g, t)} />
                  </div>
                )}
                {rows.map((c) => (
                  <Row key={c.id} card={c} selected={c.id === selected} showProject={grouping !== "project"} onOpen={onOpen} nameOf={nameOf} />
                ))}
                {(hidden > 0 || (g.lane === "closed" && older && g.rows.length > closedShown)) && <OlderLink hidden={hidden} onClick={onOlder} />}
                {g.rows.length === 0 && adding !== g.key && <p className="py-1.5 pr-3 pl-9 text-xs text-faint">没有工单</p>}
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}

function Row({
  card,
  selected,
  showProject,
  onOpen,
  nameOf,
}: {
  card: BoardCard;
  selected: boolean;
  showProject: boolean;
  onOpen: (id: string) => void;
  nameOf: (id: string) => string;
}) {
  const graphs = useGraphs();
  const now = Date.now();
  const look = cardLook(card, nameOf, graphs, now);
  const project = cardProject(card);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={look.title}
      aria-current={selected || undefined}
      title={look.detail}
      onClick={() => onOpen(card.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen(card.id);
      }}
      className={`flex h-[38px] cursor-pointer items-center gap-2.5 rounded-md px-2.5 ${selected ? "bg-selected" : "hover:bg-hover"}`}
    >
      <span className="flex w-3.5 shrink-0 justify-center">{look.priority && <PriorityMark priority={look.priority} size={13} />}</span>
      <span className="hidden w-11 shrink-0 truncate text-xs text-muted @min-[640px]:block">{look.number}</span>
      <StatusMark status={look.status} tone={look.statusTone} size={13} />
      <span className="min-w-0 flex-1 truncate text-sm">{look.title}</span>
      {look.progress && <ProgressMark {...look.progress} />}
      {look.flags.map((f, i) => (
        <span key={f.text} className={i > 0 ? "hidden @min-[640px]:inline" : ""}>
          <FlagChip {...f} />
        </span>
      ))}
      {showProject && project && <span className="hidden max-w-[120px] truncate text-xs text-muted @min-[640px]:block">{project}</span>}
      <span className="flex w-[18px] shrink-0 justify-center">
        <CardFace card={card} size={18} />
      </span>
      <span className="w-14 shrink-0 text-right text-xs text-muted @min-[640px]:w-[72px]">{ago(rowFacts(card).updatedAt, now)}</span>
    </div>
  );
}
