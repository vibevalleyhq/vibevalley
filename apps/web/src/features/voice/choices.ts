// The voice form's choices: what each stage offers, the limits on the numbers
// and what 恢复默认 on one part touches. Why settings cannot be saved is the server's answer (setting.check).

import { voiceWording } from "./words";
import { appWording } from "../../base/words";
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
  US: voiceWording().choices.area.US,
  EU: voiceWording().choices.area.EU,
  AP: voiceWording().choices.area.AP,
  CN: voiceWording().choices.area.CN,
};
export const languageLabel: Record<Language, string> = {
  "zh-CN": voiceWording().choices.language["zh-CN"],
  "zh-HK": voiceWording().choices.language["zh-HK"],
  "zh-TW": voiceWording().choices.language["zh-TW"],
  "en-US": voiceWording().choices.language["en-US"],
  "ja-JP": voiceWording().choices.language["ja-JP"],
  "ko-KR": voiceWording().choices.language["ko-KR"],
};

export const asrLabel: Record<VoiceASR["vendor"], string> = {
  ares: voiceWording().choices.asr.ares,
  deepgram: "Deepgram",
  microsoft: voiceWording().choices.asr.microsoft,
};
export const answerLabel: Record<VoiceAnswer["vendor"], string> = {
  orchestrator: appWording().orchestrator,
  agora: voiceWording().choices.answer.agora,
  deepseek: "DeepSeek",
  openai: voiceWording().choices.answer.openai,
};
export const ttsLabel: Record<VoiceTTS["vendor"], string> = { minimax: "MiniMax", openai: "OpenAI", microsoft: voiceWording().choices.asr.microsoft };

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
  { id: "Chinese (Mandarin)_Gentle_Youth", label: voiceWording().choices.minimax.gentle },
  { id: "male-qn-qingse", label: voiceWording().choices.minimax.qingse },
  { id: "male-qn-jingying", label: voiceWording().choices.minimax.jingying },
  { id: "male-qn-badao", label: voiceWording().choices.minimax.badao },
  { id: "male-qn-daxuesheng", label: voiceWording().choices.minimax.student },
  { id: "female-shaonv", label: voiceWording().choices.minimax.girl },
  { id: "female-yujie", label: voiceWording().choices.minimax.yujie },
  { id: "female-chengshu", label: voiceWording().choices.minimax.mature },
  { id: "female-tianmei", label: voiceWording().choices.minimax.sweet },
  { id: "presenter_male", label: voiceWording().choices.minimax.presenterMale },
  { id: "presenter_female", label: voiceWording().choices.minimax.presenterFemale },
  { id: "audiobook_male_1", label: voiceWording().choices.minimax.audiobookMale },
  { id: "audiobook_female_1", label: voiceWording().choices.minimax.audiobookFemale },
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
export const voiceSample = (id: string) => (minimaxVoices.some((v) => v.id === id) ? `/voice-samples/${id.replace(/[^\w-]/g, "_")}.mp3` : undefined);

export type VoiceNumber = "silenceMs" | "interruptMs" | "idleSeconds";

export const voiceLimits: Record<VoiceNumber, { min: number; max: number }> = {
  silenceMs: { min: voiceSilenceMsMin, max: voiceSilenceMsMax },
  interruptMs: { min: voiceInterruptMsMin, max: voiceInterruptMsMax },
  idleSeconds: { min: voiceIdleSecondsMin, max: voiceIdleSecondsMax },
};

export const numberLabel: Record<VoiceNumber, string> = {
  silenceMs: voiceWording().choices.number.silenceMs,
  interruptMs: voiceWording().choices.number.interruptMs,
  idleSeconds: voiceWording().choices.number.idleSeconds,
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
