import { cleanup, keymap, Scroll, signal, Text, View, windowSize, type JSX } from "nsh";
import { Popover } from "nsh/base";

import { list, t } from "@vibevalley/i18n";
import type { Issue, Session } from "@vibevalley/protocol";
import { assignedAgentOf, omitUndefined } from "@vibevalley/protocol/rules";

import { createAct } from "../../../design/act";
import { Button } from "../../../design/Button";
import { SearchField, Select } from "../../../design/Field";
import { Icon } from "../../../design/Icon";
import { IconButton } from "../../../design/IconButton";
import { motionClass, motionDuration } from "../../../design/motion";
import { Segmented } from "../../../design/Segmented";
import { CountPill } from "../../../design/Tag";
import { Bubble } from "../../../design/Tip";
import { toast } from "../../../design/toasts";
import { useOrchestrators } from "../../../infra/agents";
import { api, reasonOf } from "../../../infra/api";
import { variant } from "../../../infra/base/dom";
import { useBoardSlice, useRefreshSlice, useSessionsSlice } from "../../../infra/frame";
import { useQueryClient } from "../../../infra/query";
import { useRouter, useSearchValues } from "../../../infra/router";
import { createMemo } from "../../../infra/solid";
import { useIntents } from "../../../infra/state/intent";
import { rememberPick } from "../../../infra/state/prefs";
import {
  type BoardCard,
  type BoardFilter,
  buildCards,
  cardAgent,
  cardMove,
  cardRepo,
  cardTags,
  filterAny,
  filterShows,
  type Lane,
  noFilter,
} from "../model/cards";
import { type BoardLook, boardLook, boardViews, viewLabel } from "../model/display";
import { useIssueHistory, useNameOf } from "../model/history";
import { issueIs } from "../model/issue";
import { type IssueScope, issueScopes, issueTagPresets } from "../model/meta";
import { issueMove, movedCards, sendMove } from "../model/moves";
import { issueSearch } from "../model/navigation";
import { issueSet, labeledIssue, sendLabel, writeIssue } from "../model/write";
import { IssueBoard } from "./Board";
import { CloseIssueDialog, ReopenDialog } from "./CloseDialog";
import { DisplayMenu } from "./DisplayMenu";
import { FamilyDetail } from "./FamilyDetail";
import { IssueCalendar } from "./IssueCalendar";
import { IssueDetail, OrchestratorIssueDetail } from "./IssueDetail";
import { IssueList, type ListAdd } from "./IssueList";
import { IssuePeekModal } from "./IssuePeekModal";
import { IssueTimeline } from "./IssueTimeline";
import { NewIssue, type NewIssueAt } from "./NewIssue";
import { createIssueChrome, IssueChromeContext } from "./Sheet";
import { dispatchedNotice, TodoDetail } from "./TodoDetail";

type Closing = { issue: Issue; session: Session | undefined; review: boolean; lane?: Lane };

/** `rest` is the path after /issues/. */
export function IssuesPage(props: { rest: string }) {
  const router = useRouter();
  const board = useBoardSlice();
  const refreshBoard = useRefreshSlice("board");
  const queries = useQueryClient();
  const sessions = useSessionsSlice();
  const refreshing = signal(false);
  let refreshToken = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveMinWait: (() => void) | undefined;
  const finishMinWait = () => {
    if (refreshTimer !== undefined) {
      clearTimeout(refreshTimer);
      refreshTimer = undefined;
    }
    if (resolveMinWait !== undefined) {
      const done = resolveMinWait;
      resolveMinWait = undefined;
      done();
    }
  };
  cleanup(finishMinWait);
  const refreshIssues = () => {
    const token = ++refreshToken;
    finishMinWait();
    refreshing.set(true);
    refreshBoard();
    const minWait = new Promise<void>((resolve) => {
      const ms = motionDuration(360);
      if (ms <= 0) {
        resolve();
        return;
      }
      resolveMinWait = resolve;
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        resolveMinWait = undefined;
        resolve();
      }, ms);
    });
    void Promise.allSettled([queries.invalidate({ prefix: ["issues"] }), minWait]).finally(() => {
      if (refreshToken === token) refreshing.set(false);
    });
  };
  const id = () => (props.rest && props.rest !== "new" ? props.rest : undefined);
  // The repo and the helper are in the address, so a reload or a link keeps the board as filtered; the words typed
  // are not, being half a thought.
  const [searchValues, setSearchValues] = useSearchValues(issueSearch);
  const repo = () => searchValues().repo ?? "";
  const agent = () => searchValues().agent ?? "";
  const tag = () => searchValues().tag ?? "";
  const scope = (): IssueScope => searchValues().scope ?? "all";
  const query = signal("");
  const filter = (): BoardFilter => ({ query: query(), repo: repo(), agent: agent(), tag: tag(), scope: scope() });
  const setFilter = (f: BoardFilter) => {
    query.set(f.query);
    setSearchValues(
      () => ({
        repo: f.repo || undefined,
        agent: f.agent || undefined,
        tag: f.tag || undefined,
        scope: f.scope === "all" ? undefined : f.scope,
      }),
      { replace: true },
    );
  };
  const older = signal(false);
  const closing = signal<Closing>();
  const reopening = signal<{ issue: Issue; lane: Lane }>();
  const history = useIssueHistory(older);

  const look = boardLook.get;
  const setLook = boardLook.set;
  // The filter's part of the address goes along, so closing an issue comes back to the board as filtered.
  const kept = () => {
    const search = new URLSearchParams(
      Object.entries({ repo: repo(), agent: agent(), tag: tag(), scope: scope() === "all" ? "" : scope() }).filter(([, v]) => v !== ""),
    ).toString();
    return search ? `?${search}` : "";
  };
  const fromScene = () => {
    if (!router.location().pathname.startsWith("/issues/")) return;
    const path = router.history.previous()?.pathname;
    if (path === "/farm" || path?.startsWith("/farm/") === true) return t("web.base.farm");
  };
  const returnTo = signal<string>();
  const peeking = signal<string>();
  const open = (to: string | undefined) => {
    if (to !== undefined) peeking.set(undefined);
    if (!to && fromScene()) {
      router.history.back();
      return;
    }
    if (to && !id()) returnTo.set(to);
    if (!to && !returnTo()) returnTo.set(card()?.id ?? id());
    router.navigate((to === undefined ? "/issues" : `/issues/${encodeURIComponent(to)}`) + kept());
  };
  const peek = (to: string) => {
    returnTo.set(to);
    peeking.set(to);
  };
  const closePeek = () => peeking.set(undefined);
  const expandPeek = (to: string) => {
    peeking.set(undefined);
    open(to);
  };
  const notice = dispatchedNotice(open);

  const orchestrators = useOrchestrators();
  const orchestratorIds = createMemo(() => new Set(orchestrators().map((a) => a.id)));
  const moves = useIntents(issueMove);
  const labelSets = useIntents(issueSet);
  const act = createAct();
  const all = createMemo(() => {
    const cards = movedCards(buildCards(history.rows() ?? [], board(), sessions()?.sessions, orchestratorIds()), moves.list());
    const pendingLabels = labelSets.list();
    if (pendingLabels.length === 0) return cards;
    return cards.map((c) => ({ ...c, issue: labeledIssue(c.issue, pendingLabels).issue }));
  });
  const allIssues = createMemo(() => all().map((c) => c.issue));
  const shown = createMemo(() => all().filter((c) => filterShows(filter(), c)));
  const card = createMemo(() => {
    const at = id();
    return at === undefined ? undefined : all().find((c) => c.id === at || (c.kind === "issue" && issueIs(c.issue, at)));
  });
  const peekCard = createMemo(() => {
    const at = id() === undefined ? peeking() : undefined;
    return at === undefined ? undefined : all().find((c) => c.id === at || (c.kind === "issue" && issueIs(c.issue, at)));
  });

  const place = async (c: BoardCard, before: string | undefined) => {
    if (c.id === before) return;
    await act.run(() => api.issue.update(omitUndefined({ id: c.id, before })));
  };

  /** Asked about first where it cannot be undone. A backlog/todo dropped back on its own lane goes last. */
  const drop = async (c: BoardCard, to: Lane) => {
    if (c.kind === "todo" && (c.lane === "backlog" || c.lane === "todo") && to === c.lane) return place(c, undefined);
    const move = cardMove(c, to);
    if (move === "start" && (c.kind === "todo" || c.kind === "family")) {
      if (!assignedAgentOf(c.issue) || !c.issue.repo) {
        toast(t("web.issue.page.pickFirst"));
        return;
      }
      const done = await sendMove(moves, { id: c.id, status: "todo", lane: to }).done;
      if (done?.replied) notice(done.replied.reply);
    } else if (move === "track") {
      await sendMove(moves, { id: c.id, status: to, lane: to }).done;
    } else if (move === "close" && c.kind === "todo") {
      await sendMove(moves, { id: c.id, status: to, lane: to }).done;
    } else if (move === "revive") {
      await sendMove(moves, { id: c.id, status: "backlog", lane: to }).done;
    } else if (move === "close" && c.kind === "issue" && c.session) closing.set({ issue: c.issue, session: c.session, review: false, lane: to });
    else if (move === "close" && c.kind === "family") closing.set({ issue: c.issue, session: undefined, review: false, lane: to });
    else if (move === "reopen" && (c.kind === "issue" || c.kind === "family")) reopening.set({ issue: c.issue, lane: to });
  };

  const newAt = signal<NewIssueAt>();
  const draftAt = () => (props.rest === "new" ? { ...(repo() ? { repo: repo() } : {}), ...(agent() ? { agent: agent() } : {}) } : newAt());
  const closeDraft = () => {
    newAt.set(undefined);
    if (props.rest === "new") open(undefined);
  };
  const startNew = (where: NewIssueAt) => {
    const f = filter();
    const repo = where.repo || f.repo;
    const agent = where.agent || f.agent;
    const text = where.text;
    const machineId = where.machineId;
    newAt.set({
      ...(repo ? { repo } : {}),
      ...(agent ? { agent } : {}),
      ...(text ? { text } : {}),
      ...(machineId ? { machineId } : {}),
      ...(where.startAt !== undefined ? { startAt: where.startAt } : {}),
      ...(where.dueAt !== undefined ? { dueAt: where.dueAt } : {}),
    });
  };
  const updateScheduleDates = async (issueId: string, dates: { startAt?: number; dueAt?: number }) => {
    await sendLabel(labelSets, omitUndefined({ id: issueId, startAt: dates.startAt, dueAt: dates.dueAt })).done;
  };
  const addInList: ListAdd = (where) => startNew(where);
  const overlayDialogUp = () => draftAt() !== undefined || closing() !== undefined || reopening() !== undefined;
  const dialogUp = () => overlayDialogUp() || peekCard() !== undefined;
  // C, unless a field has focus, a dialog is up or an issue is open.
  keymap.bind(
    "c",
    () => {
      if (id() !== undefined || dialogUp()) return;
      startNew({});
    },
    { when: "notEditing" },
  );
  const keepNew = async (words: string, where: NewIssueAt, requestKey: string) => {
    const made = await act.run(() =>
      writeIssue(words, where.agent ?? "", where.repo ?? "", requestKey, where.machineId ?? "", where.attachments, where.tags, {
        startAt: where.startAt,
        dueAt: where.dueAt,
      }),
    );
    if (!made) return false;
    rememberPick(where.agent ?? "", where.repo ?? "");
    if (made.refused) toast(t("web.issue.page.notDrafted", { why: made.refused }));
    return true;
  };
  const retry = async (c: BoardCard) => {
    if (c.move?.state !== "failed") return;
    const done = await moves.retry(c.move.key);
    if (done?.replied) notice(done.replied.reply);
  };

  return (
    <View testID="issues-page" class="flex-1">
      <If
        when={id()}
        else={
          <>
            <If when={history.error()}>
              <Text class="px-3 pt-2 text-sm text-berry">
                {t("web.issue.page.historyUnread")}
                {reasonOf(history.error())}
              </Text>
            </If>
            <Toolbar
              filter={filter()}
              cards={all()}
              shown={shown().length}
              onFilter={setFilter}
              look={look()}
              onLook={setLook}
              refreshing={refreshing()}
              onRefresh={refreshIssues}
              onNew={() => startNew({})}
            />
            <If
              when={look().view === "board"}
              else={
                <If
                  when={look().view === "list"}
                  else={
                    <If
                      when={look().view === "timeline"}
                      else={
                        <IssueCalendar
                          cards={shown()}
                          allIssues={allIssues()}
                          filtered={filterAny(filter())}
                          loading={history.loading()}
                          selected={returnTo()}
                          onOpen={peek}
                          onNew={startNew}
                          onClearFilter={() => setFilter(noFilter)}
                        />
                      }
                    >
                      <IssueTimeline
                        cards={shown()}
                        allIssues={allIssues()}
                        filtered={filterAny(filter())}
                        loading={history.loading()}
                        selected={returnTo()}
                        onOpen={peek}
                        onUpdateDates={updateScheduleDates}
                        onNew={startNew}
                        onClearFilter={() => setFilter(noFilter)}
                      />
                    </If>
                  }
                >
                  <IssueList
                    cards={shown()}
                    filtered={filterAny(filter())}
                    loading={history.loading()}
                    selected={returnTo()}
                    older={older()}
                    grouping={look().grouping}
                    ordering={look().ordering}
                    onOlder={() => older.set(!older())}
                    onOpen={peek}
                    onAdd={addInList}
                    onClearFilter={() => setFilter(noFilter)}
                  />
                </If>
              }
            >
              <IssueBoard
                cards={shown()}
                summary={board()?.boardSummary}
                filtered={filterAny(filter())}
                loading={history.loading()}
                selected={returnTo()}
                older={older()}
                ordering={look().ordering}
                onOlder={() => older.set(!older())}
                onOpen={peek}
                onDrop={(c, to) => void drop(c, to)}
                onRetry={(c) => void retry(c)}
                onPutBack={(c) => c.move && moves.drop(c.move.key)}
                onPlace={(c, before) => void place(c, before)}
                onNew={() => startNew({})}
                onClearFilter={() => setFilter(noFilter)}
              />
            </If>
          </>
        }
      >
        {/* Keyed by the id, a plain value; the detail keeps the card it last found (see Detail). */}
        <Each
          of={(() => {
            const cur = id();
            return cur === undefined ? [] : [cur];
          })()}
          key={(cur) => cur}
        >
          {(at) => (
            <IssueView onBack={() => open(undefined)} backLabel={fromScene() ?? t("web.issue.page.backToBoard")} blocked={dialogUp}>
              <Detail
                id={at()}
                cards={all}
                known={!history.loading() && history.rows() !== undefined}
                open={open}
                onClose={(issue, session, review) => closing.set({ issue, session, review })}
              />
            </IssueView>
          )}
        </Each>
      </If>
      <If when={peekCard()}>
        {(c) => (
          <IssuePeekModal card={c()} blocked={overlayDialogUp} onExpand={expandPeek} onClose={closePeek}>
            <Each of={[c().id]} key={(cur) => cur}>
              {(at) => (
                <Detail
                  id={at()}
                  cards={all}
                  known={!history.loading() && history.rows() !== undefined}
                  open={(to) => (to === undefined ? closePeek() : peeking.set(to))}
                  onClose={(issue, session, review) => closing.set({ issue, session, review })}
                />
              )}
            </Each>
          </IssuePeekModal>
        )}
      </If>
      <If when={draftAt()}>{(at) => <NewIssue at={at()} onKeep={keepNew} onClose={closeDraft} />}</If>
      <If when={closing()}>
        {(c) => <CloseIssueDialog issue={c().issue} session={c().session} review={c().review} lane={c().lane} onClose={() => closing.set(undefined)} />}
      </If>
      <If when={reopening()}>
        {(r) => <ReopenDialog issue={r().issue} lane={r().lane} onClose={() => reopening.set(undefined)} onReopened={() => open(r().issue.id)} />}
      </If>
    </View>
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
  /** What a panel is keyed by (a one-row Each, as VibeValley's keyed Match): the card's kind and the thing it shows. */
  const shows = (kind: BoardCard["kind"]): string[] => {
    const c = card();
    if (c?.kind !== kind) return [];
    return [c.kind === "issue" ? `issue:${c.sessions.at(-1)?.id ?? ""}` : `${c.kind}:${c.id}`];
  };
  return (
    <If
      when={card()}
      else={
        <Scroll class="min-h-0 flex-1">
          <View class="w-full max-w-200 self-center px-6 py-8">
            <If when={props.known} else={<Text class="text-sm text-muted">{t("web.issue.reading")}</Text>}>
              <View testID="issue-not-found">
                <Text role="header" class="text-lg font-semibold text-ink">
                  {t("web.issue.page.notFound")}
                </Text>
                <Text class="mt-3 text-sm text-muted">{t("web.issue.page.notFoundLine", { id: props.id })}</Text>
              </View>
            </If>
          </View>
        </Scroll>
      }
    >
      <Each of={shows("todo")} key={(k) => k}>
        {() => <TodoDetail item={cardOf("todo").issue} onDone={props.open} />}
      </Each>
      <Each of={shows("issue")} key={(k) => k}>
        {() => (
          <IssueDetail
            issue={cardOf("issue").issue}
            sessions={cardOf("issue").sessions}
            session={cardOf("issue").session}
            onClose={(session, review) => props.onClose(cardOf("issue").issue, session, review)}
            onOpen={props.open}
            onParent={cardOf("issue").issue.parent ? () => props.open(cardOf("issue").issue.parent) : undefined}
          />
        )}
      </Each>
      <Each of={shows("orchestrator")} key={(k) => k}>
        {() => <OrchestratorIssueDetail issue={cardOf("orchestrator").issue} />}
      </Each>
      <Each of={shows("missing")} key={(k) => k}>
        {() => (
          <Scroll class="min-h-0 flex-1">
            <View class="w-full max-w-200 self-center px-6 py-8">
              <Text role="header" class="text-xl font-semibold text-ink">
                {cardOf("missing").issue.title}
              </Text>
              <Text class="mt-3 text-sm text-ink">{t("web.issue.page.missing", { what: list(cardOf("missing").missing) })}</Text>
            </View>
          </Scroll>
        )}
      </Each>
      <Each of={shows("family")} key={(k) => k}>
        {() => (
          <FamilyDetail
            issue={cardOf("family").issue}
            children={cardOf("family").children}
            onOpen={props.open}
            onClose={(review) => props.onClose(cardOf("family").issue, undefined, review)}
          />
        )}
      </Each>
    </If>
  );
}

/** An issue's own page, at its URL: Issues or Escape goes back to the board as it was left. */
function IssueView(props: { onBack: () => void; backLabel: string; blocked: () => boolean; children: JSX.Element }) {
  const chrome = createIssueChrome();
  // A dialog over the issue takes Escape first (blocked); on narrow screens the drawer closes before the page goes back.
  keymap.bind(
    "escape",
    () => {
      if (props.blocked()) return;
      if (!chrome.wide() && chrome.drawerOpen()) {
        chrome.closeDrawer();
        return;
      }
      props.onBack();
    },
    { when: "notEditing" },
  );
  return (
    <IssueChromeContext.Provider value={chrome}>
      <View testID="issue" class="min-h-0 flex-1">
        <View desktop={{ windowDrag: true }} class="h-11 shrink-0 flex-row items-center justify-between gap-2 border-b border-line bg-page px-4">
          <View
            role="button"
            testID="issue-close"
            onPress={() => props.onBack()}
            class={`-ml-2 h-7 flex-row items-center gap-1 rounded-md px-2 ${motionClass("transition-transform duration-120 ease-out")} hover:bg-hover active:translate-y-px`}
          >
            <Icon name="back" size={14} tone="muted" />
            <Text class="text-sm font-medium text-muted">{props.backLabel}</Text>
          </View>
          <If when={chrome.hasSheet()}>
            <IconButton
              testid="issue-inspector-toggle"
              icon="sidebarRight"
              size={14}
              pressed={chrome.inspectorVisible()}
              label={t("web.issue.detail.properties")}
              onClick={() => chrome.toggleInspector()}
            />
          </If>
        </View>
        <View class="min-h-0 flex-1">{props.children}</View>
      </View>
    </IssueChromeContext.Provider>
  );
}

function Toolbar(props: {
  filter: BoardFilter;
  cards: BoardCard[];
  shown: number;
  onFilter: (f: BoardFilter) => void;
  look: BoardLook;
  onLook: (l: BoardLook) => void;
  refreshing: boolean;
  onRefresh: () => void;
  onNew: () => void;
}) {
  const nameOf = useNameOf();
  const repos = createMemo(() => [...new Set(props.cards.map(cardRepo).filter((p): p is string => !!p))].toSorted());
  const agents = createMemo(() =>
    [...new Set(props.cards.map(cardAgent).filter((a): a is string => !!a))].toSorted((a, b) => nameOf()(a).localeCompare(nameOf()(b))),
  );
  const tags = createMemo(() => {
    const present = props.cards.flatMap(cardTags);
    return [...new Set([...issueTagPresets(), ...present])];
  });
  const repoOptions = createMemo(() => repos().map((p) => ({ value: p, label: p })));
  const agentOptions = createMemo(() => agents().map((a) => ({ value: a, label: nameOf()(a) })));
  const tagOptions = createMemo(() => tags().map((tag) => ({ value: tag, label: tag })));
  const scopeOptions = createMemo(() =>
    issueScopes.map((s) => ({
      value: s,
      label: t(`web.issue.scope.${s}`),
    })),
  );
  const isFiltered = createMemo(() => filterAny(props.filter));
  const hasFacetFilter = createMemo(() => props.filter.repo !== "" || props.filter.agent !== "" || props.filter.tag !== "");
  const compactToolbar = () => windowSize().width < 1100;
  const popoverFilterCount = createMemo(
    () => Number(props.filter.scope !== "all") + Number(props.filter.repo !== "") + Number(props.filter.agent !== "") + Number(props.filter.tag !== ""),
  );
  return (
    <View testID="issues-toolbar" desktop={{ windowDrag: true }} class="h-11 shrink-0 flex-row items-center gap-2 border-b border-line bg-page px-4">
      <View class="min-w-0 flex-1 flex-row items-center gap-2">
        <If when={!compactToolbar()}>
          <Segmented
            label={t("web.issue.scope.label")}
            testid="issue-scope"
            value={props.filter.scope}
            onChange={(scope) => props.onFilter({ ...props.filter, scope })}
            options={scopeOptions()}
          />
        </If>
        <SearchField
          testid="issue-search"
          clearTestid="issue-search-clear"
          value={props.filter.query}
          onInput={(query) => props.onFilter({ ...props.filter, query })}
          placeholder={t("web.issue.page.find")}
          label={t("web.issue.page.findLabel")}
          class={compactToolbar() ? "w-36 min-w-20 shrink" : "w-40 shrink"}
        />
        <If
          when={!compactToolbar()}
          else={
            <Popover
              placement="bottom"
              align="start"
              offset={6}
              popupClass="w-72 gap-2.5 rounded-lg border border-line bg-elevated p-3 shadow-float"
              popupStyle={{ maxWidth: Math.max(240, windowSize().width - 24) }}
              trigger={
                <View
                  testID="issue-filter-popover"
                  role="button"
                  accessibilityLabel={t("web.issue.page.filter")}
                  tooltip={<Bubble text={t("web.issue.page.filter")} />}
                  class={`h-7 shrink-0 flex-row items-center gap-1.5 rounded-md border border-line px-2.5 ${
                    popoverFilterCount() > 0 ? "bg-selected" : "bg-page hover:bg-hover"
                  } ${motionClass("transition-transform duration-120 ease-out")} active:translate-y-px`}
                >
                  <Icon name="filter" size={14} tone={popoverFilterCount() > 0 ? "accent" : "muted"} />
                  <Text class="text-sm text-ink">{t("web.issue.page.filter")}</Text>
                  <If when={popoverFilterCount() > 0}>
                    <CountPill count={popoverFilterCount()} active />
                  </If>
                </View>
              }
            >
              <View testID="issue-filter-popover-menu" accessibilityLabel={t("web.issue.page.filter")} class="gap-2.5">
                <View class="gap-1">
                  <Text class="text-xs font-medium text-muted">{t("web.issue.scope.label")}</Text>
                  <Segmented
                    label={t("web.issue.scope.label")}
                    testid="issue-scope"
                    block
                    value={props.filter.scope}
                    onChange={(scope) => props.onFilter({ ...props.filter, scope })}
                    options={scopeOptions()}
                  />
                </View>
                <View class="gap-1">
                  <Text class="text-xs font-medium text-muted">{t("web.issue.page.byRepo")}</Text>
                  <Select
                    size="control"
                    class="w-full"
                    label={t("web.issue.page.byRepo")}
                    testid="filter-repo"
                    filter
                    value={props.filter.repo}
                    placeholder={t("web.issue.page.allRepos")}
                    options={repoOptions()}
                    onChange={(repo) => props.onFilter({ ...props.filter, repo })}
                  />
                </View>
                <View class="gap-1">
                  <Text class="text-xs font-medium text-muted">{t("web.issue.page.byHelper")}</Text>
                  <Select
                    size="control"
                    class="w-full"
                    label={t("web.issue.page.byHelper")}
                    testid="filter-agent"
                    filter
                    value={props.filter.agent}
                    placeholder={t("web.issue.page.allHelpers")}
                    options={agentOptions()}
                    onChange={(agent) => props.onFilter({ ...props.filter, agent })}
                  />
                </View>
                <View class="gap-1">
                  <Text class="text-xs font-medium text-muted">{t("web.issue.tags.byTag")}</Text>
                  <Select
                    size="control"
                    class="w-full"
                    label={t("web.issue.tags.byTag")}
                    testid="filter-tag"
                    filter
                    value={props.filter.tag}
                    placeholder={t("web.issue.tags.allTags")}
                    options={tagOptions()}
                    onChange={(tag) => props.onFilter({ ...props.filter, tag })}
                  />
                </View>
                <If when={isFiltered()}>
                  <View class="flex-row items-center justify-between gap-2 border-t border-line pt-2">
                    <Text class="text-xs text-muted tabular-nums">{t("web.issue.page.shown", { shown: props.shown, of: props.cards.length })}</Text>
                    <Button size="compact" tone="quiet" testID="filter-clear" onPress={() => props.onFilter(noFilter)}>
                      {t("web.issue.page.clear")}
                    </Button>
                  </View>
                </If>
              </View>
            </Popover>
          }
        >
          <View
            testID="issue-filter-bar"
            accessibilityLabel={t("web.issue.page.filter")}
            class="flex-row items-center rounded-md border border-line bg-side pl-2"
          >
            <Icon name="filter" size={14} tone={hasFacetFilter() ? "accent" : "faint"} />
            <View class="mx-1.5 h-3.5 w-px bg-line" />
            <Select
              quiet
              size="control"
              class="max-w-32"
              label={t("web.issue.page.byRepo")}
              testid="filter-repo"
              filter
              value={props.filter.repo}
              placeholder={t("web.issue.page.allRepos")}
              options={repoOptions()}
              onChange={(repo) => props.onFilter({ ...props.filter, repo })}
            />
            <View class="h-3.5 w-px bg-line" />
            <Select
              quiet
              size="control"
              class="max-w-32"
              label={t("web.issue.page.byHelper")}
              testid="filter-agent"
              filter
              value={props.filter.agent}
              placeholder={t("web.issue.page.allHelpers")}
              options={agentOptions()}
              onChange={(agent) => props.onFilter({ ...props.filter, agent })}
            />
            <View class="h-3.5 w-px bg-line" />
            <Select
              quiet
              size="control"
              class="max-w-28"
              label={t("web.issue.tags.byTag")}
              testid="filter-tag"
              filter
              value={props.filter.tag}
              placeholder={t("web.issue.tags.allTags")}
              options={tagOptions()}
              onChange={(tag) => props.onFilter({ ...props.filter, tag })}
            />
          </View>
          <If when={isFiltered()}>
            <Text class="shrink-0 text-xs text-muted" style={{ fontVariant: ["tabular-nums"] }}>
              {t("web.issue.page.shown", { shown: props.shown, of: props.cards.length })}
            </Text>
            <View
              role="button"
              testID="filter-clear"
              onPress={() => props.onFilter(noFilter)}
              class={`h-7 shrink-0 flex-row items-center rounded-md px-2 ${motionClass("transition-transform duration-120 ease-out")} hover:bg-hover active:translate-y-px`}
            >
              <Text class="text-xs font-medium text-water">{t("web.issue.page.clear")}</Text>
            </View>
          </If>
        </If>
      </View>
      <View class="ml-auto shrink-0 flex-row items-center gap-1.5">
        <Segmented
          label={t("web.issue.page.view")}
          testid="issue-view"
          value={props.look.view}
          onChange={(view) => props.onLook({ ...props.look, view })}
          options={boardViews.map((v) => ({ value: v, label: viewLabel[v] }))}
        />
        <DisplayMenu look={props.look} onChange={props.onLook} />
        <View
          role="button"
          testID="issue-refresh"
          accessibilityLabel={props.refreshing ? t("web.issue.page.refreshing") : t("web.issue.page.refresh")}
          accessibilityState={{ busy: props.refreshing }}
          tooltip={<Bubble text={props.refreshing ? t("web.issue.page.refreshing") : t("web.issue.page.refresh")} />}
          onPress={() => props.onRefresh()}
          class={`h-7 shrink-0 flex-row items-center justify-center gap-1 rounded-md ${
            props.refreshing ? "bg-selected px-2" : "w-7 hover:bg-hover"
          } ${motionClass("transition-transform duration-120 ease-out")} active:translate-y-px focus-visible:outline-2 focus-visible:outline-focus`}
        >
          <View class={props.refreshing ? motionClass("animate-spin") : ""}>
            <Icon name="refresh" size={14} tone={props.refreshing ? "water" : "muted"} />
          </View>
          <If when={props.refreshing}>
            <Text testID="issue-syncing" class="text-xs font-medium text-water">
              {t("web.issue.page.refreshing")}
            </Text>
          </If>
        </View>
        <View tooltip={<Bubble text={`${t("web.issue.new.title")} (C)`} />}>
          <Button tone="primary" icon="add" testID="issue-toolbar-new" onPress={props.onNew}>
            {t("web.issue.new.card")}
          </Button>
        </View>
      </View>
    </View>
  );
}
