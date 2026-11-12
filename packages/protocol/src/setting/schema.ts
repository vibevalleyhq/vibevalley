import { z } from "zod";

import type { Codec } from "../codec";
import { KeyStatus, Locale } from "../common/schema";
import { AgoraAppID, Dictation, SettingsUpdateVoice, VoiceSettings } from "../voice/schema";
import * as T from "./shapes";

export const MemorySourceInfo = z.object({
  name: z.string(),
  label: z.string(),
  on: z.boolean(),
  off: z.string(),
  canList: z.boolean(),
  canForget: z.boolean(),
  transcripts: z.boolean(),
}) satisfies Codec<T.MemorySourceInfo>;

export const MemorySourceKind = z.enum(T.MemorySourceKindValues) satisfies Codec<T.MemorySourceKind>;

const MemorySource = z.object({
  kind: MemorySourceKind,
  url: z.string(),
  enabled: z.boolean(),
  read: z.boolean(),
  write: z.boolean(),
  everything: z.boolean(),
  user: z.exactOptional(z.string()),
  key: KeyStatus,
}) satisfies Codec<T.MemorySource>;

const SpacePaths = z.object({
  repos: z.string(),
  worktrees: z.string(),
  pkm: z.string(),
}) satisfies Codec<T.SpacePaths>;

const Readiness = z.discriminatedUnion("ready", [
  z.object({ ready: z.literal(true) }),
  z.object({ ready: z.literal(false), missing: z.enum(T.MissingValues) }),
]) satisfies Codec<T.Readiness>;

export const SettingsStatus = z.object({
  file: z.string(),
  home: z.string(),
  paths: SpacePaths,
  version: z.string(),
  locale: Locale,
  deepseekApiKey: KeyStatus,
  agoraAppId: AgoraAppID,
  agoraAppCertificate: KeyStatus,
  voice: VoiceSettings,
  voiceDefaults: VoiceSettings,
  asrKey: KeyStatus,
  llmKey: KeyStatus,
  ttsKey: KeyStatus,
  dictation: Dictation,
  dictationKey: KeyStatus,
  readiness: z.record(z.enum(T.FeatureValues), Readiness),
  memorySources: z.array(MemorySource),
}) satisfies Codec<T.SettingsStatus>;

const MemorySourceUpdate = z.object({
  kind: MemorySourceKind,
  url: z.string(),
  enabled: z.boolean(),
  read: z.boolean(),
  write: z.boolean(),
  everything: z.exactOptional(z.boolean()),
  user: z.exactOptional(z.string()),
  key: z.exactOptional(z.string()),
}) satisfies Codec<T.MemorySourceUpdate>;

export const SettingsUpdate = z.object({
  locale: z.exactOptional(Locale),
  deepseekApiKey: z.exactOptional(z.string()),
  agoraAppId: z.exactOptional(z.string()),
  agoraAppCertificate: z.exactOptional(z.string()),
  voice: z.exactOptional(SettingsUpdateVoice),
  asrKey: z.exactOptional(z.string()),
  llmKey: z.exactOptional(z.string()),
  ttsKey: z.exactOptional(z.string()),
  dictation: z.exactOptional(Dictation),
  dictationKey: z.exactOptional(z.string()),
  memorySources: z.exactOptional(z.array(MemorySourceUpdate)),
}) satisfies Codec<T.SettingsUpdate>;
