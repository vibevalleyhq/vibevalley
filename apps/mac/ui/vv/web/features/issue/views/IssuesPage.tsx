// Ported from VibeValley apps/web/src/features/issue/views/IssuesPage.tsx:
// the same model calls (cards from the issue history and the frame, moves
// as intents, the filter in the address), the board or the list, the
// display menu, the issue / todo / family details, the new issue sheet and
// the close and reopen dialogs. Keys: C writes a new issue and Escape
// leaves an issue, through nsh's keymap (not while a field has the focus or
// a dialog is up). Cards are dragged on the board with pan gestures
// (Board.tsx). The toolbar's container query (views
// above the filters when narrow) is not carried: the row wraps instead.
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
import { Button } from "../../../ui/Button";
import { Select, TextInput } from "../../../ui/Field";
import { Icon } from "../../../ui/Icon";
import { Segmented } from "../../../ui/Segmented";
import { Bubble } from "../../../ui/Tip";
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
import { createIssueChrome, IssueChromeContext } from "./Sheet";
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
    if (path === "/farm" || path?.startsWith("/farm/")) return t("web.base.farm");
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

  // An issue is a page of its own (docs/design/03-conversation-and-work-streams.md): the board and the list give way to it, and Escape or Issues comes back.
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
            <If when={history.loading() || history.error() !== undefined || history.rows() === undefined || all().length > 0}>
              <Toolbar filter={filter()} cards={all()} shown={shown().length} onFilter={setFilter} look={look()} onLook={setLook} onNew={() => startNew({})} />
            </If>
            <If
              when={!history.loading() && !history.error() && history.rows() !== undefined && all().length === 0}
              else={
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
                    summary={core()?.boardSummary}
                    filtered={filterAny(filter())}
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
              }
            >
              <IssuesOnboarding onNavigate={(path) => router.navigate(path)} onNew={() => startNew({})} />
            </If>
          </>
        }
      >
        {/* Keyed by the id, a plain value; the detail keeps the card it last found (see Detail). */}
        <Each of={id() === undefined ? [] : [id() as string]}>
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
        <Scroll class="min-h-0 flex-1">
          <View class="w-full max-w-200 self-center px-6 py-8">
            <If when={props.known} else={<Text class="text-sm text-muted">{t("web.issue.reading")}</Text>}>
              {/* A link to an issue the farm does not have says so, instead of quietly showing the board. */}
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
  const chrome = createIssueChrome();
  // A dialog over the issue, or a field being written in, has Escape first; on narrow screens Escape closes the inspector drawer first.
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
        <View class="h-11 shrink-0 flex-row items-center justify-between gap-2 border-b border-line bg-page px-4">
          <View
            role="button"
            testID="issue-close"
            onPress={() => props.onBack()}
            class="-ml-2 h-7 flex-row items-center gap-1 rounded-md px-2 transition duration-120 ease-out hover:bg-hover active:translate-y-px"
          >
            <Icon name="back" size={14} tone="muted" />
            <Text class="text-sm font-medium text-muted">{props.backLabel}</Text>
          </View>
          <If when={chrome.hasSheet()}>
            <View
              role="button"
              testID="issue-inspector-toggle"
              accessibilityLabel={t("web.issue.detail.properties")}
              accessibilityState={{ selected: chrome.inspectorVisible() }}
              tooltip={<Bubble text={t("web.issue.detail.properties")} placement="bottom" />}
              onPress={() => chrome.toggleInspector()}
              class={`h-7 flex-row items-center gap-1.5 rounded-md border px-2 transition duration-120 ease-out active:translate-y-px ${
                chrome.inspectorVisible() ? "border-line bg-selected" : "border-transparent hover:bg-hover"
              }`}
            >
              <Icon name="info" size={14} tone={chrome.inspectorVisible() ? "ink" : "muted"} />
              <Text class={`text-xs font-medium ${chrome.inspectorVisible() ? "text-ink" : "text-muted"}`}>{t("web.issue.detail.properties")}</Text>
            </View>
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
  onNew: () => void;
}) {
  const nameOf = useNameOf();
  const repos = () => [...new Set(props.cards.map(cardRepo).filter((p): p is string => !!p))].toSorted();
  const agents = () => [...new Set(props.cards.map(cardAgent).filter((a): a is string => !!a))].toSorted((a, b) => nameOf()(a).localeCompare(nameOf()(b)));
  return (
    <View class="flex-row flex-wrap items-center gap-2 px-3 pt-3 pb-2.5">
      <View class="min-w-0 flex-1 flex-row flex-wrap items-center gap-2">
        <View class="h-7 w-60 flex-row items-center gap-1.5 rounded-md border border-line bg-page px-2 transition duration-120 ease-out hover:border-faint focus-within:border-focus">
          <Icon name="search" size={14} tone="muted" />
          <TextInput
            testID="issue-search"
            value={props.filter.query}
            onInput={(query) => props.onFilter({ ...props.filter, query })}
            placeholder={t("web.issue.page.find")}
            accessibilityLabel={t("web.issue.page.findLabel")}
            class="h-6 flex-1 border-0 bg-transparent px-0 py-0"
          />
          <If when={props.filter.query.length > 0}>
            <View
              role="button"
              accessibilityLabel={t("web.issue.page.clear")}
              onPress={() => props.onFilter({ ...props.filter, query: "" })}
              class="size-4.5 shrink-0 items-center justify-center rounded-sm hover:bg-hover"
            >
              <Icon name="close" size={10} tone="muted" />
            </View>
          </If>
        </View>
        <Icon name="filter" size={14} label={t("web.issue.page.filter")} tone="muted" />
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
          <Text class="text-xs text-muted" style={{ fontVariant: ["tabular-nums"] }}>
            {t("web.issue.page.shown", { shown: props.shown, of: props.cards.length })}
          </Text>
          <View
            role="button"
            testID="filter-clear"
            onPress={() => props.onFilter(noFilter)}
            class="h-7 flex-row items-center rounded-md px-2 transition duration-120 ease-out hover:bg-hover active:translate-y-px"
          >
            <Text class="text-xs font-medium text-water">{t("web.issue.page.clear")}</Text>
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
        <View tooltip={<Bubble text={`${t("web.issue.new.title")} (C)`} />}>
          <Button icon="add" testID="issue-toolbar-new" onPress={props.onNew}>
            {t("web.issue.new.card")}
          </Button>
        </View>
      </View>
    </View>
  );
}

function IssuesOnboarding(props: { onNavigate: (path: string) => void; onNew: () => void }) {
  return (
    <Scroll testID="issues-empty-onboarding" class="min-h-0 flex-1">
      <View class="mx-auto my-8 w-full max-w-160 px-6">
        <View class="rounded-xl border border-line bg-page p-6">
          <Text role="header" class="text-lg font-semibold text-ink">
            开始使用 VibeValley
          </Text>
          <Text class="mt-1 text-sm text-muted">按下面三步准备好环境，就能把工单派给帮工干活。</Text>
          <View class="mt-5 gap-2.5">
            <View testID="onboarding-step-runtimes" class="flex-row items-center gap-3 rounded-lg bg-side p-3.5">
              <View class="h-6 w-6 shrink-0 items-center justify-center rounded-full bg-selected">
                <Text class="text-xs font-semibold text-ink" style={{ fontVariant: ["tabular-nums"] }}>
                  1
                </Text>
              </View>
              <View class="min-w-0 flex-1">
                <Text class="text-sm font-medium text-ink">检查或配置农机</Text>
                <Text class="mt-0.5 text-xs text-muted">确认本机已安装并启用编码 agent（如 Claude Code、Codex 等）</Text>
              </View>
              <Button icon="runtimes" testID="onboarding-runtimes" onPress={() => props.onNavigate("/runtimes")}>
                配置农机
              </Button>
            </View>
            <View testID="onboarding-step-repos" class="flex-row items-center gap-3 rounded-lg bg-side p-3.5">
              <View class="h-6 w-6 shrink-0 items-center justify-center rounded-full bg-selected">
                <Text class="text-xs font-semibold text-ink" style={{ fontVariant: ["tabular-nums"] }}>
                  2
                </Text>
              </View>
              <View class="min-w-0 flex-1">
                <Text class="text-sm font-medium text-ink">添加代码仓库</Text>
                <Text class="mt-0.5 text-xs text-muted">绑定本机 Git 仓库，帮工会在独立工作目录里改动代码</Text>
              </View>
              <Button icon="repos" testID="onboarding-repos" onPress={() => props.onNavigate("/repos")}>
                添加仓库
              </Button>
            </View>
            <View testID="onboarding-step-start" class="flex-row items-start gap-3 rounded-lg bg-side p-3.5">
              <View class="mt-0.5 h-6 w-6 shrink-0 items-center justify-center rounded-full bg-selected">
                <Text class="text-xs font-semibold text-ink" style={{ fontVariant: ["tabular-nums"] }}>
                  3
                </Text>
              </View>
              <View class="min-w-0 flex-1">
                <Text class="text-sm font-medium text-ink">创建第一条工单，或在聊天中派活</Text>
                <Text class="mt-0.5 text-xs text-muted">写下需求直接派给帮工，或按 C 键新建工单，也可以在聊天里让助手帮你拆解</Text>
                <View class="mt-2.5 flex-row flex-wrap items-center gap-2">
                  <Button tone="primary" icon="add" testID="onboarding-new-issue" onPress={props.onNew}>
                    新建工单
                  </Button>
                  <Button icon="chat" testID="onboarding-chat" onPress={() => props.onNavigate("/chat")}>
                    去聊天派活
                  </Button>
                </View>
              </View>
            </View>
          </View>
        </View>
      </View>
    </Scroll>
  );
}
