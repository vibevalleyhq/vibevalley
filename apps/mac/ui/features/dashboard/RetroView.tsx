import { Clipboard, computed, Scroll, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import { type IssueRetroReport, type IssueStatus, type RetroBreakdownBucket, type RetroWindow, RetroWindowValues } from "@vibevalley/protocol";

import { Button } from "../../design/Button";
import { Icon } from "../../design/Icon";
import type { IconName } from "../../design/icons";
import { Banner, Empty, Quiet } from "../../design/layout";
import { Segmented } from "../../design/Segmented";
import { CountPill, Tag, type TagTone } from "../../design/Tag";
import { toast } from "../../design/toasts";
import { api, reasonOf } from "../../infra/api";
import { useTimeout } from "../../infra/base/timer";
import { useBoardSlice } from "../../infra/frame";
import { defineQuery, ready, retryRead, useAgents, useQuery, useQueryClient } from "../../infra/query";
import { Link as A } from "../../infra/router";
import { createEffect } from "../../infra/solid";
import { formatRetroMarkdown, retroDurationText, retroRateText, retroWindowLabel } from "./retroMarkdown";

const issueRetroQuery = defineQuery({
  key: (window: RetroWindow) => ["issue-retro", window],
  fetch: (window, context) => api.issue.retro.get({ window }, context),
  ...retryRead,
});

function statusTagTone(status: IssueStatus): TagTone {
  switch (status) {
    case "done":
      return "ok";
    case "canceled":
      return "neutral";
    case "in_review":
      return "wait";
    case "in_progress":
      return "info";
    case "todo":
    case "backlog":
      return "neutral";
  }
}

function RetroKpiCard(props: {
  testid: string;
  icon: IconName;
  label: string;
  value: string;
  sub: string;
  extra?: string | undefined;
  tone?: "default" | "bad" | "water" | undefined;
}) {
  const numClass = () => {
    switch (props.tone) {
      case "bad":
        return "text-berry";
      case "water":
        return "text-water";
      default:
        return "text-ink";
    }
  };
  return (
    <View testID={props.testid} class="min-w-44 flex-1 rounded-xl border border-line bg-elevated px-3.5 py-3">
      <View class="flex-row items-center justify-between gap-2">
        <Text class="truncate text-xs font-medium text-muted">{props.label}</Text>
        <Icon name={props.icon} size={14} tone="muted" />
      </View>
      <View class="mt-1.5 flex-row items-baseline justify-between gap-2">
        <Text class={`font-mono text-xl font-semibold tabular-nums ${numClass()}`}>{props.value}</Text>
        <If when={props.extra}>{(extra) => <Text class="truncate text-2xs font-medium text-muted tabular-nums">{extra()}</Text>}</If>
      </View>
      <Text class="mt-1 truncate text-xs text-muted">{props.sub}</Text>
    </View>
  );
}

function BreakdownCard(props: {
  testid: string;
  title: string;
  kind: "repo" | "tag" | "agent";
  buckets: readonly RetroBreakdownBucket[];
  agentName: (id: string) => string;
}) {
  const maxTotal = computed(() => Math.max(1, ...props.buckets.map((b) => b.totalCount)));
  const labelOf = (key: string) => {
    if (key !== "") return props.kind === "agent" ? props.agentName(key) : key;
    switch (props.kind) {
      case "repo":
        return t("web.base.dashboard.retro.breakdown.noRepo");
      case "tag":
        return t("web.base.dashboard.retro.breakdown.untagged");
      case "agent":
        return t("web.base.dashboard.retro.breakdown.unassigned");
    }
  };

  return (
    <View testID={props.testid} class="min-w-64 flex-1 rounded-xl border border-line bg-elevated">
      <View class="flex-row items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <Text class="truncate text-xs font-semibold text-muted">{props.title}</Text>
        <CountPill count={props.buckets.length} />
      </View>
      <If
        when={props.buckets.length > 0}
        else={
          <View class="px-4 py-4">
            <Quiet>{t("web.base.dashboard.retro.breakdown.empty")}</Quiet>
          </View>
        }
      >
        <View class="gap-3 px-4 py-3">
          <Each of={props.buckets} key={(b) => b.key}>
            {(bucket) => {
              const total = () => bucket().totalCount;
              const remainder = () => Math.max(0, maxTotal() - total());
              const meta = () =>
                t("web.base.dashboard.retro.breakdown.bucketMeta", {
                  done: bucket().completedCount,
                  rework: bucket().reworkCount,
                  overdue: bucket().overdueCount,
                });
              return (
                <View class="gap-1">
                  <View class="flex-row items-center justify-between gap-2">
                    <Text class="min-w-0 flex-1 truncate text-xs font-medium text-ink">{labelOf(bucket().key)}</Text>
                    <Text class="shrink-0 font-mono text-xs font-semibold text-ink tabular-nums">{String(total())}</Text>
                  </View>
                  <View class="h-1.5 flex-row overflow-hidden rounded-full bg-hover">
                    <If when={total() > 0}>
                      <View class="h-full rounded-full bg-accent" style={{ flexGrow: total(), flexBasis: 0 }} />
                    </If>
                    <If when={remainder() > 0}>
                      <View style={{ flexGrow: remainder(), flexBasis: 0 }} />
                    </If>
                  </View>
                  <View class="flex-row items-center justify-between gap-2">
                    <Text class="min-w-0 flex-1 truncate text-2xs text-faint">{meta()}</Text>
                    <If when={bucket().medianCycleMs !== undefined}>
                      <Text class="shrink-0 font-mono text-2xs text-faint tabular-nums">
                        {t("web.base.dashboard.retro.breakdown.medianShort", { median: retroDurationText(bucket().medianCycleMs) })}
                      </Text>
                    </If>
                  </View>
                </View>
              );
            }}
          </Each>
        </View>
      </If>
    </View>
  );
}

export function RetroView() {
  const window = signal<RetroWindow>("7d");
  const copied = signal(false);
  const scheduleResetCopied = useTimeout();
  const queryClient = useQueryClient();
  const board = useBoardSlice();
  const agents = useAgents();

  const retro = useQuery(() => issueRetroQuery(window()));
  const report = computed<IssueRetroReport | undefined>(() => ready(retro, undefined));
  const agentById = computed(() => new Map(ready(agents, []).map((a) => [a.id, a])));
  const agentName = (id: string) => agentById().get(id)?.name ?? id;

  let lastBoardSeq: number | undefined;
  createEffect(() => {
    const seq = board()?.seq;
    if (seq === undefined) return;
    if (lastBoardSeq !== undefined && lastBoardSeq !== seq) {
      void queryClient.invalidate({ prefix: ["issue-retro"] });
    }
    lastBoardSeq = seq;
  });

  const windowOptions = computed(() =>
    RetroWindowValues.map((value) => ({
      value,
      label: retroWindowLabel(value),
    })),
  );

  const copyReport = () => {
    const current = report();
    if (!current) return;
    const markdown = formatRetroMarkdown(current, agentName);
    void Clipboard.writeText(markdown).then(
      () => {
        copied.set(true);
        toast(t("web.base.dashboard.retro.copiedToast"), "info");
        scheduleResetCopied(() => copied.set(false), 1500);
      },
      () => {
        toast(t("web.base.dashboard.retro.copyFailed"), "bad");
      },
    );
  };

  return (
    <Scroll testID="dashboard-retro" class="min-h-0 flex-1 bg-page" contentClass="mx-auto w-full max-w-5xl gap-5 p-6">
      <View testID="retro-toolbar" class="flex-row flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-elevated px-4 py-3">
        <View class="min-w-0 flex-1 gap-0.5">
          <Text role="header" class="truncate text-sm font-semibold text-ink">
            {t("web.base.dashboard.retro.title")}
          </Text>
          <Text testID="retro-subtitle" class="truncate text-xs text-muted">
            {t("web.base.dashboard.retro.subtitle", { n: report()?.totalIssues ?? 0 })}
          </Text>
        </View>
        <View class="flex-row flex-wrap items-center gap-2">
          <Segmented
            label={t("web.base.dashboard.retro.windowLabel")}
            testid="retro-window"
            value={window()}
            options={windowOptions()}
            onChange={(next) => window.set(next)}
          />
          <Button testID="retro-copy-report" tone="primary" size="compact" icon={copied() ? "check" : "copy"} disabled={!report()} onPress={copyReport}>
            {copied() ? t("web.base.dashboard.retro.copiedReport") : t("web.base.dashboard.retro.copyReport")}
          </Button>
        </View>
      </View>

      <If when={retro.error()}>
        {(err) => (
          <Banner tone="bad" role="alert" testID="retro-error">
            <View class="flex-row flex-wrap items-center justify-between gap-2">
              <Text class="min-w-0 flex-1 text-xs text-berry">{reasonOf(err())}</Text>
              <Button size="compact" icon="refresh" onPress={() => void retro.refetch()}>
                {t("web.base.dashboard.retro.retry")}
              </Button>
            </View>
          </Banner>
        )}
      </If>

      <If when={report()}>
        {(r) => (
          <>
            <View testID="retro-kpis" class="flex-row flex-wrap gap-3">
              <RetroKpiCard
                testid="retro-kpi-throughput"
                icon="issues"
                label={t("web.base.dashboard.retro.kpi.throughput")}
                value={String(r().completedCount)}
                extra={r().completionRatePct !== undefined ? t("web.base.dashboard.retro.kpi.completionRate", { pct: r().completionRatePct ?? 0 }) : undefined}
                sub={t("web.base.dashboard.retro.kpi.throughputSub", {
                  done: r().completedCount,
                  canceled: r().canceledCount,
                  open: r().openCount,
                })}
                tone={r().completedCount > 0 ? "water" : "default"}
              />
              <RetroKpiCard
                testid="retro-kpi-cycle"
                icon="clock"
                label={t("web.base.dashboard.retro.kpi.cycleTime")}
                value={retroDurationText(r().cycleTime.medianMs)}
                extra={t("web.base.dashboard.retro.kpi.samples", { n: r().cycleTime.sampleCount })}
                sub={t("web.base.dashboard.retro.kpi.medianP90", {
                  median: retroDurationText(r().cycleTime.medianMs),
                  p90: retroDurationText(r().cycleTime.p90Ms),
                })}
              />
              <RetroKpiCard
                testid="retro-kpi-review"
                icon="log"
                label={t("web.base.dashboard.retro.kpi.reviewWait")}
                value={retroDurationText(r().reviewWait.medianMs)}
                extra={t("web.base.dashboard.retro.kpi.samples", { n: r().reviewWait.sampleCount })}
                sub={t("web.base.dashboard.retro.kpi.medianP90", {
                  median: retroDurationText(r().reviewWait.medianMs),
                  p90: retroDurationText(r().reviewWait.p90Ms),
                })}
              />
              <RetroKpiCard
                testid="retro-kpi-due"
                icon="calendar"
                label={t("web.base.dashboard.retro.kpi.dueSla")}
                value={retroRateText(r().onTimeRatePct)}
                sub={t("web.base.dashboard.retro.kpi.dueSub", {
                  onTime: r().onTimeCount,
                  overdue: r().overdueCount,
                  noDue: r().withoutDueCount,
                })}
                tone={r().overdueCount > 0 ? "bad" : "default"}
              />
              <RetroKpiCard
                testid="retro-kpi-rework"
                icon="retry"
                label={t("web.base.dashboard.retro.kpi.rework")}
                value={retroRateText(r().reworkRatePct)}
                sub={t("web.base.dashboard.retro.kpi.reworkSub", {
                  issues: r().reworkIssueCount,
                  findings: r().totalFindingsCount,
                  unresolved: r().unresolvedFindingsCount,
                })}
                tone={r().unresolvedFindingsCount > 0 ? "bad" : "default"}
              />
            </View>

            <If
              when={r().totalIssues > 0}
              else={
                <Empty variant="filtered" compact testid="retro-empty" icon="clock">
                  {t("web.base.dashboard.retro.empty")}
                </Empty>
              }
            >
              <>
                <View testID="retro-breakdowns" class="flex-row flex-wrap items-start gap-4">
                  <BreakdownCard
                    testid="retro-breakdown-repo"
                    title={t("web.base.dashboard.retro.breakdown.byRepo")}
                    kind="repo"
                    buckets={r().byRepo}
                    agentName={agentName}
                  />
                  <BreakdownCard
                    testid="retro-breakdown-tag"
                    title={t("web.base.dashboard.retro.breakdown.byTag")}
                    kind="tag"
                    buckets={r().byTag}
                    agentName={agentName}
                  />
                  <BreakdownCard
                    testid="retro-breakdown-agent"
                    title={t("web.base.dashboard.retro.breakdown.byAgent")}
                    kind="agent"
                    buckets={r().byAgent}
                    agentName={agentName}
                  />
                </View>

                <View testID="retro-tables" class="gap-4">
                  <View testID="retro-overdue-table" class="overflow-hidden rounded-xl border border-line bg-elevated">
                    <View class="flex-row items-center justify-between gap-2 border-b border-line px-4 py-2.5">
                      <Text class="text-xs font-semibold text-muted">{t("web.base.dashboard.retro.overdue.title")}</Text>
                      <CountPill count={r().overdueItems.length} tone={r().overdueItems.length > 0 ? "bad" : "neutral"} />
                    </View>
                    <If
                      when={r().overdueItems.length > 0}
                      else={
                        <View class="px-4 py-4">
                          <Quiet>{t("web.base.dashboard.retro.overdue.empty")}</Quiet>
                        </View>
                      }
                    >
                      <View>
                        <View class="flex-row items-center gap-3 bg-side px-4 py-1.5">
                          <Text class="min-w-0 flex-1 text-xs font-medium text-muted">{t("web.base.dashboard.retro.overdue.issue")}</Text>
                          <Text class="w-24 shrink-0 text-xs font-medium text-muted">{t("web.base.dashboard.retro.overdue.status")}</Text>
                          <Text class="w-36 shrink-0 text-xs font-medium text-muted">{t("web.base.dashboard.retro.overdue.owner")}</Text>
                          <Text class="w-24 shrink-0 text-right text-xs font-medium text-muted">{t("web.base.dashboard.retro.overdue.delay")}</Text>
                        </View>
                        <Each of={r().overdueItems} key={(item) => item.id}>
                          {(item) => {
                            const owner = () => [item().repo, item().agent ? agentName(item().agent!) : undefined].filter(Boolean).join(" / ") || "—";
                            return (
                              <A
                                href={`/issues/${encodeURIComponent(item().id)}`}
                                testID={`retro-overdue-row-${item().id}`}
                                class="flex-row items-center gap-3 border-t border-line px-4 py-2.5 hover:bg-hover"
                              >
                                <View class="min-w-0 flex-1 flex-row items-center gap-2">
                                  <Text class="shrink-0 font-mono text-xs text-faint tabular-nums">{`#${item().number}`}</Text>
                                  <Text class="min-w-0 flex-1 truncate text-sm font-medium text-ink">{item().title}</Text>
                                </View>
                                <View class="w-24 shrink-0">
                                  <Tag label={t(`shared.status.${item().status}`)} tone={statusTagTone(item().status)} />
                                </View>
                                <Text class="w-36 shrink-0 truncate text-xs text-muted">{owner()}</Text>
                                <Text class="w-24 shrink-0 text-right font-mono text-xs font-medium text-berry tabular-nums">
                                  {`+${retroDurationText(item().overdueMs)}`}
                                </Text>
                              </A>
                            );
                          }}
                        </Each>
                      </View>
                    </If>
                  </View>

                  <View testID="retro-rework-table" class="overflow-hidden rounded-xl border border-line bg-elevated">
                    <View class="flex-row items-center justify-between gap-2 border-b border-line px-4 py-2.5">
                      <Text class="text-xs font-semibold text-muted">{t("web.base.dashboard.retro.rework.title")}</Text>
                      <CountPill count={r().reworkItems.length} />
                    </View>
                    <If
                      when={r().reworkItems.length > 0}
                      else={
                        <View class="px-4 py-4">
                          <Quiet>{t("web.base.dashboard.retro.rework.empty")}</Quiet>
                        </View>
                      }
                    >
                      <View>
                        <View class="flex-row items-center gap-3 bg-side px-4 py-1.5">
                          <Text class="min-w-0 flex-1 text-xs font-medium text-muted">{t("web.base.dashboard.retro.rework.issue")}</Text>
                          <Text class="w-24 shrink-0 text-xs font-medium text-muted">{t("web.base.dashboard.retro.rework.status")}</Text>
                          <Text class="w-36 shrink-0 text-xs font-medium text-muted">{t("web.base.dashboard.retro.rework.owner")}</Text>
                          <Text class="w-32 shrink-0 text-right text-xs font-medium text-muted">{t("web.base.dashboard.retro.rework.findings")}</Text>
                        </View>
                        <Each of={r().reworkItems} key={(item) => item.id}>
                          {(item) => {
                            const owner = () => [item().repo, item().agent ? agentName(item().agent!) : undefined].filter(Boolean).join(" / ") || "—";
                            const findingsLabel = () =>
                              item().unresolvedCount > 0
                                ? `${item().findingsCount} · ${t("web.base.dashboard.retro.rework.unresolved", { n: item().unresolvedCount })}`
                                : `${item().findingsCount} · ${t("web.base.dashboard.retro.rework.allResolved")}`;
                            return (
                              <A
                                href={`/issues/${encodeURIComponent(item().id)}`}
                                testID={`retro-rework-row-${item().id}`}
                                class="flex-row items-center gap-3 border-t border-line px-4 py-2.5 hover:bg-hover"
                              >
                                <View class="min-w-0 flex-1 flex-row items-center gap-2">
                                  <Text class="shrink-0 font-mono text-xs text-faint tabular-nums">{`#${item().number}`}</Text>
                                  <Text class="min-w-0 flex-1 truncate text-sm font-medium text-ink">{item().title}</Text>
                                </View>
                                <View class="w-24 shrink-0">
                                  <Tag label={t(`shared.status.${item().status}`)} tone={statusTagTone(item().status)} />
                                </View>
                                <Text class="w-36 shrink-0 truncate text-xs text-muted">{owner()}</Text>
                                <View class="w-32 shrink-0 items-end">
                                  <Tag label={findingsLabel()} tone={item().unresolvedCount > 0 ? "bad" : "ok"} />
                                </View>
                              </A>
                            );
                          }}
                        </Each>
                      </View>
                    </If>
                  </View>
                </View>
              </>
            </If>
          </>
        )}
      </If>
    </Scroll>
  );
}
