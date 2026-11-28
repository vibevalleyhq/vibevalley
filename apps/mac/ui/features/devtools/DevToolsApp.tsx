import { computed, effect, signal, Text, untracked, View } from "nsh";
import { z } from "zod";

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
import { useVdpNode } from "../../infra/vdpProbe";
import { DEVTOOLS_TABS, type DevToolsTab, formatFrameMs, isDisabledError, type TimelineJumpFocus, type TrajectoryJumpFocus } from "./format";
import { LabOverridesTab } from "./LabOverridesTab";
import { OverviewTab } from "./OverviewTab";
import { type AttachedRemoteVdp, RemoteVdpPanel } from "./RemoteVdpPanel";
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
    case "remote":
      return { icon: "plug", label: t("web.devtools.tabs.remote") };
  }
}

const devtoolsVisibleSchema = z.object({ visible: z.exactOptional(z.boolean()) });

const inspectorBoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

const inspectorSelectionSchema = z.object({
  hit: z.boolean(),
  surface: z.exactOptional(z.string()),
  testId: z.exactOptional(z.string()),
  role: z.exactOptional(z.string()),
  text: z.exactOptional(z.string()),
  route: z.exactOptional(z.string()),
  source: z.exactOptional(z.string()),
  bounds: z.exactOptional(inspectorBoundsSchema),
});

const inspectorFrameSchema = z.object({
  inspecting: z.boolean(),
  selection: z.exactOptional(inspectorSelectionSchema.nullable()),
});

function parseSourceLocation(source: string): { path: string; line?: number | undefined } {
  const trimmed = source.trim();
  const match = /^(.+?):(\d+)$/u.exec(trimmed);
  if (!match) return { path: trimmed };
  const line = Number(match[2]);
  return Number.isFinite(line) && line > 0 ? { path: match[1] ?? trimmed, line } : { path: match[1] ?? trimmed };
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
  const remoteConn = signal<AttachedRemoteVdp | undefined>(undefined);
  const timelineFocus = signal<TimelineJumpFocus | undefined>(undefined);
  const trajectoryFocus = signal<TrajectoryJumpFocus | undefined>(undefined);
  let jumpSeq = 0;

  const visibleFrame = frame("devtools_visible", devtoolsVisibleSchema);
  const inspectorFrame = frame("inspector", inspectorFrameSchema);
  const visible = computed(() => visibleFrame()?.visible !== false);
  const inspecting = computed(() => inspectorFrame()?.inspecting === true);
  const inspected = computed(() => inspectorFrame()?.selection ?? undefined);

  useVdpNode({
    testId: "devtools-root",
    role: "main",
    text: () => t("web.devtools.title"),
    source: "apps/mac/ui/features/devtools/DevToolsApp.tsx:82",
  });

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

  const onJumpToTimeline = (target: { traceId?: number | undefined; timestampMs: number }) => {
    jumpSeq += 1;
    timelineFocus.set({
      ...(target.traceId !== undefined ? { traceId: target.traceId } : {}),
      timestampMs: target.timestampMs,
      key: jumpSeq,
    });
    activeTab.set("timeline");
  };

  const onJumpToTrajectory = (target: { traceId?: number | undefined; timestampMs: number; summary: string }) => {
    jumpSeq += 1;
    trajectoryFocus.set({
      ...(target.traceId !== undefined ? { traceId: target.traceId } : {}),
      timestampMs: target.timestampMs,
      key: jumpSeq,
    });
    activeTab.set("trajectory");
  };

  const jumpToInspectedSource = () => {
    const source = inspected()?.source;
    if (!source) return;
    const loc = parseSourceLocation(source);
    act({
      type: "devtools_jump_source",
      path: loc.path,
      ...(loc.line !== undefined ? { line: loc.line } : {}),
    });
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
          <If when={remoteConn()}>
            {(conn) => (
              <View role="button" testID="devtools-vdp-badge" onPress={() => activeTab.set("remote")}>
                <Tag tone="ok" label={`VDP ${conn().label}`} />
              </View>
            )}
          </If>
        </View>

        <View class="shrink-0 flex-row items-center gap-1">
          <IconButton
            icon="understand"
            size={14}
            pressed={inspecting()}
            label={inspecting() ? t("web.devtools.actions.inspectCancel") : t("web.devtools.actions.inspect")}
            testid="devtools-inspect-toggle"
            onClick={() => act({ type: "devtools_inspector_mode", enabled: !inspecting() })}
          />
          <IconButton icon="refresh" size={14} label={t("web.devtools.actions.refresh")} testid="devtools-refresh" onClick={() => void refresh()} />
          <IconButton
            icon={autoRefresh() ? "stop" : "play"}
            size={14}
            pressed={autoRefresh()}
            label={`${t("web.devtools.actions.autoRefresh")}: ${autoRefresh() ? t("web.devtools.actions.pause") : t("web.devtools.actions.resume")}`}
            testid="devtools-auto-refresh"
            onClick={() => autoRefresh.set(!autoRefresh())}
          />
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

      <If when={inspecting() || inspected() !== undefined}>
        <View testID="devtools-inspector-bar" class="flex-row flex-wrap items-center justify-between gap-2 border-b border-line bg-selected px-3 py-1.5">
          <View class="min-w-0 flex-1 flex-row flex-wrap items-center gap-2">
            <Icon name="understand" size={13} tone="accent" />
            <Text class="text-xs font-semibold text-ink">{t("web.devtools.inspector.title")}</Text>
            <If when={inspecting()}>
              <Text class="text-xs text-muted">{t("web.devtools.inspector.active")}</Text>
            </If>
            <If when={inspected() !== undefined}>
              <View class="flex-row flex-wrap items-center gap-1.5">
                <If when={Boolean(inspected()!.testId)}>
                  <Tag tone="info" label={inspected()!.testId ?? ""} />
                </If>
                <If when={Boolean(inspected()!.surface)}>
                  <Tag tone="neutral" label={`${t("web.devtools.inspector.surface")}: ${inspected()!.surface ?? ""}`} />
                </If>
                <If when={inspected()!.bounds !== undefined}>
                  <Text testID="devtools-inspector-bounds" class="font-mono text-2xs text-muted">
                    {`${Math.round(inspected()!.bounds!.x)},${Math.round(inspected()!.bounds!.y)} ${Math.round(inspected()!.bounds!.width)}×${Math.round(inspected()!.bounds!.height)}`}
                  </Text>
                </If>
                <If when={Boolean(inspected()!.source)} else={<Text class="text-2xs text-faint">{t("web.devtools.inspector.noSource")}</Text>}>
                  <Text testID="devtools-inspector-source" class="font-mono text-2xs text-water">
                    {inspected()!.source}
                  </Text>
                </If>
              </View>
            </If>
          </View>
          <View class="flex-row items-center gap-1.5">
            <If when={Boolean(inspected()?.source)}>
              <Button size="compact" tone="primary" icon="file" testID="devtools-jump-source" onPress={jumpToInspectedSource}>
                {t("web.devtools.actions.jumpToSource")}
              </Button>
            </If>
            <If when={inspected() !== undefined}>
              <IconButton
                icon="close"
                size={14}
                label={t("web.devtools.actions.clearHighlight")}
                testid="devtools-clear-highlight"
                onClick={() => act({ type: "devtools_highlight" })}
              />
            </If>
          </View>
        </View>
      </If>

      <View class="min-h-0 flex-1 flex-row">
        <View testID="devtools-rail" class="w-12 shrink-0 items-center gap-1 border-r border-line bg-rail py-2">
          <Each of={DEVTOOLS_TABS} key={(tab) => tab}>
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
            when={activeTab() === "remote"}
            else={
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
                      <TimelineTab
                        fallbackEvents={() => snapshot()!.recentTimeline}
                        refreshTick={refreshTick}
                        focus={() => timelineFocus()}
                        onJumpToTrajectory={onJumpToTrajectory}
                        onCleared={() => void refresh()}
                      />
                    </If>
                    <If when={activeTab() === "trajectory"}>
                      <TrajectoryTab refreshTick={refreshTick} focus={() => trajectoryFocus()} onJumpToTimeline={onJumpToTimeline} />
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
            }
          >
            <RemoteVdpPanel visible={visible} onConnectionChange={(next) => remoteConn.set(next)} />
          </If>
        </View>
      </View>
    </View>
  );
}
