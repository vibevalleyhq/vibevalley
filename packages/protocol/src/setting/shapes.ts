import type { KeyStatus, Locale } from "../common/shapes";
import type { AgoraAppID, Dictation, SettingsUpdateVoice, VoiceSettings } from "../voice/shapes";

export interface MemorySourceInfo {
  name: string;
  label: string;
  on: boolean;
  off: string;
  canList: boolean;
  canForget: boolean;
  transcripts: boolean;
}

export interface SpacePaths {
  /** The space's git repositories; each folder is a repo. */
  repos: string;
  /** The issues' worktrees, named <repo>.<issue number>. */
  worktrees: string;
  /** The notes vault. */
  pkm: string;
}

export interface SettingsStatus {
  file: string;
  /** The farm's home ($VIBEVALLEY_HOME) and the server's version, for About. */
  home: string;
  /** Where the current space keeps its repositories, worktrees and notes. */
  paths: SpacePaths;
  version: string;
  locale: Locale;
  deepseekApiKey: KeyStatus;
  agoraAppId: AgoraAppID;
  agoraAppCertificate: KeyStatus;
  voice: VoiceSettings;
  voiceDefaults: VoiceSettings;
  asrKey: KeyStatus;
  llmKey: KeyStatus;
  ttsKey: KeyStatus;
  dictation: Dictation;
  dictationKey: KeyStatus;
  /** Whether a recording has somewhere to go: MOSS with its key, or an own address. */
  dictationReady: boolean;
  /** MOSS Live (wss://api.mosi.cn/v1/realtime): a realtime voice model the server connects to. */
  mossKey: KeyStatus;
  memorySources: MemorySource[];
}

export interface MemorySource {
  kind: MemorySourceKind;
  url: string;
  enabled: boolean;
  read: boolean;
  write: boolean;
  everything: boolean;
  user?: string;
  key: KeyStatus;
}

export const MemorySourceKindValues = ["nowledge", "everos"] as const;
export type MemorySourceKind = (typeof MemorySourceKindValues)[number];

export interface MemorySourceUpdate {
  kind: MemorySourceKind;
  url: string;
  enabled: boolean;
  read: boolean;
  write: boolean;
  everything?: boolean;
  user?: string;
  key?: string;
}

export interface SettingsUpdate {
  locale?: Locale;
  deepseekApiKey?: string;
  agoraAppId?: string;
  agoraAppCertificate?: string;
  voice?: SettingsUpdateVoice;
  asrKey?: string;
  llmKey?: string;
  ttsKey?: string;
  dictation?: Dictation;
  dictationKey?: string;
  mossKey?: string;
  memorySources?: MemorySourceUpdate[];
}
