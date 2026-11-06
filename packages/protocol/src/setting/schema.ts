import { Schema } from "effect";

import type { Codec } from "../codec";
import { KeyStatus, Locale } from "../common/schema";
import * as T from "../shapes";
import { AgoraAppID, Dictation, SettingsUpdateVoice, VoiceSettings } from "../voice/schema";

export const MemorySourceInfo: Codec<T.MemorySourceInfo> = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  on: Schema.Boolean,
  off: Schema.String,
  canList: Schema.Boolean,
  canForget: Schema.Boolean,
  transcripts: Schema.Boolean,
});

export const MemorySourceKind: Codec<T.MemorySourceKind> = Schema.Literals(T.MemorySourceKindValues);

export const MemorySource: Codec<T.MemorySource> = Schema.Struct({
  kind: MemorySourceKind,
  url: Schema.String,
  enabled: Schema.Boolean,
  read: Schema.Boolean,
  write: Schema.Boolean,
  everything: Schema.Boolean,
  user: Schema.optionalKey(Schema.String),
  key: KeyStatus,
});

export const SettingsStatus: Codec<T.SettingsStatus> = Schema.Struct({
  file: Schema.String,
  home: Schema.String,
  version: Schema.String,
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
  dictationReady: Schema.Boolean,
  mossKey: KeyStatus,
  memorySources: Schema.mutable(Schema.Array(MemorySource)),
});

export const MemorySourceUpdate: Codec<T.MemorySourceUpdate> = Schema.Struct({
  kind: MemorySourceKind,
  url: Schema.String,
  enabled: Schema.Boolean,
  read: Schema.Boolean,
  write: Schema.Boolean,
  everything: Schema.optionalKey(Schema.Boolean),
  user: Schema.optionalKey(Schema.String),
  key: Schema.optionalKey(Schema.String),
});

export const SettingsUpdate: Codec<T.SettingsUpdate> = Schema.Struct({
  locale: Schema.optionalKey(Locale),
  deepseekApiKey: Schema.optionalKey(Schema.String),
  agoraAppId: Schema.optionalKey(Schema.String),
  agoraAppCertificate: Schema.optionalKey(Schema.String),
  voice: Schema.optionalKey(SettingsUpdateVoice),
  asrKey: Schema.optionalKey(Schema.String),
  llmKey: Schema.optionalKey(Schema.String),
  ttsKey: Schema.optionalKey(Schema.String),
  dictation: Schema.optionalKey(Dictation),
  dictationKey: Schema.optionalKey(Schema.String),
  mossKey: Schema.optionalKey(Schema.String),
  memorySources: Schema.optionalKey(Schema.mutable(Schema.Array(MemorySourceUpdate))),
});
