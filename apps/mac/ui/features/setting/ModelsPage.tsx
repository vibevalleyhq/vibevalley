import { computed, signal, Text, untracked, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { ProviderBinding, ProviderScene, ProviderScenePolicy, ProviderStatus, ProviderUpdate } from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";

import { createAct } from "../../design/act";
import { Button, ButtonLink } from "../../design/Button";
import { SettingRow, SettingsGroup, SettingsPage } from "../../design/domain/settings";
import { Select } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { IconButton } from "../../design/IconButton";
import { SaveBar } from "../../design/KeyField";
import { Quiet } from "../../design/layout";
import { Tag } from "../../design/Tag";
import { TextLink } from "../../design/TextLink";
import { toast } from "../../design/toasts";
import { api, reasonOf } from "../../infra/api";
import { providerQuery, ready, settingsQuery, useQuery, useQueryClient } from "../../infra/query";
import { Link } from "../../infra/router";
import { useVdpNode } from "../../infra/vdpProbe";
import {
  discoveredModelsForCapability,
  editableProviderUpdate,
  encodeBindingValue,
  parseBindingValue,
  requiredCapabilityForScene,
  totalDiscoveredModelCount,
  vendorMeta,
} from "../provider";
import { SettingsReadiness } from "./SettingsReadiness";

type SceneHint = "orchestratorHint" | "polishHint" | "transcriptionHint" | "speechNotice" | "liveHint" | "understandingNotice" | "imageNotice";

const SCENE_GROUPS: readonly {
  readonly title: "groupChat" | "groupVoice" | "groupLive" | "groupImage";
  readonly scenes: readonly { readonly scene: ProviderScene; readonly hint?: SceneHint }[];
}[] = [
  {
    title: "groupChat",
    scenes: [
      { scene: "orchestrator", hint: "orchestratorHint" },
      { scene: "polish", hint: "polishHint" },
    ],
  },
  {
    title: "groupVoice",
    scenes: [{ scene: "transcription", hint: "transcriptionHint" }, { scene: "speech", hint: "speechNotice" }, { scene: "speakers" }, { scene: "voiceDesign" }],
  },
  {
    title: "groupLive",
    scenes: [{ scene: "live", hint: "liveHint" }, { scene: "vision" }],
  },
  {
    title: "groupImage",
    scenes: [
      { scene: "understanding", hint: "understandingNotice" },
      { scene: "image", hint: "imageNotice" },
    ],
  },
];

export function ModelsPage() {
  useVdpNode({ testId: "settings-models-page", role: "region" });
  const query = useQuery(providerQuery);
  return (
    <SettingsPage
      title={t("web.setting.nav.models")}
      description={t("web.setting.models.intro")}
      action={<TextLink href="/settings/providers">{t("web.provider.manageProviders")}</TextLink>}
    >
      <SettingsReadiness features={["orchestrator", "call"]} selfHref="/settings/models" />
      <If when={ready(query, undefined)} else={<Quiet>{query.error() ? reasonOf(query.error()) : t("web.base.form.asking")}</Quiet>}>
        {(status) => <ModelsPolicyForm initial={untracked(status)} />}
      </If>
    </SettingsPage>
  );
}

function ModelsPolicyForm(props: { initial: ProviderStatus }) {
  const start = untracked(() => props.initial);
  const base = signal(start);
  const draft = signal<ProviderUpdate>(editableProviderUpdate(start));
  const openFallback = signal<Record<string, boolean>>({});
  const error = signal<string | undefined>(undefined);
  const client = useQueryClient();
  const act = createAct((why) => error.set(why));

  const dirty = computed(() => !same(draft(), editableProviderUpdate(base())));
  const discoveredTotal = computed(() => totalDiscoveredModelCount(base()));

  const accept = (status: ProviderStatus) => {
    base.set(status);
    draft.set(editableProviderUpdate(status));
    error.set(undefined);
    client.setData(providerQuery(), () => ({ value: status }));
  };

  const setSceneBinding = (scene: ProviderScene, raw: string) => {
    const binding = parseBindingValue(raw);
    const current = draft();
    const nextPolicies = binding ? current.scenePolicies : current.scenePolicies.filter((p) => p.scene !== scene);
    draft.set({ ...current, [scene]: binding, scenePolicies: nextPolicies });
    error.set(undefined);
  };

  const fallbacksFor = (scene: ProviderScene): readonly ProviderBinding[] => draft().scenePolicies.find((p) => p.scene === scene)?.fallbacks ?? [];

  const setFallbacks = (scene: ProviderScene, nextFallbacks: readonly ProviderBinding[]) => {
    const current = draft();
    const rest: ProviderScenePolicy[] = current.scenePolicies.filter((p) => p.scene !== scene);
    const nextPolicies = nextFallbacks.length > 0 ? [...rest, { scene, fallbacks: [...nextFallbacks] }] : rest;
    draft.set({ ...current, scenePolicies: nextPolicies });
    error.set(undefined);
  };

  const addFallback = (scene: ProviderScene, raw: string) => {
    const parsed = parseBindingValue(raw);
    if (!parsed) return;
    const list = fallbacksFor(scene);
    if (list.some((f) => f.connection === parsed.connection && f.model === parsed.model)) return;
    setFallbacks(scene, [...list, parsed]);
  };

  const moveFallback = (scene: ProviderScene, index: number, delta: -1 | 1) => {
    const list = [...fallbacksFor(scene)];
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    const [item] = list.splice(index, 1);
    if (item !== undefined) list.splice(target, 0, item);
    setFallbacks(scene, list);
  };

  const removeFallback = (scene: ProviderScene, index: number) => {
    setFallbacks(
      scene,
      fallbacksFor(scene).filter((_, i) => i !== index),
    );
  };

  const save = () => {
    const input = draft();
    return act.run(async () => {
      const next = await api.provider.update(input);
      accept(next);
      await client.invalidate({ key: settingsQuery().key });
      toast(t("web.setting.keys.saved"));
    });
  };

  const optionsForScene = (scene: ProviderScene) => {
    const cap = requiredCapabilityForScene(scene);
    const discovered = discoveredModelsForCapability(base(), cap);
    const options = discovered.map((item) => ({
      value: item.value,
      label: item.model,
      group: item.providerName,
    }));
    const currentBinding = draft()[scene] ?? undefined;
    if (currentBinding) {
      const encoded = encodeBindingValue(currentBinding);
      if (!options.some((o) => o.value === encoded)) {
        const conn = base().connections.find((c) => c.id === currentBinding.connection);
        const groupName = conn ? conn.name || vendorMeta(conn.adapter).name : currentBinding.connection;
        options.push({
          value: encoded,
          label: `${currentBinding.model} (${t("web.provider.unverifiedModelTag")})`,
          group: groupName,
        });
      }
    }
    return options;
  };

  return (
    <View testID="models-policy-form" class="gap-5">
      <If when={discoveredTotal() === 0}>
        <SettingsGroup testid="models-empty-cta">
          <SettingRow icon="plug" label={t("web.setting.nav.providers")} hint={t("web.provider.empty")} last>
            <ButtonLink href="/settings/providers" tone="primary" icon="key" testID="models-go-providers">
              {t("web.provider.emptyCta")}
            </ButtonLink>
          </SettingRow>
        </SettingsGroup>
      </If>

      <Each of={SCENE_GROUPS} key={(g) => g.title}>
        {(group) => (
          <SettingsGroup title={t(`web.provider.${group().title}`)}>
            <Each of={group().scenes} key={(entry) => entry.scene}>
              {(entry, idx) => {
                const scene = () => entry().scene;
                const label = () => t(`web.provider.use.${scene()}`);
                const hintText = () => {
                  const h = entry().hint;
                  return h ? t(`web.provider.${h}`) : undefined;
                };
                const cap = () => requiredCapabilityForScene(scene());
                const capLabel = () => t(`web.provider.capability.${cap()}`);
                const sceneOptions = () => optionsForScene(scene());
                const selected = () => encodeBindingValue(draft()[scene()] ?? undefined);
                const fbs = () => fallbacksFor(scene());
                const fbExpanded = () => (openFallback()[scene()] ?? false) || fbs().length > 0;
                const remainingFallbacks = () =>
                  discoveredModelsForCapability(base(), cap())
                    .filter((opt) => opt.value !== selected() && !fbs().some((f) => encodeBindingValue(f) === opt.value))
                    .map((opt) => ({ value: opt.value, label: opt.model, group: opt.providerName }));
                const isLastRow = () => idx() === group().scenes.length - 1;

                return (
                  <View testID={`scene-row-${scene()}`} class={isLastRow() ? "" : "border-b border-line"}>
                    <SettingRow label={label()} hint={hintText()} tip={capLabel()} last>
                      <Tag label={capLabel()} tone="neutral" />
                      <If when={scene() === "speech"}>
                        <Link
                          href="/library?make=speech"
                          testID="provider-speech-open"
                          class="rounded-sm px-1.5 py-0.5 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
                        >
                          <Text class="text-xs font-medium text-water underline">{t("web.provider.openSpeechShort")}</Text>
                        </Link>
                      </If>
                      <View class="w-60 max-w-full">
                        <Select
                          testid={`scene-select-${scene()}`}
                          label={t("web.provider.modelFor", { use: label() })}
                          placeholder={sceneOptions().length === 0 ? t("web.provider.emptyScene", { capability: capLabel() }) : t("web.provider.unbound")}
                          disabled={act.busy() || (sceneOptions().length === 0 && !selected())}
                          value={selected()}
                          options={sceneOptions()}
                          onChange={(val) => setSceneBinding(scene(), val)}
                        />
                      </View>
                      <If when={Boolean(selected())}>
                        <Button
                          size="compact"
                          tone="quiet"
                          testID={`scene-fallback-toggle-${scene()}`}
                          onPress={() => openFallback.set({ ...openFallback(), [scene()]: !fbExpanded() })}
                        >
                          {fbs().length > 0 ? `${t("web.provider.fallbackTitle")} (${fbs().length})` : t("web.provider.addFallback")}
                        </Button>
                      </If>
                    </SettingRow>

                    <If when={Boolean(selected()) && fbExpanded()}>
                      <View testID={`scene-fallbacks-${scene()}`} class="gap-2 border-t border-line bg-side px-4 py-2.5">
                        <View class="flex-row items-center justify-between gap-2">
                          <Text class="text-xs font-medium text-muted">{t("web.provider.fallbackTitle")}</Text>
                          <If when={remainingFallbacks().length > 0}>
                            <View class="w-56 max-w-full">
                              <Select
                                size="control"
                                text="xs"
                                testid={`scene-fallback-add-${scene()}`}
                                label={t("web.provider.addFallback")}
                                placeholder={t("web.provider.fallbackSelect")}
                                disabled={act.busy()}
                                value=""
                                options={remainingFallbacks()}
                                onChange={(val) => addFallback(scene(), val)}
                              />
                            </View>
                          </If>
                        </View>
                        <If when={fbs().length > 0} else={<Quiet>{t("web.provider.fallbackEmpty")}</Quiet>}>
                          <View class="gap-1">
                            <Each of={fbs()} key={(f) => encodeBindingValue(f)}>
                              {(fb, fbIdx) => (
                                <View
                                  testID={`scene-fallback-item-${scene()}-${fbIdx()}`}
                                  class="flex-row items-center justify-between gap-2 rounded-md bg-page px-2.5 py-1.5"
                                >
                                  <Text class="font-mono text-xs text-ink">{`${fbIdx() + 1}. ${fb().model} · ${fb().connection}`}</Text>
                                  <View class="flex-row items-center gap-1">
                                    <IconButton
                                      icon="moveUp"
                                      size={12}
                                      label={t("web.provider.moveFallbackUp")}
                                      disabled={act.busy() || fbIdx() === 0}
                                      onClick={() => moveFallback(scene(), fbIdx(), -1)}
                                    />
                                    <IconButton
                                      icon="moveDown"
                                      size={12}
                                      label={t("web.provider.moveFallbackDown")}
                                      disabled={act.busy() || fbIdx() === fbs().length - 1}
                                      onClick={() => moveFallback(scene(), fbIdx(), 1)}
                                    />
                                    <IconButton
                                      icon="delete"
                                      size={12}
                                      tone="danger"
                                      label={t("web.provider.removeFallback")}
                                      disabled={act.busy()}
                                      onClick={() => removeFallback(scene(), fbIdx())}
                                    />
                                  </View>
                                </View>
                              )}
                            </Each>
                          </View>
                        </If>
                      </View>
                    </If>
                  </View>
                );
              }}
            </Each>
          </SettingsGroup>
        )}
      </Each>

      <SaveBar
        dirty={dirty()}
        busy={act.busy()}
        onSave={() => void save()}
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
