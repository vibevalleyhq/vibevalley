import { Clipboard, computed, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { ConnectionSaveRequest, DesktopConnectionSnapshot, RemoteDeviceSummary, RemotePairCode, RemotePlatform, RemoteStatus } from "@vibevalley/protocol";
import { BizCode } from "@vibevalley/protocol/api";

import { Button } from "../../design/Button";
import { SettingRow, SettingsGroup, SettingsPage } from "../../design/domain/settings";
import { Field, TextInput } from "../../design/Field";
import { Icon } from "../../design/Icon";
import type { IconName } from "../../design/icons";
import { Banner, SecretInput } from "../../design/layout";
import { Qr } from "../../design/Qr";
import { Segmented } from "../../design/Segmented";
import { SkeletonLines } from "../../design/Skeleton";
import { Tag } from "../../design/Tag";
import { createAct } from "../../infra/act";
import { api, reasonOf } from "../../infra/api";
import { shortMomentText } from "../../infra/base/format";
import { useTimeout } from "../../infra/base/timer";
import { hostApi } from "../../infra/bridge";
import { onSettled } from "../../infra/solid";

type AuthMethod = "pair" | "token";
type RemoteAccessMode = "lan" | "tailscale";

const DEFAULT_CONNECTION: DesktopConnectionSnapshot = {
  activeMode: "embedded",
  configuredMode: "embedded",
  source: "default",
  restartRequired: false,
};

function ControlPlaneConnectionSection() {
  const conn = signal<DesktopConnectionSnapshot>(DEFAULT_CONNECTION);
  const editing = signal(false);
  const method = signal<AuthMethod>("pair");
  const urlDraft = signal("");
  const codeDraft = signal("");
  const tokenDraft = signal("");
  const labelDraft = signal("");
  const busy = signal(false);
  const errorText = signal<string | undefined>(undefined);

  let alive = true;

  const refreshConnection = async () => {
    const env = await hostApi.connectionState();
    if (!alive) return;
    if (env.bizCode === 0) {
      if (env.data !== undefined) conn.set(env.data);
      return;
    }
    if (env.bizCode !== BizCode.RouteNotFound && env.bizCode !== BizCode.ServiceUnavailable) {
      errorText.set(env.message);
    }
  };

  onSettled(() => {
    void refreshConnection();
    return () => {
      alive = false;
    };
  });

  const openEditor = () => {
    const current = conn();
    urlDraft.set(current.configuredUrl ?? current.activeUrl ?? "");
    labelDraft.set(current.configuredLabel ?? current.activeLabel ?? "");
    codeDraft.set("");
    tokenDraft.set("");
    errorText.set(undefined);
    editing.set(true);
  };

  const canSave = computed(() => {
    if (busy() || urlDraft().trim() === "") return false;
    return method() === "pair" ? codeDraft().trim() !== "" : tokenDraft().trim() !== "";
  });

  const onSave = async () => {
    if (!canSave()) return;
    busy.set(true);
    errorText.set(undefined);
    try {
      const url = urlDraft().trim();
      const trimmedLabel = labelDraft().trim();
      const input: ConnectionSaveRequest =
        method() === "pair"
          ? {
              url,
              pairCode: codeDraft().trim(),
              ...(trimmedLabel !== "" ? { label: trimmedLabel } : {}),
            }
          : {
              url,
              token: tokenDraft().trim(),
              ...(trimmedLabel !== "" ? { label: trimmedLabel } : {}),
            };
      const env = await hostApi.connectionSave(input);
      if (!alive) return;
      if (env.bizCode !== 0) {
        errorText.set(env.message);
        return;
      }
      if (env.data !== undefined) conn.set(env.data);
      codeDraft.set("");
      tokenDraft.set("");
      editing.set(false);
    } finally {
      if (alive) busy.set(false);
    }
  };

  const onReset = async () => {
    if (busy()) return;
    busy.set(true);
    errorText.set(undefined);
    try {
      const env = await hostApi.connectionReset();
      if (!alive) return;
      if (env.bizCode !== 0) {
        errorText.set(env.message);
        return;
      }
      if (env.data !== undefined) conn.set(env.data);
      editing.set(false);
    } finally {
      if (alive) busy.set(false);
    }
  };

  const isRemote = computed(() => conn().activeMode === "remote");
  const hasRemoteConfigured = computed(() => conn().configuredMode === "remote");
  const envLocked = computed(() => conn().source === "env");
  const displayedUrl = computed(() => conn().configuredUrl ?? conn().activeUrl);
  const displayedLabel = computed(() => conn().configuredLabel ?? conn().activeLabel);
  const showTargetDetails = computed(() => displayedUrl() !== undefined || conn().tokenHint !== undefined);

  return (
    <View testID="control-plane-section" class="gap-3">
      <If when={errorText()}>
        {(err) => (
          <Banner tone="bad" role="alert" testID="control-plane-error">
            {err()}
          </Banner>
        )}
      </If>

      <If when={conn().restartRequired}>
        <Banner tone="warn" testID="control-plane-restart">
          {hasRemoteConfigured()
            ? t("web.remote.controlPlane.restartToRemote", { url: conn().configuredUrl ?? "" })
            : t("web.remote.controlPlane.restartToEmbedded")}
        </Banner>
      </If>

      <SettingsGroup title={t("web.remote.controlPlane.title")}>
        <SettingRow
          label={t("web.remote.controlPlane.modeLabel")}
          hint={t("web.remote.controlPlane.subtitle")}
          testid="control-plane-mode-row"
          last={!showTargetDetails() && !editing()}
        >
          <View testID="control-plane-mode-badge">
            <Tag
              icon={isRemote() ? "web" : "runtimes"}
              tone={isRemote() ? "info" : "ok"}
              label={isRemote() ? t("web.remote.controlPlane.mode.remote") : t("web.remote.controlPlane.mode.embedded")}
            />
          </View>
          <If when={envLocked()}>
            <View testID="control-plane-env-badge">
              <Tag icon="terminal" tone="wait" label={t("web.remote.controlPlane.envOverride")} />
            </View>
          </If>
          <If when={!envLocked() && !editing()}>
            <Button tone={hasRemoteConfigured() ? "plain" : "primary"} icon="link" testID="control-plane-configure" disabled={busy()} onPress={openEditor}>
              {hasRemoteConfigured() ? t("web.remote.controlPlane.changeAction") : t("web.remote.controlPlane.switchAction")}
            </Button>
          </If>
          <If when={!envLocked() && (hasRemoteConfigured() || isRemote())}>
            <Button tone="plain" icon="undo" testID="control-plane-reset" disabled={busy()} onPress={() => void onReset()}>
              {t("web.remote.controlPlane.resetAction")}
            </Button>
          </If>
        </SettingRow>

        <If when={showTargetDetails()}>
          <SettingRow label={t("web.remote.controlPlane.urlLabel")} hint={displayedLabel()} testid="control-plane-target-row" last={!editing()}>
            <If when={displayedUrl()}>
              {(url) => (
                <View class="max-w-full flex-row items-center gap-1.5 rounded-sm bg-page px-2 py-0.5">
                  <Icon name="link" size={12} tone="muted" />
                  <Text testID="control-plane-url" class="min-w-0 select-text truncate font-mono text-xs tabular-nums text-ink">
                    {url()}
                  </Text>
                </View>
              )}
            </If>
            <If when={conn().tokenHint}>
              {(hint) => (
                <Text testID="control-plane-token-hint" class="font-mono text-xs text-muted">
                  {t("web.remote.controlPlane.tokenHint", { hint: hint() })}
                </Text>
              )}
            </If>
          </SettingRow>
        </If>

        <If when={editing()}>
          <View testID="control-plane-editor" class="gap-3 px-4 py-4">
            <Field label={t("web.remote.controlPlane.methodLabel")}>
              <Segmented<AuthMethod>
                testid="control-plane-method"
                label={t("web.remote.controlPlane.methodLabel")}
                value={method()}
                onChange={(v) => method.set(v)}
                options={[
                  { value: "pair", label: t("web.remote.controlPlane.method.pair"), icon: "devices" },
                  { value: "token", label: t("web.remote.controlPlane.method.token"), icon: "lock" },
                ]}
              />
            </Field>

            <Field label={t("web.remote.controlPlane.urlLabel")}>
              <TextInput
                testID="control-plane-url-input"
                accessibilityLabel={t("web.remote.controlPlane.urlLabel")}
                placeholder={t("web.remote.controlPlane.urlPlaceholder")}
                value={urlDraft()}
                disabled={busy()}
                onInput={(v) => urlDraft.set(v)}
              />
            </Field>

            <If
              when={method() === "pair"}
              else={
                <Field label={t("web.remote.controlPlane.tokenLabel")}>
                  <SecretInput
                    testID="control-plane-token-input"
                    accessibilityLabel={t("web.remote.controlPlane.tokenLabel")}
                    placeholder={t("web.remote.controlPlane.tokenPlaceholder")}
                    value={tokenDraft()}
                    disabled={busy()}
                    onInput={(v) => tokenDraft.set(v)}
                  />
                </Field>
              }
            >
              <Field label={t("web.remote.controlPlane.codeLabel")}>
                <TextInput
                  testID="control-plane-code-input"
                  accessibilityLabel={t("web.remote.controlPlane.codeLabel")}
                  placeholder={t("web.remote.controlPlane.codePlaceholder")}
                  value={codeDraft()}
                  disabled={busy()}
                  onInput={(v) => codeDraft.set(v)}
                />
              </Field>
            </If>

            <Field label={t("web.remote.controlPlane.labelField")}>
              <TextInput
                testID="control-plane-label-input"
                accessibilityLabel={t("web.remote.controlPlane.labelField")}
                placeholder={t("web.remote.controlPlane.labelPlaceholder")}
                value={labelDraft()}
                disabled={busy()}
                onInput={(v) => labelDraft.set(v)}
              />
            </Field>

            <View class="flex-row items-center gap-2 pt-1">
              <Button tone="primary" icon="check" testID="control-plane-save" disabled={!canSave()} onPress={() => void onSave()}>
                {t("web.remote.controlPlane.save")}
              </Button>
              <Button
                tone="plain"
                testID="control-plane-cancel"
                disabled={busy()}
                onPress={() => {
                  errorText.set(undefined);
                  editing.set(false);
                }}
              >
                {t("web.remote.controlPlane.cancel")}
              </Button>
            </View>
          </View>
        </If>
      </SettingsGroup>
    </View>
  );
}

function platformLabel(platform: RemotePlatform): string {
  switch (platform) {
    case "ios":
      return t("web.remote.devices.platform.ios");
    case "android":
      return t("web.remote.devices.platform.android");
    case "cli":
      return t("web.remote.devices.platform.cli");
    case "machine":
      return t("web.remote.devices.platform.machine");
    case "sandbox":
      return t("web.remote.devices.platform.sandbox");
    case "other":
      return t("web.remote.devices.platform.other");
  }
}

function platformIcon(platform: RemotePlatform): IconName {
  switch (platform) {
    case "ios":
    case "android":
      return "devices";
    case "cli":
      return "terminal";
    case "machine":
      return "runtimes";
    case "sandbox":
      return "lock";
    case "other":
      return "devices";
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
  const preferredMode = signal<RemoteAccessMode | undefined>(undefined);
  const resetCopied = useTimeout();
  const act = createAct((reason) => actionError.set(reason));

  const activeMode = computed((): RemoteAccessMode => {
    const current = status();
    const bind = current?.bindAddr;
    if (bind !== undefined) {
      if (bind === current?.lanIp) return "lan";
      if (bind === current?.tailscaleIp) return "tailscale";
    }
    const pref = preferredMode();
    if (pref !== undefined) return pref;
    return current?.tailscaleOnline === true ? "tailscale" : "lan";
  });

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
    const current = status();
    const pref = preferredMode();
    const bindAddr = pref === "lan" ? current?.lanIp : pref === "tailscale" && current?.tailscaleOnline === true ? current.tailscaleIp : undefined;
    const next = await act.run(() => api.remote.enable(bindAddr !== undefined ? { bindAddr } : {}));
    if (!alive || !next) return;
    loadSeq++;
    status.set(next);
  };

  const onSelectMode = async (mode: RemoteAccessMode) => {
    preferredMode.set(mode);
    const current = status();
    if (current?.enabled !== true) return;
    const targetIp = mode === "lan" ? current.lanIp : current.tailscaleOnline ? current.tailscaleIp : undefined;
    if (targetIp === undefined || (current.listening && current.bindAddr === targetIp)) return;
    actionError.set(undefined);
    const next = await act.run(() => api.remote.enable({ bindAddr: targetIp }));
    if (!alive || !next) return;
    loadSeq++;
    status.set(next);
    pair.set(undefined);
    copied.set(false);
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
      <ControlPlaneConnectionSection />

      <If
        when={status()}
        else={
          <If
            when={loadError()}
            else={
              <SettingsGroup testid="remote-loading" title={t("web.setting.remote.toggleLabel")}>
                <View class="gap-3 px-4 py-4">
                  <SkeletonLines rows={["38%", "68%", "52%"]} gap="md" accessibilityLabel={t("web.base.form.asking")} />
                </View>
              </SettingsGroup>
            }
          >
            {(err) => (
              <Banner tone="bad" role="alert" testID="remote-load-error">
                {t("web.base.form.unreachable", { why: err() })}
              </Banner>
            )}
          </If>
        }
      >
        {(s) => {
          const liveUrl = () => (s().listening ? s().url : undefined);
          const devices = computed(() => activeDevicesOf(s()));
          const hasBothModes = () => s().lanIp !== undefined && s().tailscaleOnline && s().tailscaleIp !== undefined;
          const lanActive = () => s().listening && s().lanIp !== undefined && s().bindAddr === s().lanIp;
          const tailscaleHint = () => s().tailscaleHost ?? t("web.remote.tailscale.optionalHint");
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
                <SettingRow label={t("web.setting.remote.toggleLabel")} hint={t("web.setting.remote.toggleHint")} testid="remote-toggle-row">
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

                <If when={hasBothModes()}>
                  <SettingRow
                    label={t("web.remote.mode.label")}
                    hint={activeMode() === "lan" ? t("web.remote.mode.lanHint") : t("web.remote.mode.tailscaleHint")}
                    testid="remote-mode-row"
                  >
                    <Segmented<RemoteAccessMode>
                      testid="remote-mode-switch"
                      label={t("web.remote.mode.label")}
                      value={activeMode()}
                      onChange={(v) => void onSelectMode(v)}
                      options={[
                        { value: "lan", label: t("web.remote.mode.lan"), icon: "web", disabled: act.busy() },
                        { value: "tailscale", label: t("web.remote.mode.tailscale"), icon: "link", disabled: act.busy() },
                      ]}
                    />
                  </SettingRow>
                </If>

                <SettingRow label={t("web.remote.lan.label")} hint={t("web.remote.lan.hint")} testid="remote-lan-row">
                  <View testID="remote-lan-badge">
                    <Tag
                      icon={s().lanIp !== undefined ? "check" : "wait"}
                      tone={s().lanIp !== undefined ? (lanActive() ? "ok" : "info") : "neutral"}
                      label={s().lanIp !== undefined ? (lanActive() ? t("web.remote.lan.active") : t("web.remote.lan.ready")) : t("web.remote.lan.unavailable")}
                    />
                  </View>
                  <If when={s().lanIp}>
                    {(ip) => (
                      <View testID="remote-lan-ip" class="rounded-sm bg-page px-2 py-0.5">
                        <Text class="select-text font-mono text-xs tabular-nums text-ink">{ip()}</Text>
                      </View>
                    )}
                  </If>
                </SettingRow>

                <SettingRow label={t("web.remote.tailscale.ip")} hint={tailscaleHint()} testid="remote-tailscale-row" last={!liveUrl()}>
                  <View testID="remote-tailscale-badge">
                    <Tag
                      icon={s().tailscaleOnline ? "check" : "info"}
                      tone={s().tailscaleOnline ? "ok" : "neutral"}
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
                  <Each of={devices()} key={(d) => d.id}>
                    {(device, index) => (
                      <View
                        testID={`remote-device-${device().id}`}
                        class={`flex-row flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 ${index() === devices().length - 1 ? "" : "border-b border-line"}`}
                      >
                        <View class="min-w-0 flex-1 gap-1">
                          <View class="flex-row items-center gap-2">
                            <Icon name={platformIcon(device().platform)} size={14} tone="muted" />
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
