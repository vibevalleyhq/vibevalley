import { computed, signal, Text, untracked, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type {
  ModelCapability,
  ProviderConnection,
  ProviderConnectionAdapter,
  ProviderConnectionUpdate,
  ProviderStatus,
  ProviderUpdate,
} from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";

import { Button } from "../../design/Button";
import { KeyRow, SettingRow, SettingsGroup, SettingsPage } from "../../design/domain/settings";
import { TextInput } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { IconButton } from "../../design/IconButton";
import { SaveBar } from "../../design/KeyField";
import { Banner, Toggle } from "../../design/layout";
import { SkeletonLines } from "../../design/Skeleton";
import { Tag, type TagTone } from "../../design/Tag";
import { TextLink } from "../../design/TextLink";
import { toast } from "../../design/toasts";
import { createAct } from "../../infra/act";
import { api, reasonOf } from "../../infra/api";
import { providerQuery, ready, settingsQuery, useQuery, useQueryClient } from "../../infra/query";
import { useVdpNode } from "../../infra/vdpProbe";
import { editableProviderUpdate, PROVIDER_CATALOG, type ProviderVendorMeta } from "../provider";
import { SettingsReadiness } from "./SettingsReadiness";

const CAP_TONES: Record<ModelCapability, TagTone> = {
  chat: "info",
  asr: "ok",
  tts: "ok",
  realtime: "wait",
  vision: "info",
  image: "neutral",
};

function connectionNote(saved: ProviderConnection | undefined): string {
  if (!saved || saved.key.source === null) return t("web.provider.notConfiguredBadge");
  if (saved.verification?.status === "verified") {
    return t("web.provider.verifiedBadge", { n: saved.models.length });
  }
  if (saved.verification?.status === "failed") {
    return t("web.provider.failedBadge");
  }
  if (saved.key.source === "config") {
    return t("web.provider.fromConfigBadge");
  }
  return t("web.provider.unverifiedBadge");
}

function defaultConnectionDraft(vendor: ProviderVendorMeta): ProviderConnectionUpdate {
  return {
    id: vendor.id,
    name: vendor.name,
    adapter: vendor.adapter,
    enabled: true,
  };
}

export function ModelProvidersPage() {
  useVdpNode({ testId: "settings-providers-page", role: "region" });
  const query = useQuery(providerQuery);
  return (
    <SettingsPage
      title={t("web.setting.nav.providers")}
      description={t("web.setting.providers.intro")}
      action={<TextLink href="/settings/models">{t("web.setting.nav.models")}</TextLink>}
    >
      <SettingsReadiness features={["orchestrator", "call"]} selfHref="/settings/providers" />
      <If
        when={ready(query, undefined)}
        else={
          <If
            when={query.error()}
            else={
              <SettingsGroup testid="providers-loading">
                <View class="gap-3 px-4 py-4">
                  <SkeletonLines rows={["36%", "70%", "54%"]} gap="md" accessibilityLabel={t("web.base.form.asking")} />
                </View>
              </SettingsGroup>
            }
          >
            {(err) => (
              <Banner tone="bad" role="alert">
                {reasonOf(err())}
              </Banner>
            )}
          </If>
        }
      >
        {(status) => <ProvidersForm initial={untracked(status)} />}
      </If>
    </SettingsPage>
  );
}

function ProvidersForm(props: { initial: ProviderStatus }) {
  const start = untracked(() => props.initial);
  const base = signal(start);
  const draft = signal<ProviderUpdate>(editableProviderUpdate(start));
  const verifying = signal<ProviderConnectionAdapter | undefined>(undefined);
  const baseUrlOpen = signal<Record<string, boolean>>({});
  const error = signal<string | undefined>(undefined);
  const client = useQueryClient();
  const act = createAct((why) => error.set(why));

  const dirty = computed(() => !same(draft(), editableProviderUpdate(base())));

  const accept = (status: ProviderStatus) => {
    base.set(status);
    draft.set(editableProviderUpdate(status));
    error.set(undefined);
    client.setData(providerQuery(), () => ({ value: status }));
  };

  const savedFor = (adapter: ProviderConnectionAdapter) => base().connections.find((c) => c.adapter === adapter);
  const draftFor = (adapter: ProviderConnectionAdapter) => draft().connections.find((c) => c.adapter === adapter);

  const upsertDraft = (vendor: ProviderVendorMeta, patch: Partial<ProviderConnectionUpdate>) => {
    const current = draft();
    const existing = current.connections.find((c) => c.adapter === vendor.adapter);
    const nextConn = existing ? { ...existing, ...patch } : { ...defaultConnectionDraft(vendor), ...patch };
    const connections = existing ? current.connections.map((c) => (c.adapter === vendor.adapter ? nextConn : c)) : [...current.connections, nextConn];
    draft.set({ ...current, connections });
    error.set(undefined);
  };

  const keepKey = (vendor: ProviderVendorMeta) => {
    const current = draft();
    const existing = current.connections.find((c) => c.adapter === vendor.adapter);
    if (!existing) return;
    const { key: _key, ...rest } = existing;
    const saved = savedFor(vendor.adapter);
    // Remove newly added empty entry if it was never persisted.
    const connections =
      !saved && rest.baseUrl === undefined
        ? current.connections.filter((c) => c.adapter !== vendor.adapter)
        : current.connections.map((c) => (c.adapter === vendor.adapter ? rest : c));
    draft.set({ ...current, connections });
    error.set(undefined);
  };

  const setBaseUrl = (vendor: ProviderVendorMeta, raw: string) => {
    const trimmed = raw.trim();
    const current = draft();
    const existing = current.connections.find((c) => c.adapter === vendor.adapter);
    const saved = savedFor(vendor.adapter);
    if (!trimmed) {
      if (saved?.baseUrl !== undefined) {
        upsertDraft(vendor, { baseUrl: null });
      } else if (existing) {
        const { baseUrl: _baseUrl, ...rest } = existing;
        draft.set({
          ...current,
          connections: current.connections.map((c) => (c.adapter === vendor.adapter ? rest : c)),
        });
      }
      return;
    }
    upsertDraft(vendor, { baseUrl: trimmed });
  };

  const persistAndAutoVerify = async (targetAdapters: readonly ProviderConnectionAdapter[]) => {
    const saved = await api.provider.update(draft());
    accept(saved);
    let latest = saved;
    for (const adapter of targetAdapters) {
      const conn = latest.connections.find((c) => c.adapter === adapter);
      if (!conn || !conn.enabled || conn.key.source === null) continue;
      verifying.set(adapter);
      try {
        latest = await api.provider.verify({ connection: conn.id, revision: latest.revision });
        accept(latest);
      } finally {
        verifying.set(undefined);
      }
    }
    await client.invalidate({ key: settingsQuery().key });
    return latest;
  };

  const saveAll = () => {
    const changedKeys = draft()
      .connections.filter((c) => typeof c.key === "string" && c.key.trim() !== "")
      .map((c) => c.adapter);
    return act.run(async () => {
      await persistAndAutoVerify(changedKeys);
      toast(t("web.setting.keys.saved"));
    });
  };

  const saveAndVerifyOne = (vendor: ProviderVendorMeta) => {
    const entry = draftFor(vendor.adapter);
    const saved = savedFor(vendor.adapter);
    const hasPendingChange = Boolean(entry && (typeof entry.key === "string" || entry.baseUrl !== saved?.baseUrl || !saved));
    return act.run(async () => {
      if (dirty() || hasPendingChange) {
        await persistAndAutoVerify([vendor.adapter]);
      } else if (saved) {
        verifying.set(vendor.adapter);
        try {
          const verified = await api.provider.verify({ connection: saved.id, revision: base().revision });
          accept(verified);
          await client.invalidate({ key: settingsQuery().key });
        } finally {
          verifying.set(undefined);
        }
      }
    });
  };

  return (
    <View testID="model-providers-form" class="gap-5">
      <Each of={PROVIDER_CATALOG} key={(v) => v.adapter}>
        {(vendor) => {
          const saved = () => savedFor(vendor().adapter);
          const entry = () => draftFor(vendor().adapter);
          const isVerifying = () => verifying() === vendor().adapter;
          const isKeyRemoving = () => entry()?.key === null;
          const hasDraftKey = () => typeof entry()?.key === "string" && entry()!.key!.trim() !== "";
          const hasSavedKey = () => saved()?.key.source !== null && saved()?.key.source !== undefined;
          const canVerify = () => !act.busy() && (hasDraftKey() || (hasSavedKey() && !isKeyRemoving() && entry()?.enabled !== false));
          const showBaseUrl = () => (baseUrlOpen()[vendor().id] ?? false) || Boolean(entry()?.baseUrl ?? saved()?.baseUrl);
          const verifyLabel = () =>
            isVerifying() ? t("web.provider.verifying") : hasDraftKey() ? t("web.provider.saveAndVerify") : t("web.provider.discover");
          const models = () => saved()?.models ?? [];
          const verification = () => saved()?.verification;
          const hasRowsAfterKey = () => showBaseUrl() || verification()?.status === "failed" || models().length > 0;

          return (
            <SettingsGroup
              testid={`provider-card-${vendor().adapter}`}
              title={vendor().name}
              note={connectionNote(saved())}
              action={
                <View class="flex-row items-center gap-1.5">
                  <If when={saved() ?? entry()}>
                    <Toggle
                      label={t("web.provider.enabled")}
                      testid={`provider-enabled-${vendor().adapter}`}
                      checked={entry()?.enabled ?? saved()?.enabled ?? true}
                      disabled={act.busy()}
                      onChange={(enabled) => upsertDraft(vendor(), { enabled })}
                    />
                  </If>
                  <IconButton
                    icon="settings"
                    size={12}
                    testid={`provider-baseurl-toggle-${vendor().adapter}`}
                    label={t("web.provider.baseUrlToggle")}
                    pressed={showBaseUrl()}
                    onClick={() => baseUrlOpen.set({ ...baseUrlOpen(), [vendor().id]: !showBaseUrl() })}
                  />
                </View>
              }
            >
              <KeyRow
                testid={`provider-key-${vendor().adapter}`}
                label="API Key"
                hint={t(`web.provider.vendorHint.${vendor().adapter}`)}
                status={saved()?.key ?? { source: null }}
                value={typeof entry()?.key === "string" ? entry()!.key! : ""}
                onInput={(val) => (val ? upsertDraft(vendor(), { enabled: true, key: val }) : keepKey(vendor()))}
                removing={isKeyRemoving()}
                onRemove={(remove) => (remove ? upsertDraft(vendor(), { key: null }) : keepKey(vendor()))}
                placeholder={vendor().keyPlaceholder}
                link={{ href: vendor().consoleUrl, label: vendor().consoleLabel }}
                after={
                  <Button
                    size="compact"
                    testID={`provider-verify-${vendor().adapter}`}
                    icon="refresh"
                    disabled={!canVerify()}
                    onPress={() => void saveAndVerifyOne(vendor())}
                  >
                    {verifyLabel()}
                  </Button>
                }
                last={!hasRowsAfterKey()}
              />

              <If when={showBaseUrl()}>
                <SettingRow
                  testid={`provider-baseurl-${vendor().adapter}`}
                  label={t("web.provider.baseUrl")}
                  last={verification()?.status !== "failed" && models().length === 0}
                >
                  <View class="w-72 max-w-full">
                    <TextInput
                      testID={`provider-baseurl-input-${vendor().adapter}`}
                      accessibilityLabel={t("web.provider.baseUrl")}
                      class="font-mono"
                      placeholder={t("web.provider.baseUrlPlaceholder", { url: vendor().defaultBaseUrl })}
                      value={typeof entry()?.baseUrl === "string" ? entry()!.baseUrl! : entry()?.baseUrl === null ? "" : (saved()?.baseUrl ?? "")}
                      disabled={act.busy()}
                      onInput={(v) => setBaseUrl(vendor(), v)}
                    />
                  </View>
                </SettingRow>
              </If>

              <If when={verification()?.status === "failed" && verification()?.error ? verification() : undefined}>
                {(v) => (
                  <SettingRow testid={`provider-verify-error-${vendor().adapter}`} label={t("web.provider.failedBadge")} last={models().length === 0}>
                    <View class="flex-row items-center gap-1.5 rounded-md bg-bad-soft px-2.5 py-1">
                      <Icon name="warn" size={12} tone="berry" />
                      <Text class="text-xs font-medium text-berry">{v().error ?? ""}</Text>
                    </View>
                  </SettingRow>
                )}
              </If>

              <If when={models().length > 0}>
                <SettingRow testid={`provider-models-${vendor().adapter}`} label={t("web.provider.discoveredModels", { n: models().length })} wide last>
                  <View class="w-full flex-row flex-wrap gap-1.5">
                    <Each of={models()} key={(m) => m.id}>
                      {(model) => (
                        <View testID={`provider-model-chip-${model().id}`} class="flex-row items-center gap-1.5 rounded-md bg-side px-2 py-1">
                          <Text class="font-mono text-xs text-ink">{model().id}</Text>
                          <Each of={model().capabilities} key={(c) => c}>
                            {(cap) => <Tag label={t(`web.provider.capability.${cap()}`)} tone={CAP_TONES[cap()]} />}
                          </Each>
                        </View>
                      )}
                    </Each>
                  </View>
                </SettingRow>
              </If>
            </SettingsGroup>
          );
        }}
      </Each>

      <SaveBar
        dirty={dirty()}
        busy={act.busy()}
        onSave={() => void saveAll()}
        onUndo={() => accept(base())}
        left={
          <If when={error()}>
            {(why) => (
              <View class="flex-row items-center gap-1.5 self-start rounded-md bg-bad-soft px-2.5 py-1">
                <Icon name="cross" size={12} />
                <Text testID="provider-error" role="alert" class="min-w-0 text-xs font-medium text-berry">
                  {why()}
                </Text>
              </View>
            )}
          </If>
        }
      />
    </View>
  );
}
