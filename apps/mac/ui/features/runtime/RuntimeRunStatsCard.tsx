import { computed, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { SessionView } from "@vibevalley/protocol";

import { SettingRow, SettingsGroup } from "../../design/domain/settings";
import { Quiet } from "../../design/layout";
import { yuan } from "../../infra/base/format";
import { formatTokens } from "../../infra/sessionRuns";

interface RuntimeSessionSummary {
  sessionsCount: number;
  recentRunsCount: number;
  failedCount: number;
  totalErrors: number;
  retriedCount: number;
  totalRetries: number;
  failureRatePct: number;
  retryRatePct: number;
  totalTokens: number;
  totalCny: number;
  hasCost: boolean;
}

function summarizeRuntimeSessions(sessions: readonly SessionView[]): RuntimeSessionSummary {
  let recentRunsCount = 0;
  let failedCount = 0;
  let totalErrors = 0;
  let retriedCount = 0;
  let totalRetries = 0;
  let totalTokens = 0;
  let totalCny = 0;
  let hasCost = false;

  for (const s of sessions) {
    recentRunsCount += Math.max(s.runs, s.lastRun !== undefined ? 1 : 0);
    const failed = s.phase._tag === "failed" || s.lastRun?.outcome === "failed";
    if (failed) failedCount += 1;
    totalErrors += Math.max(s.telemetry?.runErrors ?? 0, failed ? 1 : 0);

    const activeRetry = s.phase._tag === "working" && s.phase.retry !== undefined;
    const retries = Math.max(s.telemetry?.llmRetries ?? 0, activeRetry ? 1 : 0);
    if (retries > 0) retriedCount += 1;
    totalRetries += retries;

    const telTokens = s.telemetry
      ? s.telemetry.inputTokens +
        s.telemetry.cacheReadTokens +
        (s.telemetry.cacheWriteTokens ?? 0) +
        s.telemetry.outputTokens +
        (s.telemetry.reasoningTokens ?? 0)
      : 0;
    totalTokens += Math.max(s.spent?.tokens ?? 0, s.lastRun?.spent?.tokens ?? 0, telTokens);

    const cny = s.spent?.cny ?? s.lastRun?.spent?.cny;
    if (cny !== undefined) {
      totalCny += cny;
      hasCost = true;
    }
  }

  const sessionsCount = sessions.length;
  return {
    sessionsCount,
    recentRunsCount,
    failedCount,
    totalErrors,
    retriedCount,
    totalRetries,
    failureRatePct: sessionsCount > 0 ? Math.round((failedCount / sessionsCount) * 100) : 0,
    retryRatePct: sessionsCount > 0 ? Math.round((retriedCount / sessionsCount) * 100) : 0,
    totalTokens,
    totalCny,
    hasCost,
  };
}

export function RuntimeRunStatsCard(props: { sessions: readonly SessionView[] }) {
  const summary = computed(() => summarizeRuntimeSessions(props.sessions));
  return (
    <SettingsGroup
      title={t("web.runtime.stats.title")}
      testid="runtime-run-stats"
      note={summary().sessionsCount > 0 ? t("web.runtime.stats.sessions", { n: summary().sessionsCount }) : undefined}
    >
      <If
        when={summary().sessionsCount > 0}
        else={
          <View class="px-4 py-3.5">
            <Quiet>{t("web.runtime.stats.empty")}</Quiet>
          </View>
        }
      >
        <SettingRow label={t("web.runtime.stats.runs")}>
          <Text testID="runtime-stats-runs" class="font-mono text-xs font-medium text-ink">
            {String(summary().recentRunsCount)}
          </Text>
        </SettingRow>
        <SettingRow
          label={t("web.runtime.stats.failureRate")}
          hint={t("web.runtime.stats.failuresDetail", { failed: summary().failedCount, errors: summary().totalErrors })}
        >
          <Text
            testID="runtime-stats-failure-rate"
            class={summary().failedCount > 0 ? "font-mono text-xs font-medium text-berry" : "font-mono text-xs text-ink"}
          >
            {`${summary().failureRatePct}%`}
          </Text>
        </SettingRow>
        <SettingRow
          label={t("web.runtime.stats.retryRate")}
          hint={t("web.runtime.stats.retriesDetail", { retried: summary().retriedCount, retries: summary().totalRetries })}
        >
          <Text
            testID="runtime-stats-retry-rate"
            class={summary().retriedCount > 0 ? "font-mono text-xs font-medium text-warn-ink" : "font-mono text-xs text-ink"}
          >
            {`${summary().retryRatePct}%`}
          </Text>
        </SettingRow>
        <SettingRow label={t("web.runtime.stats.cumulativeSpend")} last>
          <View testID="runtime-stats-usage" class="flex-row items-center gap-2">
            <If when={summary().totalTokens > 0}>
              <Text class="font-mono text-xs text-ink">{`${formatTokens(summary().totalTokens)} tok`}</Text>
            </If>
            <If when={summary().hasCost}>
              <Text class="font-mono text-xs font-medium text-ink">{yuan(summary().totalCny)}</Text>
            </If>
            <If when={summary().totalTokens === 0 && !summary().hasCost}>
              <Text class="font-mono text-xs text-muted">—</Text>
            </If>
          </View>
        </SettingRow>
      </If>
    </SettingsGroup>
  );
}
