import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import type { Issue, Session } from "@vibevalley/protocol";
import { api, reasonOf } from "../../data/api";
import { useCore } from "../../data/frame";
import { type BoardLook, boardViews, defaultLook, lookFromList, lookToList, viewLabel } from "../../rules/board";
import { type BoardCard, type BoardFilter, buildCards, cardAgent, cardMove, cardProject, filterAny, filterShows, noFilter } from "../../rules/cards";
import { issueIs, type Lane } from "../../rules/issues";
import { Icon } from "../../ui/Icon";
import { useToast } from "../../ui/Toast";
import { Segmented } from "../../ui/Segmented";
import { IconButton, IssueBoard } from "./Board";
import { CloseIssueDialog, ReopenDialog } from "./CloseDialog";
import { useIssueHistory, useRun, writeIssue } from "./data";
import { DisplayMenu } from "./DisplayMenu";
import { useGraphs, useNameOf } from "./hooks";
import { IssueDetail, ManagerIssueDetail } from "./IssueDetail";
import { IssueList, type ListAdd } from "./IssueList";
import { TaskDetail } from "./TaskDetail";
import { TodoDetail, useDispatchedNotice } from "./TodoDetail";

const lookKey = "vibevalley.board.look";

function loadLook(): BoardLook {
  try {
    return lookFromList(JSON.parse(localStorage.getItem(lookKey) ?? "null"));
  } catch {
    return defaultLook;
  }
}

function saveLook(look: BoardLook) {
  try {
    localStorage.setItem(lookKey, JSON.stringify(lookToList(look)));
  } catch {
    // No storage: the look lasts for this visit.
  }
}

export function IssuesPage() {
  const id = useParams()["*"] || undefined;
  const navigate = useNavigate();
  const core = useCore();
  const graphs = useGraphs();
  const toast = useToast();
  const run = useRun();
  const [filter, setFilter] = useState<BoardFilter>(noFilter);
  const [older, setOlder] = useState(false);
  const [look, setLookState] = useState(loadLook);
  const [closing, setClosing] = useState<{ issue: Issue; session: Session; review: boolean } | null>(null);
  const [reopening, setReopening] = useState<Issue | null>(null);
  const history = useIssueHistory(older);

  const setLook = (l: BoardLook) => {
    setLookState(l);
    saveLook(l);
  };
  const open = (to: string | undefined) => navigate(to === undefined ? "/issues" : `/issues/${encodeURIComponent(to)}`);
  const notice = useDispatchedNotice(open);

  const all = useMemo(() => buildCards(history.rows ?? [], core, graphs), [history.rows, core, graphs]);
  const shown = all.filter((c) => filterShows(filter, c));
  const card = id === undefined ? undefined : all.find((c) => c.id === id || (c.kind === "issue" && issueIs(c.issue, id)));

  const place = async (c: BoardCard, before: string | undefined) => {
    if (c.id === before) return;
    await run(() => api.issue.move({ id: c.id, body: { before } }));
  };

  /** Asked about first where it cannot be undone. A 待办 dropped back on its own lane goes last. */
  const drop = async (c: BoardCard, to: Lane) => {
    if (c.kind === "todo" && to === "todo") return place(c, undefined);
    const move = cardMove(c, to);
    if (move === "start" && c.kind === "todo") {
      if (!c.issue.assignee || !c.issue.project) {
        void open(c.id);
        toast("还差一点：选好派哪个帮工、在哪个项目里做，再点「开工」。");
        return;
      }
      const got = await run(() => api.issue.status({ id: c.id, body: { status: "todo" } }));
      if (got) notice(got);
    } else if (move === "close" && c.kind === "issue" && c.session) setClosing({ issue: c.issue, session: c.session, review: false });
    else if (move === "reopen" && c.kind === "issue") setReopening(c.issue);
  };

  const add = async (text: string, where: { project?: string; agent?: string } = {}) => {
    const made = await run(() => writeIssue(text, where.agent || filter.agent, where.project || filter.project));
    if (!made) return;
    if (made.refused) toast(`先没起草：${made.refused}`);
    void open(made.issue.id);
  };
  const addInList: ListAdd = (text, where) => void add(text, where);
  const write = () => void add("");

  return (
    <div className="relative flex h-full flex-col">
      {history.error && <p className="px-3 pt-2 text-sm text-berry">工单记录没读到：{reasonOf(history.error)}</p>}
      <Toolbar filter={filter} cards={all} shown={shown.length} onFilter={setFilter} look={look} onLook={setLook} />
      {look.view === "board" ? (
        <IssueBoard
          cards={shown}
          loading={history.loading}
          selected={card?.id ?? id}
          older={older}
          ordering={look.ordering}
          onOlder={() => setOlder(!older)}
          onOpen={open}
          onDrop={(c, to) => void drop(c, to)}
          onPlace={(c, before) => void place(c, before)}
          onAdd={(t) => void add(t)}
          onWrite={write}
        />
      ) : (
        <IssueList
          cards={shown}
          loading={history.loading}
          selected={card?.id ?? id}
          older={older}
          grouping={look.grouping}
          ordering={look.ordering}
          onOlder={() => setOlder(!older)}
          onOpen={open}
          onAdd={addInList}
        />
      )}
      {id !== undefined && (
        <Overlay onClose={() => open(undefined)}>
          <Detail
            id={id}
            card={card}
            known={!history.loading && history.rows !== undefined}
            rows={history.rows ?? []}
            open={open}
            onClose={(issue, session, review) => setClosing({ issue, session, review })}
          />
        </Overlay>
      )}
      {closing && <CloseIssueDialog {...closing} onClose={() => setClosing(null)} />}
      {reopening && <ReopenDialog issue={reopening} onClose={() => setReopening(null)} onReopened={() => open(reopening.id)} />}
    </div>
  );
}

function Detail({
  id,
  card,
  known,
  rows,
  open,
  onClose,
}: {
  id: string;
  card: BoardCard | undefined;
  known: boolean;
  rows: { issue: Issue }[];
  open: (id: string | undefined) => void;
  onClose: (issue: Issue, session: Session, review: boolean) => void;
}) {
  if (!card) {
    if (!known) return <p className="text-sm text-muted">在读……</p>;
    // A link to an issue the farm does not have says so, instead of quietly showing the board.
    return (
      <div>
        <h1 className="text-lg font-semibold">找不到这张工单</h1>
        <p className="mt-3 text-sm text-muted">农场里没有 {id}：可能已经删掉了，或者链接写错了。</p>
      </div>
    );
  }
  switch (card.kind) {
    case "todo":
      return <TodoDetail key={card.id} item={card.issue} onDone={open} />;
    case "issue":
      return (
        <IssueDetail
          key={card.sessions[card.sessions.length - 1]!.id}
          issue={card.issue}
          sessions={card.sessions}
          tag={card.tag}
          session={card.session}
          onClose={(session, review) => onClose(card.issue, session, review)}
          onTask={card.issue.parent ? () => open(`task:${card.issue.parent}`) : undefined}
        />
      );
    case "manager":
      return <ManagerIssueDetail key={card.id} issue={card.issue} />;
    case "missing":
      return (
        <div>
          <h1 className="text-xl font-semibold">{card.issue.title}</h1>
          <p className="mt-3 text-sm">执行记录缺失：{card.missing.join("、")}。执行动作暂不可用。</p>
        </div>
      );
    case "task": {
      const steps: Record<string, string> = {};
      for (const r of rows) if (r.issue.parent === card.graph.id && r.issue.task && r.issue.sessions.length > 0) steps[r.issue.task.key] = r.issue.id;
      return <TaskDetail key={card.graph.id} graph={card.graph} stepIssues={steps} onOpen={open} />;
    }
  }
}

/** The detail over the board, sharing its URL: Escape or a click beside it goes back to the board. */
function Overlay({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      // A dialog over the detail closes first.
      if (e.key === "Escape" && !document.querySelector("dialog[open]")) onClose();
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div
      className="absolute inset-0 z-20 flex justify-center overflow-y-auto bg-[#2f1f1333] px-3 py-6 sm:px-6"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="工单"
        className="relative h-fit w-full max-w-[1080px] rounded-xl border border-line bg-page px-6 py-5 shadow-float"
      >
        <div className="absolute top-3 right-3">
          <IconButton icon="button-close" label="关掉" onClick={onClose} />
        </div>
        {children}
      </div>
    </div>
  );
}

function Toolbar({
  filter,
  cards,
  shown,
  onFilter,
  look,
  onLook,
}: {
  filter: BoardFilter;
  cards: BoardCard[];
  shown: number;
  onFilter: (f: BoardFilter) => void;
  look: BoardLook;
  onLook: (l: BoardLook) => void;
}) {
  const nameOf = useNameOf();
  const projects = [...new Set(cards.map(cardProject).filter((p): p is string => !!p))].sort();
  const agents = [...new Set(cards.map(cardAgent).filter((a): a is string => !!a))].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  const select = "h-7 max-w-[150px] cursor-pointer rounded-md border border-line bg-page px-2 text-sm outline-none hover:bg-hover focus:border-focus";
  return (
    // Narrow, the views go on their own line above the filters, at the right where the 显示 panel opens leftwards.
    <div className="@container px-3 pt-3 pb-2.5">
      <div className="flex flex-col-reverse gap-2 @min-[760px]:flex-row @min-[760px]:items-center">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <label className="flex h-7 w-60 items-center gap-1.5 rounded-md border border-line bg-page px-2 focus-within:border-focus">
            <Icon name="button-search" size={14} />
            <input
              value={filter.query}
              onChange={(e) => onFilter({ ...filter, query: e.target.value })}
              placeholder="找工单：标题、帮工、项目"
              aria-label="找工单"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
            />
          </label>
          <Icon name="button-filter" size={16} label="筛选" />
          <select aria-label="按项目看" value={filter.project} onChange={(e) => onFilter({ ...filter, project: e.target.value })} className={select}>
            <option value="">所有项目</option>
            {projects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <select aria-label="按帮工看" value={filter.agent} onChange={(e) => onFilter({ ...filter, agent: e.target.value })} className={select}>
            <option value="">所有帮工</option>
            {agents.map((a) => (
              <option key={a} value={a}>
                {nameOf(a)}
              </option>
            ))}
          </select>
          {filterAny(filter) && (
            <>
              <span className="text-xs text-muted">
                {shown} / {cards.length} 张
              </span>
              <button type="button" onClick={() => onFilter(noFilter)} className="cursor-pointer text-sm text-water hover:underline">
                清掉筛选
              </button>
            </>
          )}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <Segmented
            label="看法"
            value={look.view}
            onChange={(view) => onLook({ ...look, view })}
            options={boardViews.map((v) => ({ value: v, label: viewLabel[v] }))}
          />
          <DisplayMenu look={look} onChange={onLook} />
        </div>
      </div>
    </div>
  );
}
