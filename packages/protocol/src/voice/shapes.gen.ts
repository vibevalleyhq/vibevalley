// Generated from crates/vibevalley-protocol/src/contract (vp run protocol:ts). Do not edit.

import type { KeySource } from "../common/shapes.gen";

export const CallStateValues = ["idle", "connecting", "live", "ending", "error"] as const;
export type CallState = (typeof CallStateValues)[number];

export type FactCallChanged = { "type": "callChanged", at: number, state: CallState, reason: string, };

export type VoiceCall = { agentId: string, };

export type AgoraGrant = { appId: string, channel: string, uid: string, token: string, };

export type AgoraAppID = { source: KeySource | null, value?: string, };

export const AreaValues = ["US", "EU", "AP", "CN"] as const;
export type Area = (typeof AreaValues)[number];

export const LanguageValues = ["zh-CN", "zh-HK", "zh-TW", "en-US", "ja-JP", "ko-KR"] as const;
export type Language = (typeof LanguageValues)[number];

export type VoiceASRAres = { "vendor": "ares", };

export const ModelValues = ["nova-2", "nova-3"] as const;
export type Model = (typeof ModelValues)[number];

export type VoiceASRDeepgram = { "vendor": "deepgram", model: Model, };

export type VoiceASRMicrosoft = { "vendor": "microsoft", region: string, };

/**
 * Told apart by `vendor`.
 */
export type VoiceASR = VoiceASRAres | VoiceASRDeepgram | VoiceASRMicrosoft;

export type VoiceAnswerOrchestrator = { "vendor": "orchestrator", };

export type VoiceAnswerMoss = { "vendor": "moss", };

export const VoiceAnswerAgoraModelValues = ["gpt-4o-mini", "gpt-4.1-mini", "gpt-5-nano", "gpt-5-mini"] as const;
export type VoiceAnswerAgoraModel = (typeof VoiceAnswerAgoraModelValues)[number];

export type VoiceAnswerAgora = { "vendor": "agora", model: VoiceAnswerAgoraModel, };

export type VoiceAnswerDeepseek = { "vendor": "deepseek", model: string, };

export type VoiceAnswerOpenai = { "vendor": "openai", url: string, model: string, };

/**
 * Told apart by `vendor`.
 */
export type VoiceAnswer = VoiceAnswerOrchestrator | VoiceAnswerMoss | VoiceAnswerAgora | VoiceAnswerDeepseek | VoiceAnswerOpenai;

export const VoiceTTSMinimaxModelValues = ["speech_2_6_turbo", "speech_2_8_turbo"] as const;
export type VoiceTTSMinimaxModel = (typeof VoiceTTSMinimaxModelValues)[number];

export type VoiceTTSMinimax = { "vendor": "minimax", model: VoiceTTSMinimaxModel, voiceId: string, };

export const VoiceValues = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"] as const;
export type Voice = (typeof VoiceValues)[number];

export type VoiceTTSOpenai = { "vendor": "openai", voice: Voice, };

export type VoiceTTSMicrosoft = { "vendor": "microsoft", region: string, voiceName: string, };

/**
 * Told apart by `vendor`.
 */
export type VoiceTTS = VoiceTTSMinimax | VoiceTTSOpenai | VoiceTTSMicrosoft;

export type VoiceSettings = { area: Area, language: Language, asr: VoiceASR, answer: VoiceAnswer, tts: VoiceTTS, persona: string, greeting: string, failureMessage: string, silenceMs: number, interruptMs: number, idleSeconds: number, };

export const DictationViaValues = ["moss", "own"] as const;
export type DictationVia = (typeof DictationViaValues)[number];

/**
 * url and model are the user's own address's; kept while MOSS is chosen, so switching back finds them.
 */
export type Dictation = { via: DictationVia, url: string, model: string, };

/**
 * A change to the voice settings: the keys it names.
 */
export type SettingsUpdateVoice = { area?: Area, language?: Language, asr?: VoiceASR, answer?: VoiceAnswer, tts?: VoiceTTS, persona?: string, greeting?: string, failureMessage?: string, silenceMs?: number, interruptMs?: number, idleSeconds?: number, };

export type VoiceGrantRenew = { channel: string, uid: string, };

export type DictateRequest = { audio: string, format: string, };

export type Dictated = { text: string, };

export type VoiceSaid = { agentId: string, text: string, };

export type VoiceHeard = { agentId: string, text: string, 
/**
 * The profile the user picked; absent for none.
 */
agent?: string, sendKey?: string, };

export type VoiceCallStart = { channel: string, uid: string, 
/**
 * The call answers a ring: what rang, which the orchestrator says first instead of the greeting.
 */
about?: string, };

export type VoiceHearInput = { text: string, agent?: string, sendKey?: string, };
