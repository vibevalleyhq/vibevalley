// The voice form's choices: what each stage offers, the limits on the numbers
// and what 恢复默认 on one part touches. Why settings cannot be saved is the server's answer (setting.check).

import { rulesWording } from "../../base/words/rules";
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
  US: rulesWording().voice.area.US,
  EU: rulesWording().voice.area.EU,
  AP: rulesWording().voice.area.AP,
  CN: rulesWording().voice.area.CN,
};
export const languageLabel: Record<Language, string> = {
  "zh-CN": rulesWording().voice.language["zh-CN"],
  "zh-HK": rulesWording().voice.language["zh-HK"],
  "zh-TW": rulesWording().voice.language["zh-TW"],
  "en-US": rulesWording().voice.language["en-US"],
  "ja-JP": rulesWording().voice.language["ja-JP"],
  "ko-KR": rulesWording().voice.language["ko-KR"],
};

export const asrLabel: Record<VoiceASR["vendor"], string> = {
  ares: rulesWording().voice.asr.ares,
  deepgram: "Deepgram",
  microsoft: rulesWording().voice.asr.microsoft,
};
export const answerLabel: Record<VoiceAnswer["vendor"], string> = {
  orchestrator: rulesWording().card.orchestrator,
  agora: rulesWording().voice.answer.agora,
  deepseek: "DeepSeek",
  openai: rulesWording().voice.answer.openai,
};
export const ttsLabel: Record<VoiceTTS["vendor"], string> = { minimax: "MiniMax", openai: "OpenAI", microsoft: rulesWording().voice.asr.microsoft };

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
  { id: "Chinese (Mandarin)_Gentle_Youth", label: rulesWording().voice.minimax.gentle },
  { id: "male-qn-qingse", label: rulesWording().voice.minimax.qingse },
  { id: "male-qn-jingying", label: rulesWording().voice.minimax.jingying },
  { id: "male-qn-badao", label: rulesWording().voice.minimax.badao },
  { id: "male-qn-daxuesheng", label: rulesWording().voice.minimax.student },
  { id: "female-shaonv", label: rulesWording().voice.minimax.girl },
  { id: "female-yujie", label: rulesWording().voice.minimax.yujie },
  { id: "female-chengshu", label: rulesWording().voice.minimax.mature },
  { id: "female-tianmei", label: rulesWording().voice.minimax.sweet },
  { id: "presenter_male", label: rulesWording().voice.minimax.presenterMale },
  { id: "presenter_female", label: rulesWording().voice.minimax.presenterFemale },
  { id: "audiobook_male_1", label: rulesWording().voice.minimax.audiobookMale },
  { id: "audiobook_female_1", label: rulesWording().voice.minimax.audiobookFemale },
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
  silenceMs: rulesWording().voice.number.silenceMs,
  interruptMs: rulesWording().voice.number.interruptMs,
  idleSeconds: rulesWording().voice.number.idleSeconds,
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
