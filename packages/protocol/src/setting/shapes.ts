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
  /** Whether each feature has what it needs set up, and what it lacks when not. This does not verify the remote services. */
  readiness: Record<Feature, Readiness>;
  memorySources: MemorySource[];
}

/** What the user sets up and uses: the orchestrator's thinking, each media use, dictation, the call and its live parts. */
export const FeatureValues = [
  "orchestrator",
  "image",
  "understanding",
  "speech",
  "speakers",
  "voiceDesign",
  "transcription",
  "dictation",
  "live",
  "vision",
  "call",
] as const;
export type Feature = (typeof FeatureValues)[number];

/** What a feature lacks: a key, a MOSS account (none, keyless, turned off), the use bound to none, the call's Agora
 * credentials, dictation's own address. */
export const MissingValues = ["deepseekKey", "mossAccount", "mossKey", "mossOff", "binding", "agora", "dictationUrl"] as const;
export type Missing = (typeof MissingValues)[number];

export type Readiness = { ready: true } | { ready: false; missing: Missing };

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
  memorySources?: MemorySourceUpdate[];
}
