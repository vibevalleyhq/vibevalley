import { keymap, Scroll, signal, Text, View, type JSX } from "nsh";

import { list, t } from "@vibevalley/i18n";
import type { Issue, Session } from "@vibevalley/protocol";
import { assignedAgentOf, omitUndefined } from "@vibevalley/protocol/rules";

import { createMemo } from "../../../../solid";
import { variant } from "../../../base/dom";
import { useOrchestrators } from "../../../infra/agents";
import { api, reasonOf } from "../../../infra/api";
import { useCore } from "../../../infra/frame";
import { useRouter, useSearchValues } from "../../../infra/router";
import { useIntents } from "../../../state/intent";
import { rememberPick } from "../../../state/prefs";
import { createAct } from "../../../ui/act";
import { Select, TextInput } from "../../../ui/Field";
import { Icon } from "../../../ui/Icon";
import { Segmented } from "../../../ui/Segmented";
import { toast } from "../../../ui/toasts";
import { type BoardCard, type BoardFilter, buildCards, cardAgent, cardMove, cardRepo, filterAny, filterShows, type Lane, noFilter } from "../model/cards";
import { type BoardLook, boardLook, boardViews, viewLabel } from "../model/display";
import { useIssueHistory, useNameOf } from "../model/history";
import { issueIs } from "../model/issue";
import { issueMove, movedCards, sendMove } from "../model/moves";
import { issueSearch } from "../model/navigation";
import { writeIssue } from "../model/write";
import { IssueBoard } from "./Board";
import { CloseIssueDialog, ReopenDialog } from "./CloseDialog";
import { DisplayMenu } from "./DisplayMenu";
import { FamilyDetail } from "./FamilyDetail";
import { IssueDetail, OrchestratorIssueDetail } from "./IssueDetail";
import { IssueList, type ListAdd } from "./IssueList";
import { NewIssue, type NewIssueAt } from "./NewIssue";
import { dispatchedNotice, TodoDetail } from "./TodoDetail";

type Closing = { issue: Issue; session: Session | undefined; review: boolean; lane?: Lane };

/** `rest` is the path after /issues/. */
export function IssuesPage(props: { rest: string }) {
  const router = useRouter();
  const core = useCore();
  const id = () => (props.rest && props.rest !== "new" ? props.rest : undefined);
  // The repo and the helper are in the address, so a reload or a link keeps the board as filtered; the words typed
  // are not, being half a thought.
  const [searchValues, setSearchValues] = useSearchValues(issueSearch);
  const repo = () => searchValues().repo ?? "";
  const agent = () => searchValues().agent ?? "";
  const query = signal("");
  const filter = (): BoardFilter => ({ query: query(), repo: repo(), agent: agent() });
  const setFilter = (f: BoardFilter) => {
    query.set(f.query);
    setSearchValues(() => ({ repo: f.repo || undefined, agent: f.agent || undefined }), { replace: true });
  };
  const older = signal(false);
  const closing = signal<Closing>();
  const reopening = signal<{ issue: Issue; lane: Lane }>();
  const history = useIssueHistory(older);

  const look = boardLook.get;
  const setLook = boardLook.set;
  // The filter's part of the address goes along, so closing an issue comes back to the board as filtered.
  const kept = () => {
    const search = new URLSearchParams(Object.entries({ repo: repo(), agent: agent() }).filter(([, v]) => v !== "")).toString();
    return search ? `?${search}` : "";
  };
  const fromScene = () => {
    if (!router.location().pathname.startsWith("/issues/")) return;
    const path = router.history.previous()?.pathname;
    if (path === "/map") return t("web.farm.native.map");
    if (path === "/farm" || path?.startsWith("/farm/") === true) return t("web.base.farm");
  };
  const returnTo = signal<string>();
  const open = (to: string | undefined) => {
    if (!to && fromScene()) {
      router.history.back();
      return;
    }
    if (to && !id()) returnTo.set(to);
    if (!to && !returnTo()) returnTo.set(card()?.id ?? id());
    router.navigate((to === undefined ? "/issues" : `/issues/${encodeURIComponent(to)}`) + kept());
  };
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
    newAt.set({ ...(repo ? { repo } : {}), ...(agent ? { agent } : {}) });
  };
  const addInList: ListAdd = (where) => startNew(where);
  const dialogUp = () => draftAt() !== undefined || closing() !== undefined || reopening() !== undefined;
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
    const made = await act.run(() => writeIssue(words, where.agent ?? "", where.repo ?? "", requestKey));
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

  // An issue is a page of its own (docs/style/design.md): the board and the list give way to it, and Escape or Issues comes back.
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
            <Toolbar filter={filter()} cards={all()} shown={shown().length} onFilter={setFilter} look={look()} onLook={setLook} />
            <If
              when={look().view === "board"}
              else={
                <IssueList
                  cards={shown()}
                  loading={history.loading()}
                  selected={returnTo()}
                  older={older()}
                  grouping={look().grouping}
                  ordering={look().ordering}
                  onOlder={() => older.set(!older())}
                  onOpen={open}
                  onAdd={addInList}
                />
              }
            >
              <IssueBoard
                cards={shown()}
                loading={history.loading()}
                selected={returnTo()}
                older={older()}
                ordering={look().ordering}
                onOlder={() => older.set(!older())}
                onOpen={open}
                onDrop={(c, to) => void drop(c, to)}
                onRetry={(c) => void retry(c)}
                onPutBack={(c) => c.move && moves.drop(c.move.key)}
                onPlace={(c, before) => void place(c, before)}
                onNew={() => startNew({})}
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
        <If when={props.known} else={<Text class="text-sm text-muted">{t("web.issue.reading")}</Text>}>
          {/* A link to an issue the farm does not have says so, instead of quietly showing the board. */}
          <View testID="issue-not-found">
            <Text role="header" class="text-lg font-semibold text-ink">
              {t("web.issue.page.notFound")}
            </Text>
            <Text class="mt-3 text-sm text-muted">{t("web.issue.page.notFoundLine", { id: props.id })}</Text>
          </View>
        </If>
      }
    >
      <Each of={shows("todo")}>{() => <TodoDetail item={cardOf("todo").issue} onDone={props.open} />}</Each>
      <Each of={shows("issue")}>
        {() => (
          <IssueDetail
            issue={cardOf("issue").issue}
            sessions={cardOf("issue").sessions}
            session={cardOf("issue").session}
            onClose={(session, review) => props.onClose(cardOf("issue").issue, session, review)}
            onParent={cardOf("issue").issue.parent ? () => props.open(cardOf("issue").issue.parent) : undefined}
          />
        )}
      </Each>
      <Each of={shows("orchestrator")}>{() => <OrchestratorIssueDetail issue={cardOf("orchestrator").issue} />}</Each>
      <Each of={shows("missing")}>
        {() => (
          <View>
            <Text role="header" class="text-xl font-semibold text-ink">
              {cardOf("missing").issue.title}
            </Text>
            <Text class="mt-3 text-sm text-ink">{t("web.issue.page.missing", { what: list(cardOf("missing").missing) })}</Text>
          </View>
        )}
      </Each>
      <Each of={shows("family")}>
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
  // A dialog over the issue, or a field being written in, has Escape first.
  keymap.bind("escape", () => !props.blocked() && props.onBack(), { when: "notEditing" });
  return (
    <Scroll testID="issue-scroll" class="min-h-0 flex-1">
      <View testID="issue" class="w-full max-w-300 self-center px-6 pt-3 pb-10">
        <View
          role="button"
          testID="issue-close"
          onPress={() => props.onBack()}
          class="mb-3 flex-row items-center gap-1 self-start rounded-md px-1.5 py-0.5 hover:bg-hover"
        >
          <Icon name="back" size={14} tone="muted" />
          <Text class="text-sm text-muted">{props.backLabel}</Text>
        </View>
        {props.children}
      </View>
    </Scroll>
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
    <View class="flex-row flex-wrap items-center gap-2 px-3 pt-3 pb-2.5">
      <View class="min-w-0 flex-1 flex-row flex-wrap items-center gap-2">
        <View class="h-7 w-60 flex-row items-center gap-1.5 rounded-md border border-line bg-page px-2">
          <Icon name="search" size={14} tone="muted" />
          <TextInput
            testID="issue-search"
            value={props.filter.query}
            onInput={(query) => props.onFilter({ ...props.filter, query })}
            placeholder={t("web.issue.page.find")}
            accessibilityLabel={t("web.issue.page.findLabel")}
            class="h-6 flex-1 border-0 bg-transparent px-0 py-0"
          />
        </View>
        <Icon name="filter" size={16} label={t("web.issue.page.filter")} tone="muted" />
        <Select
          size="control"
          class="max-w-48"
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
          class="max-w-48"
          label={t("web.issue.page.byHelper")}
          testid="filter-agent"
          filter
          value={props.filter.agent}
          placeholder={t("web.issue.page.allHelpers")}
          options={agents().map((a) => ({ value: a, label: nameOf()(a) }))}
          onChange={(agent) => props.onFilter({ ...props.filter, agent })}
        />
        <If when={filterAny(props.filter)}>
          <Text class="text-xs text-muted">{t("web.issue.page.shown", { shown: props.shown, of: props.cards.length })}</Text>
          <View role="button" testID="filter-clear" onPress={() => props.onFilter(noFilter)}>
            <Text class="text-sm text-water">{t("web.issue.page.clear")}</Text>
          </View>
        </If>
      </View>
      <View class="ml-auto flex-row items-center gap-1.5">
        <Segmented
          label={t("web.issue.page.view")}
          testid="issue-view"
          value={props.look.view}
          onChange={(view) => props.onLook({ ...props.look, view })}
          options={boardViews.map((v) => ({ value: v, label: viewLabel[v] }))}
        />
        <DisplayMenu look={props.look} onChange={props.onLook} />
      </View>
    </View>
  );
}
