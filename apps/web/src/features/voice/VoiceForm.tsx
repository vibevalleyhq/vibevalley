import { t } from "@vibevalley/i18n";
// 声音: the line's settings in 设置 › 语音 (/settings/call: credentials, how it listens, who answers; /settings/moss:
// MOSS Live's key; /settings/dictation) and the orchestrator's voice
// on /orchestrator/voice (what it says, in what voice). Each part saves only its own fields over the settings as they are
// now: the other part may have been saved meanwhile.

import { saveSettings } from "../../base/settings";

import { createSignal, For, onSettled, Show, snapshot, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { keepPreviousData } from "@tanstack/solid-query";
import {
  AreaValues,
  type Dictation,
  type KeySource,
  type KeyStatus,
  LanguageValues,
  ModelValues,
  type SettingsStatus,
  type SettingsUpdate,
  VoiceAnswerAgoraModelValues,
  type VoiceSettings,
  VoiceTTSMinimaxModelValues,
  VoiceValues,
} from "@vibevalley/protocol";
import { api, reasonOf } from "../../base/api";
import {
  answerLabel,
  answerStart,
  areaLabel,
  asrLabel,
  asrStart,
  languageLabel,
  microsoftVoices,
  minimaxVoices,
  numberLabel,
  sameVoice,
  ttsLabel,
  ttsStart,
  type VoiceNumber,
  type VoicePart,
  voiceLimits,
  voiceSample,
  withPart,
} from "./choices";
import { A } from "../../ui/A";
import { aria, createSettled, Keyed } from "../../base/util";
import { ready, useQuery, useSettings } from "../../base/query";
import { Button } from "../../ui/Button";
import { Select, TextArea, TextInput } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { Segmented } from "../../ui/Segmented";
import { Card, Quiet, SecretInput } from "../../ui/layout";
import { IconLink } from "../../ui/IconButton";
import { KeyField, SaveBar } from "../../ui/KeyField";
import { Hint } from "../../ui/Tip";
import { toast } from "../../ui/toasts";
import { MossCheck } from "./MossCheck";
import { KeyRow, SettingsGroup } from "../../ui/settings";

type Key = "agoraAppId" | "agoraAppCertificate" | "asrKey" | "llmKey" | "ttsKey" | "dictationKey" | "mossKey";

const keyFrom: Record<KeySource, string> = { settings: t("web.base.form.from.settings"), config: t("web.base.form.from.config") };

const options = <T extends string>(labels: Record<T, string>) => (Object.keys(labels) as T[]).map((value) => ({ value, label: labels[value] }));
const plain = <T extends string>(values: readonly T[]) => values.map((value) => ({ value, label: value }));

/** Which of the line's settings a page shows: the call (credentials, listening, who answers), MOSS Live's key, or
 * dictation. They save together, each only what it changed. */
export type LineView = "call" | "moss" | "dictation";

export function VoiceForm(props: { part: VoicePart; view?: LineView }) {
  const settings = useSettings();
  return (
    <Show
      when={ready(settings, undefined)}
      fallback={<Quiet>{settings.error ? t("web.voice.voice.noSettings", { why: reasonOf(settings.error) }) : t("web.base.form.asking")}</Quiet>}
    >
      {(status) => <Keyed key={status().file}>{() => <Form status={untrack(status)} part={props.part} view={props.view ?? "call"} />}</Keyed>}
    </Show>
  );
}

/** What the server says is wrong with the draft, asked a moment after it last changed. */
function useProblem(update: () => SettingsUpdate) {
  const asked = createSettled(() => JSON.stringify(update()));
  const check = useQuery(() => ({
    queryKey: ["settings-check", asked()],
    queryFn: () => api.setting.check(JSON.parse(asked()) as SettingsUpdate),
    placeholderData: keepPreviousData,
  }));
  return () => ready(check, undefined)?.problem;
}

function Form(props: { status: SettingsStatus; part: VoicePart; view: LineView }) {
  // A plain copy: the form starts from it once, and reading the store's fields later would be untracked reads.
  const start = untrack(() => snapshot(props.status));
  const [draft, setDraft] = createSignal<VoiceSettings>(start.voice);
  const [appId, setAppId] = createSignal(start.agoraAppId.value ?? "");
  const [dictation, setDictation] = createSignal<Dictation>(start.dictation);
  const [secrets, setSecrets] = createSignal<Partial<Record<Key, string>>>({});
  const [cleared, setCleared] = createSignal<ReadonlySet<Key>>(new Set());
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  // The settings as saved now: a save answers with them, and the form keeps the draft over them.
  const [base, setBase] = createSignal(start);

  const set = (next: VoiceSettings) => {
    setDraft(next);
  };
  const voiceDirty = () => !sameVoice(draft(), base().voice);
  const appIdDirty = () => appId().trim() !== (base().agoraAppId.value ?? "");
  const dictationDirty = () => dictation().url.trim() !== base().dictation.url || dictation().model.trim() !== base().dictation.model;
  const dirty = () => voiceDirty() || appIdDirty() || dictationDirty() || Object.values(secrets()).some((v) => v?.trim()) || cleared().size > 0;
  const problem = useProblem(() => ({ voice: draft(), ...(dictationDirty() ? { dictation: dictation() } : {}) }));
  const atDefaults = () => sameVoice(draft(), withPart(props.part, draft(), base().voiceDefaults));

  const submit = async () => {
    const update: Record<string, unknown> = {};
    for (const k of cleared()) update[k] = "";
    if (appIdDirty() && !cleared().has("agoraAppId")) update.agoraAppId = appId().trim();
    for (const [k, v] of Object.entries(secrets())) if (v?.trim()) update[k] = v.trim();
    if (voiceDirty()) update.voice = withPart(props.part, base().voice, draft());
    if (dictationDirty()) update.dictation = { url: dictation().url.trim(), model: dictation().model.trim() };
    setBusy(true);
    setError(undefined);
    try {
      const now = await saveSettings(update);
      setBase(now);
      setSecrets({});
      setCleared(new Set<Key>());
      toast(t("web.voice.voice.saved"));
    } catch (e) {
      setError(reasonOf(e));
    } finally {
      setBusy(false);
    }
  };
  const undo = () => {
    setDraft(base().voice);
    setAppId(base().agoraAppId.value ?? "");
    setDictation(base().dictation);
    setSecrets({});
    setCleared(new Set<Key>());
    setError(undefined);
  };

  const remove = (k: Key) => (on: boolean) => {
    const next = new Set(cleared());
    if (on) next.add(k);
    else next.delete(k);
    setCleared(next);
  };
  const secret = (k: Key, label: string, current: () => KeyStatus) => (
    <KeyField small label={label} status={current()} removing={cleared().has(k)} onRemove={remove(k)}>
      <SecretInput
        aria-label={label}
        placeholder={t("web.base.form.keepEmpty")}
        value={secrets()[k] ?? ""}
        onInput={(e) => {
          setSecrets({ ...secrets(), [k]: e.currentTarget.value });
        }}
      />
    </KeyField>
  );
  const number = (k: VoiceNumber) => (
    <Labeled label={numberLabel[k]} hint={t("web.voice.voice.range", { min: voiceLimits[k].min, max: voiceLimits[k].max, fallback: base().voiceDefaults[k] })}>
      <TextInput
        aria-label={numberLabel[k]}
        class="font-mono"
        inputmode="numeric"
        value={String(draft()[k])}
        onInput={(e) => set({ ...draft(), [k]: Number(e.currentTarget.value.replace(/\D/g, "")) || 0 })}
      />
    </Labeled>
  );

  const bar = () => (
    <SaveBar
      dirty={dirty()}
      busy={busy() || !!problem()}
      onSave={() => void submit()}
      onUndo={undo}
      left={<Show when={error() ?? problem()}>{(e) => <p class="text-berry">{e()}</p>}</Show>}
      // 恢复默认 puts back the call's own settings: on MOSS Live's key or dictation it would touch what is not shown.
      extra={
        <Show when={props.part === "agent" || props.view === "call"}>
          <Button tone="quiet" data-testid="reset" disabled={atDefaults()} onClick={() => set(withPart(props.part, draft(), base().voiceDefaults))}>
            {t("web.base.form.reset")}
          </Button>
        </Show>
      }
    />
  );

  const tts = () => draft().tts;
  const asr = () => draft().asr;
  const answer = () => draft().answer;
  const credentialsReady = () => base().agoraAppId.source !== undefined && base().agoraAppCertificate.source !== undefined;
  const answerHint = () =>
    answer().vendor === "orchestrator"
      ? t("web.voice.voice.answer.orchestrator")
      : answer().vendor === "agora"
        ? t("web.voice.voice.answer.agora")
        : answer().vendor === "deepseek"
          ? base().deepseekApiKey.source
            ? t("web.voice.voice.answer.deepseek", { from: keyFrom[base().deepseekApiKey.source!] })
            : t("web.voice.voice.answer.noDeepseek")
          : t("web.voice.voice.answer.openai");

  return (
    <Show
      when={props.part === "agent"}
      fallback={
        <div class="flex h-full min-h-0 flex-col gap-3">
          <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
            <Show when={props.view === "moss"}>
              <SettingsGroup>
                <KeyRow
                  label="API Key"
                  hint={t("web.voice.voice.moss.keyHint")}
                  status={base().mossKey}
                  value={secrets().mossKey ?? ""}
                  onInput={(v) => setSecrets({ ...secrets(), mossKey: v })}
                  removing={cleared().has("mossKey")}
                  onRemove={remove("mossKey")}
                  link={{ href: "https://platform.mosi.cn/", label: t("web.voice.voice.moss.console") }}
                  after={<MossCheck typed={() => secrets().mossKey ?? ""} />}
                />
              </SettingsGroup>
            </Show>
            <Show when={props.view === "call"}>
              <div class="flex max-w-4xl items-center gap-2 px-1">
                <span class={["rounded px-1.5 py-0.5 text-xs", credentialsReady() ? "bg-ok-soft text-ok-ink" : "bg-bad-soft text-berry"]}>
                  {credentialsReady() ? t("web.voice.voice.ready") : t("web.voice.voice.missing")}
                </span>
                <Hint
                  text={t("web.voice.voice.intro") + t("web.voice.voice.orchestratorPage") + t("web.voice.voice.period") + " " + t("web.voice.voice.nextCall")}
                />
                <span class="flex-1" />
                <IconLink href="/orchestrator/voice" icon="agents" label={t("web.voice.voice.orchestratorPage")} />
                <Hint text={t("web.base.form.storedIn", { file: base().file })} />
              </div>
              <Card
                title={t("web.voice.voice.credentials")}
                action={<IconLink href="https://console.agora.io/" label={t("web.voice.voice.console")} />}
                class="max-w-4xl"
              >
                <Cols>
                  <KeyField small label="App ID" status={base().agoraAppId} removing={cleared().has("agoraAppId")} onRemove={remove("agoraAppId")}>
                    <TextInput
                      data-testid="agora-app-id"
                      aria-label="Agora App ID"
                      class="font-mono"
                      placeholder={t("web.voice.voice.hex")}
                      value={appId()}
                      onInput={(e) => {
                        setAppId(e.currentTarget.value);
                      }}
                    />
                  </KeyField>
                  {secret("agoraAppCertificate", "App Certificate", () => base().agoraAppCertificate)}
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
              <Card title={t("web.voice.voice.listen")} action={<span class="text-sm text-muted">{t("web.voice.voice.listenParts")}</span>} class="max-w-4xl">
                <Cols>
                  <Labeled label={t("web.voice.voice.asr")} hint={asr().vendor === "microsoft" ? t("web.voice.voice.microsoft") : t("web.voice.voice.hosted")}>
                    <Segmented
                      label={t("web.voice.voice.asr")}
                      testid="voice-asr"
                      value={asr().vendor}
                      options={options(asrLabel)}
                      onChange={(v) => set({ ...draft(), asr: v === asr().vendor ? asr() : asrStart[v] })}
                    />
                  </Labeled>
                  <Labeled label={t("web.voice.voice.language")} hint={t("web.voice.voice.languageHint")}>
                    <Select
                      label={t("web.voice.voice.language")}
                      value={draft().language}
                      options={LanguageValues.map((l) => ({ value: l, label: t("shared.join.aside", { text: languageLabel[l], aside: l }) }))}
                      onChange={(l) => l && set({ ...draft(), language: l as VoiceSettings["language"] })}
                    />
                  </Labeled>
                  <Show when={asr().vendor === "deepgram" ? (asr() as Extract<VoiceSettings["asr"], { vendor: "deepgram" }>) : undefined}>
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
                  </Show>
                  <Show when={asr().vendor === "microsoft" ? (asr() as Extract<VoiceSettings["asr"], { vendor: "microsoft" }>) : undefined}>
                    {(a) => (
                      <>
                        <Labeled label={t("web.voice.voice.azureArea")} hint={t("web.voice.voice.azureAreaHint")}>
                          <TextInput
                            aria-label={t("web.voice.voice.asrArea")}
                            class="font-mono"
                            value={a().region}
                            onInput={(e) => set({ ...draft(), asr: { vendor: "microsoft", region: e.currentTarget.value } })}
                          />
                        </Labeled>
                        {secret("asrKey", t("web.voice.voice.microsoftKey"), () => base().asrKey)}
                      </>
                    )}
                  </Show>
                  {number("silenceMs")}
                  {number("interruptMs")}
                  {number("idleSeconds")}
                </Cols>
              </Card>
              <Card title={t("web.voice.voice.think")} action={<span class="text-sm text-muted">{answerLabel[answer().vendor]}</span>} class="max-w-4xl">
                <Labeled label={t("web.voice.voice.who")} hint={answerHint()}>
                  <Segmented
                    label={t("web.voice.voice.who")}
                    testid="voice-answer"
                    value={answer().vendor}
                    options={options(answerLabel)}
                    onChange={(v) => set({ ...draft(), answer: v === answer().vendor ? answer() : answerStart[v] })}
                  />
                </Labeled>
                <Show when={answer().vendor === "agora" ? (answer() as Extract<VoiceSettings["answer"], { vendor: "agora" }>) : undefined}>
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
                </Show>
                <Show when={answer().vendor === "deepseek" ? (answer() as Extract<VoiceSettings["answer"], { vendor: "deepseek" }>) : undefined}>
                  {(a) => (
                    <Labeled label={t("web.voice.voice.model")} hint={t("web.voice.voice.deepseekModel")}>
                      <TextInput
                        aria-label={t("web.voice.voice.deepseekModelLabel")}
                        class="font-mono"
                        value={a().model}
                        onInput={(e) => set({ ...draft(), answer: { vendor: "deepseek", model: e.currentTarget.value } })}
                      />
                    </Labeled>
                  )}
                </Show>
                <Show when={answer().vendor === "openai" ? (answer() as Extract<VoiceSettings["answer"], { vendor: "openai" }>) : undefined}>
                  {(a) => (
                    <Cols>
                      <Labeled label={t("web.voice.voice.address")} hint={t("web.voice.voice.llmAddress")}>
                        <TextInput
                          aria-label={t("web.voice.voice.llmAddressLabel")}
                          class="font-mono"
                          value={a().url}
                          onInput={(e) => set({ ...draft(), answer: { ...a(), url: e.currentTarget.value } })}
                        />
                      </Labeled>
                      <Labeled label={t("web.voice.voice.model")}>
                        <TextInput
                          aria-label={t("web.voice.voice.llmModel")}
                          class="font-mono"
                          value={a().model}
                          onInput={(e) => set({ ...draft(), answer: { ...a(), model: e.currentTarget.value } })}
                        />
                      </Labeled>
                      {secret("llmKey", t("web.voice.voice.llmKey"), () => base().llmKey)}
                    </Cols>
                  )}
                </Show>
              </Card>
            </Show>
            <Show when={props.view === "dictation"}>
              <Card
                title={t("web.voice.voice.dictation")}
                action={<IconLink href="https://github.com/soniqo/speech-swift" label={t("web.voice.voice.speechServer")} />}
                class="max-w-4xl"
              >
                <p class="text-sm text-muted">{t("web.voice.voice.dictationIntro")}</p>
                <Cols>
                  <Labeled label={t("web.voice.voice.address")} hint={t("web.voice.voice.dictationAddress")}>
                    <TextInput
                      aria-label={t("web.voice.voice.dictationAddressLabel")}
                      class="font-mono"
                      placeholder="http://127.0.0.1:8080/v1"
                      value={dictation().url}
                      onInput={(e) => {
                        setDictation({ ...dictation(), url: e.currentTarget.value });
                      }}
                    />
                  </Labeled>
                  <Labeled label={t("web.voice.voice.model")} hint={t("web.voice.voice.dictationModel")}>
                    <TextInput
                      aria-label={t("web.voice.voice.dictationModelLabel")}
                      class="font-mono"
                      placeholder="qwen3"
                      value={dictation().model}
                      onInput={(e) => {
                        setDictation({ ...dictation(), model: e.currentTarget.value });
                      }}
                    />
                  </Labeled>
                  {secret("dictationKey", t("web.voice.voice.dictationKey"), () => base().dictationKey)}
                </Cols>
              </Card>
            </Show>
          </div>
          <div class="max-w-4xl">{bar()}</div>
        </div>
      }
    >
      <div class="flex max-w-4xl flex-col gap-3">
        <p class="text-sm text-muted">
          {t("web.voice.voice.persona.intro")}
          <A class="underline" href="/settings/call">
            {t("web.voice.voice.section.label")}
          </A>
          {t("web.voice.voice.persona.page")}
        </p>
        <Card title={t("web.voice.voice.persona.open")} action={<span class="text-sm text-muted">{t("web.voice.voice.persona.openParts")}</span>}>
          {/* The persona is the quick model's only: the orchestrator answering is itself, with its own prompt. */}
          <Show when={answer().vendor !== "orchestrator"} fallback={<p class="text-sm text-muted">{t("web.voice.voice.persona.ownCall")}</p>}>
            <Labeled label={t("web.voice.voice.persona.persona")} hint={t("web.voice.voice.persona.personaHint")}>
              <TextArea
                aria-label={t("web.voice.voice.persona.persona")}
                rows={8}
                value={draft().persona}
                onInput={(e) => set({ ...draft(), persona: e.currentTarget.value })}
              />
            </Labeled>
          </Show>
          <Cols>
            <Labeled label={t("web.voice.voice.persona.greeting")} hint={t("web.voice.voice.persona.greetingHint")}>
              <TextInput
                data-testid="greeting"
                aria-label={t("web.voice.voice.persona.greeting")}
                value={draft().greeting}
                onInput={(e) => set({ ...draft(), greeting: e.currentTarget.value })}
              />
            </Labeled>
            <Labeled label={t("web.voice.voice.persona.failure")} hint={t("web.voice.voice.persona.failureHint")}>
              <TextInput
                aria-label={t("web.voice.voice.persona.failure")}
                value={draft().failureMessage}
                onInput={(e) => set({ ...draft(), failureMessage: e.currentTarget.value })}
              />
            </Labeled>
          </Cols>
        </Card>
        <Card title={t("web.voice.voice.persona.speak")} action={<span class="text-sm text-muted">{ttsLabel[tts().vendor]}</span>}>
          <Cols>
            <Labeled
              label={t("web.voice.voice.persona.tts")}
              hint={tts().vendor === "microsoft" ? t("web.voice.voice.microsoft") : t("web.voice.voice.hosted")}
            >
              <Segmented
                label={t("web.voice.voice.persona.tts")}
                testid="voice-tts"
                value={tts().vendor}
                options={options(ttsLabel)}
                onChange={(v) => set({ ...draft(), tts: v === tts().vendor ? tts() : ttsStart[v] })}
              />
            </Labeled>
            <Show when={tts().vendor === "minimax" ? (tts() as Extract<VoiceSettings["tts"], { vendor: "minimax" }>) : undefined}>
              {(narrowed) => (
                <Labeled label={t("web.voice.voice.persona.ttsModel")}>
                  <Segmented
                    label={t("web.voice.voice.persona.ttsModel")}
                    testid="voice-tts-model"
                    value={narrowed().model}
                    options={plain(VoiceTTSMinimaxModelValues)}
                    onChange={(model) => set({ ...draft(), tts: { ...narrowed(), model } })}
                  />
                </Labeled>
              )}
            </Show>
            <Show when={tts().vendor === "openai" ? (tts() as Extract<VoiceSettings["tts"], { vendor: "openai" }>) : undefined}>
              {(narrowed) => (
                <Labeled label={t("web.voice.voice.persona.voice")} hint={t("web.voice.voice.persona.openaiVoice")}>
                  <Segmented
                    label={t("web.voice.voice.persona.voice")}
                    testid="voice-voice"
                    value={narrowed().voice}
                    options={plain(VoiceValues)}
                    onChange={(voice) => set({ ...draft(), tts: { ...narrowed(), voice } })}
                  />
                </Labeled>
              )}
            </Show>
            <Show when={tts().vendor === "microsoft" ? (tts() as Extract<VoiceSettings["tts"], { vendor: "microsoft" }>) : undefined}>
              {(narrowed) => (
                <>
                  <Labeled label={t("web.voice.voice.azureArea")}>
                    <TextInput
                      aria-label={t("web.voice.voice.persona.ttsArea")}
                      class="font-mono"
                      value={narrowed().region}
                      onInput={(e) => set({ ...draft(), tts: { ...narrowed(), region: e.currentTarget.value } })}
                    />
                  </Labeled>
                  <Labeled label={t("web.voice.voice.persona.voice")} hint={t("web.voice.voice.persona.azureVoice")}>
                    <TextInput
                      aria-label={t("web.voice.voice.persona.microsoftVoice")}
                      class="font-mono"
                      list="microsoft-voices"
                      value={narrowed().voiceName}
                      onInput={(e) => set({ ...draft(), tts: { ...narrowed(), voiceName: e.currentTarget.value } })}
                    />
                    <datalist id="microsoft-voices">
                      <For each={microsoftVoices}>{(v) => <option value={v} />}</For>
                    </datalist>
                  </Labeled>
                  {secret("ttsKey", t("web.voice.voice.microsoftKey"), () => base().ttsKey)}
                </>
              )}
            </Show>
          </Cols>
          <Show when={tts().vendor === "minimax" ? (tts() as Extract<VoiceSettings["tts"], { vendor: "minimax" }>) : undefined}>
            {(narrowed) => (
              <>
                <Labeled label={t("web.voice.voice.persona.voice")} hint={t("web.voice.voice.persona.minimaxVoice")}>
                  <MiniMaxVoices value={narrowed().voiceId} onChange={(voiceId) => set({ ...draft(), tts: { ...narrowed(), voiceId } })} />
                </Labeled>
                <Cols>
                  <Labeled label={t("web.voice.voice.persona.voiceId")}>
                    <TextInput
                      aria-label={t("web.voice.voice.persona.voiceId")}
                      class="font-mono"
                      value={narrowed().voiceId}
                      onInput={(e) => set({ ...draft(), tts: { ...narrowed(), voiceId: e.currentTarget.value } })}
                    />
                  </Labeled>
                </Cols>
              </>
            )}
          </Show>
        </Card>
        {bar()}
      </div>
    </Show>
  );
}

function Cols(props: { children: JSX.Element }) {
  return <div class="grid gap-4 md:grid-cols-2">{props.children}</div>;
}

/** A label, what sits at its right (清掉), the control and a hint under it. */
function Labeled(props: { label: string; hint?: string; aside?: JSX.Element; children: JSX.Element }) {
  return (
    <div class="flex flex-col gap-1">
      <div class="flex items-center gap-1.5">
        <span class="text-xs font-medium text-muted">{props.label}</span>
        <Show when={props.hint}>{(h) => <Hint text={h()} />}</Show>
        <span class="flex-1" />
        {props.aside}
      </div>
      <div>{props.children}</div>
    </div>
  );
}

/** The MiniMax voices with a sample each: one plays at a time, pressed again it stops. */
function MiniMaxVoices(props: { value: string; onChange: (id: string) => void }) {
  const [playing, setPlaying] = createSignal<string>();
  let audio: HTMLAudioElement | undefined;
  onSettled(() => () => audio?.pause());
  const play = (id: string, src: string) => {
    audio?.pause();
    if (playing() === id) return setPlaying(undefined);
    const a = new Audio(src);
    audio = a;
    a.onended = a.onerror = () => setPlaying((p) => (p === id ? undefined : p));
    setPlaying(id);
    a.play().catch(() => setPlaying(undefined));
  };
  return (
    <div class="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
      <For each={minimaxVoices}>
        {(v) => {
          const sample = voiceSample(v.id);
          const chosen = () => v.id === props.value;
          return (
            <div class={["flex h-[34px] items-center rounded-md border", chosen() ? "border-ink/40 bg-selected" : "border-line bg-page"]}>
              <button
                type="button"
                disabled={!sample}
                title={sample ? t("web.voice.voice.persona.sample", { greeting: t("shared.greeting") }) : t("web.voice.voice.persona.noSample")}
                aria-label={playing() === v.id ? t("web.voice.voice.persona.stop", { name: v.label }) : t("web.voice.voice.persona.play", { name: v.label })}
                class="ml-0.5 inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded hover:bg-hover disabled:cursor-default disabled:opacity-50"
                onClick={() => sample && play(v.id, sample)}
              >
                <Icon name={playing() === v.id ? "stop" : "play"} size={16} />
              </button>
              <button
                type="button"
                title={v.id}
                aria-pressed={aria(chosen())}
                class={[
                  "h-full min-w-0 flex-1 cursor-pointer truncate pr-2 pl-1 text-left text-sm",
                  chosen() ? "font-semibold" : "text-bark-800 hover:text-ink",
                ]}
                onClick={() => props.onChange(v.id)}
              >
                {v.label}
              </button>
            </div>
          );
        }}
      </For>
    </div>
  );
}
