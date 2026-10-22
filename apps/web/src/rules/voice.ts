// The voice form's choices: what each stage offers, the limits on the numbers
// and what 恢复默认 on one part touches. Why settings cannot be saved is the server's answer (setting.check).

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

export const areaLabel: Record<Area, string> = { US: "美国", EU: "欧洲", AP: "亚太", CN: "中国大陆" };
export const languageLabel: Record<Language, string> = {
  "zh-CN": "普通话",
  "zh-HK": "粤语（香港）",
  "zh-TW": "中文（台湾）",
  "en-US": "英语（美国）",
  "ja-JP": "日语",
  "ko-KR": "韩语",
};

export const asrLabel: Record<VoiceASR["vendor"], string> = { ares: "声网 ARES", deepgram: "Deepgram", microsoft: "微软" };
export const answerLabel: Record<VoiceAnswer["vendor"], string> = { orchestrator: "农场的管家", agora: "声网托管", deepseek: "DeepSeek", openai: "自己的接口" };
export const ttsLabel: Record<VoiceTTS["vendor"], string> = { minimax: "MiniMax", openai: "OpenAI", microsoft: "微软" };

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
  { id: "Chinese (Mandarin)_Gentle_Youth", label: "温润青年" },
  { id: "male-qn-qingse", label: "青涩青年" },
  { id: "male-qn-jingying", label: "精英青年" },
  { id: "male-qn-badao", label: "霸道青年" },
  { id: "male-qn-daxuesheng", label: "青年大学生" },
  { id: "female-shaonv", label: "少女" },
  { id: "female-yujie", label: "御姐" },
  { id: "female-chengshu", label: "成熟女性" },
  { id: "female-tianmei", label: "甜美女性" },
  { id: "presenter_male", label: "男性主持人" },
  { id: "presenter_female", label: "女性主持人" },
  { id: "audiobook_male_1", label: "男性有声书" },
  { id: "audiobook_female_1", label: "女性有声书" },
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
  silenceMs: "停顿多久算说完（毫秒）",
  interruptMs: "说多久能打断他（毫秒）",
  idleSeconds: "没人时多久离开（秒）",
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
