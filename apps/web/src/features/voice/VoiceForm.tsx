// 声音: the call's line on /settings/voice (credentials, how it listens, who answers, dictation) and the orchestrator's voice
// on /orchestrator/voice (what it says, in what voice). Each part saves only its own fields over the settings as they are
// now: the other part may have been saved meanwhile.

import { saveSettings } from "../../base/settings";
import { settingsWording } from "../setting/words";
import { wording } from "@vibevalley/protocol/words";
import { createSignal, For, Match, onSettled, Show, snapshot, Switch, untrack } from "solid-js";
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
import { Card, Quiet, SecretInput, TextLink } from "../../ui/layout";

type Key = "agoraAppId" | "agoraAppCertificate" | "asrKey" | "llmKey" | "ttsKey" | "dictationKey";

const keyFrom: Record<KeySource, string> = { settings: settingsWording().from.settings, config: settingsWording().from.config };

const options = <T extends string>(labels: Record<T, string>) => (Object.keys(labels) as T[]).map((value) => ({ value, label: labels[value] }));
const plain = <T extends string>(values: readonly T[]) => values.map((value) => ({ value, label: value }));

export function VoiceForm(props: { part: VoicePart }) {
  const settings = useSettings();
  return (
    <Show
      when={ready(settings, undefined)}
      fallback={<Quiet>{settings.error ? settingsWording().voice.noSettings(reasonOf(settings.error)) : settingsWording().asking}</Quiet>}
    >
      {(status) => <Keyed key={status().file}>{() => <Form status={untrack(status)} part={props.part} />}</Keyed>}
    </Show>
  );
}

/** What the server says is wrong with the draft, asked a moment after it last changed. */
function useProblem(update: () => SettingsUpdate) {
  const asked = createSettled(() => JSON.stringify(update()));
  const check = useQuery(() => ({
    queryKey: ["settings-check", asked()],
    queryFn: () => api.setting.check({ body: JSON.parse(asked()) as SettingsUpdate }),
    placeholderData: keepPreviousData,
  }));
  return () => ready(check, undefined)?.problem;
}

function Form(props: { status: SettingsStatus; part: VoicePart }) {
  // A plain copy: the form starts from it once, and reading the store's fields later would be untracked reads.
  const start = untrack(() => snapshot(props.status));
  const [draft, setDraft] = createSignal<VoiceSettings>(start.voice);
  const [appId, setAppId] = createSignal(start.agoraAppId.value ?? "");
  const [dictation, setDictation] = createSignal<Dictation>(start.dictation);
  const [secrets, setSecrets] = createSignal<Partial<Record<Key, string>>>({});
  const [cleared, setCleared] = createSignal<ReadonlySet<Key>>(new Set());
  const [error, setError] = createSignal<string>();
  const [saved, setSaved] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  // The settings as saved now: a save answers with them, and the form keeps the draft over them.
  const [base, setBase] = createSignal(start);

  const touched = () => setSaved(false);
  const set = (next: VoiceSettings) => {
    setDraft(next);
    touched();
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
      setSaved(true);
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

  const clearLink = (k: Key) => (
    <TextLink
      danger
      onClick={() => {
        setCleared(new Set([...cleared(), k]));
        touched();
      }}
    >
      {settingsWording().clear}
    </TextLink>
  );
  const secret = (k: Key, label: string, current: () => KeyStatus) => (
    <Labeled
      label={label}
      aside={current().source === "settings" && !cleared().has(k) ? clearLink(k) : undefined}
      hint={
        cleared().has(k)
          ? settingsWording().clearOnSave
          : current().source
            ? settingsWording().inUse(current().hint ?? "", keyFrom[current().source!])
            : settingsWording().none
      }
    >
      <SecretInput
        aria-label={label}
        placeholder={settingsWording().keepEmpty}
        value={secrets()[k] ?? ""}
        onInput={(e) => {
          setSecrets({ ...secrets(), [k]: e.currentTarget.value });
          touched();
        }}
      />
    </Labeled>
  );
  const number = (k: VoiceNumber) => (
    <Labeled label={numberLabel[k]} hint={settingsWording().voice.range(voiceLimits[k].min, voiceLimits[k].max, base().voiceDefaults[k])}>
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
    <div class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-page px-4 py-2.5">
      <Switch fallback={<p class="text-xs text-muted">{dirty() ? settingsWording().voice.dirty : settingsWording().voice.clean}</p>}>
        <Match when={error()}>
          <p class="text-sm text-berry">{error()}</p>
        </Match>
        <Match when={problem()}>
          <p class="text-sm text-berry">{problem()}</p>
        </Match>
        <Match when={saved()}>
          <p class="text-sm text-accent">{settingsWording().voice.saved}</p>
        </Match>
      </Switch>
      <div class="flex gap-2">
        <Button disabled={atDefaults()} onClick={() => set(withPart(props.part, draft(), base().voiceDefaults))}>
          {settingsWording().reset}
        </Button>
        <Button disabled={!dirty()} onClick={undo}>
          {settingsWording().voice.undo}
        </Button>
        <Button tone="primary" disabled={!dirty() || !!problem() || busy()} onClick={() => void submit()}>
          {busy() ? settingsWording().voice.saving : settingsWording().save}
        </Button>
      </div>
    </div>
  );

  const tts = () => draft().tts;
  const asr = () => draft().asr;
  const answer = () => draft().answer;
  const credentialsReady = () => base().agoraAppId.source !== undefined && base().agoraAppCertificate.source !== undefined;
  const answerHint = () =>
    answer().vendor === "orchestrator"
      ? settingsWording().voice.answer.orchestrator
      : answer().vendor === "agora"
        ? settingsWording().voice.answer.agora
        : answer().vendor === "deepseek"
          ? base().deepseekApiKey.source
            ? settingsWording().voice.answer.deepseek(keyFrom[base().deepseekApiKey.source!])
            : settingsWording().voice.answer.noDeepseek
          : settingsWording().voice.answer.openai;

  return (
    <Show
      when={props.part === "agent"}
      fallback={
        <div class="flex h-full min-h-0 flex-col gap-3">
          <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
            <div class="flex max-w-4xl flex-col gap-2 px-1 pt-1">
              <h2 class="text-xl font-semibold">{settingsWording().sections.voice.label}</h2>
              <p class="text-sm text-muted">
                {settingsWording().voice.intro}
                <A class="underline" href="/orchestrator/voice">
                  {settingsWording().voice.orchestratorPage}
                </A>
                。
              </p>
              <div class="flex flex-wrap items-center gap-2">
                <span class={["rounded px-1.5 py-0.5 text-xs", credentialsReady() ? "bg-[#e3efd2] text-[#3f6427]" : "bg-[#f6ddd8] text-berry"]}>
                  {credentialsReady() ? settingsWording().voice.ready : settingsWording().voice.missing}
                </span>
                <span class="text-xs text-muted">{settingsWording().voice.nextCall}</span>
                <span class="min-w-0 truncate font-mono text-xs text-muted" title={base().file}>
                  {base().file}
                </span>
              </div>
            </div>
            <Card
              title={settingsWording().voice.credentials}
              action={<TextLink href="https://console.agora.io/">{settingsWording().voice.console}</TextLink>}
              class="max-w-4xl"
            >
              <Cols>
                <Labeled
                  label="App ID"
                  aside={base().agoraAppId.source === "settings" && !cleared().has("agoraAppId") ? clearLink("agoraAppId") : undefined}
                  hint={
                    cleared().has("agoraAppId")
                      ? settingsWording().clearOnSave
                      : base().agoraAppId.source
                        ? keyFrom[base().agoraAppId.source!]
                        : settingsWording().none
                  }
                >
                  <TextInput
                    aria-label="Agora App ID"
                    class="font-mono"
                    placeholder={settingsWording().voice.hex}
                    value={appId()}
                    onInput={(e) => {
                      setAppId(e.currentTarget.value);
                      touched();
                    }}
                  />
                </Labeled>
                {secret("agoraAppCertificate", "App Certificate", () => base().agoraAppCertificate)}
                <Labeled label={settingsWording().voice.area} hint={settingsWording().voice.areaHint}>
                  <Segmented
                    label={settingsWording().voice.area}
                    value={draft().area}
                    options={AreaValues.map((a) => ({ value: a, label: areaLabel[a] }))}
                    onChange={(area) => set({ ...draft(), area })}
                  />
                </Labeled>
              </Cols>
            </Card>
            <Card
              title={settingsWording().voice.listen}
              action={<span class="text-sm text-muted">{settingsWording().voice.listenParts}</span>}
              class="max-w-4xl"
            >
              <Cols>
                <Labeled
                  label={settingsWording().voice.asr}
                  hint={asr().vendor === "microsoft" ? settingsWording().voice.microsoft : settingsWording().voice.hosted}
                >
                  <Segmented
                    label={settingsWording().voice.asr}
                    value={asr().vendor}
                    options={options(asrLabel)}
                    onChange={(v) => set({ ...draft(), asr: v === asr().vendor ? asr() : asrStart[v] })}
                  />
                </Labeled>
                <Labeled label={settingsWording().sections.language.label} hint={settingsWording().voice.languageHint}>
                  <Select
                    label={settingsWording().sections.language.label}
                    value={draft().language}
                    options={LanguageValues.map((l) => ({ value: l, label: `${languageLabel[l]}（${l}）` }))}
                    onChange={(l) => l && set({ ...draft(), language: l as VoiceSettings["language"] })}
                  />
                </Labeled>
                <Show when={asr().vendor === "deepgram" ? (asr() as Extract<VoiceSettings["asr"], { vendor: "deepgram" }>) : undefined}>
                  {(a) => (
                    <Labeled label={settingsWording().voice.deepgramModel}>
                      <Segmented
                        label={settingsWording().voice.deepgramModel}
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
                      <Labeled label={settingsWording().voice.azureArea} hint={settingsWording().voice.azureAreaHint}>
                        <TextInput
                          aria-label={settingsWording().voice.asrArea}
                          class="font-mono"
                          value={a().region}
                          onInput={(e) => set({ ...draft(), asr: { vendor: "microsoft", region: e.currentTarget.value } })}
                        />
                      </Labeled>
                      {secret("asrKey", settingsWording().voice.microsoftKey, () => base().asrKey)}
                    </>
                  )}
                </Show>
                {number("silenceMs")}
                {number("interruptMs")}
                {number("idleSeconds")}
              </Cols>
            </Card>
            <Card title={settingsWording().voice.think} action={<span class="text-sm text-muted">{answerLabel[answer().vendor]}</span>} class="max-w-4xl">
              <Labeled label={settingsWording().voice.who} hint={answerHint()}>
                <Segmented
                  label={settingsWording().voice.who}
                  value={answer().vendor}
                  options={options(answerLabel)}
                  onChange={(v) => set({ ...draft(), answer: v === answer().vendor ? answer() : answerStart[v] })}
                />
              </Labeled>
              <Show when={answer().vendor === "agora" ? (answer() as Extract<VoiceSettings["answer"], { vendor: "agora" }>) : undefined}>
                {(a) => (
                  <Labeled label={settingsWording().voice.model}>
                    <Segmented
                      label={settingsWording().voice.model}
                      value={a().model}
                      options={plain(VoiceAnswerAgoraModelValues)}
                      onChange={(model) => set({ ...draft(), answer: { vendor: "agora", model } })}
                    />
                  </Labeled>
                )}
              </Show>
              <Show when={answer().vendor === "deepseek" ? (answer() as Extract<VoiceSettings["answer"], { vendor: "deepseek" }>) : undefined}>
                {(a) => (
                  <Labeled label={settingsWording().voice.model} hint={settingsWording().voice.deepseekModel}>
                    <TextInput
                      aria-label={settingsWording().voice.deepseekModelLabel}
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
                    <Labeled label={settingsWording().lan.address} hint={settingsWording().voice.llmAddress}>
                      <TextInput
                        aria-label={settingsWording().voice.llmAddressLabel}
                        class="font-mono"
                        value={a().url}
                        onInput={(e) => set({ ...draft(), answer: { ...a(), url: e.currentTarget.value } })}
                      />
                    </Labeled>
                    <Labeled label={settingsWording().voice.model}>
                      <TextInput
                        aria-label={settingsWording().voice.llmModel}
                        class="font-mono"
                        value={a().model}
                        onInput={(e) => set({ ...draft(), answer: { ...a(), model: e.currentTarget.value } })}
                      />
                    </Labeled>
                    {secret("llmKey", settingsWording().voice.llmKey, () => base().llmKey)}
                  </Cols>
                )}
              </Show>
            </Card>
            <Card
              title={settingsWording().voice.dictation}
              action={<TextLink href="https://github.com/soniqo/speech-swift">{settingsWording().voice.speechServer}</TextLink>}
              class="max-w-4xl"
            >
              <p class="text-sm text-muted">{settingsWording().voice.dictationIntro}</p>
              <Cols>
                <Labeled label={settingsWording().lan.address} hint={settingsWording().voice.dictationAddress}>
                  <TextInput
                    aria-label={settingsWording().voice.dictationAddressLabel}
                    class="font-mono"
                    placeholder="http://127.0.0.1:8080/v1"
                    value={dictation().url}
                    onInput={(e) => {
                      setDictation({ ...dictation(), url: e.currentTarget.value });
                      touched();
                    }}
                  />
                </Labeled>
                <Labeled label={settingsWording().voice.model} hint={settingsWording().voice.dictationModel}>
                  <TextInput
                    aria-label={settingsWording().voice.dictationModelLabel}
                    class="font-mono"
                    placeholder="qwen3"
                    value={dictation().model}
                    onInput={(e) => {
                      setDictation({ ...dictation(), model: e.currentTarget.value });
                      touched();
                    }}
                  />
                </Labeled>
                {secret("dictationKey", settingsWording().voice.dictationKey, () => base().dictationKey)}
              </Cols>
            </Card>
          </div>
          <div class="max-w-4xl">{bar()}</div>
        </div>
      }
    >
      <div class="flex max-w-4xl flex-col gap-3">
        <p class="text-sm text-muted">
          {settingsWording().voice.persona.intro}
          <A class="underline" href="/settings/voice">
            {settingsWording().sections.voice.label}
          </A>
          {settingsWording().voice.persona.page}
        </p>
        <Card title={settingsWording().voice.persona.open} action={<span class="text-sm text-muted">{settingsWording().voice.persona.openParts}</span>}>
          {/* The persona is the quick model's only: the orchestrator answering is itself, with its own prompt. */}
          <Show when={answer().vendor !== "orchestrator"} fallback={<p class="text-sm text-muted">{settingsWording().voice.persona.ownCall}</p>}>
            <Labeled label={settingsWording().voice.persona.persona} hint={settingsWording().voice.persona.personaHint}>
              <TextArea
                aria-label={settingsWording().voice.persona.persona}
                rows={8}
                value={draft().persona}
                onInput={(e) => set({ ...draft(), persona: e.currentTarget.value })}
              />
            </Labeled>
          </Show>
          <Cols>
            <Labeled label={settingsWording().voice.persona.greeting} hint={settingsWording().voice.persona.greetingHint}>
              <TextInput
                aria-label={settingsWording().voice.persona.greeting}
                value={draft().greeting}
                onInput={(e) => set({ ...draft(), greeting: e.currentTarget.value })}
              />
            </Labeled>
            <Labeled label={settingsWording().voice.persona.failure} hint={settingsWording().voice.persona.failureHint}>
              <TextInput
                aria-label={settingsWording().voice.persona.failure}
                value={draft().failureMessage}
                onInput={(e) => set({ ...draft(), failureMessage: e.currentTarget.value })}
              />
            </Labeled>
          </Cols>
        </Card>
        <Card title={settingsWording().voice.persona.speak} action={<span class="text-sm text-muted">{ttsLabel[tts().vendor]}</span>}>
          <Cols>
            <Labeled
              label={settingsWording().voice.persona.tts}
              hint={tts().vendor === "microsoft" ? settingsWording().voice.microsoft : settingsWording().voice.hosted}
            >
              <Segmented
                label={settingsWording().voice.persona.tts}
                value={tts().vendor}
                options={options(ttsLabel)}
                onChange={(v) => set({ ...draft(), tts: v === tts().vendor ? tts() : ttsStart[v] })}
              />
            </Labeled>
            <Show when={tts().vendor === "minimax" ? (tts() as Extract<VoiceSettings["tts"], { vendor: "minimax" }>) : undefined}>
              {(t) => (
                <Labeled label={settingsWording().voice.persona.ttsModel}>
                  <Segmented
                    label={settingsWording().voice.persona.ttsModel}
                    value={t().model}
                    options={plain(VoiceTTSMinimaxModelValues)}
                    onChange={(model) => set({ ...draft(), tts: { ...t(), model } })}
                  />
                </Labeled>
              )}
            </Show>
            <Show when={tts().vendor === "openai" ? (tts() as Extract<VoiceSettings["tts"], { vendor: "openai" }>) : undefined}>
              {(t) => (
                <Labeled label={settingsWording().voice.persona.voice} hint={settingsWording().voice.persona.openaiVoice}>
                  <Segmented
                    label={settingsWording().voice.persona.voice}
                    value={t().voice}
                    options={plain(VoiceValues)}
                    onChange={(voice) => set({ ...draft(), tts: { ...t(), voice } })}
                  />
                </Labeled>
              )}
            </Show>
            <Show when={tts().vendor === "microsoft" ? (tts() as Extract<VoiceSettings["tts"], { vendor: "microsoft" }>) : undefined}>
              {(t) => (
                <>
                  <Labeled label={settingsWording().voice.azureArea}>
                    <TextInput
                      aria-label={settingsWording().voice.persona.ttsArea}
                      class="font-mono"
                      value={t().region}
                      onInput={(e) => set({ ...draft(), tts: { ...t(), region: e.currentTarget.value } })}
                    />
                  </Labeled>
                  <Labeled label={settingsWording().voice.persona.voice} hint={settingsWording().voice.persona.azureVoice}>
                    <TextInput
                      aria-label={settingsWording().voice.persona.microsoftVoice}
                      class="font-mono"
                      list="microsoft-voices"
                      value={t().voiceName}
                      onInput={(e) => set({ ...draft(), tts: { ...t(), voiceName: e.currentTarget.value } })}
                    />
                    <datalist id="microsoft-voices">
                      <For each={microsoftVoices}>{(v) => <option value={v} />}</For>
                    </datalist>
                  </Labeled>
                  {secret("ttsKey", settingsWording().voice.microsoftKey, () => base().ttsKey)}
                </>
              )}
            </Show>
          </Cols>
          <Show when={tts().vendor === "minimax" ? (tts() as Extract<VoiceSettings["tts"], { vendor: "minimax" }>) : undefined}>
            {(t) => (
              <>
                <Labeled label={settingsWording().voice.persona.voice} hint={settingsWording().voice.persona.minimaxVoice}>
                  <MiniMaxVoices value={t().voiceId} onChange={(voiceId) => set({ ...draft(), tts: { ...t(), voiceId } })} />
                </Labeled>
                <Cols>
                  <Labeled label={settingsWording().voice.persona.voiceId}>
                    <TextInput
                      aria-label={settingsWording().voice.persona.voiceId}
                      class="font-mono"
                      value={t().voiceId}
                      onInput={(e) => set({ ...draft(), tts: { ...t(), voiceId: e.currentTarget.value } })}
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
      <div class="flex items-center gap-2">
        <span class="flex-1 text-xs font-medium text-muted">{props.label}</span>
        {props.aside}
      </div>
      <div>{props.children}</div>
      <Show when={props.hint}>
        <span class="text-xs text-faint">{props.hint}</span>
      </Show>
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
                title={sample ? settingsWording().voice.persona.sample(wording().greeting) : settingsWording().voice.persona.noSample}
                aria-label={playing() === v.id ? settingsWording().voice.persona.stop(v.label) : settingsWording().voice.persona.play(v.label)}
                class="ml-0.5 inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded hover:bg-hover disabled:cursor-default disabled:opacity-40"
                onClick={() => sample && play(v.id, sample)}
              >
                <Icon name={playing() === v.id ? "button-stop" : "button-play"} size={16} />
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
