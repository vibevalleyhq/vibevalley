// Generated from crates/vibevalley-protocol/src/contract (vp run protocol:ts). Do not edit.

import type { KeyStatus, Locale } from "../common/shapes.gen";
import type { AgoraAppID, Dictation, SettingsUpdateVoice, VoiceSettings } from "../voice/shapes.gen";

export type MemorySourceInfo = { name: string, label: string, on: boolean, off: string, canList: boolean, canForget: boolean, transcripts: boolean, };

export const MemorySourceKindValues = ["nowledge", "everos"] as const;
export type MemorySourceKind = (typeof MemorySourceKindValues)[number];

export type MemorySource = { kind: MemorySourceKind, url: string, enabled: boolean, read: boolean, write: boolean, everything: boolean, user?: string, key: KeyStatus, };

export type SpacePaths = { repos: string, 
/**
 * Named `<repo>.<issue number>`.
 */
worktrees: string, pkm: string, };

export const MissingValues = ["deepseekKey", "mossAccount", "mossKey", "mossOff", "binding", "agora", "dictationUrl"] as const;
export type Missing = (typeof MissingValues)[number];

export type Readiness = { ready: true, } | { ready: false, missing: Missing, };

export const FeatureValues = ["orchestrator", "image", "understanding", "speech", "speakers", "voiceDesign", "transcription", "dictation", "live", "vision", "call"] as const;
export type Feature = (typeof FeatureValues)[number];

export type SettingsStatus = { file: string, home: string, paths: SpacePaths, version: string, locale: Locale, deepseekApiKey: KeyStatus, agoraAppId: AgoraAppID, agoraAppCertificate: KeyStatus, voice: VoiceSettings, voiceDefaults: VoiceSettings, asrKey: KeyStatus, llmKey: KeyStatus, ttsKey: KeyStatus, dictation: Dictation, dictationKey: KeyStatus, 
/**
 * Local configuration check only; does not probe remote endpoints.
 */
readiness: Record<Feature, Readiness>, memorySources: Array<MemorySource>, };

export type MemorySourceUpdate = { kind: MemorySourceKind, url: string, enabled: boolean, read: boolean, write: boolean, everything?: boolean, user?: string, key?: string, };

export type SettingsUpdate = { locale?: Locale, deepseekApiKey?: string, agoraAppId?: string, agoraAppCertificate?: string, voice?: SettingsUpdateVoice, asrKey?: string, llmKey?: string, ttsKey?: string, dictation?: Dictation, dictationKey?: string, memorySources?: Array<MemorySourceUpdate>, };
