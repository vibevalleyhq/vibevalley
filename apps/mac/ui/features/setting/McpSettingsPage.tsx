import { Clipboard, computed, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { McpHostId, McpHostInfo, McpInstallStatus, McpTransportKind } from "@vibevalley/protocol";

import { Button } from "../../design/Button";
import { RuntimeIcon } from "../../design/domain/RuntimeIcon";
import { SettingRow, SettingsGroup, SettingsPage } from "../../design/domain/settings";
import { Icon } from "../../design/Icon";
import { IconButton } from "../../design/IconButton";
import { Banner, Quiet } from "../../design/layout";
import { Segmented } from "../../design/Segmented";
import { Tag, type TagTone } from "../../design/Tag";
import { toast } from "../../design/toasts";
import { createAct } from "../../infra/act";
import { api, reasonOf } from "../../infra/api";
import { defineQuery, ready, retryRead, useQuery, useQueryClient } from "../../infra/query";

const mcpHostsQuery = defineQuery({
  key: (transport: McpTransportKind) => ["runtime", "mcp", transport],
  fetch: (transport: McpTransportKind, context) => api.runtime.mcp.list({ transport }, context),
  ...retryRead,
});

function statusTagMeta(status: McpInstallStatus): { readonly label: string; readonly tone: TagTone } {
  switch (status.kind) {
    case "installed":
      return {
        label: t("web.setting.mcp.statusInstalled", { transport: status.transport }),
        tone: "ok",
      };
    case "outdated":
      return {
        label: t("web.setting.mcp.statusOutdated", { current: status.current }),
        tone: "wait",
      };
    case "notInstalled":
      return {
        label: t("web.setting.mcp.statusNotInstalled"),
        tone: "neutral",
      };
    case "unsupported":
      return {
        label: t("web.setting.mcp.statusUnsupported"),
        tone: "bad",
      };
  }
}

function actionLabel(status: McpInstallStatus): string {
  switch (status.kind) {
    case "installed":
      return t("web.setting.mcp.reinstall");
    case "outdated":
      return t("web.setting.mcp.update");
    case "notInstalled":
    case "unsupported":
      return t("web.setting.mcp.install");
  }
}

function snippetFor(host: McpHostInfo, transport: McpTransportKind): string {
  if (transport === "streamableHttp" && host.httpSnippet) return host.httpSnippet;
  return host.stdioSnippet;
}

function supportsTransport(host: McpHostInfo, transport: McpTransportKind): boolean {
  return transport === "streamableHttp" ? host.supportsHttp : host.supportsStdio;
}

function McpHostCard(props: {
  host: McpHostInfo;
  transport: McpTransportKind;
  busy: boolean;
  onInstall: (id: McpHostId) => void;
  onUninstall: (id: McpHostId) => void;
}) {
  const badge = computed(() => statusTagMeta(props.host.status));
  const snippet = computed(() => snippetFor(props.host, props.transport));
  const canInstall = computed(() => props.host.status.kind !== "unsupported" && supportsTransport(props.host, props.transport));
  const canUninstall = computed(() => props.host.status.kind === "installed" || props.host.status.kind === "outdated");

  return (
    <SettingsGroup
      testid={`mcp-host-${props.host.id}`}
      title={props.host.label}
      action={
        <View class="flex-row items-center gap-1.5">
          <Tag
            icon={props.host.installed ? "check" : "cross"}
            tone={props.host.installed ? "ok" : "neutral"}
            label={props.host.installed ? t("web.setting.mcp.detected") : t("web.setting.mcp.notDetected")}
          />
          <View testID={`mcp-status-${props.host.id}`}>
            <Tag tone={badge().tone} label={badge().label} />
          </View>
        </View>
      }
    >
      <SettingRow
        label={props.host.label}
        hint={props.host.status.kind === "outdated" || props.host.status.kind === "unsupported" ? props.host.status.reason : props.host.configPath}
      >
        <View class="flex-row items-center gap-2">
          <RuntimeIcon runtime={props.host.id} size={20} />
          <If when={canInstall()}>
            <Button
              tone={props.host.status.kind === "installed" ? "plain" : "primary"}
              size="compact"
              icon="plug"
              testID={`mcp-install-${props.host.id}`}
              disabled={props.busy}
              onPress={() => props.onInstall(props.host.id)}
            >
              {actionLabel(props.host.status)}
            </Button>
          </If>
          <If when={canUninstall()}>
            <Button
              tone="danger"
              size="compact"
              icon="delete"
              testID={`mcp-uninstall-${props.host.id}`}
              disabled={props.busy}
              onPress={() => props.onUninstall(props.host.id)}
            >
              {t("web.setting.mcp.uninstall")}
            </Button>
          </If>
        </View>
      </SettingRow>
      <If when={props.host.configPath}>
        {(path) => (
          <SettingRow label={t("web.setting.mcp.configPath")}>
            <View class="min-w-0 max-w-full rounded-md border border-line bg-side px-2 py-0.5">
              <Text class="min-w-0 select-text truncate font-mono text-xs text-muted">{path()}</Text>
            </View>
          </SettingRow>
        )}
      </If>
      <SettingRow label={t("web.setting.mcp.snippet")} wide last>
        <View class="w-full gap-2">
          <View class="w-full flex-row items-start justify-between gap-2 rounded-md border border-line bg-side p-2.5">
            <Text testID={`mcp-snippet-${props.host.id}`} class="min-w-0 flex-1 select-text font-mono text-xs leading-relaxed text-ink">
              {snippet()}
            </Text>
            <IconButton
              icon="copy"
              size={14}
              testid={`mcp-copy-${props.host.id}`}
              label={t("web.setting.mcp.copySnippet")}
              onClick={() =>
                void Clipboard.writeText(snippet()).then(
                  () => toast(t("web.setting.mcp.copiedSnippet")),
                  () => undefined,
                )
              }
            />
          </View>
        </View>
      </SettingRow>
    </SettingsGroup>
  );
}

export function McpSettingsPage() {
  const client = useQueryClient();
  const transport = signal<McpTransportKind>("stdio");
  const error = signal<string | undefined>(undefined);
  const busyHost = signal<McpHostId | undefined>(undefined);
  const act = createAct((reason) => error.set(reason));
  const query = useQuery(() => mcpHostsQuery(transport()));

  const refresh = () => {
    error.set(undefined);
    return client.invalidate({ prefix: ["runtime", "mcp"] });
  };

  const installHost = (hostId: McpHostId) => {
    if (act.busy()) return;
    error.set(undefined);
    busyHost.set(hostId);
    void act
      .run(async () => {
        const updated = await api.runtime.mcp.install({ host: hostId, transport: transport() });
        await client.invalidate({ prefix: ["runtime", "mcp"] });
        toast(t("web.setting.mcp.installedToast", { label: updated.label }));
      })
      .finally(() => {
        if (busyHost() === hostId) busyHost.set(undefined);
      });
  };

  const uninstallHost = (hostId: McpHostId) => {
    if (act.busy()) return;
    error.set(undefined);
    busyHost.set(hostId);
    void act
      .run(async () => {
        const updated = await api.runtime.mcp.uninstall({ host: hostId });
        await client.invalidate({ prefix: ["runtime", "mcp"] });
        toast(t("web.setting.mcp.uninstalledToast", { label: updated.label }));
      })
      .finally(() => {
        if (busyHost() === hostId) busyHost.set(undefined);
      });
  };

  return (
    <SettingsPage
      title={t("web.setting.nav.mcp")}
      description={t("web.setting.mcp.intro")}
      action={
        <Button tone="plain" size="compact" icon="refresh" testID="mcp-refresh" disabled={act.busy()} onPress={() => void refresh()}>
          {t("web.setting.mcp.refresh")}
        </Button>
      }
    >
      <View testID="mcp-settings-page" class="gap-5">
        <If when={error()}>
          {(err) => (
            <Banner tone="bad" role="alert" testID="mcp-error">
              {err()}
            </Banner>
          )}
        </If>

        <SettingsGroup>
          <SettingRow label={t("web.setting.mcp.transport")} hint={t("web.setting.mcp.transportHint")} last>
            <Segmented
              label={t("web.setting.mcp.transport")}
              testid="mcp-transport"
              value={transport()}
              options={[
                { value: "stdio", label: "stdio" },
                { value: "streamableHttp", label: "streamableHttp" },
              ]}
              onChange={(next) => transport.set(next)}
            />
          </SettingRow>
        </SettingsGroup>

        <If
          when={ready(query, undefined)}
          else={<Quiet>{query.error() ? t("web.base.form.unreachable", { why: reasonOf(query.error()) }) : t("web.base.form.asking")}</Quiet>}
        >
          {(result) => (
            <View class="gap-5">
              <If when={result().httpUrl}>
                {(url) => (
                  <View class="flex-row items-center gap-2 rounded-md border border-line bg-side px-3 py-2">
                    <Icon name="link" size={14} tone="muted" />
                    <Text class="text-xs text-muted">{url()}</Text>
                  </View>
                )}
              </If>
              <Each of={result().hosts} key={(h) => h.id}>
                {(host) => (
                  <McpHostCard host={host()} transport={transport()} busy={busyHost() === host().id} onInstall={installHost} onUninstall={uninstallHost} />
                )}
              </Each>
            </View>
          )}
        </If>
      </View>
    </SettingsPage>
  );
}
