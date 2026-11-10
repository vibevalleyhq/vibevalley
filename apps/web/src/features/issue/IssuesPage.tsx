import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { createMemo, createSignal, Match, onSettled, Show, Switch } from "solid-js";

import { list, t } from "@vibevalley/i18n";
import type { Issue, Session } from "@vibevalley/protocol";
import { assignedAgentOf, omitUndefined } from "@vibevalley/protocol/rules";

import { variant } from "#/base/dom.tsx";
import { inField, pressed } from "#/base/shortcuts.ts";
import { useOrchestrators } from "#/infra/agents.ts";
import { api, reasonOf } from "#/infra/api.ts";
import { useCore } from "#/infra/frame.ts";
import { useRouter, useSearchValues } from "#/infra/router.ts";
import { useIntents } from "#/state/intent.ts";
import { rememberPick } from "#/state/prefs.ts";
import { createAct } from "#/ui/act.ts";
import { Select } from "#/ui/Field.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { Segmented } from "#/ui/Segmented.tsx";
import { toast } from "#/ui/toasts.ts";

import { IssueBoard } from "./Board";
import { type BoardCard, type BoardFilter, buildCards, cardAgent, cardMove, cardRepo, filterAny, filterShows, type Lane, noFilter } from "./cards";
import { CloseIssueDialog, ReopenDialog } from "./CloseDialog";
import { type BoardLook, boardLook, boardViews, viewLabel } from "./display";
import { DisplayMenu } from "./DisplayMenu";
import { FamilyDetail } from "./FamilyDetail";
import { useIssueHistory, useNameOf } from "./history";
import { issueIs } from "./issue";
import { IssueDetail, OrchestratorIssueDetail } from "./IssueDetail";
import { IssueList, type ListAdd } from "./IssueList";
import { issueMove, movedCards, sendMove } from "./moves";
import { issueSearch } from "./navigation";
import { NewIssue, type NewIssueAt } from "./NewIssue";
import { dispatchedNotice, TodoDetail } from "./TodoDetail";
import { createWriteKey, writeIssue } from "./write";

const styles = stylex.create({
  issueViewButton: {
    marginBottom: "calc(var(--spacing) * 3)",
    display: "inline-flex",
    cursor: "pointer",
    alignItems: "center",
    gap: "var(--spacing)",
    borderRadius: "var(--radius-md)",
    paddingInline: "calc(var(--spacing) * 1.5)",
    paddingBlock: "calc(var(--spacing) * .5)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: {
      default: "var(--color-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-ink)",
      },
    },
    transitionProperty: "color,background-color,border-color,outline-color,text-decoration-color,fill,stroke",
    transitionTimingFunction: "var(--default-transition-timing-function)",
    transitionDuration: ".12s",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  toolbarDiv: {
    display: "flex",
    flexDirection: {
      default: "column-reverse",
      "@container (width>=760px)": "row",
    },
    gap: "calc(var(--spacing) * 2)",
    alignItems: {
      default: null,
      "@container (width>=760px)": "center",
    },
  },
  issuesPage: {
    position: "relative",
    display: "flex",
    height: "100%",
    flexDirection: "column",
  },
  issuesPageP: {
    paddingInline: "calc(var(--spacing) * 3)",
    paddingTop: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-berry)",
  },
  detailP: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-muted)",
  },
  detailH1: {
    fontSize: "var(--text-lg)",
    lineHeight: "var(--text-lg--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  detailP2: {
    marginTop: "calc(var(--spacing) * 3)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-muted)",
  },
  detailH12: {
    fontSize: "var(--text-xl)",
    lineHeight: "var(--text-xl--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  detailP3: {
    marginTop: "calc(var(--spacing) * 3)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  issueViewDiv: {
    minHeight: "0",
    flex: "1",
    overflowY: "auto",
  },
  issue: {
    marginInline: "auto",
    width: "100%",
    maxWidth: "1200px",
    paddingInline: "calc(var(--spacing) * 6)",
    paddingTop: "calc(var(--spacing) * 3)",
    paddingBottom: "calc(var(--spacing) * 10)",
  },
  toolbarDiv2: {
    containerType: "inline-size",
    paddingInline: "calc(var(--spacing) * 3)",
    paddingTop: "calc(var(--spacing) * 3)",
    paddingBottom: "calc(var(--spacing) * 2.5)",
  },
  toolbarDiv22: {
    display: "flex",
    minWidth: "0",
    flex: "1",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
  },
  toolbarLabel: {
    display: "flex",
    height: "calc(var(--spacing) * 7)",
    width: "calc(var(--spacing) * 60)",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: {
      default: "var(--color-line)",
      ":focus-within": "var(--color-focus)",
    },
    backgroundColor: "var(--color-page)",
    paddingInline: "calc(var(--spacing) * 2)",
  },
  issueSearch: {
    minWidth: "0",
    flex: "1",
    backgroundColor: "transparent",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    outlineStyle: "none",
    color: {
      default: null,
      "::placeholder": "var(--color-faint)",
    },
  },
  toolbarSpan: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  filterClear: {
    cursor: "pointer",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-water)",
    textDecorationLine: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "underline",
      },
    },
  },
  toolbarDiv3: {
    marginLeft: "auto",
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
  },
});

const selectStyles = stylex.create({ filter: { maxWidth: "calc(var(--spacing) * 48)" } });

type Closing = { issue: Issue; session: Session | undefined; review: boolean; lane?: Lane };

/** `rest` is the path after /issues/. */
export function IssuesPage(props: { rest: string }) {
  const router = useRouter();
  const core = useCore();
  const id = () => props.rest || undefined;
  // The repo and the helper are in the address, so a reload or a link keeps the board as filtered; the words typed
  // are not, being half a thought.
  const [searchValues, setSearchValues] = useSearchValues(issueSearch);
  const repo = () => searchValues().repo ?? "";
  const agent = () => searchValues().agent ?? "";
  const [query, setQuery] = createSignal("");
  const filter = (): BoardFilter => ({ query: query(), repo: repo(), agent: agent() });
  const setFilter = (f: BoardFilter) => {
    setQuery(f.query);
    setSearchValues(() => ({ repo: f.repo || undefined, agent: f.agent || undefined }), { replace: true });
  };
  const [older, setOlder] = createSignal(false);
  const [closing, setClosing] = createSignal<Closing>();
  const [reopening, setReopening] = createSignal<{ issue: Issue; lane: Lane }>();
  const history = useIssueHistory(older);

  const look = boardLook.get;
  const setLook = boardLook.set;
  // The filter's part of the address goes along, so closing an issue comes back to the board as filtered.
  const kept = () => {
    const search = new URLSearchParams(Object.entries({ repo: repo(), agent: agent() }).filter(([, v]) => v !== "")).toString();
    return search ? `?${search}` : "";
  };
  const open = (to: string | undefined) => router.navigate((to === undefined ? "/issues" : `/issues/${encodeURIComponent(to)}`) + kept());
  const notice = dispatchedNotice(open);

  const orchestrators = useOrchestrators();
  const orchestratorIds = createMemo(() => new Set(orchestrators().map((a) => a.id)));
  const moves = useIntents(issueMove);
  const act = createAct();
  const all = createMemo(() => movedCards(buildCards(history.rows() ?? [], core(), orchestratorIds()), moves.list()));
  const shown = () => all().filter((c) => filterShows(filter(), c));
  const card = () => {
    const at = id();
    return at === undefined ? undefined : all().find((c) => c.id === at || (c.kind === "issue" && issueIs(c.issue, at)));
  };

  const place = async (c: BoardCard, before: string | undefined) => {
    if (c.id === before) return;
    await act.run(() => api.issue.update(omitUndefined({ id: c.id, before })));
  };

  /** Asked about first where it cannot be undone. A todo dropped back on its own lane goes last. */
  const drop = async (c: BoardCard, to: Lane) => {
    if (c.kind === "todo" && to === "todo") return place(c, undefined);
    const move = cardMove(c, to);
    if (move === "start" && (c.kind === "todo" || c.kind === "family")) {
      if (!assignedAgentOf(c.issue) || !c.issue.repo) {
        open(c.id);
        toast(t("web.issue.page.pickFirst"));
        return;
      }
      const done = await sendMove(moves, { id: c.id, status: "todo", lane: to }).done;
      if (done?.replied) notice(done.replied.reply);
    } else if (move === "close" && c.kind === "issue" && c.session) setClosing({ issue: c.issue, session: c.session, review: false, lane: to });
    else if (move === "close" && c.kind === "family") setClosing({ issue: c.issue, session: undefined, review: false, lane: to });
    else if (move === "reopen" && (c.kind === "issue" || c.kind === "family")) setReopening({ issue: c.issue, lane: to });
  };

  const [newAt, setNewAt] = createSignal<NewIssueAt>();
  const startNew = (where: NewIssueAt) => {
    const f = filter();
    const repo = where.repo || f.repo;
    const agent = where.agent || f.agent;
    setNewAt({ ...(repo ? { repo } : {}), ...(agent ? { agent } : {}) });
  };
  const addInList: ListAdd = (where) => startNew(where);
  // C, unless a field has focus, a dialog is up or an issue is open.
  onSettled(() => {
    const key = (e: KeyboardEvent) => {
      if (!pressed(e, "newIssue") || inField() || id() !== undefined || document.querySelector("dialog[open]")) return;
      e.preventDefault();
      startNew({});
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  const writeKey = createWriteKey();
  const keepNew = async (words: string, where: NewIssueAt) => {
    const made = await act.run(() => writeIssue(words, where.agent ?? "", where.repo ?? "", writeKey.for(words)));
    if (!made) return;
    writeKey.used();
    rememberPick(where.agent ?? "", where.repo ?? "");
    if (made.refused) toast(t("web.issue.page.notDrafted", { why: made.refused }));
  };
  const retry = async (c: BoardCard) => {
    if (c.move?.state !== "failed") return;
    const done = await moves.retry(c.move.key);
    if (done?.replied) notice(done.replied.reply);
  };

  // An issue is a page of its own (docs/style/design.md): the board and the list give way to it, and Escape or Issues comes back.
  return (
    <div data-testid="issues-page" {...stylex.attrs(styles.issuesPage)}>
      <Show
        when={id()}
        keyed
        fallback={
          <>
            <Show when={history.error()}>
              <p {...stylex.attrs(styles.issuesPageP)}>
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
                onRetry={(c) => void retry(c)}
                onPutBack={(c) => c.move && moves.drop(c.move.key)}
                onPlace={(c, before) => void place(c, before)}
                onNew={() => startNew({})}
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
              open={open}
              onClose={(issue, session, review) => setClosing({ issue, session, review })}
            />
          </IssueView>
        )}
      </Show>
      <Show when={newAt()}>{(at) => <NewIssue at={at()} onKeep={(words, where) => void keepNew(words, where)} onClose={() => setNewAt(undefined)} />}</Show>
      <Show when={closing()}>
        {(c) => <CloseIssueDialog issue={c().issue} session={c().session} review={c().review} lane={c().lane} onClose={() => setClosing(undefined)} />}
      </Show>
      <Show when={reopening()}>
        {(r) => <ReopenDialog issue={r().issue} lane={r().lane} onClose={() => setReopening(undefined)} onReopened={() => open(r().issue.id)} />}
      </Show>
    </div>
  );
}

/** The open card. */
function Detail(props: {
  id: string;
  cards: () => BoardCard[];
  known: boolean;
  open: (id: string | undefined) => void;
  onClose: (issue: Issue, session: Session | undefined, review: boolean) => void;
}) {
  const card = createMemo<BoardCard | undefined>(
    // By its id, a session of it, or its number (#12 in a message links to /issues/12).
    (last) => props.cards().find((c) => c.id === props.id || issueIs(c.issue, props.id) || String(c.issue.number) === props.id) ?? last,
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
    return c.kind === "issue" ? `issue:${c.sessions.at(-1)?.id ?? ""}` : `${c.kind}:${c.id}`;
  };
  return (
    <Switch>
      <Match when={!card() && !props.known}>
        <p {...stylex.attrs(styles.detailP)}>{t("web.issue.reading")}</p>
      </Match>
      <Match when={!card()}>
        {/* A link to an issue the farm does not have says so, instead of quietly showing the board. */}
        <div>
          <h1 {...stylex.attrs(styles.detailH1)}>{t("web.issue.page.notFound")}</h1>
          <p {...stylex.attrs(styles.detailP2)}>{t("web.issue.page.notFoundLine", { id: props.id })}</p>
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
            onParent={cardOf("issue").issue.parent ? () => props.open(cardOf("issue").issue.parent) : undefined}
          />
        )}
      </Match>
      <Match when={shows("orchestrator")} keyed>
        {() => <OrchestratorIssueDetail issue={cardOf("orchestrator").issue} />}
      </Match>
      <Match when={shows("missing")} keyed>
        {() => (
          <div>
            <h1 {...stylex.attrs(styles.detailH12)}>{cardOf("missing").issue.title}</h1>
            <p {...stylex.attrs(styles.detailP3)}>{t("web.issue.page.missing", { what: list(cardOf("missing").missing) })}</p>
          </div>
        )}
      </Match>
      <Match when={shows("family")} keyed>
        {() => (
          <FamilyDetail
            issue={cardOf("family").issue}
            children={cardOf("family").children}
            onOpen={props.open}
            onClose={(review) => props.onClose(cardOf("family").issue, undefined, review)}
          />
        )}
      </Match>
    </Switch>
  );
}

/** An issue's own page, at its URL: Issues or Escape goes back to the board as it was left. */
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
    <div {...stylex.attrs(styles.issueViewDiv)}>
      <div data-testid="issue" {...stylex.attrs(styles.issue)}>
        <button type="button" data-testid="issue-close" onClick={() => props.onBack()} {...stylex.attrs(styles.issueViewButton)}>
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
  const repos = () => [...new Set(props.cards.map(cardRepo).filter((p): p is string => !!p))].toSorted();
  const agents = () => [...new Set(props.cards.map(cardAgent).filter((a): a is string => !!a))].toSorted((a, b) => nameOf()(a).localeCompare(nameOf()(b)));
  return (
    // Narrow, the views go on their own line above the filters, at the right where the Display panel opens leftwards.
    <div {...stylex.attrs(styles.toolbarDiv2)}>
      <div {...stylex.attrs(styles.toolbarDiv)}>
        <div {...stylex.attrs(styles.toolbarDiv22)}>
          <label {...stylex.attrs(styles.toolbarLabel)}>
            <Icon name="search" size={14} />
            <input
              data-testid="issue-search"
              value={props.filter.query}
              onInput={(e) => props.onFilter({ ...props.filter, query: e.currentTarget.value })}
              placeholder={t("web.issue.page.find")}
              aria-label={t("web.issue.page.findLabel")}
              {...stylex.attrs(styles.issueSearch)}
            />
          </label>
          <Icon name="filter" size={16} label={t("web.issue.page.filter")} />
          <Select
            size="control"
            styles={selectStyles.filter}
            label={t("web.issue.page.byRepo")}
            testid="filter-repo"
            filter
            value={props.filter.repo}
            placeholder={t("web.issue.page.allRepos")}
            options={repos().map((p) => ({ value: p, label: p }))}
            onChange={(repo) => props.onFilter({ ...props.filter, repo })}
          />
          <Select
            size="control"
            styles={selectStyles.filter}
            label={t("web.issue.page.byHelper")}
            testid="filter-agent"
            filter
            value={props.filter.agent}
            placeholder={t("web.issue.page.allHelpers")}
            options={agents().map((a) => ({ value: a, label: nameOf()(a) }))}
            onChange={(agent) => props.onFilter({ ...props.filter, agent })}
          />
          <Show when={filterAny(props.filter)}>
            <span {...stylex.attrs(styles.toolbarSpan)}>{t("web.issue.page.shown", { shown: props.shown, of: props.cards.length })}</span>
            <button type="button" data-testid="filter-clear" onClick={() => props.onFilter(noFilter)} {...stylex.attrs(styles.filterClear)}>
              {t("web.issue.page.clear")}
            </button>
          </Show>
        </div>
        <div {...stylex.attrs(styles.toolbarDiv3)}>
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
