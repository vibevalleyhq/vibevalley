import { cleanup, keymap, signal, Text, untracked, View } from "nsh";

import { t } from "@vibevalley/i18n";
import { assignedAgentOf, omitUndefined } from "@vibevalley/protocol/rules";

import { motionDuration } from "../../../design/motion";
import { toast } from "../../../design/toasts";
import { createAct } from "../../../infra/act";
import { useOrchestrators } from "../../../infra/agents";
import { api, reasonOf } from "../../../infra/api";
import { useBoardSlice, useRefreshSlice, useSessionsSlice } from "../../../infra/frame";
import { writeIssue } from "../../../infra/issueActions";
import { useQueryClient } from "../../../infra/query";
import { useRouter, useSearchValues } from "../../../infra/router";
import { createEffect, createMemo } from "../../../infra/solid";
import { useIntents } from "../../../infra/state/intent";
import { pendingNewIssue } from "../../../infra/state/issueDraft";
import { rememberPick } from "../../../infra/state/prefs";
import { useVdpNode } from "../../../infra/vdpProbe";
import { BacklogTriagePanel } from "../../dashboard";
import { type BoardCard, type BoardFilter, buildCards, cardMove, cardRepo, filterAny, filterShows, type Lane, noFilter } from "../model/cards";
import { boardLook, type GroupBy, type HierarchyMode, hierarchyShows } from "../model/display";
import { useIssueHistory } from "../model/history";
import { issueIs } from "../model/issue";
import type { IssueScope } from "../model/meta";
import { issueMove, movedCards, type PendingPlacement, placedCards, sendMove } from "../model/moves";
import { issueSearch } from "../model/navigation";
import { orderedVisibleCardIds, stepFocusId } from "../model/triage";
import { issueSet, labeledIssue, sendLabel } from "../model/write";
import { IssueBoard } from "./Board";
import { CloseIssueDialog, ReopenDialog } from "./CloseDialog";
import { IssueCalendar } from "./IssueCalendar";
import { IssueList, type ListAdd } from "./IssueList";
import { IssuePeekModal } from "./IssuePeekModal";
import { Detail, IssueView } from "./issues/IssueDetailView";
import { IssuesToolbar } from "./issues/IssuesToolbar";
import {
  effectiveIssueOverlay,
  initialIssueOverlay,
  isIssueOverlayBlocking,
  type IssueOverlay,
  type IssueOverlayEvent,
  issueOverlayTransition,
} from "./issues/overlay";
import { IssueTimeline } from "./IssueTimeline";
import { NewIssue, type NewIssueAt } from "./NewIssue";
import { dispatchedNotice } from "./TodoDetail";

export { effectiveIssueOverlay, initialIssueOverlay, isIssueOverlayBlocking, type IssueOverlay, type IssueOverlayEvent, issueOverlayTransition };

/** `rest` is the path after /issues/. */
export function IssuesPage(props: { rest: string }) {
  useVdpNode({ testId: "issues-page", role: "region" });
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
  const status = () => searchValues().status ?? "";
  const query = signal("");
  const filter = (): BoardFilter => ({ query: query(), repo: repo(), agent: agent(), tag: tag(), scope: scope(), status: status() });
  const setFilter = (f: BoardFilter) => {
    query.set(f.query);
    setSearchValues(
      () => ({
        repo: f.repo || undefined,
        agent: f.agent || undefined,
        tag: f.tag || undefined,
        scope: f.scope === "all" ? undefined : f.scope,
        status: f.status || undefined,
      }),
      { replace: true },
    );
  };
  const older = signal(false);
  const overlay = signal<IssueOverlay>(initialIssueOverlay());
  const dispatchOverlay = (event: IssueOverlayEvent) => {
    overlay.set(issueOverlayTransition(untracked(overlay), event));
  };
  const history = useIssueHistory(older);

  const look = boardLook.get;
  const setLook = boardLook.set;
  // The filter's part of the address goes along, so closing an issue comes back to the board as filtered.
  const kept = () => {
    const search = new URLSearchParams(
      Object.entries({ repo: repo(), agent: agent(), tag: tag(), scope: scope() === "all" ? "" : scope(), status: status() }).filter(([, v]) => v !== ""),
    ).toString();
    return search ? `?${search}` : "";
  };
  const fromScene = () => {
    if (!router.location().pathname.startsWith("/issues/")) return;
    const path = router.history.previous()?.pathname;
    if (path === "/farm" || path?.startsWith("/farm/") === true) return t("web.base.farm");
  };
  const returnTo = signal<string>();
  const open = (to: string | undefined) => {
    if (to !== undefined) dispatchOverlay({ kind: "clear" });
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
    dispatchOverlay({ kind: "peek", id: to });
  };
  const closePeek = () => dispatchOverlay({ kind: "clear" });
  const expandPeek = (to: string) => {
    dispatchOverlay({ kind: "clear" });
    open(to);
  };
  const notice = dispatchedNotice(open);

  const orchestrators = useOrchestrators();
  const orchestratorIds = createMemo(() => new Set(orchestrators().map((a) => a.id)));
  const moves = useIntents(issueMove);
  const pendingPlacements = signal<readonly PendingPlacement[]>([]);
  const labelSets = useIntents(issueSet);
  const act = createAct();
  const all = createMemo(() => {
    const base = buildCards(history.rows() ?? [], board(), sessions()?.sessions, orchestratorIds());
    const cards = placedCards(movedCards(base, moves.list()), pendingPlacements());
    const pendingLabels = labelSets.list();
    if (pendingLabels.length === 0) return cards;
    return cards.map((c) => ({ ...c, issue: labeledIssue(c.issue, pendingLabels).issue }));
  });
  const allIssues = createMemo(() => all().map((c) => c.issue));
  const shown = createMemo(() => all().filter((c) => filterShows(filter(), c)));
  const effectiveGroupBy = (): GroupBy => look().groupBy ?? "none";
  const effectiveHierarchy = (): HierarchyMode => look().hierarchy ?? "all";
  const visibleCards = createMemo(() => shown().filter((c) => hierarchyShows(effectiveHierarchy(), c, allIssues())));
  const orderedIds = createMemo(() => orderedVisibleCardIds(visibleCards(), look(), allIssues(), older(), Date.now(), board()?.boardSummary));
  const focusedId = signal<string | undefined>(undefined);
  createEffect(
    () =>
      allIssues()
        .map((i) => i.id)
        .join("\0"),
    () => {
      const known = new Set<string>(allIssues().map((i) => i.id));
      const focus = untracked(focusedId);
      if (focus !== undefined && !known.has(focus)) {
        focusedId.set(undefined);
      }
    },
    { defer: true },
  );
  const activeFocusId = () => {
    const cur = focusedId();
    if (cur !== undefined && orderedIds().includes(cur)) return cur;
    return returnTo();
  };
  const card = createMemo(() => {
    const at = id();
    return at === undefined ? undefined : all().find((c) => c.id === at || (c.kind === "issue" && issueIs(c.issue, at)));
  });
  const activeOverlay = createMemo(() => {
    const promoted = props.rest === "new" ? pendingNewIssue.get() : undefined;
    const effectiveRepo = promoted?.repo ?? (repo() || undefined);
    const routeDefaults: NewIssueAt = {
      ...(promoted ? { text: promoted.text, attachmentFiles: promoted.attachmentFiles } : {}),
      ...(effectiveRepo ? { repo: effectiveRepo } : {}),
      ...(agent() ? { agent: agent() } : {}),
    };
    return effectiveIssueOverlay(overlay(), props.rest, routeDefaults, id());
  });
  const peekCard = createMemo(() => {
    const cur = activeOverlay();
    if (cur.kind !== "peeking") return undefined;
    return all().find((c) => c.id === cur.id || (c.kind === "issue" && issueIs(c.issue, cur.id)));
  });
  const newDraftAt = createMemo(() => {
    const cur = activeOverlay();
    return cur.kind === "new" ? cur.at : undefined;
  });
  const closingOverlay = createMemo(() => {
    const cur = activeOverlay();
    return cur.kind === "closing" ? cur : undefined;
  });
  const reopeningOverlay = createMemo(() => {
    const cur = activeOverlay();
    return cur.kind === "reopening" ? cur : undefined;
  });

  const place = async (c: BoardCard, before: string | undefined) => {
    if (c.id === before) return;
    const laneCards = visibleCards().filter((item) => item.lane === c.lane);
    const curIdx = laneCards.findIndex((item) => item.id === c.id);
    if (curIdx !== -1) {
      if (before === undefined && curIdx === laneCards.length - 1) return;
      if (before !== undefined && laneCards[curIdx + 1]?.id === before) return;
    }
    const targetBefore = before ?? "";
    const entry: PendingPlacement = { id: c.id, before: targetBefore };
    pendingPlacements.set([...untracked(pendingPlacements).filter((p) => p.id !== c.id), entry]);
    try {
      await act.run(() => api.issue.update({ id: c.id, before: targetBefore }));
    } finally {
      pendingPlacements.set(untracked(pendingPlacements).filter((p) => p !== entry));
    }
  };

  /** Asked about first where it cannot be undone. Cross-lane drops forward `before` so rank persists with status. */
  const drop = async (c: BoardCard, to: Lane, before?: string) => {
    if (c.kind === "todo" && c.lane === to) return place(c, before === "" ? undefined : before);
    const move = cardMove(c, to);
    const rankEdit = c.kind === "todo" && before !== undefined ? { before } : undefined;
    if (move === "start" && (c.kind === "todo" || c.kind === "family")) {
      if (!assignedAgentOf(c.issue) || !c.issue.repo) {
        toast(t("web.issue.page.pickFirst"));
        return;
      }
      const done = await sendMove(moves, {
        id: c.id,
        status: "todo",
        lane: to,
        ...(rankEdit ? { before: rankEdit.before, edit: rankEdit } : {}),
      }).done;
      if (done?.replied) notice(done.replied.reply);
    } else if (move === "track") {
      await sendMove(moves, {
        id: c.id,
        status: to,
        lane: to,
        ...(rankEdit ? { before: rankEdit.before, edit: rankEdit } : {}),
      }).done;
    } else if (move === "close" && c.kind === "todo") {
      await sendMove(moves, { id: c.id, status: to, lane: to }).done;
    } else if (move === "revive") {
      await sendMove(moves, {
        id: c.id,
        status: "backlog",
        lane: to,
        ...(rankEdit ? { before: rankEdit.before, edit: rankEdit } : {}),
      }).done;
    } else if (move === "close" && c.kind === "issue" && c.session) {
      dispatchOverlay({ kind: "openClose", issue: c.issue, session: c.session, review: false, lane: to });
    } else if (move === "close" && c.kind === "family") {
      dispatchOverlay({ kind: "openClose", issue: c.issue, session: undefined, review: false, lane: to });
    } else if (move === "reopen" && (c.kind === "issue" || c.kind === "family")) {
      dispatchOverlay({ kind: "openReopen", issue: c.issue, lane: to });
    }
  };

  const closeDraft = () => {
    pendingNewIssue.set(undefined);
    dispatchOverlay({ kind: "clear" });
    if (props.rest === "new") open(undefined);
  };
  const startNew = (where: NewIssueAt) => {
    const f = filter();
    const repo = where.repo || f.repo;
    const agent = where.agent || f.agent;
    const text = where.text;
    const machineId = where.machineId;
    dispatchOverlay({
      kind: "openNew",
      at: {
        ...(repo ? { repo } : {}),
        ...(agent ? { agent } : {}),
        ...(text ? { text } : {}),
        ...(machineId ? { machineId } : {}),
        ...(where.parent ? { parent: where.parent } : {}),
        ...(where.startAt !== undefined ? { startAt: where.startAt } : {}),
        ...(where.dueAt !== undefined ? { dueAt: where.dueAt } : {}),
      },
    });
  };
  const updateScheduleDates = async (issueId: string, dates: { startAt?: number; dueAt?: number }) => {
    await sendLabel(labelSets, omitUndefined({ id: issueId, startAt: dates.startAt, dueAt: dates.dueAt })).done;
  };
  const addInList: ListAdd = (where) => startNew(where);
  const dialogUp = () => {
    const cur = activeOverlay();
    return cur.kind === "peeking" ? peekCard() !== undefined : isIssueOverlayBlocking(cur);
  };
  // Board navigation shortcuts: active only when on the board surface with no modal or detail open.
  const canNavigateBoard = () => id() === undefined && !dialogUp();
  createEffect(() => {
    if (!canNavigateBoard()) return;
    return keymap.bind(
      {
        c: () => startNew({}),
        j: () => {
          const next = stepFocusId(orderedIds(), untracked(focusedId), 1);
          if (next !== undefined) focusedId.set(next);
        },
        down: () => {
          const next = stepFocusId(orderedIds(), untracked(focusedId), 1);
          if (next !== undefined) focusedId.set(next);
        },
        k: () => {
          const next = stepFocusId(orderedIds(), untracked(focusedId), -1);
          if (next !== undefined) focusedId.set(next);
        },
        up: () => {
          const next = stepFocusId(orderedIds(), untracked(focusedId), -1);
          if (next !== undefined) focusedId.set(next);
        },
        enter: () => {
          const target = untracked(focusedId);
          if (target !== undefined && orderedIds().includes(target)) peek(target);
        },
        e: () => {
          const target = untracked(focusedId);
          if (target !== undefined && orderedIds().includes(target)) open(target);
        },
      },
      { when: "notEditing" },
    );
  });
  const keepNew = async (words: string, where: NewIssueAt, requestKey: string) => {
    const made = await act.run(() =>
      writeIssue(words, where.agent ?? "", where.repo ?? "", requestKey, where.machineId ?? "", where.attachments, where.tags, {
        parent: where.parent,
        owner: where.owner,
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
    <View testID="issues-page" class="min-h-0 min-w-0 flex-1">
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
            <IssuesToolbar
              filter={filter()}
              cards={all()}
              shown={visibleCards().length}
              onFilter={setFilter}
              look={look()}
              onLook={setLook}
              refreshing={refreshing()}
              onRefresh={refreshIssues}
              onNew={() => startNew({})}
            />
            <If when={filter().scope === "backlog"}>
              <BacklogTriagePanel />
            </If>
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
                          cards={visibleCards()}
                          allIssues={allIssues()}
                          summary={board()?.boardSummary}
                          filtered={filterAny(filter()) || effectiveHierarchy() !== "all"}
                          loading={history.loading()}
                          selected={returnTo()}
                          density={look().density}
                          fields={look().fields}
                          onOpen={peek}
                          onNew={startNew}
                          onClearFilter={() => setFilter(noFilter)}
                        />
                      }
                    >
                      <IssueTimeline
                        cards={visibleCards()}
                        allIssues={allIssues()}
                        summary={board()?.boardSummary}
                        filtered={filterAny(filter()) || effectiveHierarchy() !== "all"}
                        loading={history.loading()}
                        selected={activeFocusId()}
                        density={look().density}
                        fields={look().fields}
                        onOpen={peek}
                        onUpdateDates={updateScheduleDates}
                        onNew={startNew}
                        onClearFilter={() => setFilter(noFilter)}
                      />
                    </If>
                  }
                >
                  <IssueList
                    cards={visibleCards()}
                    allIssues={allIssues()}
                    filtered={filterAny(filter()) || effectiveHierarchy() !== "all"}
                    loading={history.loading()}
                    selected={activeFocusId()}
                    older={older()}
                    grouping={look().grouping}
                    groupBy={effectiveGroupBy()}
                    hierarchy={effectiveHierarchy()}
                    ordering={look().ordering}
                    density={look().density}
                    fields={look().fields}
                    onOlder={() => older.set(!older())}
                    onOpen={peek}
                    onAdd={addInList}
                    onClearFilter={() => setFilter(noFilter)}
                  />
                </If>
              }
            >
              <IssueBoard
                cards={visibleCards()}
                allIssues={allIssues()}
                summary={board()?.boardSummary}
                filtered={filterAny(filter()) || effectiveHierarchy() !== "all"}
                loading={history.loading()}
                selected={activeFocusId()}
                older={older()}
                ordering={look().ordering}
                groupBy={effectiveGroupBy()}
                hierarchy={effectiveHierarchy()}
                density={look().density}
                fields={look().fields}
                onOlder={() => older.set(!older())}
                onOpen={peek}
                onDrop={(c, to, before) => void drop(c, to, before)}
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
          {(at) => {
            const cur = () => all().find((c) => c.id === at() || issueIs(c.issue, at()) || String(c.issue.number) === at());
            return (
              <IssueView
                onBack={() => open(undefined)}
                backLabel={fromScene() ?? t("web.issue.page.backToBoard")}
                issueNumber={cur()?.issue.number}
                repo={cur() ? cardRepo(cur()!) : undefined}
                blocked={dialogUp}
              >
                <Detail
                  id={at()}
                  cards={all}
                  known={!history.loading() && history.rows() !== undefined}
                  open={open}
                  onClose={(issue, session, review) => dispatchOverlay({ kind: "openClose", issue, session, review })}
                />
              </IssueView>
            );
          }}
        </Each>
      </If>
      <If when={peekCard()}>
        {(c) => (
          <IssuePeekModal card={c()} blocked={() => activeOverlay().kind !== "peeking"} onExpand={expandPeek} onClose={closePeek}>
            <Each of={[c().id]} key={(cur) => cur}>
              {(at) => (
                <Detail
                  id={at()}
                  cards={all}
                  known={!history.loading() && history.rows() !== undefined}
                  open={(to) => (to === undefined ? closePeek() : dispatchOverlay({ kind: "peek", id: to }))}
                  onClose={(issue, session, review) => dispatchOverlay({ kind: "openClose", issue, session, review })}
                />
              )}
            </Each>
          </IssuePeekModal>
        )}
      </If>
      <If when={newDraftAt()}>{(at) => <NewIssue at={at()} onKeep={keepNew} onClose={closeDraft} />}</If>
      <If when={closingOverlay()}>
        {(c) => (
          <CloseIssueDialog issue={c().issue} session={c().session} review={c().review} lane={c().lane} onClose={() => dispatchOverlay({ kind: "dismiss" })} />
        )}
      </If>
      <If when={reopeningOverlay()}>
        {(r) => <ReopenDialog issue={r().issue} lane={r().lane} onClose={() => dispatchOverlay({ kind: "dismiss" })} onReopened={() => open(r().issue.id)} />}
      </If>
    </View>
  );
}
