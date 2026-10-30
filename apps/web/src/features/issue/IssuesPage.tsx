import { list, t } from "@vibevalley/i18n";
import { variant } from "@/base/util";
import { createMemo, createSignal, Match, onSettled, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { Issue, Session } from "@vibevalley/protocol";
import { api, reasonOf } from "@/base/api";
import { writeIssue } from "./write";
import { type BoardLook, boardViews, defaultLook, lookFromList, lookToList, viewLabel } from "./display";
import { type BoardCard, type BoardFilter, buildCards, cardAgent, cardMove, cardProject, filterAny, filterShows, noFilter } from "./cards";
import { issueIs } from "./issue";
import { type Lane } from "./lanes";
import { toast } from "@/ui/toasts";
import { useRouter } from "@/base/router";
import { Select } from "@/ui/Field";
import { useCore } from "@/base/frame";
import { useOrchestrators } from "@/base/agents";
import { useIssueHistory, useGraphs, useNameOf } from "./queries";
import { Icon } from "@/ui/Icon";
import { Segmented } from "@/ui/Segmented";
import { IssueBoard } from "./Board";
import { CloseIssueDialog, ReopenDialog } from "./CloseDialog";
import { DisplayMenu } from "./DisplayMenu";
import { run } from "./acts";
import { IssueDetail, OrchestratorIssueDetail } from "./IssueDetail";
import { IssueList, type ListAdd } from "./IssueList";
import { TaskDetail } from "./TaskDetail";
import { dispatchedNotice, TodoDetail } from "./TodoDetail";
import { omitUndefined } from "@vibevalley/protocol/rules";

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
  const [closing, setClosing] = createSignal<Closing>();
  const [reopening, setReopening] = createSignal<Issue>();
  const history = useIssueHistory(older);

  const setLook = (l: BoardLook) => {
    setLookState(l);
    saveLook(l);
  };
  const open = (to: string | undefined) => router.navigate(to === undefined ? "/issues" : `/issues/${encodeURIComponent(to)}`);
  const notice = dispatchedNotice(open);

  const orchestrators = useOrchestrators();
  const orchestratorIds = createMemo(() => new Set(orchestrators().map((a) => a.id)));
  const all = createMemo(() => buildCards(history.rows() ?? [], core(), graphs(), orchestratorIds()));
  const shown = () => all().filter((c) => filterShows(filter(), c));
  const card = () => {
    const at = id();
    return at === undefined ? undefined : all().find((c) => c.id === at || (c.kind === "issue" && issueIs(c.issue, at)));
  };

  const place = async (c: BoardCard, before: string | undefined) => {
    if (c.id === before) return;
    await run(() => api.issue.update(omitUndefined({ id: c.id, before })));
  };

  /** Asked about first where it cannot be undone. A 待办 dropped back on its own lane goes last. */
  const drop = async (c: BoardCard, to: Lane) => {
    if (c.kind === "todo" && to === "todo") return place(c, undefined);
    const move = cardMove(c, to);
    if (move === "start" && c.kind === "todo") {
      if (!c.issue.assignee || !c.issue.project) {
        open(c.id);
        toast(t("web.issue.page.pickFirst"));
        return;
      }
      const got = await run(() => api.issue.status.update({ id: c.id, status: "todo" }));
      if (got) notice(got);
    } else if (move === "close" && c.kind === "issue" && c.session) setClosing({ issue: c.issue, session: c.session, review: false });
    else if (move === "reopen" && c.kind === "issue") setReopening(() => c.issue);
  };

  const add = async (text: string, where: { project?: string; agent?: string } = {}) => {
    const f = filter();
    const made = await run(() => writeIssue(text, where.agent || f.agent, where.project || f.project));
    if (!made) return;
    if (made.refused) toast(t("web.issue.page.notDrafted", { why: made.refused }));
    // A line written in a lane stays on the board, among the others; only a blank one to write out opens its page.
    if (!text.trim()) open(made.issue.id);
  };
  const addInList: ListAdd = (text, where) => void add(text, where);
  const write = () => void add("");

  // An issue is a page of its own (docs/style/design.md): the board and the list give way to it, and Escape or 工单 comes back.
  return (
    <div class="relative flex h-full flex-col">
      <Show
        when={id()}
        keyed
        fallback={
          <>
            <Show when={history.error()}>
              <p class="px-3 pt-2 text-sm text-berry">
                {t("web.issue.page.historyUnread")}
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
          </>
        }
      >
        {/* Keyed by the id, a plain value; the detail keeps the card it last found (see Detail). */}
        {(at) => (
          <IssueView onBack={() => open(undefined)}>
            <Detail
              id={at}
              cards={all}
              known={!history.loading() && history.rows() !== undefined}
              rows={history.rows() ?? []}
              open={open}
              onClose={(issue, session, review) => setClosing({ issue, session, review })}
            />
          </IssueView>
        )}
      </Show>
      <Show when={closing()}>
        {(c) => <CloseIssueDialog issue={c().issue} session={c().session} review={c().review} onClose={() => setClosing(undefined)} />}
      </Show>
      <Show when={reopening()}>{(issue) => <ReopenDialog issue={issue()} onClose={() => setReopening(undefined)} onReopened={() => open(issue().id)} />}</Show>
    </div>
  );
}

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
    // By its id, a session of it, or its number (#12 in a message links to /issues/12).
    (last) =>
      props
        .cards()
        .find((c) => c.id === props.id || ((c.kind === "issue" || c.kind === "todo") && (issueIs(c.issue, props.id) || String(c.issue.number) === props.id))) ??
      last,
  );
  /** Only read inside that kind's panel: it throws once the card is another kind. */
  const cardOf = <const K extends BoardCard["kind"]>(kind: K) => {
    const c = card();
    const of = c && variant(c, "kind", kind);
    if (!of) throw new Error(`the card is no longer a ${kind}`);
    return of;
  };
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
        <p class="text-sm text-muted">{t("web.issue.reading")}</p>
      </Match>
      <Match when={!card()}>
        {/* A link to an issue the farm does not have says so, instead of quietly showing the board. */}
        <div>
          <h1 class="text-lg font-semibold">{t("web.issue.page.notFound")}</h1>
          <p class="mt-3 text-sm text-muted">{t("web.issue.page.notFoundLine", { id: props.id })}</p>
        </div>
      </Match>
      <Match when={shows("todo")} keyed>
        {() => <TodoDetail item={cardOf("todo").issue} onDone={props.open} />}
      </Match>
      <Match when={shows("issue")} keyed>
        {() => (
          <IssueDetail
            issue={cardOf("issue").issue}
            sessions={cardOf("issue").sessions}
            session={cardOf("issue").session}
            onClose={(session, review) => props.onClose(cardOf("issue").issue, session, review)}
            onTask={cardOf("issue").issue.parent ? () => props.open(`task:${cardOf("issue").issue.parent}`) : undefined}
          />
        )}
      </Match>
      <Match when={shows("orchestrator")} keyed>
        {() => <OrchestratorIssueDetail issue={cardOf("orchestrator").issue} />}
      </Match>
      <Match when={shows("missing")} keyed>
        {() => (
          <div>
            <h1 class="text-xl font-semibold">{cardOf("missing").issue.title}</h1>
            <p class="mt-3 text-sm">{t("web.issue.page.missing", { what: list(cardOf("missing").missing) })}</p>
          </div>
        )}
      </Match>
      <Match when={shows("task")} keyed>
        {() => <TaskDetail graph={cardOf("task").graph} stepIssues={steps(cardOf("task").graph.id)} onOpen={props.open} />}
      </Match>
    </Switch>
  );
}

/** An issue's own page, at its URL: 工单 or Escape goes back to the board as it was left. */
function IssueView(props: { onBack: () => void; children: JSX.Element }) {
  onSettled(() => {
    const esc = (e: KeyboardEvent) => {
      // A dialog over the issue, or a field being written in, has Escape first.
      const at = document.activeElement;
      if (e.key !== "Escape" || document.querySelector("dialog[open]") || (at instanceof HTMLElement && at.closest("input, textarea, [contenteditable]")))
        return;
      props.onBack();
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  });
  return (
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div data-testid="issue" class="mx-auto w-full max-w-[1200px] px-6 pt-3 pb-10">
        <button
          type="button"
          data-testid="issue-close"
          onClick={() => props.onBack()}
          class="mb-3 inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-sm text-muted transition-colors duration-120 hover:bg-hover hover:text-ink"
        >
          <Icon name="back" size={14} />
          {t("web.issue.page.backToBoard")}
        </button>
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
  return (
    // Narrow, the views go on their own line above the filters, at the right where the 显示 panel opens leftwards.
    <div class="@container px-3 pt-3 pb-2.5">
      <div class="flex flex-col-reverse gap-2 @min-[760px]:flex-row @min-[760px]:items-center">
        <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <label class="flex h-7 w-60 items-center gap-1.5 rounded-md border border-line bg-page px-2 focus-within:border-focus">
            <Icon name="search" size={14} />
            <input
              data-testid="issue-search"
              value={props.filter.query}
              onInput={(e) => props.onFilter({ ...props.filter, query: e.currentTarget.value })}
              placeholder={t("web.issue.page.find")}
              aria-label={t("web.issue.page.findLabel")}
              class="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
            />
          </label>
          <Icon name="filter" size={16} label={t("web.issue.page.filter")} />
          <Select
            size="control"
            class="max-w-48"
            label={t("web.issue.page.byProject")}
            testid="filter-project"
            filter
            value={props.filter.project}
            placeholder={t("web.issue.page.allProjects")}
            options={projects().map((p) => ({ value: p, label: p }))}
            onChange={(project) => props.onFilter({ ...props.filter, project })}
          />
          <Select
            size="control"
            class="max-w-48"
            label={t("web.issue.page.byHelper")}
            testid="filter-agent"
            filter
            value={props.filter.agent}
            placeholder={t("web.issue.page.allHelpers")}
            options={agents().map((a) => ({ value: a, label: nameOf()(a) }))}
            onChange={(agent) => props.onFilter({ ...props.filter, agent })}
          />
          <Show when={filterAny(props.filter)}>
            <span class="text-xs text-muted">{t("web.issue.page.shown", { shown: props.shown, of: props.cards.length })}</span>
            <button type="button" data-testid="filter-clear" onClick={() => props.onFilter(noFilter)} class="cursor-pointer text-sm text-water hover:underline">
              {t("web.issue.page.clear")}
            </button>
          </Show>
        </div>
        <div class="ml-auto flex items-center gap-1.5">
          <Segmented
            label={t("web.issue.page.view")}
            testid="issue-view"
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
