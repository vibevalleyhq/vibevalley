import { Clipboard, computed, Scroll, signal, Text, untracked, View, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Look, OrchestratorEval, SessionEvent, SessionRunCodeResult, Spent } from "@vibevalley/protocol";
import { oneLine, sessionIssueId, sessionProfile, sessionRepo, sessionWorktree } from "@vibevalley/protocol/rules";

import { createAct } from "../../design/act";
import { Button, ButtonLink } from "../../design/Button";
import { Dialog } from "../../design/Dialog";
import { AgentFace, OrchestratorFace } from "../../design/domain/Face";
import { Field, SearchField, Select, TextArea, TextInput } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { ActiveBar, Quiet } from "../../design/layout";
import { Segmented } from "../../design/Segmented";
import { CountPill, Dot, type DotTone } from "../../design/Tag";
import { Bubble } from "../../design/Tip";
import { toast } from "../../design/toasts";
import { mix } from "../../design/tone";
import { useOrchestrators, useWorkAgents } from "../../infra/agents";
import { api, reasonOf } from "../../infra/api";
import { Keyed, useNow } from "../../infra/base/dom";
import { ago, spentText, yuan } from "../../infra/base/format";
import { useTimeout } from "../../infra/base/timer";
import { hostApi } from "../../infra/bridge";
import { useBoardSlice, useSessionsSlice } from "../../infra/frame";
import { defineQuery, ready, retryRead, useAgents, useQuery, useQueryClient, useRuntimes } from "../../infra/query";
import { useLocation, useRouter, useSearch } from "../../infra/router";
import { localizeRuntimeError } from "../../infra/runtimeError";
import { formatTokens } from "../../infra/sessionRuns";
import { createEffect, createMemo } from "../../infra/solid";
import { createSessionProjection } from "./events";
import {
  buildRunEntries,
  filterRunEntries,
  isRecoverableRun,
  parseRunsSearch,
  resolveSelectedRun,
  runActivityAt,
  type RunEntry,
  runsHref,
  type RunsScope,
  runsScopes,
  type RunStatusBadge,
  runStatusOf,
  runTelemetryOf,
  type RunTelemetryRollup,
  supportsCodeMode,
  supportsManualCompaction,
} from "./runsView";
import { TrajectoryLog } from "./Trajectory";

const markWrongOf =
  (agent: string) =>
  (on: number, want: string): Promise<OrchestratorEval> =>
    api.orchestrator.eval.create({ agent, on, want });

export const allSessionsQuery = defineQuery({
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

function formatCompactSpend(spent: Spent): string {
  const tokens = formatTokens(spent.tokens);
  return spent.cny !== undefined ? `${yuan(spent.cny)} · ${tokens}` : tokens;
}

function saturationTone(pct: number): { readonly bar: string; readonly text: string } {
  if (pct >= 85) return { bar: "bg-berry", text: "text-berry" };
  if (pct >= 65) return { bar: "bg-wheat", text: "text-warn-ink" };
  return { bar: "bg-leaf", text: "text-muted" };
}

function ContextSaturationMeter(props: { rollup: RunTelemetryRollup; compact?: boolean; testID?: string }) {
  const tone = () => saturationTone(props.rollup.contextPct);
  const label = () =>
    t("web.session.hub.telemetry.context", {
      pct: props.rollup.contextPct,
      used: formatTokens(props.rollup.contextUsed),
      window: formatTokens(props.rollup.contextWindow),
    });
  return (
    <View
      testID={props.testID}
      role="progressbar"
      accessibilityLabel={label()}
      accessibilityValue={{ min: 0, max: 100, now: props.rollup.contextPct }}
      tooltip={<Bubble text={label()} />}
      class="shrink-0 flex-row items-center gap-1.5"
    >
      <View class={`overflow-hidden rounded-full bg-hover ${props.compact === true ? "h-1 w-9" : "h-1.5 w-16"}`}>
        <View class={`h-full rounded-full ${tone().bar}`} style={{ width: `${props.rollup.contextPct}%` }} />
      </View>
      <Text class={`font-mono text-2xs tabular-nums ${tone().text}`}>
        {props.compact === true ? t("web.session.hub.telemetry.contextCompact", { pct: props.rollup.contextPct }) : label()}
      </Text>
    </View>
  );
}

function RunListRow(props: { entry: RunEntry; look?: Look | undefined; selected: boolean; now: number; onSelect: () => void }) {
  const status = () => statusMeta(runStatusOf(props.entry));
  const at = () => runActivityAt(props.entry);
  const when = () => (at() > 0 ? ago(at(), props.now) : "");
  const issueNum = () => (props.entry.kind === "worker" && props.entry.issue ? `#${props.entry.issue.number}` : undefined);
  const repo = () => (props.entry.kind === "worker" ? sessionRepo(props.entry.session) : undefined);
  const rollup = createMemo(() => runTelemetryOf(props.entry));
  const hasTelemetry = () => rollup().spent !== undefined || rollup().hasContext || rollup().llmRetries > 0 || rollup().runErrors > 0;
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
        <If when={hasTelemetry()}>
          <View class="mt-0.5 flex-row flex-wrap items-center gap-1.5">
            <If when={rollup().spent}>
              {(s) => (
                <Text testID={`run-row-cost-${props.entry.id}`} class="font-mono text-2xs text-muted tabular-nums">
                  {formatCompactSpend(s())}
                </Text>
              )}
            </If>
            <If when={rollup().llmRetries > 0}>
              <View testID={`run-row-retry-${props.entry.id}`} class="flex-row items-center gap-0.5 rounded-sm bg-warn-soft px-1 py-px">
                <Icon name="retry" size={10} tone="warn-ink" />
                <Text class="font-mono text-2xs font-medium text-warn-ink tabular-nums">
                  {t("web.session.hub.telemetry.retries", { n: rollup().llmRetries })}
                </Text>
              </View>
            </If>
            <If when={rollup().runErrors > 0}>
              <View testID={`run-row-error-${props.entry.id}`} class="flex-row items-center gap-0.5 rounded-sm bg-bad-soft px-1 py-px">
                <Icon name="cross" size={10} tone="berry" />
                <Text class="font-mono text-2xs font-medium text-berry tabular-nums">{t("web.session.hub.telemetry.errors", { n: rollup().runErrors })}</Text>
              </View>
            </If>
            <If when={rollup().hasContext}>
              <ContextSaturationMeter rollup={rollup()} compact testID={`run-row-context-${props.entry.id}`} />
            </If>
          </View>
        </If>
      </View>
    </View>
  );
}

function lastUserPromptOf(steps: readonly SessionEvent[]): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s !== undefined && s.type === "user/message" && s.under === undefined && s.text.trim().length > 0) {
      return s.text.trim();
    }
  }
  return undefined;
}

function RerunDialog(props: {
  open: boolean;
  onClose: () => void;
  entry: Extract<RunEntry, { kind: "worker" }>;
  lastPrompt?: string | undefined;
  onRerunDone: (newSessionId?: string) => void;
}) {
  const client = useQueryClient();
  const agents = useWorkAgents(true);
  const runtimes = useRuntimes();
  const target = signal("");
  const note = signal("");
  const submitting = createAct((msg) => toast(msg));

  const issueId = () => sessionIssueId(props.entry.session);
  const currentProfile = () => sessionProfile(props.entry.session);
  const currentRuntime = () => props.entry.session.runtime;

  const targetOptions = createMemo(() => {
    const runtimeList = ready(runtimes, []);
    const runtimeLabelById = new Map(runtimeList.map((r) => [r.id, r.preset.label]));
    const opts: { value: string; label: string; group?: string }[] = [];
    if (issueId() !== undefined) {
      for (const a of agents()) {
        const rtLabel = runtimeLabelById.get(a.runtime) ?? a.runtime;
        opts.push({
          value: `agent:${a.id}`,
          label: `${a.name} · ${rtLabel}`,
          group: t("web.session.hub.recovery.groupExperts"),
        });
      }
    }
    for (const r of runtimeList) {
      if (r.installation.status === "available" && r.settings.enabled) {
        opts.push({
          value: `runtime:${r.id}`,
          label: r.preset.label,
          group: t("web.session.hub.recovery.groupEngines"),
        });
      }
    }
    return opts;
  });

  createEffect(
    () => props.open,
    (open) => {
      if (!open) return;
      note.set("");
      const opts = targetOptions();
      const currentAgentValue = currentProfile() ? `agent:${currentProfile()}` : undefined;
      const currentRuntimeValue = `runtime:${currentRuntime()}`;
      const preferred = opts.find((o) => o.value !== currentAgentValue && o.value !== currentRuntimeValue) ?? opts[0];
      target.set(preferred?.value ?? "");
    },
  );

  const selectedLabel = () => targetOptions().find((o) => o.value === target())?.label ?? target();

  const submit = () => {
    const chosen = target().trim();
    if (!chosen || submitting.busy()) return;
    const rawId = chosen.startsWith("agent:") ? chosen.slice(6) : chosen.startsWith("runtime:") ? chosen.slice(8) : chosen;
    const label = selectedLabel();
    const guidance = note().trim();
    void submitting.run(async () => {
      const id = issueId();
      if (id !== undefined) {
        await api.issue.status.update({
          id,
          status: "todo",
          agent: rawId,
          ...(guidance.length > 0 ? { text: guidance } : {}),
        });
        await client.invalidate(allSessionsQuery());
        toast(t("web.session.hub.recovery.rerunStartedToast", { target: label }));
        props.onClose();
        props.onRerunDone();
        return;
      }
      const session = props.entry.live ?? props.entry.session;
      const cwd = session.cwd ?? "";
      const repo = sessionRepo(session);
      const ws = await api.session.openWorkspace({
        runtime: rawId,
        cwd,
        ...(repo !== undefined ? { repo } : {}),
        ...(session.name ? { title: session.name } : {}),
      });
      const promptText = guidance || props.lastPrompt || t("web.session.hub.recovery.resumePrompt");
      const deliverSessionPrompt = api.session.send;
      await deliverSessionPrompt({ id: ws.id, text: promptText });
      await client.invalidate(allSessionsQuery());
      toast(t("web.session.hub.recovery.rerunStartedToast", { target: label }));
      props.onClose();
      props.onRerunDone(ws.id);
    });
  };

  return (
    <Dialog
      open={props.open}
      onClose={() => props.onClose()}
      title={t("web.session.hub.recovery.rerunTitle")}
      size="sm"
      testid="run-rerun-dialog"
      footer={
        <View class="flex-row items-center justify-end gap-2">
          <Button size="compact" tone="quiet" testID="run-rerun-cancel" onPress={() => props.onClose()}>
            {t("shared.act.close")}
          </Button>
          <Button size="compact" tone="primary" icon="shuffle" testID="run-rerun-confirm" disabled={!target() || submitting.busy()} onPress={submit}>
            {t("web.session.hub.recovery.rerunConfirm")}
          </Button>
        </View>
      }
    >
      <View class="gap-3">
        <Field label={t("web.session.hub.recovery.rerunTarget")}>
          <Select
            searchable
            testid="run-rerun-target"
            label={t("web.session.hub.recovery.rerunTarget")}
            placeholder={t("web.session.hub.recovery.rerunTargetPlaceholder")}
            value={target()}
            onChange={(v) => target.set(v)}
            options={targetOptions()}
          />
        </Field>
        <Field label={t("web.session.hub.recovery.rerunNote")}>
          <TextInput
            testID="run-rerun-note"
            accessibilityLabel={t("web.session.hub.recovery.rerunNote")}
            placeholder={t("web.session.hub.recovery.rerunNotePlaceholder")}
            value={note()}
            onInput={(v) => note.set(v)}
            onSubmit={submit}
          />
        </Field>
      </View>
    </Dialog>
  );
}

function CodeModeDialog(props: { open: boolean; sessionId: string; onClose: () => void }) {
  const client = useQueryClient();
  const script = signal("");
  const result = signal<SessionRunCodeResult | undefined>(undefined);
  const running = createAct((msg) => toast(msg));

  createEffect(
    () => [props.open, props.sessionId] as const,
    ([open]) => {
      if (!open) return;
      result.set(undefined);
    },
  );

  const submit = () => {
    const body = script().trim();
    if (!body || running.busy()) return;
    void running.run(async () => {
      const res = await api.session.runCode({ id: props.sessionId, script: body });
      result.set(res);
      await client.invalidate(allSessionsQuery());
    });
  };

  return (
    <Dialog
      open={props.open}
      onClose={() => props.onClose()}
      title={t("web.session.hub.codemode.title")}
      size="md"
      testid="run-codemode-dialog"
      footer={
        <View class="flex-row items-center justify-end gap-2">
          <Button size="compact" tone="quiet" testID="run-codemode-cancel" onPress={() => props.onClose()}>
            {t("shared.act.close")}
          </Button>
          <Button size="compact" tone="primary" icon="bolt" testID="run-codemode-submit" disabled={!script().trim() || running.busy()} onPress={submit}>
            {t("web.session.hub.codemode.run")}
          </Button>
        </View>
      }
    >
      <View class="gap-3">
        <Text class="text-xs text-muted">{t("web.session.hub.codemode.description")}</Text>
        <Field label={t("web.session.hub.codemode.scriptLabel")}>
          <TextArea
            testID="run-codemode-script"
            accessibilityLabel={t("web.session.hub.codemode.scriptLabel")}
            placeholder={t("web.session.hub.codemode.scriptPlaceholder")}
            rows={5}
            value={script()}
            onInput={(v) => script.set(v)}
          />
        </Field>
        <If when={result()}>
          {(res) => (
            <View testID="run-codemode-output" class="gap-1 rounded-md border border-line bg-side p-2.5">
              <View class="flex-row items-center justify-between gap-2">
                <Text class="text-2xs font-medium text-muted">{t("web.session.hub.codemode.outputLabel")}</Text>
                <Text class="font-mono text-2xs text-faint">
                  {t("web.session.hub.codemode.stats", {
                    steps: res().executedSteps,
                    calls: res().replayedCalls,
                    sleeps: res().replayedSleeps,
                  })}
                </Text>
              </View>
              <Text class="font-mono text-xs text-ink">{res().outputJson}</Text>
            </View>
          )}
        </If>
      </View>
    </Dialog>
  );
}

function RunDetail(props: {
  entry: RunEntry;
  look?: Look | undefined;
  now: number;
  showBack: boolean;
  onBack: () => void;
  onOpenSession: (id: string) => void;
  approvals?: RunApprovals;
}) {
  const client = useQueryClient();
  const copiedId = signal(false);
  const rerunOpen = signal(false);
  const codeModeOpen = signal(false);
  const resetCopy = useTimeout();
  const resumeAct = createAct((msg) => toast(msg));
  const compactAct = createAct((msg) => toast(msg));
  const proj = createSessionProjection(
    () => props.entry.id,
    () => true,
  );
  const steps = () => proj().steps;
  createEffect(
    () => props.entry.id,
    () => {
      copiedId.set(false);
      rerunOpen.set(false);
      codeModeOpen.set(false);
    },
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
  const runStatus = computed(() => runStatusOf(props.entry));
  const status = computed(() => statusMeta(runStatus()));
  const pillStyle = () => {
    const bg = status().pillBg;
    return bg ? { backgroundColor: bg() } : undefined;
  };
  const profileId = () => (props.entry.kind === "orchestrator" ? props.entry.agent.id : (sessionProfile(props.entry.session) ?? ""));
  const workerIssueId = () => (props.entry.kind === "worker" ? sessionIssueId(props.entry.session) : undefined);
  const workerIssueNumber = () => (props.entry.kind === "worker" ? props.entry.issue?.number : undefined);
  const timing = () => entryTiming(props.entry, props.now);
  const repo = () => (props.entry.kind === "worker" ? sessionRepo(props.entry.session) : undefined);
  const rollup = createMemo(() => runTelemetryOf(props.entry, proj().trajectory?.telemetry));
  const recoverable = createMemo(() => isRecoverableRun(props.entry));
  const canCompact = createMemo(() => supportsManualCompaction(props.entry));
  const canRunCode = createMemo(() => supportsCodeMode(props.entry));
  const compactContext = () => {
    if (compactAct.busy()) return;
    void compactAct.run(async () => {
      const res = await api.session.compact({ id: props.entry.id });
      await client.invalidate(allSessionsQuery());
      toast(res.compacted ? t("web.session.hub.compact.compacted") : (res.reason ?? t("web.session.hub.compact.skipped")));
    });
  };
  const terminalCwd = () => {
    if (props.entry.kind !== "worker") return undefined;
    const s = props.entry.live ?? props.entry.session;
    return sessionWorktree(s) ?? s.cwd;
  };
  const hasTelemetryBar = createMemo(
    () => rollup().spent !== undefined || rollup().hasContext || rollup().llmRetries > 0 || rollup().runErrors > 0 || recoverable(),
  );
  const tokenBreakdownText = () =>
    t("web.session.hub.telemetry.tokenBreakdown", {
      input: formatTokens(rollup().inputTokens),
      cached: formatTokens(rollup().cacheReadTokens),
      output: formatTokens(rollup().outputTokens),
    });

  const resumeSameConfig = () => {
    if (props.entry.kind !== "worker" || resumeAct.busy()) return;
    const worker = props.entry;
    const issueId = sessionIssueId(worker.session);
    const prompt = lastUserPromptOf(steps()) ?? t("web.session.hub.recovery.resumePrompt");
    void resumeAct.run(async () => {
      if (issueId !== undefined) {
        if (worker.issue?.stage.state === "stuck" || runStatus() === "failed" || runStatus() === "interrupted") {
          await api.issue.status.update({ id: issueId, status: "todo" });
        } else if (worker.issue && worker.issue.status !== "done" && worker.issue.status !== "canceled") {
          await api.issue.comment.create({ id: issueId, text: t("web.session.hub.recovery.resumePrompt") });
        } else {
          await api.issue.status.update({ id: issueId, status: "todo", text: t("web.session.hub.recovery.resumePrompt") });
        }
      } else {
        const deliverSessionPrompt = api.session.send;
        await deliverSessionPrompt({ id: worker.id, text: prompt });
      }
      await client.invalidate(allSessionsQuery());
      toast(t("web.session.hub.recovery.resumedToast"));
    });
  };

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
      <View desktop={{ windowDrag: true }} testID="run-detail-header" class="shrink-0 border-b border-line bg-page">
        <View class="min-h-11 flex-row items-center gap-2.5 px-4">
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
            <If when={canCompact()}>
              <Button size="compact" icon="collapse" testID="run-compact-context" disabled={compactAct.busy()} onPress={compactContext}>
                {t("web.session.hub.compact.button")}
              </Button>
            </If>
            <If when={canRunCode()}>
              <Button size="compact" icon="bolt" testID="run-codemode-open" onPress={() => codeModeOpen.set(true)}>
                {t("web.session.hub.codemode.button")}
              </Button>
            </If>
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
        <If when={hasTelemetryBar()}>
          <View testID="run-detail-telemetry" class="flex-row flex-wrap items-center justify-between gap-2 border-t border-line bg-side px-4 py-1.5">
            <View class="flex-row flex-wrap items-center gap-2">
              <If when={rollup().spent}>
                {(s) => (
                  <View
                    testID="run-detail-spent"
                    tooltip={
                      <If when={rollup().inputTokens + rollup().cacheReadTokens + rollup().outputTokens > 0}>
                        <Bubble text={tokenBreakdownText()} />
                      </If>
                    }
                    class="h-5 flex-row items-center gap-1 rounded-sm border border-line bg-page px-1.5"
                  >
                    <Icon name="spend" size={11} tone="muted" />
                    <Text class="font-mono text-2xs font-medium text-ink tabular-nums">{spentText(s())}</Text>
                  </View>
                )}
              </If>
              <If when={rollup().hasContext}>
                <ContextSaturationMeter rollup={rollup()} testID="run-detail-context-meter" />
              </If>
              <If when={rollup().llmRetries > 0}>
                <View testID="run-detail-retry-badge" class="h-5 flex-row items-center gap-1 rounded-sm bg-warn-soft px-1.5">
                  <Icon name="retry" size={11} tone="warn-ink" />
                  <Text class="font-mono text-2xs font-medium text-warn-ink tabular-nums">
                    {t("web.session.hub.telemetry.retries", { n: rollup().llmRetries })}
                  </Text>
                </View>
              </If>
              <If when={rollup().runErrors > 0}>
                <View testID="run-detail-error-badge" class="h-5 flex-row items-center gap-1 rounded-sm bg-bad-soft px-1.5">
                  <Icon name="cross" size={11} tone="berry" />
                  <Text class="font-mono text-2xs font-medium text-berry tabular-nums">{t("web.session.hub.telemetry.errors", { n: rollup().runErrors })}</Text>
                </View>
              </If>
            </View>
            <If when={recoverable()}>
              <View testID="run-detail-recovery" class="flex-row flex-wrap items-center gap-1.5">
                <Button size="compact" tone="primary" icon="retry" testID="run-resume-same" disabled={resumeAct.busy()} onPress={resumeSameConfig}>
                  {runStatus() === "failed" ? t("web.session.hub.recovery.retrySame") : t("web.session.hub.recovery.resumeSame")}
                </Button>
                <Button size="compact" icon="shuffle" testID="run-rerun-other" onPress={() => rerunOpen.set(true)}>
                  {t("web.session.hub.recovery.rerunOther")}
                </Button>
                <Button
                  size="compact"
                  icon="terminal"
                  testID="run-open-worktree-terminal"
                  disabled={terminalCwd() === undefined}
                  tooltip={terminalCwd() === undefined ? <Bubble text={t("web.session.hub.recovery.noWorktree")} /> : undefined}
                  onPress={() => {
                    const cwd = terminalCwd();
                    if (cwd !== undefined) void hostApi.openTerminal({ cwd, title: entryName(props.entry) });
                  }}
                >
                  {t("web.session.hub.recovery.openWorktree")}
                </Button>
              </View>
            </If>
          </View>
        </If>
      </View>
      <CodeModeDialog open={codeModeOpen()} sessionId={props.entry.id} onClose={() => codeModeOpen.set(false)} />
      <If when={props.entry.kind === "worker" ? props.entry : undefined}>
        {(worker) => (
          <RerunDialog
            open={rerunOpen()}
            onClose={() => rerunOpen.set(false)}
            entry={worker()}
            lastPrompt={lastUserPromptOf(steps())}
            onRerunDone={(newId) => {
              if (newId !== undefined) props.onOpenSession(newId);
            }}
          />
        )}
      </If>
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
