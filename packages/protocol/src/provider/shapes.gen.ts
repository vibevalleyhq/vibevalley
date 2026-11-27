// Generated from crates/protocol/src/contract (vp run protocol:ts). Do not edit.

import type { KeyStatus } from "../common/shapes.gen";

export const ModelCapabilityValues = ["chat", "asr", "tts", "realtime", "vision", "image"] as const;
export type ModelCapability = (typeof ModelCapabilityValues)[number];

export type ProviderModel = { id: string, owner: string, capabilities: Array<ModelCapability>, };

export const ProviderConnectionAdapterValues = ["deepseek", "minimax", "moss", "openai", "anthropic"] as const;
export type ProviderConnectionAdapter = (typeof ProviderConnectionAdapterValues)[number];

export const ProviderVerificationStatusValues = ["unverified", "verified", "failed"] as const;
export type ProviderVerificationStatus = (typeof ProviderVerificationStatusValues)[number];

export type ProviderVerification = { status: ProviderVerificationStatus, checkedAt?: number, error?: string, };

export type ProviderConnection = { id: string, name: string, adapter: ProviderConnectionAdapter, enabled: boolean, key: KeyStatus, baseUrl?: string, models: Array<ProviderModel>, verification?: ProviderVerification, };

export type ProviderBinding = { connection: string, model: string, };

export const ProviderSceneValues = ["orchestrator", "polish", "transcription", "speech", "speakers", "voiceDesign", "live", "vision", "image", "understanding"] as const;
export type ProviderScene = (typeof ProviderSceneValues)[number];

export type ProviderScenePolicy = { scene: ProviderScene, fallbacks: Array<ProviderBinding>, };

export type ProviderStatus = { revision: number, connections: Array<ProviderConnection>, orchestrator: ProviderBinding | null, polish: ProviderBinding | null, image: ProviderBinding | null, live: ProviderBinding | null, speakers: ProviderBinding | null, voiceDesign: ProviderBinding | null, transcription: ProviderBinding | null, vision: ProviderBinding | null, understanding: ProviderBinding | null, speech: ProviderBinding | null, scenePolicies: Array<ProviderScenePolicy>, };

export type ProviderConnectionUpdate = { id: string, name: string, adapter: ProviderConnectionAdapter, enabled: boolean,
/**
 * Omitted keeps the credential; null clears it; a nonempty string replaces it.
 */
key?: string | null,
/**
 * Omitted keeps the base URL; null clears it; a nonempty string replaces it.
 */
baseUrl?: string | null, };

export type ProviderUpdate = { revision: number, connections: Array<ProviderConnectionUpdate>, orchestrator: ProviderBinding | null, polish: ProviderBinding | null, speech: ProviderBinding | null, understanding: ProviderBinding | null, image: ProviderBinding | null, live: ProviderBinding | null, speakers: ProviderBinding | null, voiceDesign: ProviderBinding | null, transcription: ProviderBinding | null, vision: ProviderBinding | null, scenePolicies: Array<ProviderScenePolicy>, };

export type ProviderVerifyRequest = { connection: string, revision: number, };

export type ProviderModelRequest = { connection: string, revision: number, };

export type ProviderVoiceRequest = { connection: string, revision: number, limit?: number, offset?: number, after?: string, status?: string, };

export type ProviderVoiceListingVoices = { id: string, name: string, createdAtSeconds: number, };

export type ProviderVoiceListing = { connection: string, revision: number, voices: Array<ProviderVoiceListingVoices>, hasMore: boolean, nextCursor: string | null, };

export type ProviderModelListing = { connection: string, revision: number, models: Array<ProviderModel>, };
