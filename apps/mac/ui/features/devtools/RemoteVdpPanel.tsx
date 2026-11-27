import { computed, Scroll, signal, Text, untracked, View } from "nsh";

import { t } from "@vibevalley/i18n";
import { BizCode } from "@vibevalley/protocol/api";

import { Button } from "../../design/Button";
import { Icon } from "../../design/Icon";
import { Banner } from "../../design/layout";
import { Tag } from "../../design/Tag";
import { useInterval } from "../../infra/base/timer";
import { hostApi, type VdpEndpointInfo } from "../../infra/bridge";
import { onSettled } from "../../infra/solid";
import { formatJson } from "./format";
import {
  type AttachedRemoteVdp,
  extractShellDark,
  extractShellRoute,
  invokeRemoteVdp,
  LogEntriesResultSchema,
  LogEventParamsSchema,
  PageMetricsSchema,
  type RemoteLogRow,
  type RemoteMetrics,
  type RemoteScreenshot,
  type RemoteTarget,
  type RemoteUiNode,
  ScreenshotResultSchema,
  TargetListResultSchema,
  targetTone,
  UiQueryResultSchema,
} from "./remoteVdpModel";
import { RemoteVdpConnectView, RemoteVdpLogSection, RemoteVdpRpcSection, RemoteVdpShellSection, RemoteVdpUiProbeSection } from "./RemoteVdpSections";
import { SectionHeader } from "./shared";

export type { AttachedRemoteVdp } from "./remoteVdpModel";

export function RemoteVdpPanel(props: { visible: () => boolean; onConnectionChange?: ((conn: AttachedRemoteVdp | undefined) => void) | undefined }) {
  const instances = signal<readonly VdpEndpointInfo[]>([]);
  const scanning = signal(false);
  const attaching = signal(false);
  const error = signal<string | undefined>(undefined);
  const feedback = signal<string | undefined>(undefined);

  const manualPort = signal("");
  const manualToken = signal("");

  const attached = signal<AttachedRemoteVdp | undefined>(undefined);
  const targets = signal<readonly RemoteTarget[]>([]);
  const selectedTargetId = signal<string | undefined>(undefined);
  const shellState = signal<unknown>(undefined);
  const metrics = signal<RemoteMetrics | undefined>(undefined);

  const navInput = signal("/issues");
  const resizeW = signal("1280");
  const resizeH = signal("820");
  const capturing = signal(false);
  const screenshot = signal<RemoteScreenshot | undefined>(undefined);

  const uiTestId = signal("");
  const uiText = signal("");
  const uiRole = signal("");
  const uiNodes = signal<readonly RemoteUiNode[]>([]);
  const uiTreeJson = signal<string | undefined>(undefined);
  const uiBusy = signal(false);

  const rpcMethod = signal("");
  const rpcParams = signal("");
  const rpcResponse = signal<string | undefined>(undefined);
  const rpcBusy = signal(false);

  const logStreaming = signal(false);
  const logRows = signal<readonly RemoteLogRow[]>([]);
  let lastLogId = 0;
  let logPollInFlight = false;

  const selectedViewName = computed(() => {
    const id = selectedTargetId();
    if (!id) return undefined;
    const match = targets().find((item) => item.id === id && item.kind === "view");
    return match ? match.title : undefined;
  });

  const remoteRoute = computed(() => extractShellRoute(shellState()));
  const remoteDark = computed(() => metrics()?.themeDark ?? extractShellDark(shellState()));

  const discover = async () => {
    if (untracked(scanning)) return;
    scanning.set(true);
    error.set(undefined);
    const res = await hostApi.vdpDiscover();
    scanning.set(false);
    if (res.bizCode !== BizCode.Ok || res.data === undefined) {
      error.set(res.message);
      return;
    }
    instances.set(res.data);
  };

  const refreshAttached = async (conn: AttachedRemoteVdp): Promise<boolean> => {
    const [targetsRes, stateRes, metricsRes] = await Promise.all([
      invokeRemoteVdp(conn, "Target.list", {}),
      invokeRemoteVdp(conn, "Shell.getState", {}),
      invokeRemoteVdp(conn, "Page.getMetrics", {}),
    ]);
    if (!targetsRes.ok && !stateRes.ok) {
      error.set(targetsRes.ok ? (stateRes.ok ? "" : stateRes.message) : targetsRes.message);
      return false;
    }
    error.set(undefined);
    if (targetsRes.ok) {
      const parsed = TargetListResultSchema.safeParse(targetsRes.data);
      if (parsed.success) targets.set(parsed.data.targets);
    }
    if (stateRes.ok) {
      shellState.set(stateRes.data);
      const r = extractShellRoute(stateRes.data);
      if (r !== "—") navInput.set(r);
    }
    if (metricsRes.ok) {
      const parsedMetrics = PageMetricsSchema.safeParse(metricsRes.data);
      if (parsedMetrics.success) {
        metrics.set(parsedMetrics.data);
        resizeW.set(String(Math.round(parsedMetrics.data.width)));
        resizeH.set(String(Math.round(parsedMetrics.data.height)));
      }
    }
    return true;
  };

  const attachTo = async (conn: AttachedRemoteVdp) => {
    if (untracked(attaching)) return;
    attaching.set(true);
    error.set(undefined);
    feedback.set(undefined);
    const ok = await refreshAttached(conn);
    attaching.set(false);
    if (!ok) return;
    attached.set(conn);
    screenshot.set(undefined);
    uiNodes.set([]);
    uiTreeJson.set(undefined);
    logRows.set([]);
    lastLogId = 0;
    logStreaming.set(false);
    props.onConnectionChange?.(conn);
  };

  const attachEndpoint = (endpoint: VdpEndpointInfo) => {
    void attachTo({
      label: `${endpoint.channel} :${endpoint.port}`,
      port: endpoint.port,
      wsUrl: endpoint.wsUrl,
      token: endpoint.token,
      channel: endpoint.channel,
      pid: endpoint.pid,
      home: endpoint.home,
    });
  };

  const connectManual = () => {
    const parsedPort = Number.parseInt(manualPort().trim(), 10);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
      error.set(t("web.devtools.remote.invalidPort"));
      return;
    }
    const token = manualToken().trim();
    void attachTo({
      label: `127.0.0.1:${parsedPort}`,
      port: parsedPort,
      wsUrl: `ws://127.0.0.1:${parsedPort}/devtools`,
      token,
    });
  };

  const disconnect = () => {
    const current = untracked(attached);
    if (current && untracked(logStreaming)) {
      void invokeRemoteVdp(current, "Log.disable", {});
    }
    logStreaming.set(false);
    attached.set(undefined);
    targets.set([]);
    selectedTargetId.set(undefined);
    shellState.set(undefined);
    metrics.set(undefined);
    screenshot.set(undefined);
    uiNodes.set([]);
    uiTreeJson.set(undefined);
    rpcResponse.set(undefined);
    logRows.set([]);
    error.set(undefined);
    feedback.set(undefined);
    props.onConnectionChange?.(undefined);
  };

  const navigateRemote = async (routePath: string) => {
    const conn = untracked(attached);
    const trimmed = routePath.trim();
    if (!conn || !trimmed) return;
    navInput.set(trimmed);
    const res = await invokeRemoteVdp(conn, "Shell.navigate", { route: trimmed });
    if (!res.ok) {
      error.set(res.message);
      return;
    }
    error.set(undefined);
    await refreshAttached(conn);
  };

  const toggleRemoteTheme = async () => {
    const conn = untracked(attached);
    if (!conn) return;
    const res = await invokeRemoteVdp(conn, "Shell.setTheme", {});
    if (!res.ok) {
      error.set(res.message);
      return;
    }
    error.set(undefined);
    await refreshAttached(conn);
  };

  const resizeRemote = async () => {
    const conn = untracked(attached);
    if (!conn) return;
    const width = Number.parseInt(resizeW().trim(), 10);
    const height = Number.parseInt(resizeH().trim(), 10);
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return;
    const res = await invokeRemoteVdp(conn, "Shell.resize", { width, height });
    if (!res.ok) {
      error.set(res.message);
      return;
    }
    error.set(undefined);
    await refreshAttached(conn);
  };

  const captureRemote = async (target: "shell" | "webview") => {
    const conn = untracked(attached);
    if (!conn || untracked(capturing)) return;
    capturing.set(true);
    error.set(undefined);
    const res = await invokeRemoteVdp(conn, "Page.captureScreenshot", { target });
    capturing.set(false);
    if (!res.ok) {
      error.set(res.message);
      return;
    }
    const parsed = ScreenshotResultSchema.safeParse(res.data);
    if (!parsed.success) {
      error.set("Invalid screenshot payload from remote VDP");
      return;
    }
    screenshot.set(parsed.data);
  };

  const queryRemoteUi = async () => {
    const conn = untracked(attached);
    if (!conn || untracked(uiBusy)) return;
    uiBusy.set(true);
    error.set(undefined);
    feedback.set(undefined);
    const params: Record<string, string> = {};
    if (uiTestId().trim()) params.testId = uiTestId().trim();
    if (uiText().trim()) params.text = uiText().trim();
    if (uiRole().trim()) params.role = uiRole().trim();
    const view = selectedViewName();
    if (view) params.view = view;
    const res = await invokeRemoteVdp(conn, "UI.query", params);
    uiBusy.set(false);
    if (!res.ok) {
      error.set(res.message);
      return;
    }
    const parsed = UiQueryResultSchema.safeParse(res.data);
    uiNodes.set(parsed.success ? parsed.data.nodes : []);
  };

  const fetchRemoteUiTree = async () => {
    const conn = untracked(attached);
    if (!conn || untracked(uiBusy)) return;
    uiBusy.set(true);
    error.set(undefined);
    const view = selectedViewName();
    const res = await invokeRemoteVdp(conn, "UI.getTree", view ? { view, maxDepth: 6 } : { maxDepth: 6 });
    uiBusy.set(false);
    if (!res.ok) {
      error.set(res.message);
      return;
    }
    uiTreeJson.set(formatJson(res.data));
  };

  const pressRemoteNode = async (testId: string) => {
    const conn = untracked(attached);
    if (!conn) return;
    const view = selectedViewName();
    const res = await invokeRemoteVdp(conn, "UI.press", view ? { testId, view } : { testId });
    if (!res.ok) {
      error.set(res.message);
      return;
    }
    error.set(undefined);
    feedback.set(t("web.devtools.remote.pressedFeedback", { testId }));
  };

  const sendRawRpc = async () => {
    const conn = untracked(attached);
    const method = rpcMethod().trim();
    if (!conn || !method || untracked(rpcBusy)) return;
    let parsedParams: unknown = {};
    const rawParams = rpcParams().trim();
    if (rawParams.length > 0) {
      try {
        parsedParams = JSON.parse(rawParams);
      } catch {
        error.set(t("web.devtools.remote.invalidJson"));
        return;
      }
    }
    rpcBusy.set(true);
    error.set(undefined);
    const res = await invokeRemoteVdp(conn, method, parsedParams);
    rpcBusy.set(false);
    rpcResponse.set(res.ok ? formatJson(res.data) : formatJson({ error: res.message }));
  };

  const appendLogEntries = (raw: unknown) => {
    const existing = untracked(logRows);
    const seen = new Set(existing.map((r) => r.key));
    const added: RemoteLogRow[] = [];

    const buffered = LogEntriesResultSchema.safeParse(raw);
    if (buffered.success) {
      if (buffered.data.latestId !== undefined && buffered.data.latestId > lastLogId) {
        lastLogId = buffered.data.latestId;
      }
      for (const item of buffered.data.entries) {
        if (item.id > lastLogId) lastLogId = item.id;
        const key = `vdp:${item.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const parsedParams = LogEventParamsSchema.safeParse(item.event.params);
        const params = parsedParams.success ? parsedParams.data : {};
        const level = params.level ?? "info";
        const source = params.source ?? params.view ?? item.event.method;
        const message = params.message ?? (params.frameMs !== undefined ? `frame ${params.frameMs.toFixed(1)} ms` : formatJson(item.event.params));
        const time = params.timestamp ?? Date.now();
        added.push({ key, level, source, message, time });
      }
    }

    if (added.length > 0) logRows.set([...existing, ...added].slice(-80));
  };

  const pollRemoteLogs = async () => {
    const conn = untracked(attached);
    if (!conn || !untracked(logStreaming) || logPollInFlight) return;
    logPollInFlight = true;
    try {
      const params = lastLogId > 0 ? { sinceId: lastLogId, limit: 30 } : { limit: 30 };
      const res = await invokeRemoteVdp(conn, "Log.getEntries", params);
      if (res.ok) appendLogEntries(res.data);
    } finally {
      logPollInFlight = false;
    }
  };

  const toggleLogStream = async () => {
    const conn = untracked(attached);
    if (!conn) return;
    const next = !untracked(logStreaming);
    const res = await invokeRemoteVdp(conn, next ? "Log.enable" : "Log.disable", {});
    if (!res.ok) {
      error.set(res.message);
      return;
    }
    error.set(undefined);
    logStreaming.set(next);
    if (next) void pollRemoteLogs();
  };

  onSettled(() => {
    void discover();
  });

  useInterval(() => {
    if (props.visible() && attached() !== undefined && logStreaming()) {
      void pollRemoteLogs();
    }
  }, 2000);

  return (
    <Scroll testID="devtools-remote" class="min-h-0 flex-1" contentClass="gap-4 p-3">
      <If when={error() !== undefined}>
        <Banner tone="bad" size="sm" testID="vdp-error">
          {error() ?? ""}
        </Banner>
      </If>

      <If when={feedback() !== undefined}>
        <Banner tone="ok" size="sm" testID="vdp-feedback">
          {feedback() ?? ""}
        </Banner>
      </If>

      <If
        when={attached()}
        else={
          <RemoteVdpConnectView
            instances={instances()}
            scanning={scanning()}
            attaching={attaching()}
            manualPort={manualPort()}
            manualToken={manualToken()}
            onDiscover={() => void discover()}
            onAttachEndpoint={attachEndpoint}
            onManualPort={(v) => manualPort.set(v)}
            onManualToken={(v) => manualToken.set(v)}
            onManualConnect={connectManual}
          />
        }
      >
        {(conn) => (
          <View testID="vdp-attached-view" class="gap-4">
            <View testID="vdp-connected-bar" class="flex-row flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-side px-3 py-2">
              <View class="min-w-0 flex-1 flex-row flex-wrap items-center gap-2">
                <Icon name="plug" size={14} tone="accent" />
                <Tag tone="ok" label={t("web.devtools.remote.connected")} />
                <Text class="font-mono text-xs font-medium text-ink">{conn().label}</Text>
                <If when={conn().pid !== undefined}>
                  <Text class="font-mono text-2xs text-muted">pid {conn().pid}</Text>
                </If>
                <If when={conn().home !== undefined}>
                  <Text class="min-w-0 flex-1 truncate font-mono text-2xs text-faint">{conn().home}</Text>
                </If>
              </View>
              <View class="shrink-0 flex-row items-center gap-1.5">
                <Button size="compact" tone="plain" icon="refresh" testID="vdp-remote-refresh" onPress={() => void refreshAttached(conn())}>
                  {t("web.devtools.actions.refresh")}
                </Button>
                <Button size="compact" tone="danger" icon="close" testID="vdp-disconnect" onPress={disconnect}>
                  {t("web.devtools.remote.disconnect")}
                </Button>
              </View>
            </View>

            <View testID="vdp-targets" class="gap-2 rounded-md border border-line bg-page p-3">
              <SectionHeader title={t("web.devtools.remote.targets")} count={targets().length} />
              <If when={targets().length > 0} else={<Text class="text-xs text-muted">{t("web.devtools.remote.emptyTargets")}</Text>}>
                <View class="flex-row flex-wrap gap-1.5">
                  <Each of={targets()} key={(item) => item.id}>
                    {(item) => {
                      const active = () => selectedTargetId() === item().id;
                      return (
                        <View
                          role="button"
                          testID={`vdp-target-${item().id}`}
                          onPress={() => selectedTargetId.set(active() ? undefined : item().id)}
                          class={`flex-row items-center gap-1.5 rounded-md border px-2 py-1 ${
                            active() ? "border-focus bg-selected" : "border-line bg-side hover:bg-hover"
                          }`}
                        >
                          <Tag tone={targetTone(item().kind)} label={item().kind} />
                          <Text class="text-xs font-medium text-ink">{item().title}</Text>
                          <Text class="font-mono text-2xs text-faint">{item().id}</Text>
                        </View>
                      );
                    }}
                  </Each>
                </View>
              </If>
            </View>

            <RemoteVdpShellSection
              remoteRoute={remoteRoute()}
              remoteDark={remoteDark()}
              metrics={metrics()}
              navInput={navInput()}
              resizeW={resizeW()}
              resizeH={resizeH()}
              capturing={capturing()}
              screenshot={screenshot()}
              onNavInput={(v) => navInput.set(v)}
              onNavigate={(route) => void navigateRemote(route)}
              onToggleTheme={() => void toggleRemoteTheme()}
              onResizeW={(v) => resizeW.set(v)}
              onResizeH={(v) => resizeH.set(v)}
              onResize={() => void resizeRemote()}
              onCapture={(target) => void captureRemote(target)}
              onClearScreenshot={() => screenshot.set(undefined)}
            />

            <RemoteVdpUiProbeSection
              uiTestId={uiTestId()}
              uiText={uiText()}
              uiRole={uiRole()}
              uiNodes={uiNodes()}
              uiTreeJson={uiTreeJson()}
              uiBusy={uiBusy()}
              onUiTestId={(v) => uiTestId.set(v)}
              onUiText={(v) => uiText.set(v)}
              onUiRole={(v) => uiRole.set(v)}
              onQuery={() => void queryRemoteUi()}
              onTree={() => void fetchRemoteUiTree()}
              onPressNode={(id) => void pressRemoteNode(id)}
            />

            <RemoteVdpRpcSection
              rpcMethod={rpcMethod()}
              rpcParams={rpcParams()}
              rpcResponse={rpcResponse()}
              rpcBusy={rpcBusy()}
              onRpcMethod={(v) => rpcMethod.set(v)}
              onRpcParams={(v) => rpcParams.set(v)}
              onSend={() => void sendRawRpc()}
            />

            <RemoteVdpLogSection
              logStreaming={logStreaming()}
              logRows={logRows()}
              onToggleStream={() => void toggleLogStream()}
              onClearLogs={() => logRows.set([])}
            />
          </View>
        )}
      </If>
    </Scroll>
  );
}
