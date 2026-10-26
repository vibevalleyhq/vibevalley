import { issuesWording } from "./words";
import { createMemo, createSignal, For, Match, onSettled, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { Issue, Session } from "@vibevalley/protocol";
import { api, reasonOf } from "../../data/api";
import { writeIssue } from "./write";
import { type BoardLook, boardViews, defaultLook, lookFromList, lookToList, viewLabel } from "../../rules/board";
import { type BoardCard, type BoardFilter, buildCards, cardAgent, cardMove, cardProject, filterAny, filterShows, noFilter } from "../../rules/cards";
import { issueIs, type Lane } from "../../rules/issues";
import { toast } from "../../ui/toasts";
import { useRouter } from "../../app/router";
import { useSelectValue } from "../../app/util";
import { useCore } from "../../data/frame";
import { useIssueHistory } from "../../data/issues";
import { Icon } from "../../ui/Icon";
import { Segmented } from "../../ui/Segmented";
import { IconButton, IssueBoard } from "./Board";
import { CloseIssueDialog, ReopenDialog } from "./CloseDialog";
import { DisplayMenu } from "./DisplayMenu";
import { run, useGraphs, useNameOf } from "./hooks";
import { IssueDetail, OrchestratorIssueDetail } from "./IssueDetail";
import { IssueList, type ListAdd } from "./IssueList";
import { TaskDetail } from "./TaskDetail";
import { dispatchedNotice, TodoDetail } from "./TodoDetail";

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

type Closing = { issue: Issue; session: Session; review: boolean };

/** `rest` is the path after /issues/. */
export function IssuesPage(props: { rest: string }) {
  const router = useRouter();
  const core = useCore();
  const graphs = useGraphs();
  const id = () => props.rest || undefined;
  const [filter, setFilter] = createSignal<BoardFilter>(noFilter);
  const [older, setOlder] = createSignal(false);
  const [look, setLookState] = createSignal(loadLook());
  const [closing, setClosing] = createSignal<Closing | null>(null);
  const [reopening, setReopening] = createSignal<Issue | null>(null);
  const history = useIssueHistory(older);

  const setLook = (l: BoardLook) => {
    setLookState(l);
    saveLook(l);
  };
  const open = (to: string | undefined) => router.navigate(to === undefined ? "/issues" : `/issues/${encodeURIComponent(to)}`);
  const notice = dispatchedNotice(open);

  const all = createMemo(() => buildCards(history.rows() ?? [], core(), graphs()));
  const shown = () => all().filter((c) => filterShows(filter(), c));
  const card = () => {
    const at = id();
    return at === undefined ? undefined : all().find((c) => c.id === at || (c.kind === "issue" && issueIs(c.issue, at)));
  };

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
        open(c.id);
        toast(issuesWording().page.pickFirst);
        return;
      }
      const got = await run(() => api.issue.status({ id: c.id, body: { status: "todo" } }));
      if (got) notice(got);
    } else if (move === "close" && c.kind === "issue" && c.session) setClosing({ issue: c.issue, session: c.session, review: false });
    else if (move === "reopen" && c.kind === "issue") setReopening(() => c.issue);
  };

  const add = async (text: string, where: { project?: string; agent?: string } = {}) => {
    const f = filter();
    const made = await run(() => writeIssue(text, where.agent || f.agent, where.project || f.project));
    if (!made) return;
    if (made.refused) toast(issuesWording().page.notDrafted(made.refused));
    open(made.issue.id);
  };
  const addInList: ListAdd = (text, where) => void add(text, where);
  const write = () => void add("");

  return (
    <div class="relative flex h-full flex-col">
      <Show when={history.error()}>
        <p class="px-3 pt-2 text-sm text-berry">
          {issuesWording().page.historyUnread}
          {reasonOf(history.error())}
        </p>
      </Show>
      <Toolbar filter={filter()} cards={all()} shown={shown().length} onFilter={setFilter} look={look()} onLook={setLook} />
      <Show
        when={look().view === "board"}
        fallback={
          <IssueList
            cards={shown()}
            loading={history.loading()}
            selected={card()?.id ?? id()}
            older={older()}
            grouping={look().grouping}
            ordering={look().ordering}
            onOlder={() => setOlder(!older())}
            onOpen={open}
            onAdd={addInList}
          />
        }
      >
        <IssueBoard
          cards={shown()}
          loading={history.loading()}
          selected={card()?.id ?? id()}
          older={older()}
          ordering={look().ordering}
          onOlder={() => setOlder(!older())}
          onOpen={open}
          onDrop={(c, to) => void drop(c, to)}
          onPlace={(c, before) => void place(c, before)}
          onAdd={(t) => void add(t)}
          onWrite={write}
        />
      </Show>
      {/* Keyed by the id, a plain value; the detail keeps the card it last found (see Detail). */}
      <Show when={id()} keyed>
        {(at) => (
          <Overlay onClose={() => open(undefined)}>
            <Detail
              id={at}
              cards={all}
              known={!history.loading() && history.rows() !== undefined}
              rows={history.rows() ?? []}
              open={open}
              onClose={(issue, session, review) => setClosing({ issue, session, review })}
            />
          </Overlay>
        )}
      </Show>
      <Show when={closing()}>{(c) => <CloseIssueDialog issue={c().issue} session={c().session} review={c().review} onClose={() => setClosing(null)} />}</Show>
      <Show when={reopening()}>{(issue) => <ReopenDialog issue={issue()} onClose={() => setReopening(null)} onReopened={() => open(issue().id)} />}</Show>
    </div>
  );
}

type CardOf<K extends BoardCard["kind"]> = Extract<BoardCard, { kind: K }>;

/**
 * The open card. It is the last one found by the id, so it stays while the board is read again and while the overlay
 * closes: its panels' queries may still be settling then, and a read through a narrowed accessor would halt the page.
 * Each panel is keyed by what it shows, a plain value, for the same reason.
 */
function Detail(props: {
  id: string;
  cards: () => BoardCard[];
  known: boolean;
  rows: { issue: Issue }[];
  open: (id: string | undefined) => void;
  onClose: (issue: Issue, session: Session, review: boolean) => void;
}) {
  const card = createMemo<BoardCard | undefined>(
    (last) => props.cards().find((c) => c.id === props.id || (c.kind === "issue" && issueIs(c.issue, props.id))) ?? last,
  );
  const as = <K extends BoardCard["kind"]>(_kind: K) => card() as CardOf<K>;
  /** What a panel is keyed by: the card's kind and the thing it shows, or undefined for another kind. */
  const shows = (kind: BoardCard["kind"]) => {
    const c = card();
    if (c?.kind !== kind) return undefined;
    return c.kind === "issue" ? `issue:${c.sessions[c.sessions.length - 1]!.id}` : c.kind === "task" ? `task:${c.graph.id}` : `${c.kind}:${c.id}`;
  };
  const steps = (graph: string) => {
    const got: Record<string, string> = {};
    for (const r of props.rows) if (r.issue.parent === graph && r.issue.task && r.issue.sessions.length > 0) got[r.issue.task.key] = r.issue.id;
    return got;
  };
  return (
    <Switch>
      <Match when={!card() && !props.known}>
        <p class="text-sm text-muted">{issuesWording().reading}</p>
      </Match>
      <Match when={!card()}>
        {/* A link to an issue the farm does not have says so, instead of quietly showing the board. */}
        <div>
          <h1 class="text-lg font-semibold">{issuesWording().page.notFound}</h1>
          <p class="mt-3 text-sm text-muted">{issuesWording().page.notFoundLine(props.id)}</p>
        </div>
      </Match>
      <Match when={shows("todo")} keyed>
        {() => <TodoDetail item={as("todo").issue} onDone={props.open} />}
      </Match>
      <Match when={shows("issue")} keyed>
        {() => (
          <IssueDetail
            issue={as("issue").issue}
            sessions={as("issue").sessions}
            session={as("issue").session}
            onClose={(session, review) => props.onClose(as("issue").issue, session, review)}
            onTask={as("issue").issue.parent ? () => props.open(`task:${as("issue").issue.parent}`) : undefined}
          />
        )}
      </Match>
      <Match when={shows("orchestrator")} keyed>
        {() => <OrchestratorIssueDetail issue={as("orchestrator").issue} />}
      </Match>
      <Match when={shows("missing")} keyed>
        {() => (
          <div>
            <h1 class="text-xl font-semibold">{as("missing").issue.title}</h1>
            <p class="mt-3 text-sm">{issuesWording().page.missing(as("missing").missing)}</p>
          </div>
        )}
      </Match>
      <Match when={shows("task")} keyed>
        {() => <TaskDetail graph={as("task").graph} stepIssues={steps(as("task").graph.id)} onOpen={props.open} />}
      </Match>
    </Switch>
  );
}

/** The detail over the board, sharing its URL: Escape or a click beside it goes back to the board. */
function Overlay(props: { onClose: () => void; children: JSX.Element }) {
  onSettled(() => {
    const esc = (e: KeyboardEvent) => {
      // A dialog over the detail closes first.
      if (e.key === "Escape" && !document.querySelector("dialog[open]")) props.onClose();
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  });
  return (
    <div
      class="absolute inset-0 z-20 flex justify-center overflow-y-auto bg-[#2f1f1333] px-3 py-6 sm:px-6"
      onClick={(e) => e.target === e.currentTarget && props.onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={issuesWording().page.sheet}
        class="relative h-fit w-full max-w-[1080px] rounded-xl border border-line bg-page px-6 py-5 shadow-float"
      >
        <div class="absolute top-3 right-3">
          <IconButton icon="button-close" label={issuesWording().page.close} onClick={props.onClose} />
        </div>
        {props.children}
      </div>
    </div>
  );
}

function Toolbar(props: {
  filter: BoardFilter;
  cards: BoardCard[];
  shown: number;
  onFilter: (f: BoardFilter) => void;
  look: BoardLook;
  onLook: (l: BoardLook) => void;
}) {
  const nameOf = useNameOf();
  const projects = () => [...new Set(props.cards.map(cardProject).filter((p): p is string => !!p))].sort();
  const agents = () => [...new Set(props.cards.map(cardAgent).filter((a): a is string => !!a))].sort((a, b) => nameOf()(a).localeCompare(nameOf()(b)));
  const select = "h-7 max-w-[150px] cursor-pointer rounded-md border border-line bg-page px-2 text-sm outline-none hover:bg-hover focus:border-focus";
  return (
    // Narrow, the views go on their own line above the filters, at the right where the 显示 panel opens leftwards.
    <div class="@container px-3 pt-3 pb-2.5">
      <div class="flex flex-col-reverse gap-2 @min-[760px]:flex-row @min-[760px]:items-center">
        <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <label class="flex h-7 w-60 items-center gap-1.5 rounded-md border border-line bg-page px-2 focus-within:border-focus">
            <Icon name="button-search" size={14} />
            <input
              value={props.filter.query}
              onInput={(e) => props.onFilter({ ...props.filter, query: e.currentTarget.value })}
              placeholder={issuesWording().page.find}
              aria-label={issuesWording().page.findLabel}
              class="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
            />
          </label>
          <Icon name="button-filter" size={16} label={issuesWording().page.filter} />
          <SelectOf
            label={issuesWording().page.byProject}
            value={props.filter.project}
            class={select}
            none={issuesWording().page.allProjects}
            options={projects().map((p) => ({ value: p, label: p }))}
            onChange={(project) => props.onFilter({ ...props.filter, project })}
          />
          <SelectOf
            label={issuesWording().page.byHelper}
            value={props.filter.agent}
            class={select}
            none={issuesWording().page.allHelpers}
            options={agents().map((a) => ({ value: a, label: nameOf()(a) }))}
            onChange={(agent) => props.onFilter({ ...props.filter, agent })}
          />
          <Show when={filterAny(props.filter)}>
            <span class="text-xs text-muted">{issuesWording().page.shown(props.shown, props.cards.length)}</span>
            <button type="button" onClick={() => props.onFilter(noFilter)} class="cursor-pointer text-sm text-water hover:underline">
              {issuesWording().page.clear}
            </button>
          </Show>
        </div>
        <div class="ml-auto flex items-center gap-1.5">
          <Segmented
            label={issuesWording().page.view}
            value={props.look.view}
            onChange={(view) => props.onLook({ ...props.look, view })}
            options={boardViews.map((v) => ({ value: v, label: viewLabel[v] }))}
          />
          <DisplayMenu look={props.look} onChange={props.onLook} />
        </div>
      </div>
    </div>
  );
}

/** A filter's select: everything, or one of the values the cards have. */
function SelectOf(props: {
  label: string;
  value: string;
  class: string;
  none: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  const ref = useSelectValue(
    () => props.value,
    () => props.options,
  );
  return (
    <select ref={ref} aria-label={props.label} value={props.value} onChange={(e) => props.onChange(e.currentTarget.value)} class={props.class}>
      <option value="">{props.none}</option>
      <For each={props.options}>{(o) => <option value={o.value}>{o.label}</option>}</For>
    </select>
  );
}
