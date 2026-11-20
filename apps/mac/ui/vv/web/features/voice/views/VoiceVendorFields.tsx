import { AudioPlayer, cleanup, signal, Text, View, windowSize, type JSX } from "nsh";

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

import audiobookFemale from "../../../../../assets/voice-samples/audiobook_female_1.mp3";
import audiobookMale from "../../../../../assets/voice-samples/audiobook_male_1.mp3";
import gentleYouth from "../../../../../assets/voice-samples/Chinese__Mandarin__Gentle_Youth.mp3";
import chengshu from "../../../../../assets/voice-samples/female-chengshu.mp3";
import shaonv from "../../../../../assets/voice-samples/female-shaonv.mp3";
import tianmei from "../../../../../assets/voice-samples/female-tianmei.mp3";
import yujie from "../../../../../assets/voice-samples/female-yujie.mp3";
import badao from "../../../../../assets/voice-samples/male-qn-badao.mp3";
import daxuesheng from "../../../../../assets/voice-samples/male-qn-daxuesheng.mp3";
import jingying from "../../../../../assets/voice-samples/male-qn-jingying.mp3";
import qingse from "../../../../../assets/voice-samples/male-qn-qingse.mp3";
import presenterFemale from "../../../../../assets/voice-samples/presenter_female.mp3";
import presenterMale from "../../../../../assets/voice-samples/presenter_male.mp3";
import { createContext, useContext } from "../../../../solid";
import { variant } from "../../../base/dom";
import { Link as A } from "../../../infra/router";
import { TextArea, TextInput } from "../../../ui/Field";
import { Icon } from "../../../ui/Icon";
import { Card } from "../../../ui/layout";
import { Segmented } from "../../../ui/Segmented";
import { Hint, Tip } from "../../../ui/Tip";
import { mix } from "../../../ui/tone";

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

/** Any other id can be typed; each has its sample. */
const minimaxVoices = [
  { id: "Chinese (Mandarin)_Gentle_Youth", label: t("web.voice.choices.minimax.gentle"), sample: gentleYouth },
  { id: "male-qn-qingse", label: t("web.voice.choices.minimax.qingse"), sample: qingse },
  { id: "male-qn-jingying", label: t("web.voice.choices.minimax.jingying"), sample: jingying },
  { id: "male-qn-badao", label: t("web.voice.choices.minimax.badao"), sample: badao },
  { id: "male-qn-daxuesheng", label: t("web.voice.choices.minimax.student"), sample: daxuesheng },
  { id: "female-shaonv", label: t("web.voice.choices.minimax.girl"), sample: shaonv },
  { id: "female-yujie", label: t("web.voice.choices.minimax.yujie"), sample: yujie },
  { id: "female-chengshu", label: t("web.voice.choices.minimax.mature"), sample: chengshu },
  { id: "female-tianmei", label: t("web.voice.choices.minimax.sweet"), sample: tianmei },
  { id: "presenter_male", label: t("web.voice.choices.minimax.presenterMale"), sample: presenterMale },
  { id: "presenter_female", label: t("web.voice.choices.minimax.presenterFemale"), sample: presenterFemale },
  { id: "audiobook_male_1", label: t("web.voice.choices.minimax.audiobookMale"), sample: audiobookMale },
  { id: "audiobook_female_1", label: t("web.voice.choices.minimax.audiobookFemale"), sample: audiobookFemale },
] as const;

/** Any other name can be typed. */
const microsoftVoices = ["zh-CN-XiaoxiaoNeural", "zh-CN-YunxiNeural", "zh-CN-XiaoyiNeural", "zh-CN-YunjianNeural", "en-US-JennyNeural", "en-US-GuyNeural"];

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

/** Whether a Labeled is a cell of Cols, or a whole row of its own as outside them. */
const InCols = createContext(false);

/** md:grid-cols-2: the cells wrap two to a row (each `Cell`), one under another when narrow. */
export function Cols(props: { children: JSX.Element }) {
  return (
    <InCols.Provider value={true}>
      <View class="flex-row flex-wrap gap-4">{props.children}</View>
    </InCols.Provider>
  );
}

/** One cell of Cols: half the row from md (a lone last cell too, as in a grid), else the whole row. */
export function Cell(props: { children: JSX.Element }) {
  return (
    <View class="min-w-0" style={{ width: windowSize().width >= 768 ? "48.5%" : "100%" }}>
      {props.children}
    </View>
  );
}

/** A label, what sits at its right (clear), the control and a hint under it; a cell of Cols. */
export function Labeled(props: { label: string; hint?: string; aside?: JSX.Element; children: JSX.Element }) {
  const body = (
    <View class="gap-1">
      <View class="flex-row items-center gap-1.5">
        <Text class="text-xs font-medium text-muted">{props.label}</Text>
        <If when={props.hint}>{(h) => <Hint text={h()} />}</If>
        <View class="flex-1" />
        {props.aside}
      </View>
      <View>{props.children}</View>
    </View>
  );
  return useContext(InCols) ? <Cell>{body}</Cell> : body;
}

export function VoiceAgentSection(props: { draft: VoiceSettings; set: (next: VoiceSettings) => void; ttsKeyField: JSX.Element; bar: JSX.Element }) {
  const tts = () => props.draft.tts;
  const answer = () => props.draft.answer;
  return (
    <View class="max-w-4xl gap-3">
      <View class="flex-row flex-wrap items-center">
        <Text class="text-sm text-muted">{t("web.voice.voice.persona.intro")}</Text>
        <A href="/settings/call">
          <Text class="text-sm text-muted underline">{t("web.voice.voice.section.label")}</Text>
        </A>
        <Text class="text-sm text-muted">{t("web.voice.voice.persona.page")}</Text>
      </View>
      <Card title={t("web.voice.voice.persona.open")} action={<Text class="text-sm text-muted">{t("web.voice.voice.persona.openParts")}</Text>}>
        {/* The persona is the quick model's only: the orchestrator answering is itself, with its own prompt. */}
        <If when={answer().vendor !== "orchestrator"} else={<Text class="text-sm text-muted">{t("web.voice.voice.persona.ownCall")}</Text>}>
          <Labeled label={t("web.voice.voice.persona.persona")} hint={t("web.voice.voice.persona.personaHint")}>
            <TextArea
              testID="persona"
              accessibilityLabel={t("web.voice.voice.persona.persona")}
              rows={8}
              value={props.draft.persona}
              onInput={(persona) => props.set({ ...props.draft, persona })}
            />
          </Labeled>
        </If>
        <Cols>
          <Labeled label={t("web.voice.voice.persona.greeting")} hint={t("web.voice.voice.persona.greetingHint")}>
            <TextInput
              testID="greeting"
              accessibilityLabel={t("web.voice.voice.persona.greeting")}
              value={props.draft.greeting}
              onInput={(greeting) => props.set({ ...props.draft, greeting })}
            />
          </Labeled>
          <Labeled label={t("web.voice.voice.persona.failure")} hint={t("web.voice.voice.persona.failureHint")}>
            <TextInput
              accessibilityLabel={t("web.voice.voice.persona.failure")}
              value={props.draft.failureMessage}
              onInput={(failureMessage) => props.set({ ...props.draft, failureMessage })}
            />
          </Labeled>
        </Cols>
      </Card>
      <Card title={t("web.voice.voice.persona.speak")} action={<Text class="text-sm text-muted">{ttsLabel[tts().vendor]}</Text>}>
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
          <If when={variant(tts(), "vendor", "minimax")}>
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
          </If>
          <If when={variant(tts(), "vendor", "openai")}>
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
          </If>
          <If when={variant(tts(), "vendor", "microsoft")}>
            {(narrowed) => (
              <>
                <Labeled label={t("web.voice.voice.azureArea")}>
                  <TextInput
                    accessibilityLabel={t("web.voice.voice.persona.ttsArea")}
                    class="font-mono"
                    value={narrowed().region}
                    onInput={(region) => props.set({ ...props.draft, tts: { ...narrowed(), region } })}
                  />
                </Labeled>
                <Labeled label={t("web.voice.voice.persona.voice")} hint={t("web.voice.voice.persona.azureVoice")}>
                  <View class="gap-1.5">
                    <TextInput
                      accessibilityLabel={t("web.voice.voice.persona.microsoftVoice")}
                      class="font-mono"
                      value={narrowed().voiceName}
                      onInput={(voiceName) => props.set({ ...props.draft, tts: { ...narrowed(), voiceName } })}
                    />
                    <View class="flex-row flex-wrap gap-1">
                      <Each of={microsoftVoices.filter((v) => v !== narrowed().voiceName)}>
                        {(v) => (
                          <View
                            role="button"
                            onPress={() => props.set({ ...props.draft, tts: { ...narrowed(), voiceName: v() } })}
                            class="rounded-sm px-1.5 py-0.5 hover:bg-hover"
                          >
                            <Text class="font-mono text-2xs text-muted">{v()}</Text>
                          </View>
                        )}
                      </Each>
                    </View>
                  </View>
                </Labeled>
                <Cell>{props.ttsKeyField}</Cell>
              </>
            )}
          </If>
        </Cols>
        <If when={variant(tts(), "vendor", "minimax")}>
          {(narrowed) => (
            <>
              <Labeled label={t("web.voice.voice.persona.voice")} hint={t("web.voice.voice.persona.minimaxVoice")}>
                <MiniMaxVoices value={narrowed().voiceId} onChange={(voiceId) => props.set({ ...props.draft, tts: { ...narrowed(), voiceId } })} />
              </Labeled>
              <Cols>
                <Labeled label={t("web.voice.voice.persona.voiceId")}>
                  <TextInput
                    accessibilityLabel={t("web.voice.voice.persona.voiceId")}
                    class="font-mono"
                    value={narrowed().voiceId}
                    onInput={(voiceId) => props.set({ ...props.draft, tts: { ...narrowed(), voiceId } })}
                  />
                </Labeled>
              </Cols>
            </>
          )}
        </If>
      </Card>
      {props.bar}
    </View>
  );
}

/** The MiniMax voices with a sample each: one plays at a time, pressed again it stops. */
function MiniMaxVoices(props: { value: string; onChange: (id: string) => void }) {
  const playing = signal<string | undefined>(undefined);
  let audio: AudioPlayer | undefined;
  const stop = () => {
    audio?.dispose();
    audio = undefined;
  };
  cleanup(stop);
  const play = (id: string, src: string) => {
    stop();
    if (playing() === id) return playing.set(undefined);
    try {
      const a = new AudioPlayer(src);
      audio = a;
      const done = () => {
        if (playing() === id) playing.set(undefined);
      };
      a.on("end", done);
      a.on("error", done);
      playing.set(id);
      a.play().catch(done);
    } catch {
      playing.set(undefined);
    }
  };
  return (
    <View testID="minimax-voices" class="flex-row flex-wrap gap-1.5">
      <Each of={minimaxVoices}>
        {(v) => {
          const chosen = () => v().id === props.value;
          return (
            <View
              class={`h-8.5 flex-row items-center rounded-md border ${chosen() ? "bg-selected" : "border-line bg-page"}`}
              style={{ width: windowSize().width >= 640 ? "32.4%" : "48.6%", ...(chosen() ? { borderColor: mix("ink", 0.4) } : {}) }}
            >
              <Tip text={t("web.voice.voice.persona.sample", { greeting: t("shared.greeting") })}>
                <View
                  role="button"
                  testID={`voice-sample-${v().id}`}
                  accessibilityLabel={
                    playing() === v().id ? t("web.voice.voice.persona.stop", { name: v().label }) : t("web.voice.voice.persona.play", { name: v().label })
                  }
                  class="ml-0.5 size-7 shrink-0 items-center justify-center rounded-sm hover:bg-hover"
                  onPress={() => play(v().id, v().sample)}
                >
                  <Icon name={playing() === v().id ? "stop" : "play"} size={16} />
                </View>
              </Tip>
              <View
                role="button"
                testID={`voice-pick-${v().id}`}
                accessibilityState={{ selected: chosen() }}
                class="h-full min-w-0 flex-1 justify-center pr-2 pl-1"
                onPress={() => props.onChange(v().id)}
              >
                <Text class={`truncate text-sm ${chosen() ? "font-semibold text-ink" : "text-bark-800 hover:text-ink"}`}>{v().label}</Text>
              </View>
            </View>
          );
        }}
      </Each>
    </View>
  );
}
