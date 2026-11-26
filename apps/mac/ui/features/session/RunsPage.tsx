import { Clipboard, computed, Scroll, signal, Text, untracked, View, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Look, OrchestratorEval } from "@vibevalley/protocol";
import { oneLine, sessionIssueId, sessionProfile, sessionRepo } from "@vibevalley/protocol/rules";

import { Button, ButtonLink } from "../../design/Button";
import { AgentFace, OrchestratorFace } from "../../design/domain/Face";
import { SearchField } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { ActiveBar, Quiet } from "../../design/layout";
import { Segmented } from "../../design/Segmented";
import { CountPill, Dot, type DotTone } from "../../design/Tag";
import { Bubble } from "../../design/Tip";
import { toast } from "../../design/toasts";
import { mix } from "../../design/tone";
import { useOrchestrators } from "../../infra/agents";
import { api, reasonOf } from "../../infra/api";
import { Keyed, useNow } from "../../infra/base/dom";
import { ago } from "../../infra/base/format";
import { useTimeout } from "../../infra/base/timer";
import { useBoardSlice, useSessionsSlice } from "../../infra/frame";
import { defineQuery, ready, retryRead, useAgents, useQuery } from "../../infra/query";
import { useRouter, useSearch } from "../../infra/router";
import { localizeRuntimeError } from "../../infra/runtimeError";
import { createEffect, createMemo } from "../../infra/solid";
import {
  buildRunEntries,
  filterRunEntries,
  parseRunsSearch,
  resolveSelectedRun,
  runActivityAt,
  type RunEntry,
  runsHref,
  type RunsScope,
  runsScopes,
  type RunStatusBadge,
  runStatusOf,
} from "./runsView";
import { TrajectoryLog } from "./Trajectory";

const markWrongOf =
  (agent: string) =>
  (on: number, want: string): Promise<OrchestratorEval> =>
    api.orchestrator.eval.create({ agent, on, want });

const allSessionsQuery = defineQuery({
  key: () => ["sessions", "all"],
  fetch: (_: void, context) => api.session.list({}, context),
  ...retryRead,
});

function scopeLabel(scope: RunsScope): string {
  switch (scope) {
    case "all":
      return t("web.session.hub.scope.all");
    case "active":
      return t("web.session.hub.scope.active");
    case "orchestrator":
      return t("web.session.hub.scope.orchestrator");
    case "worker":
      return t("web.session.hub.scope.worker");
  }
}

interface StatusPresentation {
  readonly label: string;
  readonly dot: DotTone;
  readonly pillClass: string;
  readonly pillBg?: () => string;
  readonly textClass: string;
}

function statusMeta(status: RunStatusBadge): StatusPresentation {
  switch (status) {
    case "working":
      return {
        label: t("web.session.hub.status.working"),
        dot: "water",
        pillClass: "",
        pillBg: () => mix("water", 0.14),
        textClass: "text-water",
      };
    case "listening":
      return {
        label: t("web.session.hub.status.listening"),
        dot: "leaf",
        pillClass: "bg-ok-soft",
        textClass: "text-ok-ink",
      };
    case "resting":
      return {
        label: t("web.session.hub.status.resting"),
        dot: "wheat",
        pillClass: "bg-warn-soft",
        textClass: "text-warn-ink",
      };
    case "done":
      return {
        label: t("web.session.hub.status.done"),
        dot: "leaf",
        pillClass: "bg-ok-soft",
        textClass: "text-ok-ink",
      };
    case "failed":
      return {
        label: t("web.session.hub.status.failed"),
        dot: "berry",
        pillClass: "bg-bad-soft",
        textClass: "text-berry",
      };
    case "interrupted":
      return {
        label: t("web.session.hub.status.interrupted"),
        dot: "wheat",
        pillClass: "bg-warn-soft",
        textClass: "text-warn-ink",
      };
    case "closed":
      return {
        label: t("web.session.hub.status.closed"),
        dot: "idle",
        pillClass: "bg-hover",
        textClass: "text-muted",
      };
  }
}

function entryName(entry: RunEntry): string {
  switch (entry.kind) {
    case "orchestrator":
      return entry.agent.name;
    case "worker":
      return entry.live?.name ?? entry.session.name;
  }
}

function entrySubtitle(entry: RunEntry): string {
  switch (entry.kind) {
    case "orchestrator":
      return (entry.live?.phaseText ? localizeRuntimeError(entry.live.phaseText).text : "") || entry.agent.duty || t("web.agent.list.orchestratorLine");
    case "worker":
      if (entry.issue) return entry.issue.title;
      return oneLine(entry.session.brief).trim() || sessionRepo(entry.session) || "";
  }
}

function entryTiming(entry: RunEntry, now: number): string {
  switch (entry.kind) {
    case "orchestrator": {
      const at = runActivityAt(entry);
      return at > 0 ? ago(at, now) : "";
    }
    case "worker": {
      const phase = entry.live?.phase ?? entry.session.phase;
      if (phase._tag === "closed") {
        return t("web.session.trajectory.hiredAndLeft", { hired: ago(entry.session.hiredAt, now), left: ago(phase.at, now) });
      }
      return t("web.session.trajectory.hired", { ago: ago(entry.session.hiredAt, now) });
    }
  }
}

/** Provided by app/: orchestrator links to runs, so session does not import orchestrator back. */
export type RunApprovals = (props: { readonly conversationId: string }) => JSX.Element;

export function RunsPage(props: { approvals?: RunApprovals }) {
  const board = useBoardSlice();
  const sessionsSlice = useSessionsSlice();
  const router = useRouter();
  const search = useSearch();
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
    router.navigate(runsHref({ ...parsed(), scope: next }), { replace: true });
  };

  const clearAgent = () => {
    router.navigate(runsHref({ ...parsed(), agent: undefined }), { replace: true });
  };

  const clearIssue = () => {
    router.navigate(runsHref({ ...parsed(), issue: undefined }), { replace: true });
  };

  const clearAllFilters = () => {
    query.set("");
    router.navigate(runsHref({ session: parsed().session }), { replace: true });
  };

  const pickEntry = (entry: RunEntry) => {
    router.navigate(runsHref({ ...parsed(), session: entry.id }), { replace: true });
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

function RunListRow(props: { entry: RunEntry; look?: Look | undefined; selected: boolean; now: number; onSelect: () => void }) {
  const status = () => statusMeta(runStatusOf(props.entry));
  const at = () => runActivityAt(props.entry);
  const when = () => (at() > 0 ? ago(at(), props.now) : "");
  const issueNum = () => (props.entry.kind === "worker" && props.entry.issue ? `#${props.entry.issue.number}` : undefined);
  const repo = () => (props.entry.kind === "worker" ? sessionRepo(props.entry.session) : undefined);
  return (
    <View
      role="button"
      testID={`run-row-${props.entry.id}`}
      accessibilityLabel={entryName(props.entry)}
      accessibilityState={{ selected: props.selected }}
      onPress={props.onSelect}
      class={`relative flex-row items-start gap-2 rounded-md border px-2.5 py-1.5 focus-visible:outline-2 focus-visible:outline-focus ${
        props.selected ? "border-line bg-selected" : "border-transparent hover:bg-hover"
      }`}
    >
      <If when={props.selected}>
        <ActiveBar tall />
      </If>
      <View class="mt-0.5 shrink-0">
        <If
          when={props.entry.kind === "orchestrator"}
          else={
            <If when={props.entry.kind === "worker" ? props.entry : undefined}>
              {(w) => <AgentFace agentId={sessionProfile(w().session) ?? ""} name={w().session.name} look={props.look} size={28} />}
            </If>
          }
        >
          <OrchestratorFace size={28} agent={props.entry.id} />
        </If>
      </View>
      <View class="min-w-0 flex-1 gap-0.5">
        <View class="flex-row items-center gap-1.5">
          <Text class="min-w-0 shrink truncate text-sm font-medium text-ink">{entryName(props.entry)}</Text>
          <If when={props.entry.kind === "orchestrator"}>
            <View class="shrink-0 rounded-sm bg-hover px-1.5 py-px">
              <Text class="text-2xs font-medium text-muted">{t("web.session.hub.orchestratorRole")}</Text>
            </View>
          </If>
          <If when={issueNum()}>
            {(num) => (
              <View class="shrink-0 rounded-sm bg-hover px-1 py-px">
                <Text class="font-mono text-2xs text-muted tabular-nums">{num()}</Text>
              </View>
            )}
          </If>
          <View class="flex-1" />
          <If when={when()}>
            <Text class="shrink-0 text-2xs text-faint tabular-nums">{when()}</Text>
          </If>
        </View>
        <If when={entrySubtitle(props.entry)}>
          <Text class="truncate text-xs text-muted">{entrySubtitle(props.entry)}</Text>
        </If>
        <View class="flex-row items-center gap-1.5">
          <Dot tone={status().dot} size={6} ring={false} />
          <Text class={`shrink-0 text-2xs font-medium ${status().textClass}`}>{status().label}</Text>
          <If when={repo()}>
            {(r) => (
              <>
                <Text class="text-2xs text-faint">·</Text>
                <Text class="min-w-0 flex-1 truncate font-mono text-2xs text-faint">{r()}</Text>
              </>
            )}
          </If>
        </View>
      </View>
    </View>
  );
}

function RunDetail(props: { entry: RunEntry; look?: Look | undefined; now: number; showBack: boolean; onBack: () => void; approvals?: RunApprovals }) {
  const copiedId = signal(false);
  const resetCopy = useTimeout();
  createEffect(
    () => props.entry.id,
    () => copiedId.set(false),
    { defer: true },
  );
  const copyRunId = () => {
    const id = props.entry.id;
    void Clipboard.writeText(id).then(
      () => {
        copiedId.set(true);
        resetCopy(() => copiedId.set(false), 1500);
        toast(t("web.base.rich.copied"));
      },
      () => undefined,
    );
  };
  const status = computed(() => statusMeta(runStatusOf(props.entry)));
  const pillStyle = () => {
    const bg = status().pillBg;
    return bg ? { backgroundColor: bg() } : undefined;
  };
  const profileId = () => (props.entry.kind === "orchestrator" ? props.entry.agent.id : (sessionProfile(props.entry.session) ?? ""));
  const workerIssueId = () => (props.entry.kind === "worker" ? sessionIssueId(props.entry.session) : undefined);
  const workerIssueNumber = () => (props.entry.kind === "worker" ? props.entry.issue?.number : undefined);
  const timing = () => entryTiming(props.entry, props.now);
  const repo = () => (props.entry.kind === "worker" ? sessionRepo(props.entry.session) : undefined);
  const subLine = computed(() => {
    const parts: string[] = [];
    if (props.entry.kind === "orchestrator") {
      parts.push(t("web.session.hub.orchestratorRole"));
      if (props.entry.agent.duty) parts.push(props.entry.agent.duty);
    } else {
      if (repo()) parts.push(repo() ?? "");
      if (timing()) parts.push(timing());
    }
    return parts.join(" · ");
  });

  return (
    <View class="h-full min-h-0 flex-1 bg-page">
      <View
        desktop={{ windowDrag: true }}
        testID="run-detail-header"
        class="min-h-11 shrink-0 flex-row flex-wrap items-center gap-2.5 border-b border-line bg-page px-4 py-1.5"
      >
        <If when={props.showBack}>
          <View
            role="button"
            testID="runs-back"
            onPress={props.onBack}
            class="-ml-1 flex-row items-center gap-1 rounded-md px-1.5 py-0.5 focus-visible:outline-2 focus-visible:outline-focus hover:bg-hover"
          >
            <Icon name="back" size={12} tone="muted" />
            <Text class="text-xs font-medium text-muted">{t("web.session.hub.back")}</Text>
          </View>
        </If>
        <View class="shrink-0">
          <If
            when={props.entry.kind === "orchestrator"}
            else={
              <If when={props.entry.kind === "worker" ? props.entry : undefined}>
                {(w) => (
                  <AgentFace agentId={sessionProfile(w().session) ?? ""} name={w().session.name} runtime={w().session.runtime} look={props.look} size={24} />
                )}
              </If>
            }
          >
            <OrchestratorFace size={24} agent={props.entry.id} />
          </If>
        </View>
        <View class="min-w-0 flex-1 flex-row items-center gap-2">
          <Text role="header" class="shrink-0 truncate text-sm font-semibold text-ink">
            {entryName(props.entry)}
          </Text>
          <View class={`h-5 shrink-0 flex-row items-center gap-1 rounded-sm px-1.5 ${status().pillClass}`} style={pillStyle()}>
            <Dot tone={status().dot} size={6} ring={false} />
            <Text class={`text-2xs font-medium ${status().textClass}`}>{status().label}</Text>
          </View>
          <If when={subLine()}>
            <Text class="min-w-0 flex-1 truncate text-xs text-muted">{subLine()}</Text>
          </If>
        </View>
        <View class="shrink-0 flex-row items-center gap-1.5">
          <Button
            size="compact"
            testID="run-copy-id"
            icon={copiedId() ? "check" : "copy"}
            tooltip={<Bubble text={copiedId() ? t("web.base.rich.copied") : t("web.base.rich.copy")} />}
            onPress={copyRunId}
          >
            {copiedId() ? t("web.base.rich.copied") : t("web.base.rich.copy")}
          </Button>
          <If when={workerIssueId()}>
            {(issueId) => (
              <ButtonLink size="compact" href={`/issues/${encodeURIComponent(issueId())}`} icon="issues" testID="run-open-issue">
                {workerIssueNumber() !== undefined ? `#${workerIssueNumber()} ${t("web.session.hub.openIssue")}` : t("web.session.hub.openIssue")}
              </ButtonLink>
            )}
          </If>
          <ButtonLink size="compact" href={`/agents/${encodeURIComponent(profileId())}`} icon="agents" testID="run-open-profile">
            {t("web.session.hub.openProfile")}
          </ButtonLink>
        </View>
      </View>
      <View class="min-h-0 flex-1 px-4 pt-2.5 pb-3">
        <View class="min-h-0 w-full max-w-6xl flex-1 gap-2.5">
          <If when={props.entry.kind === "orchestrator" ? props.approvals : undefined}>
            {(Approvals) => {
              const ViewApprovals = Approvals();
              return <ViewApprovals conversationId={props.entry.id} />;
            }}
          </If>
          <View class="min-h-0 flex-1">
            <If
              when={props.entry.kind === "orchestrator"}
              else={
                <If when={props.entry.kind === "worker" ? props.entry : undefined}>
                  {(w) => (
                    <TrajectoryLog
                      id={w().id}
                      working={w().active}
                      subagents={(w().live ?? w().session).subagents}
                      title={(() => {
                        const entry = w();
                        return entry.issue
                          ? `#${entry.issue.number} ${entry.issue.title}`
                          : entry.session.brief
                            ? oneLine(entry.session.brief).trim()
                            : entryName(entry);
                      })()}
                      about={w().session.brief || undefined}
                    />
                  )}
                </If>
              }
            >
              <TrajectoryLog
                id={props.entry.id}
                working={props.entry.active}
                asked={t("web.orchestrator.orchestrator.heard")}
                empty={t("web.orchestrator.orchestrator.quiet")}
                title={t("web.orchestrator.orchestrator.trajectory")}
                about={t("web.orchestrator.orchestrator.about")}
                onMarkWrong={markWrongOf(props.entry.id)}
              />
            </If>
          </View>
        </View>
      </View>
    </View>
  );
}
