import type { KeyStatus } from "../common/shapes";

export interface ProviderModel {
  id: string;
  owner: string;
}

export interface ProviderConnection {
  id: string;
  name: string;
  adapter: "moss";
  enabled: boolean;
  key: KeyStatus;
}

export interface ProviderBinding {
  connection: string;
  model: string;
}

export interface ProviderStatus {
  revision: number;
  connections: ProviderConnection[];
  dictation: ProviderBinding | null;
  image: ProviderBinding | null;
  live: ProviderBinding | null;
  liveModels: string[];
  speakers: ProviderBinding | null;
  speakersModels: string[];
  voiceDesign: ProviderBinding | null;
  voiceDesignModels: string[];
  transcription: ProviderBinding | null;
  transcriptionModels: string[];
  vision: ProviderBinding | null;
  visionModels: string[];
  dictationModels: string[];
  imageModels: string[];
  understanding: ProviderBinding | null;
  understandingModels: string[];
  speech: ProviderBinding | null;
  speechModels: string[];
}

export interface ProviderConnectionUpdate {
  id: string;
  name: string;
  adapter: "moss";
  enabled: boolean;
  /** Omitted keeps the credential; null clears it; a nonempty string replaces it. */
  key?: string | null;
}

export interface ProviderUpdate {
  speech: ProviderBinding | null;
  revision: number;
  connections: ProviderConnectionUpdate[];
  understanding: ProviderBinding | null;
  dictation: ProviderBinding | null;
  image: ProviderBinding | null;
  live: ProviderBinding | null;
  speakers: ProviderBinding | null;
  voiceDesign: ProviderBinding | null;
  transcription: ProviderBinding | null;
  vision: ProviderBinding | null;
}

export interface ProviderModelRequest {
  connection: string;
  revision: number;
}

export interface ProviderVoiceRequest extends ProviderModelRequest {
  limit?: number;
  offset?: number;
  after?: string;
  status?: string;
}

export interface ProviderVoiceListing {
  connection: string;
  revision: number;
  voices: { id: string; name: string; createdAtSeconds: number }[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface ProviderModelListing {
  connection: string;
  revision: number;
  models: ProviderModel[];
}
