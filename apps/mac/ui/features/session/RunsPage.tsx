import { Scroll, signal, Text, untracked, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Look } from "@vibevalley/protocol";
import { sessionProfile } from "@vibevalley/protocol/rules";

import { Button } from "../../design/Button";
import { SearchField } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { Quiet } from "../../design/layout";
import { Segmented } from "../../design/Segmented";
import { CountPill, Dot } from "../../design/Tag";
import { mix } from "../../design/tone";
import { useOrchestrators } from "../../infra/agents";
import { reasonOf } from "../../infra/api";
import { Keyed, useNow } from "../../infra/base/dom";
import { useBoardSlice, useSessionsSlice } from "../../infra/frame";
import { ready, useAgents, useQuery } from "../../infra/query";
import { useLocation, useRouter, useSearch } from "../../infra/router";
import { createMemo } from "../../infra/solid";
import { useVdpNode } from "../../infra/vdpProbe";
import { allSessionsQuery, type RunApprovals, scopeLabel } from "./runs/presentation";
import { RunDetail } from "./runs/RunDetail";
import { RunListRow } from "./runs/RunListRow";
import { buildRunEntries, filterRunEntries, parseRunsSearch, resolveSelectedRun, type RunEntry, runsHref, type RunsScope, runsScopes } from "./runsView";

export { allSessionsQuery, type RunApprovals };

export function RunsPage(props: { approvals?: RunApprovals }) {
  useVdpNode({ testId: "runs-page", role: "region" });
  const board = useBoardSlice();
  const sessionsSlice = useSessionsSlice();
  const router = useRouter();
  const location = useLocation();
  const search = useSearch();
  const basePath = () => (location().pathname.startsWith("/dashboard/runs") ? "/dashboard/runs" : "/runs");
  const now = useNow();
  const orchestrators = useOrchestrators();
  const agents = useAgents();
  const sessions = useQuery(allSessionsQuery);

  const query = signal("");
  const box = signal(0);
  const wide = createMemo(() => box() === 0 || box() >= 768);
  const parsed = createMemo(() => parseRunsSearch(search()));
  const narrowPane = signal<"list" | "detail">(untracked(() => (parsed().session !== undefined ? "detail" : "list")));

  const scope = () => parsed().scope ?? "all";
  const agentFilter = () => parsed().agent;
  const issueFilter = () => parsed().issue;
  const sessionParam = () => parsed().session;

  const allEntries = createMemo(() =>
    buildRunEntries({
      orchestrators: orchestrators(),
      sessions: ready(sessions, []),
      liveSessions: sessionsSlice()?.sessions ?? [],
      issues: board()?.issues ?? [],
    }),
  );

  const activeCount = createMemo(() => allEntries().filter((e) => e.active).length);

  const visibleEntries = createMemo(() =>
    filterRunEntries(allEntries(), {
      scope: scope(),
      agentId: agentFilter(),
      issueId: issueFilter(),
      query: query(),
    }),
  );

  const selected = createMemo(() => resolveSelectedRun(visibleEntries(), sessionParam()));

  const hasFilters = createMemo(() => scope() !== "all" || agentFilter() !== undefined || issueFilter() !== undefined || query().trim().length > 0);
  const agentById = createMemo(() => new Map(ready(agents, []).map((a) => [a.id, a])));
  const lookOf = (entry: RunEntry): Look | undefined => (entry.kind === "worker" ? agentById().get(sessionProfile(entry.session) ?? "")?.look : undefined);

  const agentFilterName = createMemo(() => {
    const id = agentFilter();
    if (!id) return undefined;
    return agentById().get(id)?.name ?? id;
  });

  const issueFilterLabel = createMemo(() => {
    const id = issueFilter();
    if (!id) return undefined;
    const found = (board()?.issues ?? []).find((i) => i.id === id);
    return found ? `#${found.number} ${found.title}` : id;
  });
  const scopeOptions = createMemo(() =>
    runsScopes.map((item) => ({
      value: item,
      label: scopeLabel(item),
      count: item === "active" ? activeCount() : undefined,
      countTone: "water" as const,
    })),
  );

  const setScope = (next: RunsScope) => {
    router.navigate(runsHref({ ...parsed(), scope: next }, basePath()), { replace: true });
  };

  const clearAgent = () => {
    router.navigate(runsHref({ ...parsed(), agent: undefined }, basePath()), { replace: true });
  };

  const clearIssue = () => {
    router.navigate(runsHref({ ...parsed(), issue: undefined }, basePath()), { replace: true });
  };

  const clearAllFilters = () => {
    query.set("");
    router.navigate(runsHref({ session: parsed().session }, basePath()), { replace: true });
  };

  const pickEntry = (entry: RunEntry) => {
    router.navigate(runsHref({ ...parsed(), session: entry.id }, basePath()), { replace: true });
    if (!wide()) narrowPane.set("detail");
  };

  const listPane = () => (
    <View
      testID="runs-list-pane"
      accessibilityLabel={t("web.session.hub.list")}
      class={`min-h-0 flex-col bg-side ${wide() ? "w-76 shrink-0 border-r border-line" : "flex-1"}`}
    >
      <View desktop={{ windowDrag: true }} class="h-11 shrink-0 flex-row items-center justify-between gap-2 border-b border-line bg-page px-3">
        <View class="min-w-0 flex-row items-center gap-2">
          <Text class="truncate text-sm font-semibold text-ink">{t("web.session.hub.list")}</Text>
          <CountPill count={visibleEntries().length} />
        </View>
        <If when={activeCount() > 0}>
          <View class="h-5 shrink-0 flex-row items-center gap-1 rounded-sm px-1.5" style={{ backgroundColor: mix("water", 0.14) }}>
            <Dot tone="water" size={6} ring={false} />
            <Text class="font-mono text-2xs font-medium text-water tabular-nums">{String(activeCount())}</Text>
          </View>
        </If>
      </View>
      <View class="shrink-0 gap-1.5 border-b border-line bg-side px-2.5 py-2">
        <SearchField
          testid="runs-search"
          clearTestid="runs-search-clear"
          clearLabel={t("web.session.hub.clear")}
          value={query()}
          onInput={(v) => query.set(v)}
          placeholder={t("web.session.hub.searchHint")}
          label={t("web.session.hub.search")}
          class="w-full"
        />
        <Segmented testid="runs-scope" label={t("web.session.hub.scopeLabel")} value={scope()} onChange={setScope} options={scopeOptions()} />
        <If when={agentFilterName() !== undefined || issueFilterLabel() !== undefined}>
          <View class="flex-row flex-wrap items-center gap-1.5">
            <If when={agentFilterName()}>
              {(name) => (
                <View testID="runs-filter-agent" class="h-6 max-w-full flex-row items-center gap-1 rounded-full border border-line bg-page pr-1 pl-2">
                  <Text class="min-w-0 shrink truncate text-2xs font-medium text-ink">{t("web.session.hub.filterAgent", { name: name() })}</Text>
                  <View
                    role="button"
                    testID="runs-clear-agent"
                    accessibilityLabel={t("web.session.hub.clear")}
                    onPress={clearAgent}
                    class="size-4 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-focus hover:bg-hover"
                  >
                    <Icon name="close" size={10} tone="muted" />
                  </View>
                </View>
              )}
            </If>
            <If when={issueFilterLabel()}>
              {(label) => (
                <View testID="runs-filter-issue" class="h-6 max-w-full flex-row items-center gap-1 rounded-full border border-line bg-page pr-1 pl-2">
                  <Text class="min-w-0 shrink truncate text-2xs font-medium text-ink">{t("web.session.hub.filterIssue", { label: label() })}</Text>
                  <View
                    role="button"
                    testID="runs-clear-issue"
                    accessibilityLabel={t("web.session.hub.clear")}
                    onPress={clearIssue}
                    class="size-4 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-focus hover:bg-hover"
                  >
                    <Icon name="close" size={10} tone="muted" />
                  </View>
                </View>
              )}
            </If>
          </View>
        </If>
      </View>
      <Scroll class="min-h-0 flex-1" contentClass="gap-0.5 p-1.5">
        <If
          when={visibleEntries().length > 0}
          else={
            <View testID="runs-empty" class="gap-2.5 px-2.5 py-6">
              <Quiet>
                {sessions.error() && allEntries().length === 0
                  ? reasonOf(sessions.error())
                  : sessions.status() === "pending" && allEntries().length === 0
                    ? t("web.base.reading")
                    : hasFilters()
                      ? t("web.session.hub.emptyFiltered")
                      : t("web.session.hub.empty")}
              </Quiet>
              <If when={hasFilters()}>
                <Button size="compact" testID="runs-clear-filters" class="self-start" onPress={clearAllFilters}>
                  {t("web.session.hub.clearFilter")}
                </Button>
              </If>
            </View>
          }
        >
          <Each of={visibleEntries()} key={(entry) => `${entry.kind}:${entry.id}`}>
            {(entry) => (
              <RunListRow entry={entry()} look={lookOf(entry())} selected={selected()?.id === entry().id} now={now()} onSelect={() => pickEntry(entry())} />
            )}
          </Each>
        </If>
      </Scroll>
    </View>
  );

  const detailPane = () => (
    <View testID="runs-detail-pane" class="min-h-0 min-w-0 flex-1 bg-page">
      <If
        when={selected()}
        else={
          <View class="flex-1 items-center justify-center p-6">
            <Quiet>{allEntries().length === 0 ? t("web.session.hub.empty") : t("web.session.hub.pick")}</Quiet>
          </View>
        }
      >
        {(entry) => (
          <Keyed key={`${entry().kind}:${entry().id}`}>
            {() => (
              <RunDetail
                entry={entry()}
                look={lookOf(entry())}
                now={now()}
                showBack={!wide()}
                onBack={() => narrowPane.set("list")}
                onOpenSession={(id) => router.navigate(runsHref({ ...parsed(), session: id }, basePath()), { replace: true })}
                approvals={props.approvals}
              />
            )}
          </Keyed>
        )}
      </If>
    </View>
  );

  return (
    <View testID="runs-page" onLayout={(e) => box.set(e.bounds.size.width)} class="h-full min-h-0 flex-1 flex-row bg-page">
      <If
        when={wide()}
        else={
          <If when={narrowPane() === "detail" && selected() !== undefined} else={listPane()}>
            {detailPane()}
          </If>
        }
      >
        {listPane()}
        {detailPane()}
      </If>
    </View>
  );
}
