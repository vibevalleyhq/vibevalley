// Generated from crates/vibevalley-protocol/src/contract (vp run protocol:ts). Do not edit.

import type { KeyStatus } from "../common/shapes.gen";

export type ProviderModel = { id: string, owner: string, };

export const ProviderConnectionAdapterValues = ["moss"] as const;
export type ProviderConnectionAdapter = (typeof ProviderConnectionAdapterValues)[number];

export type ProviderConnection = { id: string, name: string, adapter: ProviderConnectionAdapter, enabled: boolean, key: KeyStatus, };

export type ProviderBinding = { connection: string, model: string, };

export type ProviderStatus = { revision: number, connections: Array<ProviderConnection>, dictation: ProviderBinding | null, image: ProviderBinding | null, live: ProviderBinding | null, liveModels: Array<string>, speakers: ProviderBinding | null, speakersModels: Array<string>, voiceDesign: ProviderBinding | null, voiceDesignModels: Array<string>, transcription: ProviderBinding | null, transcriptionModels: Array<string>, vision: ProviderBinding | null, visionModels: Array<string>, dictationModels: Array<string>, imageModels: Array<string>, understanding: ProviderBinding | null, understandingModels: Array<string>, speech: ProviderBinding | null, speechModels: Array<string>, };

export type ProviderConnectionUpdate = { id: string, name: string, adapter: ProviderConnectionAdapter, enabled: boolean, 
/**
 * Omitted keeps the credential; null clears it; a nonempty string replaces it.
 */
key?: string | null, };

export type ProviderUpdate = { speech: ProviderBinding | null, revision: number, connections: Array<ProviderConnectionUpdate>, understanding: ProviderBinding | null, dictation: ProviderBinding | null, image: ProviderBinding | null, live: ProviderBinding | null, speakers: ProviderBinding | null, voiceDesign: ProviderBinding | null, transcription: ProviderBinding | null, vision: ProviderBinding | null, };

export type ProviderModelRequest = { connection: string, revision: number, };

export type ProviderVoiceRequest = { connection: string, revision: number, limit?: number, offset?: number, after?: string, status?: string, };

export type ProviderVoiceListingVoices = { id: string, name: string, createdAtSeconds: number, };

export type ProviderVoiceListing = { connection: string, revision: number, voices: Array<ProviderVoiceListingVoices>, hasMore: boolean, nextCursor: string | null, };

export type ProviderModelListing = { connection: string, revision: number, models: Array<ProviderModel>, };
