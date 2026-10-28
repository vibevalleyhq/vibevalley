// 声音: the call's line on /settings/voice (credentials, how it listens, who answers, dictation) and the orchestrator's voice
// on /orchestrator/voice (what it says, in what voice). Each part saves only its own fields over the settings as they are
// now: the other part may have been saved meanwhile.

import { voiceWording } from "./words";
import { appWording } from "../../base/words";
import { saveSettings } from "../../base/settings";
import { wording } from "@vibevalley/protocol/words";
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

type Key = "agoraAppId" | "agoraAppCertificate" | "asrKey" | "llmKey" | "ttsKey" | "dictationKey";

const keyFrom: Record<KeySource, string> = { settings: appWording().form.from.settings, config: appWording().form.from.config };

const options = <T extends string>(labels: Record<T, string>) => (Object.keys(labels) as T[]).map((value) => ({ value, label: labels[value] }));
const plain = <T extends string>(values: readonly T[]) => values.map((value) => ({ value, label: value }));

export function VoiceForm(props: { part: VoicePart }) {
  const settings = useSettings();
  return (
    <Show
      when={ready(settings, undefined)}
      fallback={<Quiet>{settings.error ? voiceWording().voice.noSettings(reasonOf(settings.error)) : appWording().form.asking}</Quiet>}
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
    queryFn: () => api.setting.check(JSON.parse(asked()) as SettingsUpdate),
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
      toast(voiceWording().voice.saved);
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
        placeholder={appWording().form.keepEmpty}
        value={secrets()[k] ?? ""}
        onInput={(e) => {
          setSecrets({ ...secrets(), [k]: e.currentTarget.value });
        }}
      />
    </KeyField>
  );
  const number = (k: VoiceNumber) => (
    <Labeled label={numberLabel[k]} hint={voiceWording().voice.range(voiceLimits[k].min, voiceLimits[k].max, base().voiceDefaults[k])}>
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
      extra={
        <Button tone="quiet" disabled={atDefaults()} onClick={() => set(withPart(props.part, draft(), base().voiceDefaults))}>
          {appWording().form.reset}
        </Button>
      }
    />
  );

  const tts = () => draft().tts;
  const asr = () => draft().asr;
  const answer = () => draft().answer;
  const credentialsReady = () => base().agoraAppId.source !== undefined && base().agoraAppCertificate.source !== undefined;
  const answerHint = () =>
    answer().vendor === "orchestrator"
      ? voiceWording().voice.answer.orchestrator
      : answer().vendor === "agora"
        ? voiceWording().voice.answer.agora
        : answer().vendor === "deepseek"
          ? base().deepseekApiKey.source
            ? voiceWording().voice.answer.deepseek(keyFrom[base().deepseekApiKey.source!])
            : voiceWording().voice.answer.noDeepseek
          : voiceWording().voice.answer.openai;

  return (
    <Show
      when={props.part === "agent"}
      fallback={
        <div class="flex h-full min-h-0 flex-col gap-3">
          <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
            <div class="flex max-w-4xl items-center gap-2 px-1 pt-1">
              <h2 class="text-xl font-semibold">{voiceWording().voice.section.label}</h2>
              <Hint
                text={voiceWording().voice.intro + voiceWording().voice.orchestratorPage + voiceWording().voice.period + " " + voiceWording().voice.nextCall}
              />
              <span class={["rounded px-1.5 py-0.5 text-xs", credentialsReady() ? "bg-[#e3efd2] text-[#3f6427]" : "bg-[#f6ddd8] text-berry"]}>
                {credentialsReady() ? voiceWording().voice.ready : voiceWording().voice.missing}
              </span>
              <span class="flex-1" />
              <IconLink href="/orchestrator/voice" icon="agents" label={voiceWording().voice.orchestratorPage} />
              <Hint text={appWording().form.storedIn(base().file)} />
            </div>
            <Card
              title={voiceWording().voice.credentials}
              action={<IconLink href="https://console.agora.io/" label={voiceWording().voice.console} />}
              class="max-w-4xl"
            >
              <Cols>
                <KeyField small label="App ID" status={base().agoraAppId} removing={cleared().has("agoraAppId")} onRemove={remove("agoraAppId")}>
                  <TextInput
                    aria-label="Agora App ID"
                    class="font-mono"
                    placeholder={voiceWording().voice.hex}
                    value={appId()}
                    onInput={(e) => {
                      setAppId(e.currentTarget.value);
                    }}
                  />
                </KeyField>
                {secret("agoraAppCertificate", "App Certificate", () => base().agoraAppCertificate)}
                <Labeled label={voiceWording().voice.area} hint={voiceWording().voice.areaHint}>
                  <Segmented
                    label={voiceWording().voice.area}
                    value={draft().area}
                    options={AreaValues.map((a) => ({ value: a, label: areaLabel[a] }))}
                    onChange={(area) => set({ ...draft(), area })}
                  />
                </Labeled>
              </Cols>
            </Card>
            <Card title={voiceWording().voice.listen} action={<span class="text-sm text-muted">{voiceWording().voice.listenParts}</span>} class="max-w-4xl">
              <Cols>
                <Labeled label={voiceWording().voice.asr} hint={asr().vendor === "microsoft" ? voiceWording().voice.microsoft : voiceWording().voice.hosted}>
                  <Segmented
                    label={voiceWording().voice.asr}
                    value={asr().vendor}
                    options={options(asrLabel)}
                    onChange={(v) => set({ ...draft(), asr: v === asr().vendor ? asr() : asrStart[v] })}
                  />
                </Labeled>
                <Labeled label={voiceWording().voice.language} hint={voiceWording().voice.languageHint}>
                  <Select
                    label={voiceWording().voice.language}
                    value={draft().language}
                    options={LanguageValues.map((l) => ({ value: l, label: `${languageLabel[l]}（${l}）` }))}
                    onChange={(l) => l && set({ ...draft(), language: l as VoiceSettings["language"] })}
                  />
                </Labeled>
                <Show when={asr().vendor === "deepgram" ? (asr() as Extract<VoiceSettings["asr"], { vendor: "deepgram" }>) : undefined}>
                  {(a) => (
                    <Labeled label={voiceWording().voice.deepgramModel}>
                      <Segmented
                        label={voiceWording().voice.deepgramModel}
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
                      <Labeled label={voiceWording().voice.azureArea} hint={voiceWording().voice.azureAreaHint}>
                        <TextInput
                          aria-label={voiceWording().voice.asrArea}
                          class="font-mono"
                          value={a().region}
                          onInput={(e) => set({ ...draft(), asr: { vendor: "microsoft", region: e.currentTarget.value } })}
                        />
                      </Labeled>
                      {secret("asrKey", voiceWording().voice.microsoftKey, () => base().asrKey)}
                    </>
                  )}
                </Show>
                {number("silenceMs")}
                {number("interruptMs")}
                {number("idleSeconds")}
              </Cols>
            </Card>
            <Card title={voiceWording().voice.think} action={<span class="text-sm text-muted">{answerLabel[answer().vendor]}</span>} class="max-w-4xl">
              <Labeled label={voiceWording().voice.who} hint={answerHint()}>
                <Segmented
                  label={voiceWording().voice.who}
                  value={answer().vendor}
                  options={options(answerLabel)}
                  onChange={(v) => set({ ...draft(), answer: v === answer().vendor ? answer() : answerStart[v] })}
                />
              </Labeled>
              <Show when={answer().vendor === "agora" ? (answer() as Extract<VoiceSettings["answer"], { vendor: "agora" }>) : undefined}>
                {(a) => (
                  <Labeled label={voiceWording().voice.model}>
                    <Segmented
                      label={voiceWording().voice.model}
                      value={a().model}
                      options={plain(VoiceAnswerAgoraModelValues)}
                      onChange={(model) => set({ ...draft(), answer: { vendor: "agora", model } })}
                    />
                  </Labeled>
                )}
              </Show>
              <Show when={answer().vendor === "deepseek" ? (answer() as Extract<VoiceSettings["answer"], { vendor: "deepseek" }>) : undefined}>
                {(a) => (
                  <Labeled label={voiceWording().voice.model} hint={voiceWording().voice.deepseekModel}>
                    <TextInput
                      aria-label={voiceWording().voice.deepseekModelLabel}
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
                    <Labeled label={voiceWording().voice.address} hint={voiceWording().voice.llmAddress}>
                      <TextInput
                        aria-label={voiceWording().voice.llmAddressLabel}
                        class="font-mono"
                        value={a().url}
                        onInput={(e) => set({ ...draft(), answer: { ...a(), url: e.currentTarget.value } })}
                      />
                    </Labeled>
                    <Labeled label={voiceWording().voice.model}>
                      <TextInput
                        aria-label={voiceWording().voice.llmModel}
                        class="font-mono"
                        value={a().model}
                        onInput={(e) => set({ ...draft(), answer: { ...a(), model: e.currentTarget.value } })}
                      />
                    </Labeled>
                    {secret("llmKey", voiceWording().voice.llmKey, () => base().llmKey)}
                  </Cols>
                )}
              </Show>
            </Card>
            <Card
              title={voiceWording().voice.dictation}
              action={<IconLink href="https://github.com/soniqo/speech-swift" label={voiceWording().voice.speechServer} />}
              class="max-w-4xl"
            >
              <p class="text-sm text-muted">{voiceWording().voice.dictationIntro}</p>
              <Cols>
                <Labeled label={voiceWording().voice.address} hint={voiceWording().voice.dictationAddress}>
                  <TextInput
                    aria-label={voiceWording().voice.dictationAddressLabel}
                    class="font-mono"
                    placeholder="http://127.0.0.1:8080/v1"
                    value={dictation().url}
                    onInput={(e) => {
                      setDictation({ ...dictation(), url: e.currentTarget.value });
                    }}
                  />
                </Labeled>
                <Labeled label={voiceWording().voice.model} hint={voiceWording().voice.dictationModel}>
                  <TextInput
                    aria-label={voiceWording().voice.dictationModelLabel}
                    class="font-mono"
                    placeholder="qwen3"
                    value={dictation().model}
                    onInput={(e) => {
                      setDictation({ ...dictation(), model: e.currentTarget.value });
                    }}
                  />
                </Labeled>
                {secret("dictationKey", voiceWording().voice.dictationKey, () => base().dictationKey)}
              </Cols>
            </Card>
          </div>
          <div class="max-w-4xl">{bar()}</div>
        </div>
      }
    >
      <div class="flex max-w-4xl flex-col gap-3">
        <p class="text-sm text-muted">
          {voiceWording().voice.persona.intro}
          <A class="underline" href="/settings/voice">
            {voiceWording().voice.section.label}
          </A>
          {voiceWording().voice.persona.page}
        </p>
        <Card title={voiceWording().voice.persona.open} action={<span class="text-sm text-muted">{voiceWording().voice.persona.openParts}</span>}>
          {/* The persona is the quick model's only: the orchestrator answering is itself, with its own prompt. */}
          <Show when={answer().vendor !== "orchestrator"} fallback={<p class="text-sm text-muted">{voiceWording().voice.persona.ownCall}</p>}>
            <Labeled label={voiceWording().voice.persona.persona} hint={voiceWording().voice.persona.personaHint}>
              <TextArea
                aria-label={voiceWording().voice.persona.persona}
                rows={8}
                value={draft().persona}
                onInput={(e) => set({ ...draft(), persona: e.currentTarget.value })}
              />
            </Labeled>
          </Show>
          <Cols>
            <Labeled label={voiceWording().voice.persona.greeting} hint={voiceWording().voice.persona.greetingHint}>
              <TextInput
                aria-label={voiceWording().voice.persona.greeting}
                value={draft().greeting}
                onInput={(e) => set({ ...draft(), greeting: e.currentTarget.value })}
              />
            </Labeled>
            <Labeled label={voiceWording().voice.persona.failure} hint={voiceWording().voice.persona.failureHint}>
              <TextInput
                aria-label={voiceWording().voice.persona.failure}
                value={draft().failureMessage}
                onInput={(e) => set({ ...draft(), failureMessage: e.currentTarget.value })}
              />
            </Labeled>
          </Cols>
        </Card>
        <Card title={voiceWording().voice.persona.speak} action={<span class="text-sm text-muted">{ttsLabel[tts().vendor]}</span>}>
          <Cols>
            <Labeled
              label={voiceWording().voice.persona.tts}
              hint={tts().vendor === "microsoft" ? voiceWording().voice.microsoft : voiceWording().voice.hosted}
            >
              <Segmented
                label={voiceWording().voice.persona.tts}
                value={tts().vendor}
                options={options(ttsLabel)}
                onChange={(v) => set({ ...draft(), tts: v === tts().vendor ? tts() : ttsStart[v] })}
              />
            </Labeled>
            <Show when={tts().vendor === "minimax" ? (tts() as Extract<VoiceSettings["tts"], { vendor: "minimax" }>) : undefined}>
              {(narrowed) => (
                <Labeled label={voiceWording().voice.persona.ttsModel}>
                  <Segmented
                    label={voiceWording().voice.persona.ttsModel}
                    value={narrowed().model}
                    options={plain(VoiceTTSMinimaxModelValues)}
                    onChange={(model) => set({ ...draft(), tts: { ...narrowed(), model } })}
                  />
                </Labeled>
              )}
            </Show>
            <Show when={tts().vendor === "openai" ? (tts() as Extract<VoiceSettings["tts"], { vendor: "openai" }>) : undefined}>
              {(narrowed) => (
                <Labeled label={voiceWording().voice.persona.voice} hint={voiceWording().voice.persona.openaiVoice}>
                  <Segmented
                    label={voiceWording().voice.persona.voice}
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
                  <Labeled label={voiceWording().voice.azureArea}>
                    <TextInput
                      aria-label={voiceWording().voice.persona.ttsArea}
                      class="font-mono"
                      value={narrowed().region}
                      onInput={(e) => set({ ...draft(), tts: { ...narrowed(), region: e.currentTarget.value } })}
                    />
                  </Labeled>
                  <Labeled label={voiceWording().voice.persona.voice} hint={voiceWording().voice.persona.azureVoice}>
                    <TextInput
                      aria-label={voiceWording().voice.persona.microsoftVoice}
                      class="font-mono"
                      list="microsoft-voices"
                      value={narrowed().voiceName}
                      onInput={(e) => set({ ...draft(), tts: { ...narrowed(), voiceName: e.currentTarget.value } })}
                    />
                    <datalist id="microsoft-voices">
                      <For each={microsoftVoices}>{(v) => <option value={v} />}</For>
                    </datalist>
                  </Labeled>
                  {secret("ttsKey", voiceWording().voice.microsoftKey, () => base().ttsKey)}
                </>
              )}
            </Show>
          </Cols>
          <Show when={tts().vendor === "minimax" ? (tts() as Extract<VoiceSettings["tts"], { vendor: "minimax" }>) : undefined}>
            {(narrowed) => (
              <>
                <Labeled label={voiceWording().voice.persona.voice} hint={voiceWording().voice.persona.minimaxVoice}>
                  <MiniMaxVoices value={narrowed().voiceId} onChange={(voiceId) => set({ ...draft(), tts: { ...narrowed(), voiceId } })} />
                </Labeled>
                <Cols>
                  <Labeled label={voiceWording().voice.persona.voiceId}>
                    <TextInput
                      aria-label={voiceWording().voice.persona.voiceId}
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
                title={sample ? voiceWording().voice.persona.sample(wording().greeting) : voiceWording().voice.persona.noSample}
                aria-label={playing() === v.id ? voiceWording().voice.persona.stop(v.label) : voiceWording().voice.persona.play(v.label)}
                class="ml-0.5 inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded hover:bg-hover disabled:cursor-default disabled:opacity-40"
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
