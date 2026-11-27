import { Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Look } from "@vibevalley/protocol";
import { sessionProfile, sessionRepo } from "@vibevalley/protocol/rules";

import { AgentFace, OrchestratorFace } from "../../../design/domain/Face";
import { Icon } from "../../../design/Icon";
import { ActiveBar } from "../../../design/layout";
import { Dot } from "../../../design/Tag";
import { Bubble } from "../../../design/Tip";
import { ago } from "../../../infra/base/format";
import { formatTokens } from "../../../infra/sessionRuns";
import { createMemo } from "../../../infra/solid";
import { runActivityAt, type RunEntry, runStatusOf, runTelemetryOf, type RunTelemetryRollup } from "../runsView";
import { entryName, entrySubtitle, formatCompactSpend, saturationTone, statusMeta } from "./presentation";

export function ContextSaturationMeter(props: { rollup: RunTelemetryRollup; compact?: boolean; testID?: string }) {
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

export function RunListRow(props: { entry: RunEntry; look?: Look | undefined; selected: boolean; now: number; onSelect: () => void }) {
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
