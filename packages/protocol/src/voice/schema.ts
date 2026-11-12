import { z } from "zod";

import type { Codec } from "../codec";
import { KeySource } from "../common/schema";
import * as T from "./shapes";

export const CallState = z.enum(T.CallStateValues) satisfies Codec<T.CallState>;

export const FactCallChanged = z.object({
  type: z.literal("callChanged"),
  at: z.number(),
  state: CallState,
  reason: z.string(),
}) satisfies Codec<T.FactCallChanged>;

export const VoiceCall = z.object({
  agentId: z.string(),
}) satisfies Codec<T.VoiceCall>;

export const AgoraGrant = z.object({
  appId: z.string(),
  channel: z.string(),
  uid: z.string(),
  token: z.string(),
}) satisfies Codec<T.AgoraGrant>;

export const AgoraAppID = z.object({
  source: KeySource.nullable(),
  value: z.exactOptional(z.string()),
}) satisfies Codec<T.AgoraAppID>;

const Area = z.enum(T.AreaValues) satisfies Codec<T.Area>;

const Language = z.enum(T.LanguageValues) satisfies Codec<T.Language>;

const VoiceASRAres = z.object({
  vendor: z.literal("ares"),
}) satisfies Codec<T.VoiceASRAres>;

const Model = z.enum(T.ModelValues) satisfies Codec<T.Model>;

const VoiceASRDeepgram = z.object({
  vendor: z.literal("deepgram"),
  model: Model,
}) satisfies Codec<T.VoiceASRDeepgram>;

const VoiceASRMicrosoft = z.object({
  vendor: z.literal("microsoft"),
  region: z.string(),
}) satisfies Codec<T.VoiceASRMicrosoft>;

const VoiceASR = z.discriminatedUnion("vendor", [VoiceASRAres, VoiceASRDeepgram, VoiceASRMicrosoft]) satisfies Codec<T.VoiceASR>;

const VoiceAnswerOrchestrator = z.object({
  vendor: z.literal("orchestrator"),
}) satisfies Codec<T.VoiceAnswerOrchestrator>;

const VoiceAnswerMoss = z.object({
  vendor: z.literal("moss"),
}) satisfies Codec<T.VoiceAnswerMoss>;

const VoiceAnswerAgoraModel = z.enum(T.VoiceAnswerAgoraModelValues) satisfies Codec<T.VoiceAnswerAgoraModel>;

const VoiceAnswerAgora = z.object({
  vendor: z.literal("agora"),
  model: VoiceAnswerAgoraModel,
}) satisfies Codec<T.VoiceAnswerAgora>;

const VoiceAnswerDeepseek = z.object({
  vendor: z.literal("deepseek"),
  model: z.string(),
}) satisfies Codec<T.VoiceAnswerDeepseek>;

const VoiceAnswerOpenai = z.object({
  vendor: z.literal("openai"),
  url: z.string(),
  model: z.string(),
}) satisfies Codec<T.VoiceAnswerOpenai>;

const VoiceAnswer = z.discriminatedUnion("vendor", [
  VoiceAnswerOrchestrator,
  VoiceAnswerMoss,
  VoiceAnswerAgora,
  VoiceAnswerDeepseek,
  VoiceAnswerOpenai,
]) satisfies Codec<T.VoiceAnswer>;

const VoiceTTSMinimaxModel = z.enum(T.VoiceTTSMinimaxModelValues) satisfies Codec<T.VoiceTTSMinimaxModel>;

const VoiceTTSMinimax = z.object({
  vendor: z.literal("minimax"),
  model: VoiceTTSMinimaxModel,
  voiceId: z.string(),
}) satisfies Codec<T.VoiceTTSMinimax>;

const Voice = z.enum(T.VoiceValues) satisfies Codec<T.Voice>;

const VoiceTTSOpenai = z.object({
  vendor: z.literal("openai"),
  voice: Voice,
}) satisfies Codec<T.VoiceTTSOpenai>;

const VoiceTTSMicrosoft = z.object({
  vendor: z.literal("microsoft"),
  region: z.string(),
  voiceName: z.string(),
}) satisfies Codec<T.VoiceTTSMicrosoft>;

const VoiceTTS = z.discriminatedUnion("vendor", [VoiceTTSMinimax, VoiceTTSOpenai, VoiceTTSMicrosoft]) satisfies Codec<T.VoiceTTS>;

export const VoiceSettings = z.object({
  area: Area,
  language: Language,
  asr: VoiceASR,
  answer: VoiceAnswer,
  tts: VoiceTTS,
  persona: z.string(),
  greeting: z.string(),
  failureMessage: z.string(),
  silenceMs: z.number(),
  interruptMs: z.number(),
  idleSeconds: z.number(),
}) satisfies Codec<T.VoiceSettings>;

const DictationVia = z.enum(T.DictationViaValues) satisfies Codec<T.DictationVia>;

export const Dictation = z.object({
  via: DictationVia,
  url: z.string(),
  model: z.string(),
}) satisfies Codec<T.Dictation>;

export const SettingsUpdateVoice = z.object({
  area: z.exactOptional(Area),
  language: z.exactOptional(Language),
  asr: z.exactOptional(VoiceASR),
  answer: z.exactOptional(VoiceAnswer),
  tts: z.exactOptional(VoiceTTS),
  persona: z.exactOptional(z.string()),
  greeting: z.exactOptional(z.string()),
  failureMessage: z.exactOptional(z.string()),
  silenceMs: z.exactOptional(z.number()),
  interruptMs: z.exactOptional(z.number()),
  idleSeconds: z.exactOptional(z.number()),
}) satisfies Codec<T.SettingsUpdateVoice>;

const renewRequestFields = { channel: z.string(), uid: z.string() };

export const VoiceGrantRenew = z.object(renewRequestFields) satisfies Codec<T.VoiceGrantRenew>;

export const DictateRequest = z.object({
  audio: z.string(),
  format: z.string(),
}) satisfies Codec<T.DictateRequest>;

export const Dictated = z.object({
  text: z.string(),
}) satisfies Codec<T.Dictated>;

export const VoiceSaid = z.object({
  agentId: z.string(),
  text: z.string(),
}) satisfies Codec<T.VoiceSaid>;

export const VoiceHeard = z.object({
  agentId: z.string(),
  text: z.string(),
  agent: z.exactOptional(z.string()),
  sendKey: z.exactOptional(z.string()),
}) satisfies Codec<T.VoiceHeard>;

export const VoiceCallStart = z.object({ ...renewRequestFields, about: z.exactOptional(z.string()) }) satisfies Codec<T.VoiceCallStart>;
