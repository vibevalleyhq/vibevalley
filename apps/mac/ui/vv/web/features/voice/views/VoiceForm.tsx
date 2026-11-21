import { signal, Text, untracked, View } from "nsh";

import { t } from "@vibevalley/i18n";
import {
  AreaValues,
  type Dictation,
  type KeyStatus,
  LanguageValues,
  ModelValues,
  type SettingsStatus,
  type SettingsUpdate,
  VoiceAnswerAgoraModelValues,
  type VoiceSettings,
} from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";

import { createSettled, Keyed, variant } from "../../../base/dom";
import { api, reasonOf } from "../../../infra/api";
import { defineQuery, ready, useQuery, useSettings } from "../../../infra/query";
import { useSaveSettings } from "../../../infra/settings";
import { createAct } from "../../../ui/act";
import { Button } from "../../../ui/Button";
import { Select, TextInput } from "../../../ui/Field";
import { Icon } from "../../../ui/Icon";
import { IconLink, OutLink } from "../../../ui/IconButton";
import { KeyField, SaveBar } from "../../../ui/KeyField";
import { Card, Quiet, SecretInput } from "../../../ui/layout";
import { Segmented } from "../../../ui/Segmented";
import { TextLink } from "../../../ui/TextLink";
import { Hint } from "../../../ui/Tip";
import { toast } from "../../../ui/toasts";
import { MossVerify } from "./MossVerify";
import { NativeCall } from "./NativeCall";
import {
  answerLabel,
  answerStart,
  areaLabel,
  asrLabel,
  asrStart,
  Cell,
  Cols,
  keyFrom,
  Labeled,
  languageLabel,
  numberLabel,
  options,
  plain,
  VoiceAgentSection,
  voiceLimits,
  type VoiceNumber,
  type VoicePart,
  withPart,
} from "./VoiceVendorFields";

const sameVoice = (a: VoiceSettings, b: VoiceSettings) => same(a, b);

type Key = "agoraAppId" | "agoraAppCertificate" | "asrKey" | "llmKey" | "ttsKey" | "dictationKey";

/** Which of the line's settings a page shows: the call (area, listening, who answers), MOSS Live, dictation, or Agora's
 * credentials on the accounts page. */
type LineView = "call" | "moss" | "dictation" | "accounts";

export function VoiceForm(props: { part: VoicePart; view?: LineView }) {
  const settings = useSettings();
  return (
    <If
      when={ready(settings, undefined)}
      else={<Quiet>{settings.error() ? t("web.voice.voice.noSettings", { why: reasonOf(settings.error()) }) : t("web.base.form.asking")}</Quiet>}
    >
      {(status) => <Keyed key={status().file}>{() => <Form status={untracked(status)} part={props.part} view={props.view ?? "call"} />}</Keyed>}
    </If>
  );
}

/** What the server says is wrong with the draft, asked a moment after it last changed. */
const problemQuery = defineQuery({
  schema: S.Validation,
  key: (a: { input: SettingsUpdate; token: string }) => ["settings-check", a.token],
  fetch: (a, context) => api.setting.validate(a.input, context),
  gcTime: 0,
});
function useProblem(update: () => SettingsUpdate) {
  const asked = createSettled(update);
  const check = useQuery(() => problemQuery({ input: asked(), token: crypto.randomUUID() }));
  return () => ready(check, undefined)?.problem;
}

function Form(props: { status: SettingsStatus; part: VoicePart; view: LineView }) {
  const saveSettings = useSaveSettings();
  const start = untracked(() => props.status);
  const draft = signal<VoiceSettings>(start.voice);
  const appId = signal(start.agoraAppId.value ?? "");
  const dictation = signal<Dictation>(start.dictation);
  const secrets = signal<Partial<Record<Key, string>>>({});
  const cleared = signal<ReadonlySet<Key>>(new Set());
  const error = signal<string | undefined>(undefined);
  const act = createAct((e) => error.set(e));
  const busy = act.busy;
  // The settings as saved now: a save answers with them, and the form keeps the draft over them.
  const base = signal(start);

  const set = (next: VoiceSettings) => draft.set(next);
  const voiceDirty = () => !sameVoice(draft(), base().voice);
  const appIdDirty = () => appId().trim() !== (base().agoraAppId.value ?? "");
  const dictationDirty = () =>
    dictation().via !== base().dictation.via || dictation().url.trim() !== base().dictation.url || dictation().model.trim() !== base().dictation.model;
  const dirty = () => voiceDirty() || appIdDirty() || dictationDirty() || Object.values(secrets()).some((v) => v.trim()) || cleared().size > 0;
  const problem = useProblem(() => ({ voice: draft(), ...(dictationDirty() ? { dictation: dictation() } : {}) }));
  const atDefaults = () => sameVoice(draft(), withPart(props.part, draft(), base().voiceDefaults));

  const submit = async () => {
    const update: Record<string, unknown> = {};
    for (const k of cleared()) update[k] = "";
    if (appIdDirty() && !cleared().has("agoraAppId")) update.agoraAppId = appId().trim();
    for (const [k, v] of Object.entries(secrets())) if (v.trim()) update[k] = v.trim();
    if (voiceDirty()) update.voice = withPart(props.part, base().voice, draft());
    if (dictationDirty()) update.dictation = { via: dictation().via, url: dictation().url.trim(), model: dictation().model.trim() };
    error.set(undefined);
    await act.run(async () => {
      const now = await saveSettings(update);
      base.set(now);
      secrets.set({});
      cleared.set(new Set<Key>());
      toast(t("web.voice.voice.saved"));
    });
  };
  const undo = () => {
    draft.set(base().voice);
    appId.set(base().agoraAppId.value ?? "");
    dictation.set(base().dictation);
    secrets.set({});
    cleared.set(new Set<Key>());
    error.set(undefined);
  };

  const remove = (k: Key) => (on: boolean) => {
    const next = new Set(cleared());
    if (on) next.add(k);
    else next.delete(k);
    cleared.set(next);
  };
  const secret = (k: Key, label: string, current: () => KeyStatus, link?: { readonly href: string; readonly label: string }) => (
    <KeyField small label={label} status={current()} removing={cleared().has(k)} onRemove={remove(k)} link={link}>
      <SecretInput
        testID={`secret-${k}`}
        accessibilityLabel={label}
        placeholder={t("web.base.form.keepEmpty")}
        value={secrets()[k] ?? ""}
        onInput={(value) => secrets.set({ ...secrets(), [k]: value })}
      />
    </KeyField>
  );
  const number = (k: VoiceNumber) => (
    <Labeled label={numberLabel[k]} hint={t("web.voice.voice.range", { min: voiceLimits[k].min, max: voiceLimits[k].max, fallback: base().voiceDefaults[k] })}>
      <TextInput
        testID={`voice-${k}`}
        accessibilityLabel={numberLabel[k]}
        class="font-mono tabular-nums"
        value={String(draft()[k])}
        onInput={(value) => set({ ...draft(), [k]: Number(value.replace(/\D/gu, "")) })}
      />
    </Labeled>
  );

  const bar = () => (
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
      // Reset to defaults puts back the call's own settings: on MOSS Live's key or dictation it would touch what is not shown.
      extra={
        <If when={props.part === "agent" || props.view === "call"}>
          <Button tone="quiet" testID="reset" disabled={atDefaults()} onPress={() => set(withPart(props.part, draft(), base().voiceDefaults))}>
            {t("web.base.form.reset")}
          </Button>
        </If>
      }
    />
  );

  const asr = () => draft().asr;
  const answer = () => draft().answer;
  const answerHint = () => {
    const source = base().deepseekApiKey.source;
    return answer().vendor === "orchestrator"
      ? t("web.voice.voice.answer.orchestrator")
      : answer().vendor === "moss"
        ? t("web.voice.voice.answer.moss")
        : answer().vendor === "agora"
          ? t("web.voice.voice.answer.agora")
          : answer().vendor === "deepseek"
            ? source !== null
              ? t("web.voice.voice.answer.deepseek", { from: keyFrom[source] })
              : t("web.voice.voice.answer.noDeepseek")
            : t("web.voice.voice.answer.openai");
  };

  return (
    <If
      when={props.part === "agent"}
      else={
        <View testID={`voice-${props.view}`} class="min-h-0 gap-3">
          <If when={props.view === "moss"}>
            <View class="max-w-4xl flex-row flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-page px-4 py-3">
              <View class="min-w-0 flex-1 flex-row items-center gap-2">
                <Icon name="plug" size={14} tone="muted" />
                <TextLink href="/settings/providers">{t("web.provider.manage")}</TextLink>
              </View>
              <MossVerify />
            </View>
            <NativeCall />
          </If>
          <If when={props.view === "accounts"}>
            <Card
              title={t("web.voice.voice.credentials")}
              action={<OutLink href="https://console.agora.io/" label={t("web.voice.voice.console")} />}
              class="max-w-4xl"
            >
              <Cols>
                <Cell>
                  <KeyField small label="App ID" status={base().agoraAppId} removing={cleared().has("agoraAppId")} onRemove={remove("agoraAppId")}>
                    <TextInput
                      testID="agora-app-id"
                      accessibilityLabel="Agora App ID"
                      class="font-mono"
                      placeholder={t("web.voice.voice.hex")}
                      value={appId()}
                      onInput={(v) => appId.set(v)}
                    />
                  </KeyField>
                </Cell>
                <Cell>{secret("agoraAppCertificate", "App Certificate", () => base().agoraAppCertificate)}</Cell>
              </Cols>
            </Card>
          </If>
          <If when={props.view === "call"}>
            <View class="max-w-4xl flex-row flex-wrap items-center gap-2 rounded-lg bg-side px-3.5 py-2">
              <Hint
                text={t("web.voice.voice.intro") + t("web.voice.voice.orchestratorPage") + t("web.voice.voice.period") + " " + t("web.voice.voice.nextCall")}
              />
              <Text class="text-xs text-muted">{t("web.voice.voice.nextCall")}</Text>
              <View class="flex-1" />
              <IconLink href="/orchestrator/voice" icon="agents" label={t("web.voice.voice.orchestratorPage")} />
              <Hint icon="file" text={t("web.base.form.storedIn", { file: base().file })} />
            </View>
            <Card title={t("web.voice.voice.line")} class="max-w-4xl">
              <Cols>
                <Labeled label={t("web.voice.voice.area")} hint={t("web.voice.voice.areaHint")}>
                  <Segmented
                    label={t("web.voice.voice.area")}
                    testid="voice-area"
                    value={draft().area}
                    options={AreaValues.map((a) => ({ value: a, label: areaLabel[a] }))}
                    onChange={(area) => set({ ...draft(), area })}
                  />
                </Labeled>
              </Cols>
            </Card>
            <Card
              title={t("web.voice.voice.listen")}
              action={
                <View class="rounded-sm bg-side px-2 py-0.5">
                  <Text class="text-xs font-medium text-muted">{t("web.voice.voice.listenParts")}</Text>
                </View>
              }
              class="max-w-4xl"
            >
              <Cols>
                <Labeled label={t("web.voice.voice.asr")} hint={asr().vendor === "microsoft" ? t("web.voice.voice.microsoft") : t("web.voice.voice.hosted")}>
                  <Segmented
                    label={t("web.voice.voice.asr")}
                    testid="voice-asr"
                    value={asr().vendor}
                    options={options(["ares", "deepgram", "microsoft"] as const, asrLabel)}
                    onChange={(v) => set({ ...draft(), asr: v === asr().vendor ? asr() : asrStart[v] })}
                  />
                </Labeled>
                <Labeled label={t("web.voice.voice.language")} hint={t("web.voice.voice.languageHint")}>
                  <Select
                    label={t("web.voice.voice.language")}
                    testid="voice-language"
                    value={draft().language}
                    options={LanguageValues.map((l) => ({ value: l, label: t("shared.join.aside", { text: languageLabel[l], aside: l }) }))}
                    onChange={(l) => set({ ...draft(), language: l })}
                  />
                </Labeled>
                <If when={variant(asr(), "vendor", "deepgram")}>
                  {(a) => (
                    <Labeled label={t("web.voice.voice.deepgramModel")}>
                      <Segmented
                        label={t("web.voice.voice.deepgramModel")}
                        testid="voice-deepgram-model"
                        value={a().model}
                        options={plain(ModelValues)}
                        onChange={(model) => set({ ...draft(), asr: { vendor: "deepgram", model } })}
                      />
                    </Labeled>
                  )}
                </If>
                <If when={variant(asr(), "vendor", "microsoft")}>
                  {(a) => (
                    <>
                      <Labeled label={t("web.voice.voice.azureArea")} hint={t("web.voice.voice.azureAreaHint")}>
                        <TextInput
                          accessibilityLabel={t("web.voice.voice.asrArea")}
                          class="font-mono"
                          value={a().region}
                          onInput={(region) => set({ ...draft(), asr: { vendor: "microsoft", region } })}
                        />
                      </Labeled>
                      <Cell>{secret("asrKey", t("web.voice.voice.microsoftKey"), () => base().asrKey)}</Cell>
                    </>
                  )}
                </If>
                {number("silenceMs")}
                {number("interruptMs")}
                {number("idleSeconds")}
              </Cols>
            </Card>
            <Card
              title={t("web.voice.voice.think")}
              action={
                <View class="rounded-sm bg-side px-2 py-0.5">
                  <Text class="text-xs font-medium text-muted">{answerLabel[answer().vendor]}</Text>
                </View>
              }
              class="max-w-4xl"
            >
              <Labeled label={t("web.voice.voice.who")} hint={answerHint()}>
                <Segmented
                  label={t("web.voice.voice.who")}
                  testid="voice-answer"
                  value={answer().vendor}
                  options={options(["orchestrator", "moss", "agora", "deepseek", "openai"] as const, answerLabel)}
                  onChange={(v) => set({ ...draft(), answer: v === answer().vendor ? answer() : answerStart[v] })}
                />
              </Labeled>
              <If when={answer().vendor === "moss"}>
                <View class="flex-row items-center gap-2 rounded-md bg-side px-3 py-2">
                  <Icon name="plug" size={14} tone="muted" />
                  <TextLink href="/settings/providers">{t("web.provider.manage")}</TextLink>
                </View>
              </If>
              <If when={variant(answer(), "vendor", "agora")}>
                {(a) => (
                  <Labeled label={t("web.voice.voice.model")}>
                    <Segmented
                      label={t("web.voice.voice.model")}
                      testid="voice-model"
                      value={a().model}
                      options={plain(VoiceAnswerAgoraModelValues)}
                      onChange={(model) => set({ ...draft(), answer: { vendor: "agora", model } })}
                    />
                  </Labeled>
                )}
              </If>
              <If when={variant(answer(), "vendor", "deepseek")}>
                {(a) => (
                  <Labeled label={t("web.voice.voice.model")} hint={t("web.voice.voice.deepseekModel")}>
                    <TextInput
                      accessibilityLabel={t("web.voice.voice.deepseekModelLabel")}
                      class="font-mono"
                      value={a().model}
                      onInput={(model) => set({ ...draft(), answer: { vendor: "deepseek", model } })}
                    />
                  </Labeled>
                )}
              </If>
              <If when={variant(answer(), "vendor", "openai")}>
                {(a) => (
                  <Cols>
                    <Labeled label={t("web.voice.voice.address")} hint={t("web.voice.voice.llmAddress")}>
                      <TextInput
                        accessibilityLabel={t("web.voice.voice.llmAddressLabel")}
                        class="font-mono"
                        value={a().url}
                        onInput={(url) => set({ ...draft(), answer: { ...a(), url } })}
                      />
                    </Labeled>
                    <Labeled label={t("web.voice.voice.model")}>
                      <TextInput
                        accessibilityLabel={t("web.voice.voice.llmModel")}
                        class="font-mono"
                        value={a().model}
                        onInput={(model) => set({ ...draft(), answer: { ...a(), model } })}
                      />
                    </Labeled>
                    <Cell>{secret("llmKey", t("web.voice.voice.llmKey"), () => base().llmKey)}</Cell>
                  </Cols>
                )}
              </If>
            </Card>
          </If>
          <If when={props.view === "dictation"}>
            {/* The page's title already says Dictation: the card has none of its own. */}
            <Card class="max-w-4xl">
              <View class="flex-row flex-wrap items-center gap-x-3 gap-y-2 border-b border-line pb-3">
                <Segmented
                  label={t("web.voice.voice.dictationVia")}
                  testid="dictation-via"
                  value={dictation().via}
                  options={[
                    { value: "moss", label: "MOSS" },
                    { value: "own", label: t("web.voice.voice.dictationOwn") },
                  ]}
                  onChange={(via) => dictation.set({ ...dictation(), via })}
                />
                <View class="min-w-0 flex-1 flex-row flex-wrap items-center gap-x-2">
                  <Text class="text-xs leading-relaxed text-muted">
                    {dictation().via === "moss" ? t("web.voice.voice.dictationMossIntro") : t("web.voice.voice.dictationIntro")}
                  </Text>
                  <If when={dictation().via === "own"}>
                    <OutLink href="https://github.com/soniqo/speech-swift" label={t("web.voice.voice.speechServer")} />
                  </If>
                </View>
              </View>
              <If
                when={dictation().via === "own"}
                else={
                  <View testID="dictation-provider-link" class="flex-row items-center gap-2 rounded-md bg-side px-3 py-2.5">
                    <Icon name="plug" size={14} tone="muted" />
                    <TextLink href="/settings/providers">{t("web.provider.manage")}</TextLink>
                  </View>
                }
              >
                <Cols>
                  <Labeled label={t("web.voice.voice.address")} hint={t("web.voice.voice.dictationAddress")}>
                    <TextInput
                      accessibilityLabel={t("web.voice.voice.dictationAddressLabel")}
                      testID="dictation-url"
                      class="font-mono"
                      placeholder={t("web.base.form.example", { value: "http://127.0.0.1:8080/v1" })}
                      value={dictation().url}
                      onInput={(url) => dictation.set({ ...dictation(), url })}
                    />
                  </Labeled>
                  <Labeled label={t("web.voice.voice.model")} hint={t("web.voice.voice.dictationModel")}>
                    <TextInput
                      accessibilityLabel={t("web.voice.voice.dictationModelLabel")}
                      testID="dictation-model"
                      class="font-mono"
                      placeholder={t("web.base.form.example", { value: "qwen3" })}
                      value={dictation().model}
                      onInput={(model) => dictation.set({ ...dictation(), model })}
                    />
                  </Labeled>
                  <Cell>{secret("dictationKey", t("web.voice.voice.dictationKey"), () => base().dictationKey)}</Cell>
                </Cols>
              </If>
            </Card>
          </If>
          <If when={props.view !== "moss"}>
            <View class="max-w-4xl">{bar()}</View>
          </If>
        </View>
      }
    >
      <VoiceAgentSection draft={draft()} set={set} ttsKeyField={secret("ttsKey", t("web.voice.voice.microsoftKey"), () => base().ttsKey)} bar={bar()} />
    </If>
  );
}
