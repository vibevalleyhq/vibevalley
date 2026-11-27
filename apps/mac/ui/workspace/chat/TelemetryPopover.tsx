import { computed, Scroll, Text, View, windowSize } from "nsh";
import { Popover } from "nsh/base";

import { t } from "@vibevalley/i18n";
import type { ChatTelemetry } from "@vibevalley/protocol";

import { motionClass, popupTransition } from "../../design/motion";
import { Bubble } from "../../design/Tip";
import { formatTokens, type WorkspaceRuntimeOption } from "../chatSession";
import { ContextBar } from "./ActivityWidgets";

export function TelemetryPopover(props: {
  readonly telemetry: ChatTelemetry;
  readonly currentRuntime: WorkspaceRuntimeOption | undefined;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const hasSessionTelemetry = computed(() => props.telemetry.turns > 0 || props.telemetry.contextUsed > 0);
  const hasTelemetry = computed(() => hasSessionTelemetry() || props.currentRuntime?.quotaPct !== undefined);
  const quotaPct = computed(() => {
    const q = props.currentRuntime?.quotaPct;
    return q === undefined ? undefined : Math.max(0, Math.min(100, Math.round(q)));
  });
  const showQuotaPill = computed(() => props.telemetry.contextUsed === 0 && quotaPct() !== undefined);
  const telemetryWarn = computed(() => {
    const q = quotaPct();
    return props.telemetry.contextPct >= 85 || (q !== undefined && q <= 15);
  });
  const telemetryTooltip = computed(() => {
    const parts: string[] = [];
    if (props.telemetry.contextUsed > 0 || props.telemetry.turns > 0) {
      parts.push(t("web.shell.chat.telemetryContext", { pct: props.telemetry.contextPct }));
    }
    const q = quotaPct();
    if (q !== undefined) {
      parts.push(t("web.shell.chat.telemetryQuota", { pct: q }));
    }
    return parts.join(" · ") || t("web.shell.chat.telemetryDetails");
  });
  const cachedBarPercent = computed(() => {
    const tel = props.telemetry;
    return Math.min(100, Math.round((tel.cachedRead / tel.contextWindow) * 100));
  });
  const uncachedBarPercent = computed(() => {
    const tel = props.telemetry;
    return Math.min(100 - cachedBarPercent(), Math.round((tel.uncachedInput / tel.contextWindow) * 100));
  });

  return (
    <If when={hasTelemetry()}>
      <Popover
        open={props.open}
        onOpenChange={(e) => props.onOpenChange(e.open)}
        placement="top"
        align="end"
        offset={8}
        popupClass={`w-72 flex-col overflow-hidden rounded-xl border border-line bg-elevated p-2.5 shadow-float ${motionClass("transition-opacity duration-120 ease-out")}`}
        popupStyle={{ maxHeight: Math.min(420, Math.max(200, Math.round(windowSize().height * 0.7))) }}
        popupStartingClass={popupTransition("opacity-0")}
        trigger={
          <View
            role="button"
            testID="chat-telemetry-toggle"
            tooltip={
              <If when={!props.open}>
                <Bubble text={telemetryTooltip()} />
              </If>
            }
            accessibilityLabel={props.open ? t("web.shell.chat.telemetryHide") : t("web.shell.chat.telemetryDetails")}
            accessibilityState={{ expanded: props.open }}
            class={`h-6 shrink-0 flex-row items-center gap-1.5 rounded-full border border-line bg-side px-2 shadow-raise hover:bg-hover aria-expanded:bg-selected focus-visible:outline-2 focus-visible:outline-focus ${
              props.open ? "bg-selected" : ""
            }`}
          >
            <If
              when={showQuotaPill()}
              else={
                <ContextBar
                  cached={cachedBarPercent()}
                  uncached={uncachedBarPercent()}
                  class="h-1.5 w-6 shrink-0 flex-row overflow-hidden rounded-full bg-selected"
                />
              }
            >
              <View class="h-1.5 w-6 shrink-0 overflow-hidden rounded-full bg-selected">
                <View class={(quotaPct() ?? 100) <= 15 ? "h-full bg-wheat" : "h-full bg-accent"} style={{ width: `${quotaPct() ?? 0}%` }} />
              </View>
            </If>
            <Text class={`font-mono text-2xs tabular-nums ${telemetryWarn() ? "text-warn-ink" : "text-muted"}`}>
              {`${showQuotaPill() ? (quotaPct() ?? 0) : props.telemetry.contextPct}%`}
            </Text>
          </View>
        }
      >
        <Scroll class="min-h-0 shrink">
          <View testID="chat-telemetry-drawer" class="gap-2">
            <View class="gap-1.5 rounded-lg border border-line bg-side p-2.5">
              <View class="flex-row items-center justify-between gap-2">
                <Text class="min-w-0 truncate text-xs font-medium text-muted">{t("web.shell.chat.telemetryQuotaTitle")}</Text>
                <If when={quotaPct() !== undefined}>
                  <Text class={`shrink-0 font-mono text-xs tabular-nums ${(quotaPct() ?? 100) <= 15 ? "font-semibold text-warn-ink" : "text-ink"}`}>
                    {t("web.shell.chat.telemetryQuota", { pct: quotaPct() ?? 0 })}
                  </Text>
                </If>
              </View>
              <If when={quotaPct() !== undefined} else={<Text class="text-2xs text-faint">{t("web.shell.chat.telemetryQuotaUnavailable")}</Text>}>
                <View class="gap-1">
                  <View class="h-1.5 overflow-hidden rounded-full bg-selected">
                    <View class={(quotaPct() ?? 100) <= 15 ? "h-full bg-wheat" : "h-full bg-accent"} style={{ width: `${quotaPct() ?? 0}%` }} />
                  </View>
                  <If when={props.currentRuntime?.quotaText}>{(label) => <Text class="text-2xs text-faint">{label()}</Text>}</If>
                </View>
              </If>
            </View>

            <If when={hasSessionTelemetry()}>
              <View class="gap-1.5 rounded-lg border border-line bg-side p-2.5">
                <View class="flex-row items-center justify-between gap-2">
                  <Text class="min-w-0 truncate text-xs font-medium text-muted">{t("web.shell.chat.telemetryContextTitle")}</Text>
                  <Text class="shrink-0 font-mono text-xs text-ink tabular-nums">
                    {`${props.telemetry.contextPct}% · ${formatTokens(props.telemetry.contextUsed)}/${formatTokens(props.telemetry.contextWindow)}`}
                  </Text>
                </View>
                <ContextBar cached={cachedBarPercent()} uncached={uncachedBarPercent()} class="h-1.5 flex-row overflow-hidden rounded-full bg-selected" />
                <View class="flex-row flex-wrap gap-2">
                  <Text class="font-mono text-2xs text-ok-ink">{`${t("web.shell.chat.telemetryCached")} ${formatTokens(props.telemetry.cachedRead)}`}</Text>
                  <Text class="font-mono text-2xs text-water">{`${t("web.shell.chat.telemetryUncached")} ${formatTokens(props.telemetry.uncachedInput)}`}</Text>
                  <Text class="font-mono text-2xs text-muted">{`${t("web.shell.chat.telemetryOutput")} ${formatTokens(props.telemetry.output)}`}</Text>
                  <If when={props.telemetry.reasoning > 0}>
                    <Text class="font-mono text-2xs text-warn-ink">{`${t("web.shell.chat.telemetryReasoning")} ${formatTokens(props.telemetry.reasoning)}`}</Text>
                  </If>
                </View>
              </View>

              <View class="flex-row items-center justify-between gap-2 rounded-lg border border-line bg-side px-2.5 py-2">
                <View class="min-w-0 gap-0.5">
                  <Text class="truncate text-xs font-medium text-muted">{t("web.shell.chat.telemetryCacheTitle")}</Text>
                  <Text class="font-mono text-xs font-semibold text-ink tabular-nums">
                    {t("web.shell.chat.telemetryTurns", { turns: props.telemetry.turns, tools: props.telemetry.toolCount })}
                  </Text>
                </View>
                <Text class="shrink-0 font-mono text-xs font-semibold text-ok-ink tabular-nums">
                  {t("web.shell.chat.telemetryCache", { pct: props.telemetry.cacheHitPct })}
                </Text>
              </View>
            </If>
          </View>
        </Scroll>
      </Popover>
    </If>
  );
}
