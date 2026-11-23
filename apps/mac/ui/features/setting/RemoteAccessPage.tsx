import { Clipboard, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { RemoteDeviceSummary, RemotePairCode, RemotePlatform, RemoteStatus } from "@vibevalley/protocol";

import { createAct } from "../../design/act";
import { Button } from "../../design/Button";
import { SettingRow, SettingsGroup, SettingsPage } from "../../design/domain/settings";
import { Icon } from "../../design/Icon";
import { Banner, Quiet } from "../../design/layout";
import { Qr } from "../../design/Qr";
import { Tag } from "../../design/Tag";
import { api, reasonOf } from "../../infra/api";
import { shortMomentText } from "../../infra/base/format";
import { useTimeout } from "../../infra/base/timer";
import { onSettled } from "../../infra/solid";

function platformLabel(platform: RemotePlatform): string {
  switch (platform) {
    case "ios":
      return t("web.remote.devices.platform.ios");
    case "android":
      return t("web.remote.devices.platform.android");
    case "other":
      return t("web.remote.devices.platform.other");
  }
}

function activeDevicesOf(status: RemoteStatus): readonly RemoteDeviceSummary[] {
  return status.devices.filter((d) => d.revokedAt === undefined);
}

export function RemoteAccessPage() {
  const status = signal<RemoteStatus | undefined>(undefined);
  const loadError = signal<string | undefined>(undefined);
  const actionError = signal<string | undefined>(undefined);
  const pair = signal<RemotePairCode | undefined>(undefined);
  const copied = signal(false);
  const revokingId = signal<string | undefined>(undefined);
  const resetCopied = useTimeout();
  const act = createAct((reason) => actionError.set(reason));

  let alive = true;
  let loadSeq = 0;

  const refreshStatus = async () => {
    const seq = ++loadSeq;
    loadError.set(undefined);
    try {
      const next = await api.remote.status();
      if (!alive || seq !== loadSeq) return;
      status.set(next);
      if (!next.enabled) {
        pair.set(undefined);
        copied.set(false);
      }
    } catch (error) {
      if (!alive || seq !== loadSeq) return;
      loadError.set(reasonOf(error));
    }
  };

  onSettled(() => {
    void refreshStatus();
    return () => {
      alive = false;
    };
  });

  const onEnable = async () => {
    actionError.set(undefined);
    const next = await act.run(() => api.remote.enable({}));
    if (!alive || !next) return;
    loadSeq++;
    status.set(next);
  };

  const onDisable = async () => {
    actionError.set(undefined);
    const next = await act.run(() => api.remote.disable());
    if (!alive || !next) return;
    loadSeq++;
    status.set(next);
    pair.set(undefined);
    copied.set(false);
  };

  const onCreatePair = async () => {
    actionError.set(undefined);
    const next = await act.run(() => api.remote.pair.create());
    if (!alive || !next) return;
    pair.set(next);
    copied.set(false);
  };

  const onCopyPair = () => {
    const current = pair();
    if (!current) return;
    void Clipboard.writeText(current.pairUrl).then(
      () => {
        if (!alive) return;
        copied.set(true);
        resetCopied(() => {
          if (alive) copied.set(false);
        }, 2000);
      },
      (error: unknown) => {
        if (alive) actionError.set(reasonOf(error));
      },
    );
  };

  const onRevoke = async (id: string) => {
    actionError.set(undefined);
    revokingId.set(id);
    try {
      const submission = await act.attempt(() => api.remote.device.revoke({ id }));
      if (!alive || submission.kind !== "accepted") return;
      await refreshStatus();
    } finally {
      if (alive) revokingId.set(undefined);
    }
  };

  return (
    <SettingsPage title={t("web.remote.title")} hint={t("web.remote.subtitle")}>
      <If
        when={status()}
        else={
          <If when={loadError()} else={<Quiet>{t("web.base.form.asking")}</Quiet>}>
            {(err) => <Quiet>{t("web.base.form.unreachable", { why: err() })}</Quiet>}
          </If>
        }
      >
        {(s) => {
          const liveUrl = () => (s().listening ? s().url : undefined);
          const devices = () => activeDevicesOf(s());
          return (
            <View testID="remote-access-page" class="gap-5">
              <If when={actionError()}>
                {(err) => (
                  <Banner tone="bad" role="alert" testID="remote-error">
                    {err()}
                  </Banner>
                )}
              </If>

              <SettingsGroup>
                <SettingRow label={t("web.remote.title")} hint={t("web.remote.subtitle")} testid="remote-toggle-row">
                  <View testID="remote-status-badge">
                    <Tag
                      icon="lock"
                      tone={s().enabled ? "ok" : "neutral"}
                      label={s().enabled ? t("web.remote.toggle.enabled") : t("web.remote.toggle.disabled")}
                    />
                  </View>
                  <If
                    when={s().enabled}
                    else={
                      <Button tone="primary" icon="lock" testID="remote-enable" disabled={act.busy()} onPress={() => void onEnable()}>
                        {t("web.remote.toggle.enable")}
                      </Button>
                    }
                  >
                    <Button tone="plain" icon="lock" testID="remote-disable" disabled={act.busy()} onPress={() => void onDisable()}>
                      {t("web.remote.toggle.disable")}
                    </Button>
                  </If>
                </SettingRow>

                <SettingRow label={t("web.remote.tailscale.ip")} hint={s().tailscaleHost} testid="remote-tailscale-row" last={!liveUrl()}>
                  <View testID="remote-tailscale-badge">
                    <Tag
                      icon={s().tailscaleOnline ? "check" : "warn"}
                      tone={s().tailscaleOnline ? "ok" : "wait"}
                      label={s().tailscaleOnline ? t("web.remote.tailscale.online") : t("web.remote.tailscale.offline")}
                    />
                  </View>
                  <If when={s().tailscaleIp}>
                    {(ip) => (
                      <View testID="remote-tailscale-ip" class="rounded-sm bg-page px-2 py-0.5">
                        <Text class="select-text font-mono text-xs tabular-nums text-ink">{ip()}</Text>
                      </View>
                    )}
                  </If>
                </SettingRow>

                <If when={liveUrl()}>
                  {(url) => (
                    <SettingRow label={t("web.remote.tailscale.url")} testid="remote-url-row" last>
                      <View class="max-w-full flex-row items-center gap-1.5 rounded-sm bg-page px-2 py-0.5">
                        <Icon name="link" size={12} tone="muted" />
                        <Text testID="remote-access-url" class="min-w-0 select-text truncate font-mono text-xs tabular-nums text-ink">
                          {url()}
                        </Text>
                      </View>
                    </SettingRow>
                  )}
                </If>
              </SettingsGroup>

              <If when={s().enabled}>
                <SettingsGroup>
                  <SettingRow label={t("web.remote.pair.action")} hint={t("web.remote.pair.qrHint")} testid="remote-pair-action-row" last={!pair()}>
                    <Button
                      tone="primary"
                      icon={pair() ? "refresh" : "devices"}
                      testID="remote-pair-create"
                      disabled={act.busy()}
                      onPress={() => void onCreatePair()}
                    >
                      {t("web.remote.pair.action")}
                    </Button>
                  </SettingRow>

                  <If when={pair()}>
                    {(p) => (
                      <View testID="remote-pair-panel" class="flex-row flex-wrap items-start gap-5 px-4 py-4">
                        {/* QR codes require a high-contrast white quiet zone in both light and dark themes for phone cameras. */}
                        <View testID="remote-pair-qr" class="items-center justify-center rounded-md border border-line bg-white p-2 shadow-raise">
                          <Qr text={p().pairUrl} size={188} label={t("web.remote.pair.qrHint")} />
                        </View>
                        <View class="min-w-50 flex-1 gap-3">
                          <Text class="text-sm leading-relaxed text-muted">{t("web.remote.pair.qrHint")}</Text>
                          <View class="gap-1">
                            <Text class="text-xs font-medium text-muted">{t("web.remote.pair.code")}</Text>
                            <View class="self-start rounded-md border border-line bg-page px-3 py-2">
                              <Text testID="remote-pair-code" class="select-text font-mono text-2xl font-semibold tracking-wide tabular-nums text-ink">
                                {p().code}
                              </Text>
                            </View>
                          </View>
                          <View class="flex-row flex-wrap items-center gap-2">
                            <Button icon={copied() ? "check" : "copy"} testID="remote-pair-copy" onPress={onCopyPair}>
                              {copied() ? t("web.remote.pair.copied") : t("web.remote.pair.copy")}
                            </Button>
                            <Text testID="remote-pair-expires" class="text-xs tabular-nums text-muted">
                              {t("web.remote.pair.expires", { time: shortMomentText(p().expiresAt) })}
                            </Text>
                          </View>
                        </View>
                      </View>
                    )}
                  </If>
                </SettingsGroup>
              </If>

              <SettingsGroup title={t("web.remote.devices.title")}>
                <If
                  when={devices().length > 0}
                  else={
                    <View testID="remote-devices-empty" class="flex-row items-center gap-2.5 px-4 py-4">
                      <Icon name="devices" size={16} tone="faint" />
                      <Text class="text-sm text-muted">{t("web.remote.devices.empty")}</Text>
                    </View>
                  }
                >
                  <Each of={devices()}>
                    {(device, index) => (
                      <View
                        testID={`remote-device-${device().id}`}
                        class={`flex-row flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 ${index() === devices().length - 1 ? "" : "border-b border-line"}`}
                      >
                        <View class="min-w-0 flex-1 gap-1">
                          <View class="flex-row items-center gap-2">
                            <Icon name="devices" size={14} tone="muted" />
                            <Text class="min-w-0 truncate text-sm font-medium text-ink">{device().name}</Text>
                            <Tag tone="info" label={platformLabel(device().platform)} />
                          </View>
                          <Text class="text-xs tabular-nums text-muted">
                            {t("web.remote.devices.lastSeen", { time: shortMomentText(device().lastSeenAt ?? device().createdAt) })}
                          </Text>
                        </View>
                        <Button
                          tone="danger"
                          size="compact"
                          icon="delete"
                          testID={`remote-device-revoke-${device().id}`}
                          disabled={act.busy() || revokingId() === device().id}
                          onPress={() => void onRevoke(device().id)}
                        >
                          {t("web.remote.devices.revoke")}
                        </Button>
                      </View>
                    )}
                  </Each>
                </If>
              </SettingsGroup>
            </View>
          );
        }}
      </If>
    </SettingsPage>
  );
}
