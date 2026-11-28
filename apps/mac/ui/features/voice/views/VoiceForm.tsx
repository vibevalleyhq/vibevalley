import { computed, signal, Text, untracked, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { ProviderConnectionUpdate, ProviderStatus, SettingsStatus, SettingsUpdate, VoiceSettings } from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";

import { Button } from "../../../design/Button";
import { KeyRow, SettingRow, SettingsGroup } from "../../../design/domain/settings";
import { Select, TextArea, TextInput } from "../../../design/Field";
import { Icon } from "../../../design/Icon";
import { SaveBar } from "../../../design/KeyField";
import { Quiet } from "../../../design/layout";
import { TextLink } from "../../../design/TextLink";
import { toast } from "../../../design/toasts";
import { createAct } from "../../../infra/act";
import { api, reasonOf } from "../../../infra/api";
import { createSettled, Keyed } from "../../../infra/base/dom";
import { defineQuery, providerQuery, providerVoicesQuery, ready, settingsQuery, useQuery, useQueryClient, useSettings } from "../../../infra/query";
import { Link as A } from "../../../infra/router";
import { useSaveSettings } from "../../../infra/settings";
import { discoveredModelsForConnection, editableProviderUpdate } from "../../provider";
import { NativeCall } from "./NativeCall";

type VoicePart = "line" | "agent";
type VoiceUse = "live" | "speech" | "transcription";

const sameVoice = (a: VoiceSettings, b: VoiceSettings) => same(a, b);

export function VoiceForm(props: { part: VoicePart }) {
  const settings = useSettings();
  return (
    <If
      when={props.part !== "line"}
      else={
        <View testID="voice-moss" class="min-h-0 gap-6">
          <NativeCall />
          <VoiceConfigSection />
        </View>
      }
    >
      <If
        when={ready(settings, undefined)}
        else={<Quiet>{settings.error() ? t("web.voice.voice.noSettings", { why: reasonOf(settings.error()) }) : t("web.base.form.asking")}</Quiet>}
      >
        {(status) => <Keyed key={status().file}>{() => <AgentVoiceForm status={untracked(status)} />}</Keyed>}
      </If>
    </If>
  );
}

function VoiceConfigSection() {
  const providers = useQuery(providerQuery);
  return (
    <If when={ready(providers, undefined)} else={<Quiet>{providers.error() ? reasonOf(providers.error()) : t("web.base.form.asking")}</Quiet>}>
      {(status) => <VoiceConfigForm initial={untracked(status)} />}
    </If>
  );
}

function VoiceConfigForm(props: { initial: ProviderStatus }) {
  const client = useQueryClient();
  const base = signal(untracked(() => props.initial));
  const draft = signal(untracked(() => editableProviderUpdate(props.initial)));
  const selectedId = signal<string | undefined>(undefined);
  const error = signal<string | undefined>(undefined);
  const act = createAct((why) => error.set(why));

  const dirty = computed(() => !same(draft(), editableProviderUpdate(base())));
  const activeConnectionId = computed(() => {
    const list = draft().connections;
    if (list.length === 0) return undefined;
    const picked = selectedId();
    if (picked && list.some((c) => c.id === picked)) return picked;
    const liveConn = draft().live?.connection ?? draft().speech?.connection ?? draft().transcription?.connection;
    if (liveConn && list.some((c) => c.id === liveConn)) return liveConn;
    return list[0]?.id;
  });
  const activeDraftConnection = computed(() => {
    const id = activeConnectionId();
    return id ? draft().connections.find((c) => c.id === id) : undefined;
  });
  const activeBaseConnection = computed(() => {
    const id = activeConnectionId();
    return id ? base().connections.find((c) => c.id === id) : undefined;
  });

  const savedSpeech = computed(() => base().speech);
  const voices = useQuery(
    () => {
      const s = savedSpeech();
      return providerVoicesQuery({ connection: s?.connection ?? "", revision: base().revision, limit: 24 });
    },
    { enabled: () => Boolean(savedSpeech()?.connection) },
  );

  const accept = (status: ProviderStatus) => {
    base.set(status);
    draft.set(editableProviderUpdate(status));
    error.set(undefined);
    client.setData(providerQuery(), () => ({ value: status }));
  };

  const changeConnection = (id: string, patch: Partial<ProviderConnectionUpdate>) => {
    draft.set({
      ...draft(),
      connections: draft().connections.map((c) => {
        if (c.id !== id) return c;
        const { key, ...rest } = { ...c, ...patch };
        return key === undefined ? rest : { ...rest, key };
      }),
    });
    error.set(undefined);
  };

  const keepKey = (id: string) => {
    draft.set({
      ...draft(),
      connections: draft().connections.map((c) => {
        if (c.id !== id) return c;
        const { key: _key, ...rest } = c;
        return rest;
      }),
    });
  };

  const addConnection = () => {
    const id = "moss";
    const firstModel = discoveredModelsForConnection(base(), id, "realtime")[0] ?? "moss-live-1.0";
    const speechModel = discoveredModelsForConnection(base(), id, "tts")[0] ?? "moss-tts-1.5-flash";
    const txModel = discoveredModelsForConnection(base(), id, "asr")[0] ?? "moss-transcribe-1.0";
    const next = draft();
    draft.set({
      ...next,
      connections: [...next.connections, { id, name: "MOSS", adapter: "moss", enabled: true }],
      live: next.live ?? { connection: id, model: firstModel },
      speech: next.speech ?? { connection: id, model: speechModel },
      transcription: next.transcription ?? { connection: id, model: txModel },
    });
    selectedId.set(id);
  };

  const setUseModel = (use: VoiceUse, model: string) => {
    const current = draft();
    if (!model) {
      draft.set({ ...current, [use]: null });
      return;
    }
    const conn = current[use]?.connection ?? activeConnectionId();
    if (!conn) return;
    draft.set({ ...current, [use]: { connection: conn, model } });
  };

  const save = () =>
    act.run(async () => {
      const next = await api.provider.update(draft());
      accept(next);
      await client.invalidate({ key: settingsQuery().key });
      toast(t("web.voice.moss.saved"));
    });

  const connectionOptions = computed(() => draft().connections.map((c) => ({ value: c.id, label: c.name || "MOSS" })));
  const modelOptions = (models: readonly string[], currentModel: string | undefined) => {
    const items = [{ value: "", label: t("web.voice.moss.unbound") }, ...models.map((m) => ({ value: m, label: m }))];
    if (currentModel && !models.includes(currentModel)) {
      items.push({ value: currentModel, label: currentModel });
    }
    return items;
  };
  const voiceList = computed(() => ready(voices, undefined)?.voices ?? []);

  return (
    <View testID="voice-config" class="gap-5 pb-6">
      <SettingsGroup
        title={t("web.voice.moss.configTitle")}
        note={t("web.voice.moss.configNote")}
        action={<TextLink href="/settings/providers">{t("web.voice.moss.manageAll")}</TextLink>}
        testid="voice-config-group"
      >
        <SettingRow icon="plug" label={t("web.voice.moss.accountLabel")} hint={t("web.voice.moss.accountHint")} testid="voice-connection-row">
          <If
            when={draft().connections.length > 0}
            else={
              <Button tone="plain" testID="voice-add-connection" icon="add" onPress={addConnection}>
                {t("web.voice.moss.addConnection")}
              </Button>
            }
          >
            <View class="w-48">
              <Select
                testid="voice-connection-select"
                label={t("web.voice.moss.accountLabel")}
                value={activeConnectionId() ?? ""}
                options={connectionOptions()}
                onChange={(id) => selectedId.set(id)}
              />
            </View>
          </If>
        </SettingRow>

        <If when={activeDraftConnection()}>
          {(conn) => (
            <KeyRow
              testid="voice-key-row"
              label={t("web.voice.moss.keyLabel")}
              hint={t("web.voice.moss.keyHint")}
              status={activeBaseConnection()?.key ?? { source: null }}
              value={conn().key ?? ""}
              removing={conn().key === null}
              onInput={(v) => (v ? changeConnection(conn().id, { key: v }) : keepKey(conn().id))}
              onRemove={(removing) => (removing ? changeConnection(conn().id, { key: null }) : keepKey(conn().id))}
              link={{ href: "https://platform.moss.cn/", label: t("web.provider.console") }}
            />
          )}
        </If>

        <SettingRow icon="realtime" label={t("web.voice.moss.liveModel")} hint={t("web.voice.moss.liveModelHint")} testid="voice-live-model-row">
          <View class="w-60">
            <Select
              testid="voice-live-model"
              label={t("web.voice.moss.liveModel")}
              disabled={draft().connections.length === 0}
              value={draft().live?.model ?? ""}
              options={modelOptions(discoveredModelsForConnection(base(), activeConnectionId() ?? "", "realtime"), draft().live?.model)}
              onChange={(m) => setUseModel("live", m)}
            />
          </View>
        </SettingRow>

        <SettingRow icon="audio" label={t("web.voice.moss.speechModel")} hint={t("web.voice.moss.speechModelHint")} testid="voice-speech-model-row">
          <View class="w-60">
            <Select
              testid="voice-speech-model"
              label={t("web.voice.moss.speechModel")}
              disabled={draft().connections.length === 0}
              value={draft().speech?.model ?? ""}
              options={modelOptions(discoveredModelsForConnection(base(), activeConnectionId() ?? "", "tts"), draft().speech?.model)}
              onChange={(m) => setUseModel("speech", m)}
            />
          </View>
        </SettingRow>

        <SettingRow
          icon="record"
          label={t("web.voice.moss.transcriptionModel")}
          hint={t("web.voice.moss.transcriptionModelHint")}
          testid="voice-transcription-model-row"
          last={savedSpeech() === null}
        >
          <View class="w-60">
            <Select
              testid="voice-transcription-model"
              label={t("web.voice.moss.transcriptionModel")}
              disabled={draft().connections.length === 0}
              value={draft().transcription?.model ?? ""}
              options={modelOptions(discoveredModelsForConnection(base(), activeConnectionId() ?? "", "asr"), draft().transcription?.model)}
              onChange={(m) => setUseModel("transcription", m)}
            />
          </View>
        </SettingRow>

        <If when={savedSpeech()}>
          <SettingRow icon="agents" label={t("web.voice.moss.voicesTitle")} hint={t("web.voice.moss.voicesHint")} testid="voice-catalog-row" wide last>
            <If when={!voices.fetching()} else={<Text class="text-xs text-muted">{t("web.base.form.asking")}</Text>}>
              <If when={voiceList().length > 0} else={<Text class="text-xs text-faint">{t("web.voice.moss.voicesEmpty")}</Text>}>
                <View class="flex-row flex-wrap items-center gap-1.5">
                  <Each of={voiceList().slice(0, 8)} key={(v) => v.id}>
                    {(v) => (
                      <View class="rounded-md border border-line bg-side px-2 py-0.5">
                        <Text class="text-xs text-ink">{v().name || v().id}</Text>
                      </View>
                    )}
                  </Each>
                  <Text class="text-xs text-muted tabular-nums">{t("web.voice.moss.voicesCount", { n: voiceList().length })}</Text>
                </View>
              </If>
            </If>
          </SettingRow>
        </If>
      </SettingsGroup>

      <SaveBar
        dirty={dirty()}
        busy={act.busy()}
        onSave={() => void save()}
        onUndo={() => {
          draft.set(editableProviderUpdate(base()));
          error.set(undefined);
        }}
        left={
          <If when={error()}>
            {(why) => (
              <View class="flex-row items-center gap-1.5 self-start rounded-md bg-bad-soft px-2.5 py-1">
                <Icon name="cross" size={12} />
                <Text testID="voice-config-problem" role="alert" class="min-w-0 text-xs font-medium text-berry">
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

/** What the server says is wrong with the draft, asked a moment after it last changed. */
const problemQuery = defineQuery({
  key: (a: { input: SettingsUpdate; token: string }) => ["settings-check", a.token],
  fetch: (a, context) => api.setting.validate(a.input, context),
  gcTime: 0,
});

function useProblem(update: () => SettingsUpdate) {
  const asked = createSettled(update);
  const check = useQuery(() => problemQuery({ input: asked(), token: crypto.randomUUID() }));
  return () => ready(check, undefined)?.problem;
}

function AgentVoiceForm(props: { status: SettingsStatus }) {
  const saveSettings = useSaveSettings();
  const start = untracked(() => props.status);
  const draft = signal<VoiceSettings>(start.voice);
  const error = signal<string | undefined>(undefined);
  const act = createAct((e) => error.set(e));
  const busy = act.busy;
  const base = signal(start);

  const dirty = () => !sameVoice(draft(), base().voice);
  const problem = useProblem(() => ({ voice: draft() }));
  const atDefaults = () => sameVoice(draft(), base().voiceDefaults);

  const submit = async () => {
    error.set(undefined);
    await act.run(async () => {
      const now = await saveSettings({ voice: draft() });
      base.set(now);
      draft.set(now.voice);
      toast(t("web.voice.voice.saved"));
    });
  };

  const undo = () => {
    draft.set(base().voice);
    error.set(undefined);
  };

  return (
    <View testID="voice-agent" class="max-w-180 gap-4 pb-6">
      <View class="flex-row flex-wrap items-center gap-x-1 rounded-lg border border-line bg-side px-3.5 py-2">
        <View class="mr-0.5 shrink-0">
          <Icon name="info" size={12} tone="faint" />
        </View>
        <Text class="text-xs leading-relaxed text-muted">{t("web.voice.voice.persona.intro")}</Text>
        <A href="/settings/voice" class="rounded-sm px-0.5 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus">
          <Text class="text-xs font-medium text-water underline">{t("web.voice.voice.section.label")}</Text>
        </A>
        <Text class="text-xs leading-relaxed text-muted">{t("web.voice.voice.persona.page")}</Text>
      </View>
      <SettingsGroup title={t("web.voice.voice.persona.open")} note={t("web.voice.voice.persona.openParts")}>
        <SettingRow label={t("web.voice.voice.persona.persona")} hint={t("web.voice.voice.persona.personaHint")} wide>
          <TextArea
            testID="persona"
            accessibilityLabel={t("web.voice.voice.persona.persona")}
            rows={7}
            value={draft().persona}
            onInput={(persona) => draft.set({ ...draft(), persona })}
          />
        </SettingRow>
        <SettingRow label={t("web.voice.voice.persona.greeting")} hint={t("web.voice.voice.persona.greetingHint")} wide last>
          <TextInput
            testID="greeting"
            accessibilityLabel={t("web.voice.voice.persona.greeting")}
            value={draft().greeting}
            onInput={(greeting) => draft.set({ ...draft(), greeting })}
          />
        </SettingRow>
      </SettingsGroup>
      <SaveBar
        dirty={dirty()}
        busy={busy() || !!problem()}
        onSave={() => void submit()}
        onUndo={undo}
        left={
          <If when={error() ?? problem()}>
            {(e) => (
              <View class="flex-row items-center gap-1.5 self-start rounded-md bg-bad-soft px-2.5 py-1">
                <Icon name="cross" size={12} />
                <Text testID="voice-problem" role="alert" class="min-w-0 text-xs font-medium text-berry">
                  {e()}
                </Text>
              </View>
            )}
          </If>
        }
        extra={
          <Button tone="quiet" testID="reset" disabled={atDefaults()} onPress={() => draft.set(base().voiceDefaults)}>
            {t("web.base.form.reset")}
          </Button>
        }
      />
    </View>
  );
}
