import { Image, Scroll, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { Button } from "../../design/Button";
import { Field, TextArea, TextInput } from "../../design/Field";
import { Empty } from "../../design/layout";
import { Tag } from "../../design/Tag";
import { wallClockText } from "../../infra/base/format";
import type { VdpEndpointInfo } from "../../infra/bridge";
import { formatFrameMs, QUICK_ROUTES } from "./format";
import { logTone, type RemoteLogRow, type RemoteMetrics, type RemoteScreenshot, type RemoteUiNode } from "./remoteVdpModel";
import { JsonPreview, MetricTile, SectionHeader } from "./shared";

export function RemoteVdpConnectView(props: {
  readonly instances: readonly VdpEndpointInfo[];
  readonly scanning: boolean;
  readonly attaching: boolean;
  readonly manualPort: string;
  readonly manualToken: string;
  readonly onDiscover: () => void;
  readonly onAttachEndpoint: (endpoint: VdpEndpointInfo) => void;
  readonly onManualPort: (v: string) => void;
  readonly onManualToken: (v: string) => void;
  readonly onManualConnect: () => void;
}) {
  return (
    <View class="gap-4">
      <View class="gap-2 rounded-md border border-line bg-page p-3">
        <SectionHeader
          title={t("web.devtools.remote.discover")}
          count={props.instances.length}
          action={
            <Button size="compact" tone="plain" icon="refresh" testID="vdp-discover-refresh" disabled={props.scanning} onPress={() => props.onDiscover()}>
              {props.scanning ? t("web.devtools.remote.scanning") : t("web.devtools.remote.scan")}
            </Button>
          }
        />

        <If
          when={props.instances.length > 0}
          else={
            <View testID="vdp-discover-empty" class="rounded-sm border border-line bg-side p-4">
              <Empty icon="plug">{t("web.devtools.remote.emptyDiscover")}</Empty>
            </View>
          }
        >
          <View class="overflow-hidden rounded-md border border-line bg-page">
            <Each of={props.instances} key={(item) => `${item.home}:${item.port}:${item.pid}`}>
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
                    disabled={props.attaching}
                    onPress={() => props.onAttachEndpoint(item())}
                  >
                    {props.attaching ? t("web.devtools.remote.attaching") : t("web.devtools.remote.attach")}
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
                value={props.manualPort}
                placeholder={t("web.devtools.remote.portPlaceholder")}
                onInput={(v) => props.onManualPort(v)}
                onSubmit={() => props.onManualConnect()}
                class="font-mono text-xs"
              />
            </Field>
          </View>
          <View class="min-w-44 flex-1">
            <Field label={t("web.devtools.remote.token")}>
              <TextInput
                testID="vdp-manual-token"
                accessibilityLabel={t("web.devtools.remote.token")}
                value={props.manualToken}
                placeholder={t("web.devtools.remote.tokenPlaceholder")}
                masked
                onInput={(v) => props.onManualToken(v)}
                onSubmit={() => props.onManualConnect()}
                class="font-mono text-xs"
              />
            </Field>
          </View>
          <Button size="control" tone="primary" icon="plug" testID="vdp-manual-connect" disabled={props.attaching} onPress={() => props.onManualConnect()}>
            {props.attaching ? t("web.devtools.remote.attaching") : t("web.devtools.remote.connect")}
          </Button>
        </View>
      </View>
    </View>
  );
}

export function RemoteVdpShellSection(props: {
  readonly remoteRoute: string;
  readonly remoteDark: boolean | undefined;
  readonly metrics: RemoteMetrics | undefined;
  readonly navInput: string;
  readonly resizeW: string;
  readonly resizeH: string;
  readonly capturing: boolean;
  readonly screenshot: RemoteScreenshot | undefined;
  readonly onNavInput: (v: string) => void;
  readonly onNavigate: (route: string) => void;
  readonly onToggleTheme: () => void;
  readonly onResizeW: (v: string) => void;
  readonly onResizeH: (v: string) => void;
  readonly onResize: () => void;
  readonly onCapture: (target: "shell" | "webview") => void;
  readonly onClearScreenshot: () => void;
}) {
  return (
    <View testID="vdp-shell-section" class="gap-3 rounded-md border border-line bg-page p-3">
      <SectionHeader title={t("web.devtools.remote.shellTitle")} />
      <View class="flex-row flex-wrap gap-2">
        <MetricTile label={t("web.devtools.remote.route")} value={props.remoteRoute} testID="vdp-remote-route" />
        <MetricTile
          label={t("web.devtools.remote.theme")}
          value={props.remoteDark === undefined ? "—" : props.remoteDark === true ? t("web.devtools.remote.themeDark") : t("web.devtools.remote.themeLight")}
          testID="vdp-remote-theme"
        />
        <MetricTile
          label={t("web.devtools.remote.viewport")}
          value={props.metrics ? `${Math.round(props.metrics.width)}×${Math.round(props.metrics.height)}` : "—"}
        />
        <MetricTile label={t("web.devtools.overview.lastFrameMs")} value={formatFrameMs(props.metrics?.lastFrameMs)} />
      </View>

      <View class="flex-row flex-wrap items-center gap-1.5">
        <TextInput
          testID="vdp-nav-input"
          accessibilityLabel={t("web.devtools.remote.route")}
          value={props.navInput}
          placeholder={t("web.devtools.remote.routePlaceholder")}
          onInput={(v) => props.onNavInput(v)}
          onSubmit={() => props.onNavigate(props.navInput)}
          wide={false}
          class="min-w-40 flex-1 font-mono text-xs"
        />
        <Button size="compact" tone="primary" icon="open" testID="vdp-nav-go" onPress={() => props.onNavigate(props.navInput)}>
          {t("web.devtools.remote.navigate")}
        </Button>
        <Button size="compact" tone="plain" icon="appearance" testID="vdp-toggle-theme" onPress={() => props.onToggleTheme()}>
          {t("web.devtools.remote.toggleTheme")}
        </Button>
      </View>

      <View class="flex-row flex-wrap items-center gap-1">
        <Each of={QUICK_ROUTES} key={(r) => r}>
          {(r) => (
            <Button
              size="compact"
              tone={props.remoteRoute === r() ? "primary" : "plain"}
              testID={`vdp-quick-route-${r().replace(/^\//u, "")}`}
              onPress={() => props.onNavigate(r())}
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
          value={props.resizeW}
          onInput={(v) => props.onResizeW(v)}
          wide={false}
          class="w-20 font-mono text-xs"
        />
        <Text class="font-mono text-xs text-muted">x</Text>
        <TextInput
          testID="vdp-resize-h"
          accessibilityLabel={t("web.devtools.remote.height")}
          value={props.resizeH}
          onInput={(v) => props.onResizeH(v)}
          wide={false}
          class="w-20 font-mono text-xs"
        />
        <Button size="compact" tone="plain" icon="enlarge" testID="vdp-resize-go" onPress={() => props.onResize()}>
          {t("web.devtools.remote.resize")}
        </Button>
        <Button size="compact" tone="primary" icon="image" testID="vdp-capture-shell" disabled={props.capturing} onPress={() => props.onCapture("shell")}>
          {props.capturing ? t("web.devtools.remote.capturing") : t("web.devtools.remote.captureShell")}
        </Button>
        <Button size="compact" tone="plain" icon="web" testID="vdp-capture-webview" disabled={props.capturing} onPress={() => props.onCapture("webview")}>
          {t("web.devtools.remote.captureWebView")}
        </Button>
      </View>

      <If when={props.screenshot}>
        {(shot) => (
          <View testID="vdp-screenshot-box" class="gap-2 rounded-sm border border-line bg-side p-2.5">
            <View class="flex-row items-center justify-between gap-2">
              <View class="flex-row items-center gap-2">
                <Text class="text-xs font-medium text-ink">{t("web.devtools.remote.screenshot")}</Text>
                <Tag tone="info" label={`${shot().width}×${shot().height}`} />
              </View>
              <Button size="compact" tone="quiet" icon="close" testID="vdp-screenshot-clear" onPress={() => props.onClearScreenshot()}>
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
  );
}

export function RemoteVdpUiProbeSection(props: {
  readonly uiTestId: string;
  readonly uiText: string;
  readonly uiRole: string;
  readonly uiNodes: readonly RemoteUiNode[];
  readonly uiTreeJson: string | undefined;
  readonly uiBusy: boolean;
  readonly onUiTestId: (v: string) => void;
  readonly onUiText: (v: string) => void;
  readonly onUiRole: (v: string) => void;
  readonly onQuery: () => void;
  readonly onTree: () => void;
  readonly onPressNode: (testId: string) => void;
}) {
  return (
    <View testID="vdp-ui-probe" class="gap-2.5 rounded-md border border-line bg-page p-3">
      <SectionHeader title={t("web.devtools.remote.uiProbeTitle")} count={props.uiNodes.length} />
      <View class="flex-row flex-wrap items-center gap-1.5">
        <TextInput
          testID="vdp-ui-testid"
          accessibilityLabel={t("web.devtools.remote.testIdPlaceholder")}
          value={props.uiTestId}
          placeholder={t("web.devtools.remote.testIdPlaceholder")}
          onInput={(v) => props.onUiTestId(v)}
          onSubmit={() => props.onQuery()}
          wide={false}
          class="min-w-36 flex-1 font-mono text-xs"
        />
        <TextInput
          testID="vdp-ui-text"
          accessibilityLabel={t("web.devtools.remote.textPlaceholder")}
          value={props.uiText}
          placeholder={t("web.devtools.remote.textPlaceholder")}
          onInput={(v) => props.onUiText(v)}
          onSubmit={() => props.onQuery()}
          wide={false}
          class="min-w-32 flex-1 text-xs"
        />
        <TextInput
          testID="vdp-ui-role"
          accessibilityLabel={t("web.devtools.remote.rolePlaceholder")}
          value={props.uiRole}
          placeholder={t("web.devtools.remote.rolePlaceholder")}
          onInput={(v) => props.onUiRole(v)}
          onSubmit={() => props.onQuery()}
          wide={false}
          class="w-28 font-mono text-xs"
        />
        <Button size="compact" tone="primary" icon="search" testID="vdp-ui-query-btn" disabled={props.uiBusy} onPress={() => props.onQuery()}>
          {t("web.devtools.remote.query")}
        </Button>
        <Button size="compact" tone="plain" icon="branch" testID="vdp-ui-tree-btn" disabled={props.uiBusy} onPress={() => props.onTree()}>
          {t("web.devtools.remote.tree")}
        </Button>
      </View>

      <If when={props.uiNodes.length > 0} else={<Text class="text-xs text-muted">{t("web.devtools.remote.emptyUi")}</Text>}>
        <View class="overflow-hidden rounded-sm border border-line bg-side">
          <Each of={props.uiNodes} key={(n, i) => n.testId ?? `node-${i}`}>
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
                      if (id) props.onPressNode(id);
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

      <If when={props.uiTreeJson}>{(tree) => <JsonPreview content={tree()} testID="vdp-ui-tree-json" />}</If>
    </View>
  );
}

export function RemoteVdpRpcSection(props: {
  readonly rpcMethod: string;
  readonly rpcParams: string;
  readonly rpcResponse: string | undefined;
  readonly rpcBusy: boolean;
  readonly onRpcMethod: (v: string) => void;
  readonly onRpcParams: (v: string) => void;
  readonly onSend: () => void;
}) {
  return (
    <View testID="vdp-rpc-console" class="gap-2.5 rounded-md border border-line bg-page p-3">
      <SectionHeader title={t("web.devtools.remote.rpcTitle")} />
      <View class="flex-row items-center gap-2">
        <TextInput
          testID="vdp-rpc-method"
          accessibilityLabel={t("web.devtools.remote.rpcMethod")}
          value={props.rpcMethod}
          placeholder={t("web.devtools.remote.rpcMethodPlaceholder")}
          onInput={(v) => props.onRpcMethod(v)}
          onSubmit={() => props.onSend()}
          wide={false}
          class="min-w-0 flex-1 font-mono text-xs"
        />
        <Button size="compact" tone="primary" icon="send" testID="vdp-rpc-send" disabled={props.rpcBusy} onPress={() => props.onSend()}>
          {t("web.devtools.remote.rpcSend")}
        </Button>
      </View>
      <Field label={t("web.devtools.remote.rpcParams")}>
        <TextArea
          testID="vdp-rpc-params"
          accessibilityLabel={t("web.devtools.remote.rpcParams")}
          value={props.rpcParams}
          placeholder="{}"
          rows={3}
          onInput={(v) => props.onRpcParams(v)}
          class="font-mono text-xs"
        />
      </Field>
      <If when={props.rpcResponse}>{(out) => <JsonPreview content={out()} testID="vdp-rpc-response" copyTestID="vdp-rpc-copy" />}</If>
    </View>
  );
}

export function RemoteVdpLogSection(props: {
  readonly logStreaming: boolean;
  readonly logRows: readonly RemoteLogRow[];
  readonly onToggleStream: () => void;
  readonly onClearLogs: () => void;
}) {
  return (
    <View testID="vdp-log-stream" class="gap-2 rounded-md border border-line bg-page p-3">
      <SectionHeader
        title={t("web.devtools.remote.logsTitle")}
        count={props.logRows.length}
        action={
          <View class="flex-row items-center gap-1.5">
            <Button
              size="compact"
              tone={props.logStreaming ? "danger" : "plain"}
              icon={props.logStreaming ? "stop" : "play"}
              testID="vdp-log-toggle"
              onPress={() => props.onToggleStream()}
            >
              {props.logStreaming ? t("web.devtools.remote.logsDisable") : t("web.devtools.remote.logsEnable")}
            </Button>
            <Button size="compact" tone="quiet" icon="delete" testID="vdp-log-clear" onPress={() => props.onClearLogs()}>
              {t("web.devtools.actions.clear")}
            </Button>
          </View>
        }
      />
      <If when={props.logRows.length > 0} else={<Text class="text-xs text-muted">{t("web.devtools.remote.emptyLogs")}</Text>}>
        <Scroll class="max-h-48 rounded-sm border border-line bg-side" contentClass="divide-y divide-line">
          <Each of={props.logRows} key={(row) => row.key}>
            {(row, idx) => (
              <View class={`flex-row items-start gap-2 px-2.5 py-1.5 ${idx() > 0 ? "border-t border-line" : ""}`}>
                <Text class="shrink-0 font-mono text-2xs text-faint tabular-nums">
                  {Number.isFinite(row().time) && row().time > 0 ? wallClockText(row().time) : "—"}
                </Text>
                <Tag tone={logTone(row().level)} label={row().level} />
                <Text class="shrink-0 font-mono text-2xs text-muted">{row().source}</Text>
                <Text class="min-w-0 flex-1 font-mono text-2xs text-ink">{row().message}</Text>
              </View>
            )}
          </Each>
        </Scroll>
      </If>
    </View>
  );
}
