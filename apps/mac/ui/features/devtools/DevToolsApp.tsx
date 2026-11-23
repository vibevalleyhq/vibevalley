import { computed, effect, signal, Text, untracked, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { DebugOverrideConfig, DebugSnapshot } from "@vibevalley/protocol";

import { Button } from "../../design/Button";
import { Icon } from "../../design/Icon";
import { IconButton } from "../../design/IconButton";
import type { IconName } from "../../design/icons";
import { ActiveBar, Banner, Empty } from "../../design/layout";
import { Tag } from "../../design/Tag";
import { Bubble } from "../../design/Tip";
import { api, reasonOf } from "../../infra/api";
import { useInterval } from "../../infra/base/timer";
import { act, frame } from "../../infra/bridge";
import { readDevToolsParams } from "../../infra/hostParams";
import { onSettled } from "../../infra/solid";
import { DEVTOOLS_TABS, type DevToolsTab, formatFrameMs, isDisabledError } from "./format";
import { LabOverridesTab } from "./LabOverridesTab";
import { OverviewTab } from "./OverviewTab";
import { RoutesTab } from "./RoutesTab";
import { StateCacheTab } from "./StateCacheTab";
import { TimelineTab } from "./TimelineTab";
import { TrajectoryTab } from "./TrajectoryTab";

function tabMeta(tab: DevToolsTab): { icon: IconName; label: string } {
  switch (tab) {
    case "overview":
      return { icon: "info", label: t("web.devtools.tabs.overview") };
    case "routes":
      return { icon: "branch", label: t("web.devtools.tabs.routes") };
    case "timeline":
      return { icon: "clock", label: t("web.devtools.tabs.timeline") };
    case "trajectory":
      return { icon: "log", label: t("web.devtools.tabs.trajectory") };
    case "state":
      return { icon: "memory", label: t("web.devtools.tabs.state") };
    case "lab":
      return { icon: "bolt", label: t("web.devtools.tabs.lab") };
  }
}

export function DevToolsApp() {
  const { detached } = readDevToolsParams();
  const activeTab = signal<DevToolsTab>("overview");
  const snapshot = signal<DebugSnapshot | undefined>(undefined);
  const loading = signal(true);
  const disabled = signal(false);
  const error = signal<string | undefined>(undefined);
  const autoRefresh = signal(true);
  const refreshTick = signal(0);
  const visibleFrame = frame<{ visible?: boolean }>("devtools_visible");
  const visible = computed(() => visibleFrame()?.visible !== false);

  let inFlight = false;
  let wasVisible = true;

  const refresh = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const snap = await api.debug.snapshot();
      inFlight = false;
      loading.set(false);
      disabled.set(false);
      error.set(undefined);
      snapshot.set(snap);
      refreshTick.update((n) => n + 1);
    } catch (e) {
      inFlight = false;
      loading.set(false);
      if (isDisabledError(e)) {
        disabled.set(true);
        error.set(undefined);
      } else {
        error.set(reasonOf(e));
      }
    }
  };

  onSettled(() => {
    if (visible()) void refresh();
  });

  effect(() => {
    const nowVisible = visible();
    const becameVisible = !wasVisible && nowVisible;
    wasVisible = nowVisible;
    if (becameVisible && !untracked(disabled)) {
      untracked(() => {
        void refresh();
      });
    }
  });

  useInterval(() => {
    if (visible() && autoRefresh() && !disabled()) void refresh();
  }, 2000);

  const onOverridesUpdated = (next: DebugOverrideConfig) => {
    const current = snapshot();
    if (current) snapshot.set({ ...current, overrides: next });
  };

  return (
    <View testID="devtools-root" class="flex-1 bg-page">
      <View testID="devtools-topbar" class="h-10 shrink-0 flex-row items-center justify-between gap-2 border-b border-line bg-side px-3">
        <View class="min-w-0 flex-row items-center gap-2">
          <Icon name="bug" size={14} tone="accent" />
          <Text role="header" class="text-sm font-semibold text-ink">
            {t("web.devtools.title")}
          </Text>
          <If when={snapshot() !== undefined}>
            <View testID="devtools-status-badge" class="flex-row items-center gap-1.5">
              <Tag tone="info" label={snapshot()!.overview.channel} />
              <Tag tone="neutral" label={`seq ${snapshot()!.overview.latestSeq}`} />
              <If when={snapshot()!.overview.lastFrameMs !== undefined}>
                <Tag tone={(snapshot()!.overview.lastFrameMs ?? 0) >= 16 ? "wait" : "ok"} label={formatFrameMs(snapshot()!.overview.lastFrameMs)} />
              </If>
            </View>
          </If>
        </View>

        <View class="shrink-0 flex-row items-center gap-1.5">
          <Button size="compact" tone="plain" icon="refresh" testID="devtools-refresh" onPress={() => void refresh()}>
            {t("web.devtools.actions.refresh")}
          </Button>
          <Button
            size="compact"
            tone={autoRefresh() ? "plain" : "quiet"}
            icon={autoRefresh() ? "stop" : "play"}
            testID="devtools-auto-refresh"
            accessibilityLabel={`${t("web.devtools.actions.autoRefresh")}: ${autoRefresh() ? t("web.devtools.actions.pause") : t("web.devtools.actions.resume")}`}
            tooltip={<Bubble text={t("web.devtools.actions.autoRefresh")} />}
            onPress={() => autoRefresh.set(!autoRefresh())}
          >
            {autoRefresh() ? t("web.devtools.actions.pause") : t("web.devtools.actions.resume")}
          </Button>
          <If when={!detached}>
            <IconButton
              icon="open"
              size={14}
              label={t("web.devtools.actions.detach")}
              testid="devtools-detach"
              onClick={() => act({ type: "detach_devtools" })}
            />
          </If>
          <IconButton icon="close" size={14} label={t("web.devtools.actions.close")} testid="devtools-close" onClick={() => act({ type: "close_devtools" })} />
        </View>
      </View>

      <View class="min-h-0 flex-1 flex-row">
        <View testID="devtools-rail" class="w-12 shrink-0 items-center gap-1 border-r border-line bg-rail py-2">
          <Each of={DEVTOOLS_TABS}>
            {(tab) => {
              const meta = () => tabMeta(tab());
              const selected = () => activeTab() === tab();
              return (
                <View
                  role="button"
                  testID={`devtools-tab-${tab()}`}
                  accessibilityLabel={meta().label}
                  accessibilityState={{ selected: selected() }}
                  tooltip={<Bubble text={meta().label} placement="right" />}
                  onPress={() => activeTab.set(tab())}
                  class={`relative size-9 items-center justify-center rounded-md ${
                    selected() ? "bg-selected" : "hover:bg-hover"
                  } focus-visible:outline-2 focus-visible:outline-focus`}
                >
                  <If when={selected()}>
                    <ActiveBar />
                  </If>
                  <Icon name={meta().icon} size={16} tone={selected() ? "ink" : "muted"} />
                </View>
              );
            }}
          </Each>
        </View>

        <View class="min-h-0 min-w-0 flex-1 bg-page">
          <If
            when={!disabled()}
            else={
              <Empty icon="lock" testid="devtools-disabled">
                {t("web.devtools.status.disabled")}
              </Empty>
            }
          >
            <If when={error() !== undefined}>
              <Banner tone="bad" edge testID="devtools-error">
                {t("web.devtools.status.error", { reason: error() ?? "" })}
              </Banner>
            </If>
            <If
              when={snapshot() !== undefined}
              else={
                <If when={loading()}>
                  <View testID="devtools-loading" class="flex-1 items-center justify-center p-6">
                    <Text class="text-sm text-muted">{t("web.devtools.status.loading")}</Text>
                  </View>
                </If>
              }
            >
              <View class="min-h-0 flex-1">
                <If when={activeTab() === "overview"}>
                  <OverviewTab overview={() => snapshot()!.overview} graph={() => snapshot()!.graph} />
                </If>
                <If when={activeTab() === "routes"}>
                  <RoutesTab routes={() => snapshot()!.routes} />
                </If>
                <If when={activeTab() === "timeline"}>
                  <TimelineTab fallbackEvents={() => snapshot()!.recentTimeline} refreshTick={refreshTick} onCleared={() => void refresh()} />
                </If>
                <If when={activeTab() === "trajectory"}>
                  <TrajectoryTab refreshTick={refreshTick} />
                </If>
                <If when={activeTab() === "state"}>
                  <StateCacheTab stateCache={() => snapshot()!.stateCache} />
                </If>
                <If when={activeTab() === "lab"}>
                  <LabOverridesTab overrides={() => snapshot()!.overrides} onUpdated={onOverridesUpdated} />
                </If>
              </View>
            </If>
          </If>
        </View>
      </View>
    </View>
  );
}
