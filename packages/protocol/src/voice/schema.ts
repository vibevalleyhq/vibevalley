import { Schema } from "effect";

import type { Codec } from "../codec";
import { KeySource } from "../common/schema";
import * as T from "../shapes";

export const CallState: Codec<T.CallState> = Schema.Literals(T.CallStateValues);

export const FactCallChanged: Codec<T.FactCallChanged> = Schema.Struct({
  type: Schema.Literal("callChanged"),
  at: Schema.Finite,
  state: CallState,
  reason: Schema.String,
});

export const VoiceCall: Codec<T.VoiceCall> = Schema.Struct({
  agentId: Schema.String,
});

export const AgoraGrant: Codec<T.AgoraGrant> = Schema.Struct({
  appId: Schema.String,
  channel: Schema.String,
  uid: Schema.String,
  token: Schema.String,
});

export const AgoraAppID: Codec<T.AgoraAppID> = Schema.Struct({
  source: Schema.optionalKey(KeySource),
  value: Schema.optionalKey(Schema.String),
});

export const Area: Codec<T.Area> = Schema.Literals(T.AreaValues);

export const Language: Codec<T.Language> = Schema.Literals(T.LanguageValues);

export const VoiceASRAres: Codec<T.VoiceASRAres> = Schema.Struct({
  vendor: Schema.Literal("ares"),
});

export const Model: Codec<T.Model> = Schema.Literals(T.ModelValues);

export const VoiceASRDeepgram: Codec<T.VoiceASRDeepgram> = Schema.Struct({
  vendor: Schema.Literal("deepgram"),
  model: Model,
});

export const VoiceASRMicrosoft: Codec<T.VoiceASRMicrosoft> = Schema.Struct({
  vendor: Schema.Literal("microsoft"),
  region: Schema.String,
});

export const VoiceASR: Codec<T.VoiceASR> = Schema.Union([VoiceASRAres, VoiceASRDeepgram, VoiceASRMicrosoft]);

export const VoiceAnswerOrchestrator: Codec<T.VoiceAnswerOrchestrator> = Schema.Struct({
  vendor: Schema.Literal("orchestrator"),
});

export const VoiceAnswerMoss: Codec<T.VoiceAnswerMoss> = Schema.Struct({
  vendor: Schema.Literal("moss"),
});

export const VoiceAnswerAgoraModel: Codec<T.VoiceAnswerAgoraModel> = Schema.Literals(T.VoiceAnswerAgoraModelValues);

export const VoiceAnswerAgora: Codec<T.VoiceAnswerAgora> = Schema.Struct({
  vendor: Schema.Literal("agora"),
  model: VoiceAnswerAgoraModel,
});

export const VoiceAnswerDeepseek: Codec<T.VoiceAnswerDeepseek> = Schema.Struct({
  vendor: Schema.Literal("deepseek"),
  model: Schema.String,
});

export const VoiceAnswerOpenai: Codec<T.VoiceAnswerOpenai> = Schema.Struct({
  vendor: Schema.Literal("openai"),
  url: Schema.String,
  model: Schema.String,
});

export const VoiceAnswer: Codec<T.VoiceAnswer> = Schema.Union([
  VoiceAnswerOrchestrator,
  VoiceAnswerMoss,
  VoiceAnswerAgora,
  VoiceAnswerDeepseek,
  VoiceAnswerOpenai,
]);

export const VoiceTTSMinimaxModel: Codec<T.VoiceTTSMinimaxModel> = Schema.Literals(T.VoiceTTSMinimaxModelValues);

export const VoiceTTSMinimax: Codec<T.VoiceTTSMinimax> = Schema.Struct({
  vendor: Schema.Literal("minimax"),
  model: VoiceTTSMinimaxModel,
  voiceId: Schema.String,
});

export const Voice: Codec<T.Voice> = Schema.Literals(T.VoiceValues);

export const VoiceTTSOpenai: Codec<T.VoiceTTSOpenai> = Schema.Struct({
  vendor: Schema.Literal("openai"),
  voice: Voice,
});

export const VoiceTTSMicrosoft: Codec<T.VoiceTTSMicrosoft> = Schema.Struct({
  vendor: Schema.Literal("microsoft"),
  region: Schema.String,
  voiceName: Schema.String,
});

export const VoiceTTS: Codec<T.VoiceTTS> = Schema.Union([VoiceTTSMinimax, VoiceTTSOpenai, VoiceTTSMicrosoft]);

export const VoiceSettings: Codec<T.VoiceSettings> = Schema.Struct({
  area: Area,
  language: Language,
  asr: VoiceASR,
  answer: VoiceAnswer,
  tts: VoiceTTS,
  persona: Schema.String,
  greeting: Schema.String,
  failureMessage: Schema.String,
  silenceMs: Schema.Finite,
  interruptMs: Schema.Finite,
  idleSeconds: Schema.Finite,
});

export const DictationVia: Codec<T.DictationVia> = Schema.Literals(T.DictationViaValues);

export const Dictation: Codec<T.Dictation> = Schema.Struct({
  via: DictationVia,
  url: Schema.String,
  model: Schema.String,
});

export const SettingsUpdateVoice: Codec<T.SettingsUpdateVoice> = Schema.Struct({
  area: Schema.optionalKey(Area),
  language: Schema.optionalKey(Language),
  asr: Schema.optionalKey(VoiceASR),
  answer: Schema.optionalKey(VoiceAnswer),
  tts: Schema.optionalKey(VoiceTTS),
  persona: Schema.optionalKey(Schema.String),
  greeting: Schema.optionalKey(Schema.String),
  failureMessage: Schema.optionalKey(Schema.String),
  silenceMs: Schema.optionalKey(Schema.Finite),
  interruptMs: Schema.optionalKey(Schema.Finite),
  idleSeconds: Schema.optionalKey(Schema.Finite),
});

export const MossVerifyRequest: Codec<T.MossVerifyRequest> = Schema.Struct({ key: Schema.optionalKey(Schema.String) });

const renewRequestFields = { channel: Schema.String, uid: Schema.String };

export const VoiceGrantRenew: Codec<T.VoiceGrantRenew> = Schema.Struct(renewRequestFields);

export const DictateRequest: Codec<T.DictateRequest> = Schema.Struct({
  audio: Schema.String,
  format: Schema.String,
});

export const Dictated: Codec<T.Dictated> = Schema.Struct({
  text: Schema.String,
});

export const VoiceSaid: Codec<T.VoiceSaid> = Schema.Struct({
  agentId: Schema.String,
  text: Schema.String,
});

export const VoiceHeard: Codec<T.VoiceHeard> = Schema.Struct({
  agentId: Schema.String,
  text: Schema.String,
  agent: Schema.optionalKey(Schema.String),
  sendKey: Schema.optionalKey(Schema.String),
});

export const VoiceCallStart: Codec<T.VoiceCallStart> = Schema.Struct({ ...renewRequestFields, about: Schema.optionalKey(Schema.String) });
