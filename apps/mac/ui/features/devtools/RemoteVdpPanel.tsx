import { computed, Image, Scroll, signal, Text, untracked, View } from "nsh";
import { z } from "zod";

import { t } from "@vibevalley/i18n";
import { BizCode } from "@vibevalley/protocol/api";

import { Button } from "../../design/Button";
import { Field, TextArea, TextInput } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { Banner, Empty } from "../../design/layout";
import { Tag, type TagTone } from "../../design/Tag";
import { useInterval } from "../../infra/base/timer";
import { hostApi, type VdpEndpointInfo } from "../../infra/bridge";
import { onSettled } from "../../infra/solid";
import { formatFrameMs, formatJson, QUICK_ROUTES } from "./format";
import { JsonPreview, MetricTile, SectionHeader } from "./shared";

export interface AttachedRemoteVdp {
  readonly label: string;
  readonly port: number;
  readonly wsUrl: string;
  readonly token: string;
  readonly channel?: string | undefined;
  readonly pid?: number | undefined;
  readonly home?: string | undefined;
}

const VdpTargetSchema = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  url: z.exactOptional(z.string()),
  attached: z.exactOptional(z.boolean()),
});

type RemoteTarget = z.infer<typeof VdpTargetSchema>;

const TargetListResultSchema = z.object({
  targets: z.array(VdpTargetSchema),
});

const PageMetricsSchema = z.object({
  width: z.number(),
  height: z.number(),
  scaleFactor: z.exactOptional(z.number()),
  themeDark: z.exactOptional(z.boolean()),
  lastFrameMs: z.exactOptional(z.number()),
});

type RemoteMetrics = z.infer<typeof PageMetricsSchema>;

const ScreenshotResultSchema = z.object({
  mime: z.string(),
  data: z.string(),
  width: z.number(),
  height: z.number(),
});

type RemoteScreenshot = z.infer<typeof ScreenshotResultSchema>;

const UiBoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

const UiNodeSchema = z.object({
  testId: z.exactOptional(z.string()),
  role: z.exactOptional(z.string()),
  text: z.exactOptional(z.string()),
  route: z.exactOptional(z.string()),
  bounds: z.exactOptional(UiBoundsSchema),
  pressable: z.exactOptional(z.boolean()),
});

type RemoteUiNode = z.infer<typeof UiNodeSchema>;

const UiQueryResultSchema = z.object({
  view: z.exactOptional(z.string()),
  route: z.exactOptional(z.string()),
  count: z.exactOptional(z.number()),
  nodes: z.array(UiNodeSchema),
});

const BufferedEventSchema = z.object({
  id: z.number(),
  event: z.object({
    method: z.string(),
    params: z.unknown(),
  }),
});

const LogEntriesResultSchema = z.object({
  entries: z.array(BufferedEventSchema),
  latestId: z.exactOptional(z.number()),
});

const LegacyTimelineItemSchema = z.object({
  id: z.exactOptional(z.number()),
  level: z.exactOptional(z.string()),
  source: z.exactOptional(z.string()),
  lane: z.exactOptional(z.string()),
  kind: z.exactOptional(z.string()),
  message: z.exactOptional(z.string()),
  summary: z.exactOptional(z.string()),
  timestamp: z.exactOptional(z.number()),
  time: z.exactOptional(z.number()),
});

const LegacyTimelineResultSchema = z.object({
  events: z.array(LegacyTimelineItemSchema),
});

interface RemoteLogRow {
  readonly key: string;
  readonly level: string;
  readonly source: string;
  readonly message: string;
  readonly time: number;
}

function targetTone(kind: string): TagTone {
  switch (kind) {
    case "shell":
      return "ok";
    case "view":
      return "info";
    case "webview":
    case "diorama":
      return "wait";
    default:
      return "neutral";
  }
}

function logTone(level: string): TagTone {
  const lower = level.toLowerCase();
  if (lower === "error" || lower === "fatal") return "bad";
  if (lower === "warn" || lower === "warning") return "wait";
  if (lower === "info") return "info";
  return "neutral";
}

const ShellStateInfoSchema = z.object({
  route: z.exactOptional(z.string()),
  current: z.exactOptional(z.string()),
  routes: z.exactOptional(z.object({ current: z.exactOptional(z.string()) })),
  dark: z.exactOptional(z.boolean()),
  themeDark: z.exactOptional(z.boolean()),
  theme: z.exactOptional(z.string()),
});

const LogEventParamsSchema = z.object({
  level: z.exactOptional(z.string()),
  source: z.exactOptional(z.string()),
  view: z.exactOptional(z.string()),
  message: z.exactOptional(z.string()),
  frameMs: z.exactOptional(z.number()),
  timestamp: z.exactOptional(z.number()),
});

function extractShellRoute(state: unknown): string {
  const parsed = ShellStateInfoSchema.safeParse(state);
  if (!parsed.success) return "—";
  const d = parsed.data;
  if (d.route !== undefined && d.route.length > 0) return d.route;
  if (d.current !== undefined && d.current.length > 0) return d.current;
  if (d.routes?.current !== undefined && d.routes.current.length > 0) return d.routes.current;
  return "—";
}

function extractShellDark(state: unknown): boolean | undefined {
  const parsed = ShellStateInfoSchema.safeParse(state);
  if (!parsed.success) return undefined;
  const d = parsed.data;
  if (d.dark !== undefined) return d.dark;
  if (d.themeDark !== undefined) return d.themeDark;
  if (d.theme === "dark") return true;
  if (d.theme === "light") return false;
  return undefined;
}

function formatClock(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

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
  let logSeq = 0;
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

  const invokeRemote = async (
    conn: AttachedRemoteVdp,
    method: string,
    params: unknown = {},
  ): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> => {
    const env = await hostApi.vdpCall({
      wsUrl: conn.wsUrl,
      port: conn.port,
      token: conn.token,
      method,
      params,
    });
    if (env.bizCode !== BizCode.Ok) {
      return { ok: false, message: env.message || `VDP ${method} failed` };
    }
    return { ok: true, data: env.data };
  };

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
      invokeRemote(conn, "Target.list", {}),
      invokeRemote(conn, "Shell.getState", {}),
      invokeRemote(conn, "Page.getMetrics", {}),
    ]);
    if (!targetsRes.ok && !stateRes.ok) {
      error.set(targetsRes.ok ? (stateRes.ok ? "" : stateRes.message) : targetsRes.message);
      return false;
    }
    error.set(undefined);
    if (targetsRes.ok) {
      const parsed = TargetListResultSchema.safeParse(targetsRes.data);
      if (parsed.success) {
        targets.set(parsed.data.targets);
      } else if (Array.isArray(targetsRes.data)) {
        const list = z.array(VdpTargetSchema).safeParse(targetsRes.data);
        if (list.success) targets.set(list.data);
      }
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
      void invokeRemote(current, "Log.disable", {});
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
    const res = await invokeRemote(conn, "Shell.navigate", { route: trimmed });
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
    const res = await invokeRemote(conn, "Shell.setTheme", {});
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
    const res = await invokeRemote(conn, "Shell.resize", { width, height });
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
    const res = await invokeRemote(conn, "Page.captureScreenshot", { target });
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
    const res = await invokeRemote(conn, "UI.query", params);
    uiBusy.set(false);
    if (!res.ok) {
      error.set(res.message);
      return;
    }
    const parsed = UiQueryResultSchema.safeParse(res.data);
    if (parsed.success) {
      uiNodes.set(parsed.data.nodes);
    } else {
      uiNodes.set([]);
    }
  };

  const fetchRemoteUiTree = async () => {
    const conn = untracked(attached);
    if (!conn || untracked(uiBusy)) return;
    uiBusy.set(true);
    error.set(undefined);
    const view = selectedViewName();
    const res = await invokeRemote(conn, "UI.getTree", view ? { view, maxDepth: 6 } : { maxDepth: 6 });
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
    const res = await invokeRemote(conn, "UI.press", view ? { testId, view } : { testId });
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
    const res = await invokeRemote(conn, method, parsedParams);
    rpcBusy.set(false);
    if (!res.ok) {
      rpcResponse.set(formatJson({ error: res.message }));
      return;
    }
    rpcResponse.set(formatJson(res.data));
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
    } else {
      const legacy = LegacyTimelineResultSchema.safeParse(raw);
      if (legacy.success) {
        for (const item of legacy.data.events) {
          const time = item.timestamp ?? item.time ?? Date.now();
          const source = item.source ?? item.lane ?? item.kind ?? "vdp";
          const message = item.message ?? item.summary ?? formatJson(item);
          const level = item.level ?? "info";
          const key = item.id !== undefined ? `legacy:${item.id}` : `seq:${++logSeq}:${time}:${source}:${message.slice(0, 32)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          added.push({ key, level, source, message, time });
        }
      }
    }

    if (added.length > 0) {
      logRows.set([...existing, ...added].slice(-80));
    }
  };

  const pollRemoteLogs = async () => {
    const conn = untracked(attached);
    if (!conn || !untracked(logStreaming) || logPollInFlight) return;
    logPollInFlight = true;
    try {
      const params = lastLogId > 0 ? { sinceId: lastLogId, limit: 30 } : { limit: 30 };
      const res = await invokeRemote(conn, "Log.getEntries", params);
      if (res.ok) {
        appendLogEntries(res.data);
      } else {
        const fallback = await invokeRemote(conn, "Server.invoke", { method: "debug.timeline.list", params: { limit: 20 } });
        if (fallback.ok) appendLogEntries(fallback.data);
      }
    } finally {
      logPollInFlight = false;
    }
  };

  const toggleLogStream = async () => {
    const conn = untracked(attached);
    if (!conn) return;
    const next = !untracked(logStreaming);
    const res = await invokeRemote(conn, next ? "Log.enable" : "Log.disable", {});
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
          <View class="gap-4">
            <View class="gap-2 rounded-md border border-line bg-page p-3">
              <SectionHeader
                title={t("web.devtools.remote.discover")}
                count={instances().length}
                action={
                  <Button size="compact" tone="plain" icon="refresh" testID="vdp-discover-refresh" disabled={scanning()} onPress={() => void discover()}>
                    {scanning() ? t("web.devtools.remote.scanning") : t("web.devtools.remote.scan")}
                  </Button>
                }
              />

              <If
                when={instances().length > 0}
                else={
                  <View testID="vdp-discover-empty" class="rounded-sm border border-line bg-side p-4">
                    <Empty icon="plug">{t("web.devtools.remote.emptyDiscover")}</Empty>
                  </View>
                }
              >
                <View class="overflow-hidden rounded-md border border-line bg-page">
                  <Each of={instances()} key={(item) => `${item.home}:${item.port}:${item.pid}`}>
                    {(item, idx) => (
                      <View
                        testID={`vdp-instance-${item().port}`}
                        class={`flex-row items-center justify-between gap-2 px-3 py-2 ${idx() > 0 ? "border-t border-line" : ""}`}
                      >
                        <View class="min-w-0 flex-1 gap-0.5">
                          <View class="flex-row flex-wrap items-center gap-1.5">
                            <Tag tone="info" label={item().channel} />
                            <Text class="font-mono text-xs font-medium text-ink">:{item().port}</Text>
                            <Text class="font-mono text-2xs text-muted">pid {item().pid}</Text>
                            <Text class="font-mono text-2xs text-faint">{item().appVersion}</Text>
                          </View>
                          <Text class="truncate font-mono text-2xs text-faint">{item().home}</Text>
                        </View>
                        <Button
                          size="compact"
                          tone="primary"
                          icon="plug"
                          testID={`vdp-attach-${item().port}`}
                          disabled={attaching()}
                          onPress={() => attachEndpoint(item())}
                        >
                          {attaching() ? t("web.devtools.remote.attaching") : t("web.devtools.remote.attach")}
                        </Button>
                      </View>
                    )}
                  </Each>
                </View>
              </If>
            </View>

            <View testID="vdp-manual-form" class="gap-3 rounded-md border border-line bg-page p-3">
              <SectionHeader title={t("web.devtools.remote.manualTitle")} />
              <View class="flex-row flex-wrap items-end gap-2">
                <View class="w-32 shrink-0">
                  <Field label={t("web.devtools.remote.port")}>
                    <TextInput
                      testID="vdp-manual-port"
                      accessibilityLabel={t("web.devtools.remote.port")}
                      value={manualPort()}
                      placeholder={t("web.devtools.remote.portPlaceholder")}
                      onInput={(v) => manualPort.set(v)}
                      onSubmit={connectManual}
                      class="font-mono text-xs"
                    />
                  </Field>
                </View>
                <View class="min-w-44 flex-1">
                  <Field label={t("web.devtools.remote.token")}>
                    <TextInput
                      testID="vdp-manual-token"
                      accessibilityLabel={t("web.devtools.remote.token")}
                      value={manualToken()}
                      placeholder={t("web.devtools.remote.tokenPlaceholder")}
                      masked
                      onInput={(v) => manualToken.set(v)}
                      onSubmit={connectManual}
                      class="font-mono text-xs"
                    />
                  </Field>
                </View>
                <Button size="control" tone="primary" icon="plug" testID="vdp-manual-connect" disabled={attaching()} onPress={connectManual}>
                  {attaching() ? t("web.devtools.remote.attaching") : t("web.devtools.remote.connect")}
                </Button>
              </View>
            </View>
          </View>
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

            <View testID="vdp-shell-section" class="gap-3 rounded-md border border-line bg-page p-3">
              <SectionHeader title={t("web.devtools.remote.shellTitle")} />
              <View class="flex-row flex-wrap gap-2">
                <MetricTile label={t("web.devtools.remote.route")} value={remoteRoute()} testID="vdp-remote-route" />
                <MetricTile
                  label={t("web.devtools.remote.theme")}
                  value={remoteDark() === undefined ? "—" : remoteDark() === true ? t("web.devtools.remote.themeDark") : t("web.devtools.remote.themeLight")}
                  testID="vdp-remote-theme"
                />
                <MetricTile
                  label={t("web.devtools.remote.viewport")}
                  value={metrics() ? `${Math.round(metrics()!.width)}×${Math.round(metrics()!.height)}` : "—"}
                />
                <MetricTile label={t("web.devtools.overview.lastFrameMs")} value={formatFrameMs(metrics()?.lastFrameMs)} />
              </View>

              <View class="flex-row flex-wrap items-center gap-1.5">
                <TextInput
                  testID="vdp-nav-input"
                  accessibilityLabel={t("web.devtools.remote.route")}
                  value={navInput()}
                  placeholder={t("web.devtools.remote.routePlaceholder")}
                  onInput={(v) => navInput.set(v)}
                  onSubmit={() => void navigateRemote(navInput())}
                  wide={false}
                  class="min-w-40 flex-1 font-mono text-xs"
                />
                <Button size="compact" tone="primary" icon="open" testID="vdp-nav-go" onPress={() => void navigateRemote(navInput())}>
                  {t("web.devtools.remote.navigate")}
                </Button>
                <Button size="compact" tone="plain" icon="appearance" testID="vdp-toggle-theme" onPress={() => void toggleRemoteTheme()}>
                  {t("web.devtools.remote.toggleTheme")}
                </Button>
              </View>

              <View class="flex-row flex-wrap items-center gap-1">
                <Each of={QUICK_ROUTES} key={(r) => r}>
                  {(r) => (
                    <Button
                      size="compact"
                      tone={remoteRoute() === r() ? "primary" : "plain"}
                      testID={`vdp-quick-route-${r().replace(/^\//u, "")}`}
                      onPress={() => void navigateRemote(r())}
                    >
                      {r()}
                    </Button>
                  )}
                </Each>
              </View>

              <View class="flex-row flex-wrap items-center gap-2">
                <TextInput
                  testID="vdp-resize-w"
                  accessibilityLabel={t("web.devtools.remote.width")}
                  value={resizeW()}
                  onInput={(v) => resizeW.set(v)}
                  wide={false}
                  class="w-20 font-mono text-xs"
                />
                <Text class="font-mono text-xs text-muted">x</Text>
                <TextInput
                  testID="vdp-resize-h"
                  accessibilityLabel={t("web.devtools.remote.height")}
                  value={resizeH()}
                  onInput={(v) => resizeH.set(v)}
                  wide={false}
                  class="w-20 font-mono text-xs"
                />
                <Button size="compact" tone="plain" icon="enlarge" testID="vdp-resize-go" onPress={() => void resizeRemote()}>
                  {t("web.devtools.remote.resize")}
                </Button>
                <Button
                  size="compact"
                  tone="primary"
                  icon="image"
                  testID="vdp-capture-shell"
                  disabled={capturing()}
                  onPress={() => void captureRemote("shell")}
                >
                  {capturing() ? t("web.devtools.remote.capturing") : t("web.devtools.remote.captureShell")}
                </Button>
                <Button
                  size="compact"
                  tone="plain"
                  icon="web"
                  testID="vdp-capture-webview"
                  disabled={capturing()}
                  onPress={() => void captureRemote("webview")}
                >
                  {t("web.devtools.remote.captureWebView")}
                </Button>
              </View>

              <If when={screenshot()}>
                {(shot) => (
                  <View testID="vdp-screenshot-box" class="gap-2 rounded-sm border border-line bg-side p-2.5">
                    <View class="flex-row items-center justify-between gap-2">
                      <View class="flex-row items-center gap-2">
                        <Text class="text-xs font-medium text-ink">{t("web.devtools.remote.screenshot")}</Text>
                        <Tag tone="info" label={`${shot().width}×${shot().height}`} />
                      </View>
                      <Button size="compact" tone="quiet" icon="close" testID="vdp-screenshot-clear" onPress={() => screenshot.set(undefined)}>
                        {t("web.devtools.actions.clear")}
                      </Button>
                    </View>
                    <Image
                      testID="vdp-screenshot-img"
                      src={`data:${shot().mime};base64,${shot().data}`}
                      class="h-48 w-full rounded-sm border border-line bg-page object-contain"
                    />
                  </View>
                )}
              </If>
            </View>

            <View testID="vdp-ui-probe" class="gap-2.5 rounded-md border border-line bg-page p-3">
              <SectionHeader title={t("web.devtools.remote.uiProbeTitle")} count={uiNodes().length} />
              <View class="flex-row flex-wrap items-center gap-1.5">
                <TextInput
                  testID="vdp-ui-testid"
                  accessibilityLabel={t("web.devtools.remote.testIdPlaceholder")}
                  value={uiTestId()}
                  placeholder={t("web.devtools.remote.testIdPlaceholder")}
                  onInput={(v) => uiTestId.set(v)}
                  onSubmit={() => void queryRemoteUi()}
                  wide={false}
                  class="min-w-36 flex-1 font-mono text-xs"
                />
                <TextInput
                  testID="vdp-ui-text"
                  accessibilityLabel={t("web.devtools.remote.textPlaceholder")}
                  value={uiText()}
                  placeholder={t("web.devtools.remote.textPlaceholder")}
                  onInput={(v) => uiText.set(v)}
                  onSubmit={() => void queryRemoteUi()}
                  wide={false}
                  class="min-w-32 flex-1 text-xs"
                />
                <TextInput
                  testID="vdp-ui-role"
                  accessibilityLabel={t("web.devtools.remote.rolePlaceholder")}
                  value={uiRole()}
                  placeholder={t("web.devtools.remote.rolePlaceholder")}
                  onInput={(v) => uiRole.set(v)}
                  onSubmit={() => void queryRemoteUi()}
                  wide={false}
                  class="w-28 font-mono text-xs"
                />
                <Button size="compact" tone="primary" icon="search" testID="vdp-ui-query-btn" disabled={uiBusy()} onPress={() => void queryRemoteUi()}>
                  {t("web.devtools.remote.query")}
                </Button>
                <Button size="compact" tone="plain" icon="branch" testID="vdp-ui-tree-btn" disabled={uiBusy()} onPress={() => void fetchRemoteUiTree()}>
                  {t("web.devtools.remote.tree")}
                </Button>
              </View>

              <If when={uiNodes().length > 0} else={<Text class="text-xs text-muted">{t("web.devtools.remote.emptyUi")}</Text>}>
                <View class="overflow-hidden rounded-sm border border-line bg-side">
                  <Each of={uiNodes()} key={(n, i) => n.testId ?? `node-${i}`}>
                    {(node, idx) => (
                      <View
                        testID={node().testId ? `vdp-ui-node-${node().testId}` : undefined}
                        class={`flex-row items-center justify-between gap-2 px-2.5 py-1.5 ${idx() > 0 ? "border-t border-line" : ""}`}
                      >
                        <View class="min-w-0 flex-1 gap-0.5">
                          <View class="flex-row flex-wrap items-center gap-1.5">
                            <Text class="font-mono text-xs font-medium text-ink">{node().testId ?? "—"}</Text>
                            <Tag tone="neutral" label={node().role ?? "view"} />
                            <If when={node().bounds !== undefined}>
                              <Text class="font-mono text-2xs text-faint">
                                {`${node().bounds?.x ?? 0},${node().bounds?.y ?? 0} ${node().bounds?.width ?? 0}×${node().bounds?.height ?? 0}`}
                              </Text>
                            </If>
                          </View>
                          <If when={Boolean(node().text)}>
                            <Text class="truncate text-2xs text-muted">{node().text}</Text>
                          </If>
                        </View>
                        <If when={node().pressable === true && Boolean(node().testId)}>
                          <Button
                            size="compact"
                            tone="primary"
                            icon="bolt"
                            testID={`vdp-ui-press-${node().testId ?? ""}`}
                            onPress={() => {
                              const id = node().testId;
                              if (id) void pressRemoteNode(id);
                            }}
                          >
                            {t("web.devtools.remote.press")}
                          </Button>
                        </If>
                      </View>
                    )}
                  </Each>
                </View>
              </If>

              <If when={uiTreeJson()}>{(tree) => <JsonPreview content={tree()} testID="vdp-ui-tree-json" />}</If>
            </View>

            <View testID="vdp-rpc-console" class="gap-2.5 rounded-md border border-line bg-page p-3">
              <SectionHeader title={t("web.devtools.remote.rpcTitle")} />
              <View class="flex-row items-center gap-2">
                <TextInput
                  testID="vdp-rpc-method"
                  accessibilityLabel={t("web.devtools.remote.rpcMethod")}
                  value={rpcMethod()}
                  placeholder={t("web.devtools.remote.rpcMethodPlaceholder")}
                  onInput={(v) => rpcMethod.set(v)}
                  onSubmit={() => void sendRawRpc()}
                  wide={false}
                  class="min-w-0 flex-1 font-mono text-xs"
                />
                <Button size="compact" tone="primary" icon="send" testID="vdp-rpc-send" disabled={rpcBusy()} onPress={() => void sendRawRpc()}>
                  {t("web.devtools.remote.rpcSend")}
                </Button>
              </View>
              <Field label={t("web.devtools.remote.rpcParams")}>
                <TextArea
                  testID="vdp-rpc-params"
                  accessibilityLabel={t("web.devtools.remote.rpcParams")}
                  value={rpcParams()}
                  placeholder="{}"
                  rows={3}
                  onInput={(v) => rpcParams.set(v)}
                  class="font-mono text-xs"
                />
              </Field>
              <If when={rpcResponse()}>{(out) => <JsonPreview content={out()} testID="vdp-rpc-response" copyTestID="vdp-rpc-copy" />}</If>
            </View>

            <View testID="vdp-log-stream" class="gap-2 rounded-md border border-line bg-page p-3">
              <SectionHeader
                title={t("web.devtools.remote.logsTitle")}
                count={logRows().length}
                action={
                  <View class="flex-row items-center gap-1.5">
                    <Button
                      size="compact"
                      tone={logStreaming() ? "danger" : "plain"}
                      icon={logStreaming() ? "stop" : "play"}
                      testID="vdp-log-toggle"
                      onPress={() => void toggleLogStream()}
                    >
                      {logStreaming() ? t("web.devtools.remote.logsDisable") : t("web.devtools.remote.logsEnable")}
                    </Button>
                    <Button size="compact" tone="quiet" icon="delete" testID="vdp-log-clear" onPress={() => logRows.set([])}>
                      {t("web.devtools.actions.clear")}
                    </Button>
                  </View>
                }
              />
              <If when={logRows().length > 0} else={<Text class="text-xs text-muted">{t("web.devtools.remote.emptyLogs")}</Text>}>
                <Scroll class="max-h-48 rounded-sm border border-line bg-side" contentClass="divide-y divide-line">
                  <Each of={logRows()} key={(row) => row.key}>
                    {(row, idx) => (
                      <View class={`flex-row items-start gap-2 px-2.5 py-1.5 ${idx() > 0 ? "border-t border-line" : ""}`}>
                        <Text class="shrink-0 font-mono text-2xs text-faint tabular-nums">{formatClock(row().time)}</Text>
                        <Tag tone={logTone(row().level)} label={row().level} />
                        <Text class="shrink-0 font-mono text-2xs text-muted">{row().source}</Text>
                        <Text class="min-w-0 flex-1 font-mono text-2xs text-ink">{row().message}</Text>
                      </View>
                    )}
                  </Each>
                </Scroll>
              </If>
            </View>
          </View>
        )}
      </If>
    </Scroll>
  );
}
