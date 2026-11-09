import type { KeySource } from "../common/shapes";

/** The Settings section a call's problem is fixed in (VoiceUnavailable.settings): its address under /settings. */
export const VoiceFixValues = ["models", "call", "moss", "dictation"] as const;
export type VoiceFix = (typeof VoiceFixValues)[number];

/** A page's line to MOSS Live: a WebSocket the server relays to wss://api.mosi.cn/v1/realtime with the saved key. */
export const mossLinePath = "/api/v1/voice/moss/line";
export const visionLinePath = "/api/v1/voice/vision/line";

export const voiceSilenceMsMin = 200;

export const voiceSilenceMsMax = 2000;

export const voiceInterruptMsMin = 80;

export const voiceInterruptMsMax = 1000;

export const voiceIdleSecondsMin = 10;

export const voiceIdleSecondsMax = 600;

export const CallStateValues = ["idle", "connecting", "live", "ending", "error"] as const;
export type CallState = (typeof CallStateValues)[number];

export interface FactCallChanged {
  type: "callChanged";
  at: number;
  state: CallState;
  reason: string;
}

export interface VoiceCall {
  agentId: string;
}

export interface AgoraGrant {
  appId: string;
  channel: string;
  uid: string;
  token: string;
}

/** MOSS uses the provider binding; own uses an explicitly configured compatible endpoint. */
export const DictationViaValues = ["moss", "own"] as const;
export type DictationVia = (typeof DictationViaValues)[number];

/** url and model are the owner's own address's; kept while MOSS is chosen, so switching back finds them. */
export interface Dictation {
  via: DictationVia;
  url: string;
  model: string;
}

export interface VoiceSettings {
  area: Area;
  language: Language;
  asr: VoiceASR;
  answer: VoiceAnswer;
  tts: VoiceTTS;
  persona: string;
  greeting: string;
  failureMessage: string;
  silenceMs: number;
  interruptMs: number;
  idleSeconds: number;
}

export interface AgoraAppID {
  source: KeySource | null;
  value?: string;
}

export const AreaValues = ["US", "EU", "AP", "CN"] as const;
export type Area = (typeof AreaValues)[number];

export const LanguageValues = ["zh-CN", "zh-HK", "zh-TW", "en-US", "ja-JP", "ko-KR"] as const;
export type Language = (typeof LanguageValues)[number];

/** Told apart by `vendor`. */
export type VoiceASR = VoiceASRAres | VoiceASRDeepgram | VoiceASRMicrosoft;

export interface VoiceASRAres {
  vendor: "ares";
}

export const ModelValues = ["nova-2", "nova-3"] as const;
export type Model = (typeof ModelValues)[number];

export interface VoiceASRDeepgram {
  vendor: "deepgram";
  model: Model;
}

export interface VoiceASRMicrosoft {
  vendor: "microsoft";
  region: string;
}

/** Told apart by `vendor`. */
export type VoiceAnswer = VoiceAnswerOrchestrator | VoiceAnswerMoss | VoiceAnswerAgora | VoiceAnswerDeepseek | VoiceAnswerOpenai;

export interface VoiceAnswerOrchestrator {
  vendor: "orchestrator";
}

export interface VoiceAnswerMoss {
  vendor: "moss";
}

export const VoiceAnswerAgoraModelValues = ["gpt-4o-mini", "gpt-4.1-mini", "gpt-5-nano", "gpt-5-mini"] as const;
export type VoiceAnswerAgoraModel = (typeof VoiceAnswerAgoraModelValues)[number];

export interface VoiceAnswerAgora {
  vendor: "agora";
  model: VoiceAnswerAgoraModel;
}

export interface VoiceAnswerDeepseek {
  vendor: "deepseek";
  model: string;
}

export interface VoiceAnswerOpenai {
  vendor: "openai";
  url: string;
  model: string;
}

/** Told apart by `vendor`. */
export type VoiceTTS = VoiceTTSMinimax | VoiceTTSOpenai | VoiceTTSMicrosoft;

export const VoiceTTSMinimaxModelValues = ["speech_2_6_turbo", "speech_2_8_turbo"] as const;
export type VoiceTTSMinimaxModel = (typeof VoiceTTSMinimaxModelValues)[number];

export interface VoiceTTSMinimax {
  vendor: "minimax";
  model: VoiceTTSMinimaxModel;
  voiceId: string;
}

export const VoiceValues = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"] as const;
export type Voice = (typeof VoiceValues)[number];

export interface VoiceTTSOpenai {
  vendor: "openai";
  voice: Voice;
}

export interface VoiceTTSMicrosoft {
  vendor: "microsoft";
  region: string;
  voiceName: string;
}

/** A change to the voice settings: the keys it names. */
export type SettingsUpdateVoice = Partial<VoiceSettings>;

export interface VoiceGrantRenew {
  channel: string;
  uid: string;
}

export interface DictateRequest {
  audio: string;
  format: string;
}

export interface Dictated {
  text: string;
}

export interface VoiceSaid {
  agentId: string;
  text: string;
}

export interface VoiceHeard {
  agentId: string;
  text: string;
  /** The profile the owner picked; absent for none. */
  agent?: string;
  sendKey?: string;
}

export interface VoiceCallStart extends VoiceGrantRenew {
  /** The call answers a ring: what rang, which the orchestrator says first instead of the greeting. */
  about?: string;
}
