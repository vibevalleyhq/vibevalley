import { t } from "@vibevalley/i18n";
// The voice form's choices: what each stage offers, the limits on the numbers
// and what 恢复默认 on one part touches. Why settings cannot be saved is the server's answer (setting.validate).

import {
  type Area,
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
} from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";

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
  agora: t("web.voice.choices.answer.agora"),
  deepseek: "DeepSeek",
  openai: t("web.voice.choices.answer.openai"),
};
export const ttsLabel: Record<VoiceTTS["vendor"], string> = { minimax: "MiniMax", openai: "OpenAI", microsoft: t("web.voice.choices.asr.microsoft") };

/** What each starts with when picked: the one in use if it is the same vendor, else these. */
export const asrStart: Record<VoiceASR["vendor"], VoiceASR> = {
  ares: { vendor: "ares" },
  deepgram: { vendor: "deepgram", model: "nova-3" },
  microsoft: { vendor: "microsoft", region: "eastasia" },
};
export const answerStart: Record<VoiceAnswer["vendor"], VoiceAnswer> = {
  orchestrator: { vendor: "orchestrator" },
  agora: { vendor: "agora", model: "gpt-4.1-mini" },
  deepseek: { vendor: "deepseek", model: "deepseek-chat" },
  openai: { vendor: "openai", url: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini" },
};
export const ttsStart: Record<VoiceTTS["vendor"], VoiceTTS> = {
  minimax: { vendor: "minimax", model: "speech_2_6_turbo", voiceId: "Chinese (Mandarin)_Gentle_Youth" },
  openai: { vendor: "openai", voice: "nova" },
  microsoft: { vendor: "microsoft", region: "eastasia", voiceName: "zh-CN-XiaoxiaoNeural" },
};

/** Any other id can be typed. */
export const minimaxVoices = [
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
export const microsoftVoices = [
  "zh-CN-XiaoxiaoNeural",
  "zh-CN-YunxiNeural",
  "zh-CN-XiaoyiNeural",
  "zh-CN-YunjianNeural",
  "en-US-JennyNeural",
  "en-US-GuyNeural",
];

/** A MiniMax voice's sample in the repository (public/voice-samples): anything but letters, digits, _ and - is _. */
export const voiceSample = (id: string) => (minimaxVoices.some((v) => v.id === id) ? `/voice-samples/${id.replace(/[^\w-]/gu, "_")}.mp3` : undefined);

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

/** What 恢复默认 on one part touches, and what saving one part sends. */
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

export const sameVoice = (a: VoiceSettings, b: VoiceSettings) => same(a, b);
