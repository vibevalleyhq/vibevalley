import { Clipboard, computed, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Look } from "@vibevalley/protocol";
import { oneLine, sessionIssueId, sessionProfile, sessionRepo, sessionWorktree } from "@vibevalley/protocol/rules";

import { Button, ButtonLink } from "../../../design/Button";
import { AgentFace, OrchestratorFace } from "../../../design/domain/Face";
import { Icon } from "../../../design/Icon";
import { Dot } from "../../../design/Tag";
import { Bubble } from "../../../design/Tip";
import { toast } from "../../../design/toasts";
import { createAct } from "../../../infra/act";
import { api } from "../../../infra/api";
import { spentText } from "../../../infra/base/format";
import { useTimeout } from "../../../infra/base/timer";
import { hostApi } from "../../../infra/bridge";
import { useQueryClient } from "../../../infra/query";
import { formatTokens } from "../../../infra/sessionRuns";
import { createEffect, createMemo } from "../../../infra/solid";
import { createSessionProjection } from "../events";
import { isRecoverableRun, type RunEntry, runStatusOf, runTelemetryOf, supportsCodeMode, supportsManualCompaction } from "../runsView";
import { TrajectoryLog } from "../Trajectory";
import { allSessionsQuery, entryName, entryTiming, lastUserPromptOf, markWrongOf, type RunApprovals, statusMeta } from "./presentation";
import { CodeModeDialog, RerunDialog } from "./RunDialogs";
import { ContextSaturationMeter } from "./RunListRow";

export function RunDetail(props: {
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
                  tooltip={
                    <If when={terminalCwd() === undefined}>
                      <Bubble text={t("web.session.hub.recovery.noWorktree")} />
                    </If>
                  }
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
