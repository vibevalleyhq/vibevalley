import type { JSX } from "@solidjs/web";
import { createSignal, For, onSettled, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import {
  type Area,
  type KeySource,
  type Language,
  type VoiceAnswer,
  type VoiceASR,
  voiceIdleSecondsMax,
  voiceIdleSecondsMin,
  voiceInterruptMsMax,
  voiceInterruptMsMin,
  type VoiceSettings,
  voiceSilenceMsMax,
  voiceSilenceMsMin,
  type VoiceTTS,
  VoiceTTSMinimaxModelValues,
  VoiceValues,
} from "@vibevalley/protocol";

import { aria, variant } from "#/base/dom.tsx";
import { Link as A } from "#/infra/router.ts";
import { TextArea, TextInput } from "#/ui/Field.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { Card } from "#/ui/layout.tsx";
import { Segmented } from "#/ui/Segmented.tsx";
import { Hint } from "#/ui/Tip.tsx";

export const areaLabel: Record<Area, string> = {
  US: t("web.voice.choices.area.US"),
  EU: t("web.voice.choices.area.EU"),
  AP: t("web.voice.choices.area.AP"),
  CN: t("web.voice.choices.area.CN"),
};
export const languageLabel: Record<Language, string> = {
  "zh-CN": t("web.voice.choices.language.zh-CN"),
  "zh-HK": t("web.voice.choices.language.zh-HK"),
  "zh-TW": t("web.voice.choices.language.zh-TW"),
  "en-US": t("web.voice.choices.language.en-US"),
  "ja-JP": t("web.voice.choices.language.ja-JP"),
  "ko-KR": t("web.voice.choices.language.ko-KR"),
};

export const asrLabel: Record<VoiceASR["vendor"], string> = {
  ares: t("web.voice.choices.asr.ares"),
  deepgram: "Deepgram",
  microsoft: t("web.voice.choices.asr.microsoft"),
};
export const answerLabel: Record<VoiceAnswer["vendor"], string> = {
  orchestrator: t("web.base.orchestrator"),
  moss: "MOSS Live",
  agora: t("web.voice.choices.answer.agora"),
  deepseek: "DeepSeek",
  openai: t("web.voice.choices.answer.openai"),
};
const ttsLabel: Record<VoiceTTS["vendor"], string> = {
  minimax: "MiniMax",
  openai: "OpenAI",
  microsoft: t("web.voice.choices.asr.microsoft"),
};

/** What each starts with when picked: the one in use if it is the same vendor, else these. */
export const asrStart: Record<VoiceASR["vendor"], VoiceASR> = {
  ares: { vendor: "ares" },
  deepgram: { vendor: "deepgram", model: "nova-3" },
  microsoft: { vendor: "microsoft", region: "eastasia" },
};
export const answerStart: Record<VoiceAnswer["vendor"], VoiceAnswer> = {
  orchestrator: { vendor: "orchestrator" },
  moss: { vendor: "moss" },
  agora: { vendor: "agora", model: "gpt-4.1-mini" },
  deepseek: { vendor: "deepseek", model: "deepseek-chat" },
  openai: { vendor: "openai", url: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini" },
};
const ttsStart: Record<VoiceTTS["vendor"], VoiceTTS> = {
  minimax: { vendor: "minimax", model: "speech_2_6_turbo", voiceId: "Chinese (Mandarin)_Gentle_Youth" },
  openai: { vendor: "openai", voice: "nova" },
  microsoft: { vendor: "microsoft", region: "eastasia", voiceName: "zh-CN-XiaoxiaoNeural" },
};

/** Any other id can be typed. */
const minimaxVoices = [
  { id: "Chinese (Mandarin)_Gentle_Youth", label: t("web.voice.choices.minimax.gentle") },
  { id: "male-qn-qingse", label: t("web.voice.choices.minimax.qingse") },
  { id: "male-qn-jingying", label: t("web.voice.choices.minimax.jingying") },
  { id: "male-qn-badao", label: t("web.voice.choices.minimax.badao") },
  { id: "male-qn-daxuesheng", label: t("web.voice.choices.minimax.student") },
  { id: "female-shaonv", label: t("web.voice.choices.minimax.girl") },
  { id: "female-yujie", label: t("web.voice.choices.minimax.yujie") },
  { id: "female-chengshu", label: t("web.voice.choices.minimax.mature") },
  { id: "female-tianmei", label: t("web.voice.choices.minimax.sweet") },
  { id: "presenter_male", label: t("web.voice.choices.minimax.presenterMale") },
  { id: "presenter_female", label: t("web.voice.choices.minimax.presenterFemale") },
  { id: "audiobook_male_1", label: t("web.voice.choices.minimax.audiobookMale") },
  { id: "audiobook_female_1", label: t("web.voice.choices.minimax.audiobookFemale") },
] as const;

/** Any other name can be typed. */
const microsoftVoices = ["zh-CN-XiaoxiaoNeural", "zh-CN-YunxiNeural", "zh-CN-XiaoyiNeural", "zh-CN-YunjianNeural", "en-US-JennyNeural", "en-US-GuyNeural"];

/** A MiniMax voice's sample in the repository (public/voice-samples): anything but letters, digits, _ and - is _. */
const voiceSample = (id: string) => (minimaxVoices.some((v) => v.id === id) ? `/voice-samples/${id.replace(/[^\w-]/gu, "_")}.mp3` : undefined);

export type VoiceNumber = "silenceMs" | "interruptMs" | "idleSeconds";

export const voiceLimits: Record<VoiceNumber, { min: number; max: number }> = {
  silenceMs: { min: voiceSilenceMsMin, max: voiceSilenceMsMax },
  interruptMs: { min: voiceInterruptMsMin, max: voiceInterruptMsMax },
  idleSeconds: { min: voiceIdleSecondsMin, max: voiceIdleSecondsMax },
};

export const numberLabel: Record<VoiceNumber, string> = {
  silenceMs: t("web.voice.choices.number.silenceMs"),
  interruptMs: t("web.voice.choices.number.interruptMs"),
  idleSeconds: t("web.voice.choices.number.idleSeconds"),
};

/** The line: credentials' area, how it listens and who answers. The agent: what it says and in what voice. */
export type VoicePart = "line" | "agent";

/** What Reset to defaults on one part touches, and what saving one part sends. */
export function withPart(part: VoicePart, onto: VoiceSettings, from: VoiceSettings): VoiceSettings {
  return part === "line"
    ? {
        ...onto,
        area: from.area,
        language: from.language,
        asr: from.asr,
        answer: from.answer,
        silenceMs: from.silenceMs,
        interruptMs: from.interruptMs,
        idleSeconds: from.idleSeconds,
      }
    : { ...onto, persona: from.persona, greeting: from.greeting, failureMessage: from.failureMessage, tts: from.tts };
}

export const keyFrom: Record<KeySource, string> = { settings: t("web.base.form.from.settings"), config: t("web.base.form.from.config") };

export const options = <T extends string>(values: readonly T[], labels: Record<T, string>) => values.map((value) => ({ value, label: labels[value] }));
export const plain = <T extends string>(values: readonly T[]) => values.map((value) => ({ value, label: value }));

export function Cols(props: { children: JSX.Element }) {
  return <div class="grid gap-4 md:grid-cols-2">{props.children}</div>;
}

/** A label, what sits at its right (clear), the control and a hint under it. */
export function Labeled(props: { label: string; hint?: string; aside?: JSX.Element; children: JSX.Element }) {
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

export function VoiceAgentSection(props: { draft: VoiceSettings; set: (next: VoiceSettings) => void; ttsKeyField: JSX.Element; bar: JSX.Element }) {
  const tts = () => props.draft.tts;
  const answer = () => props.draft.answer;
  return (
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
              value={props.draft.persona}
              onInput={(e) => props.set({ ...props.draft, persona: e.currentTarget.value })}
            />
          </Labeled>
        </Show>
        <Cols>
          <Labeled label={t("web.voice.voice.persona.greeting")} hint={t("web.voice.voice.persona.greetingHint")}>
            <TextInput
              data-testid="greeting"
              aria-label={t("web.voice.voice.persona.greeting")}
              value={props.draft.greeting}
              onInput={(e) => props.set({ ...props.draft, greeting: e.currentTarget.value })}
            />
          </Labeled>
          <Labeled label={t("web.voice.voice.persona.failure")} hint={t("web.voice.voice.persona.failureHint")}>
            <TextInput
              aria-label={t("web.voice.voice.persona.failure")}
              value={props.draft.failureMessage}
              onInput={(e) => props.set({ ...props.draft, failureMessage: e.currentTarget.value })}
            />
          </Labeled>
        </Cols>
      </Card>
      <Card title={t("web.voice.voice.persona.speak")} action={<span class="text-sm text-muted">{ttsLabel[tts().vendor]}</span>}>
        <Cols>
          <Labeled label={t("web.voice.voice.persona.tts")} hint={tts().vendor === "microsoft" ? t("web.voice.voice.microsoft") : t("web.voice.voice.hosted")}>
            <Segmented
              label={t("web.voice.voice.persona.tts")}
              testid="voice-tts"
              value={tts().vendor}
              options={options(["minimax", "openai", "microsoft"] as const, ttsLabel)}
              onChange={(v) => props.set({ ...props.draft, tts: v === tts().vendor ? tts() : ttsStart[v] })}
            />
          </Labeled>
          <Show when={variant(tts(), "vendor", "minimax")}>
            {(narrowed) => (
              <Labeled label={t("web.voice.voice.persona.ttsModel")}>
                <Segmented
                  label={t("web.voice.voice.persona.ttsModel")}
                  testid="voice-tts-model"
                  value={narrowed().model}
                  options={plain(VoiceTTSMinimaxModelValues)}
                  onChange={(model) => props.set({ ...props.draft, tts: { ...narrowed(), model } })}
                />
              </Labeled>
            )}
          </Show>
          <Show when={variant(tts(), "vendor", "openai")}>
            {(narrowed) => (
              <Labeled label={t("web.voice.voice.persona.voice")} hint={t("web.voice.voice.persona.openaiVoice")}>
                <Segmented
                  label={t("web.voice.voice.persona.voice")}
                  testid="voice-voice"
                  value={narrowed().voice}
                  options={plain(VoiceValues)}
                  onChange={(voice) => props.set({ ...props.draft, tts: { ...narrowed(), voice } })}
                />
              </Labeled>
            )}
          </Show>
          <Show when={variant(tts(), "vendor", "microsoft")}>
            {(narrowed) => (
              <>
                <Labeled label={t("web.voice.voice.azureArea")}>
                  <TextInput
                    aria-label={t("web.voice.voice.persona.ttsArea")}
                    class="font-mono"
                    value={narrowed().region}
                    onInput={(e) => props.set({ ...props.draft, tts: { ...narrowed(), region: e.currentTarget.value } })}
                  />
                </Labeled>
                <Labeled label={t("web.voice.voice.persona.voice")} hint={t("web.voice.voice.persona.azureVoice")}>
                  <TextInput
                    aria-label={t("web.voice.voice.persona.microsoftVoice")}
                    class="font-mono"
                    list="microsoft-voices"
                    value={narrowed().voiceName}
                    onInput={(e) => props.set({ ...props.draft, tts: { ...narrowed(), voiceName: e.currentTarget.value } })}
                  />
                  <datalist id="microsoft-voices">
                    <For each={microsoftVoices}>{(v) => <option value={v} />}</For>
                  </datalist>
                </Labeled>
                {props.ttsKeyField}
              </>
            )}
          </Show>
        </Cols>
        <Show when={variant(tts(), "vendor", "minimax")}>
          {(narrowed) => (
            <>
              <Labeled label={t("web.voice.voice.persona.voice")} hint={t("web.voice.voice.persona.minimaxVoice")}>
                <MiniMaxVoices value={narrowed().voiceId} onChange={(voiceId) => props.set({ ...props.draft, tts: { ...narrowed(), voiceId } })} />
              </Labeled>
              <Cols>
                <Labeled label={t("web.voice.voice.persona.voiceId")}>
                  <TextInput
                    aria-label={t("web.voice.voice.persona.voiceId")}
                    class="font-mono"
                    value={narrowed().voiceId}
                    onInput={(e) => props.set({ ...props.draft, tts: { ...narrowed(), voiceId: e.currentTarget.value } })}
                  />
                </Labeled>
              </Cols>
            </>
          )}
        </Show>
      </Card>
      {props.bar}
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
    <div class="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
      <For each={minimaxVoices}>
        {(v) => {
          const sample = voiceSample(v.id);
          const chosen = () => v.id === props.value;
          return (
            <div class={["flex h-8.5 items-center rounded-md border", chosen() ? "border-ink/40 bg-selected" : "border-line bg-page"]}>
              <button
                type="button"
                disabled={!sample}
                title={sample ? t("web.voice.voice.persona.sample", { greeting: t("shared.greeting") }) : t("web.voice.voice.persona.noSample")}
                aria-label={playing() === v.id ? t("web.voice.voice.persona.stop", { name: v.label }) : t("web.voice.voice.persona.play", { name: v.label })}
                class="ml-0.5 inline-flex w-7 h-7 shrink-0 cursor-pointer disabled:cursor-default items-center justify-center rounded-sm hover:bg-hover disabled:opacity-50"
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
