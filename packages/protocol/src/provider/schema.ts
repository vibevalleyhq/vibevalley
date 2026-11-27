import { z } from "zod";

import type { Codec } from "../codec";
import { codePoints, KeyStatus } from "../common/schema";
import * as T from "./shapes.gen";

export const ModelCapability = z.enum(T.ModelCapabilityValues) satisfies Codec<T.ModelCapability>;
export const ProviderConnectionAdapter = z.enum(T.ProviderConnectionAdapterValues) satisfies Codec<T.ProviderConnectionAdapter>;
export const ProviderVerificationStatus = z.enum(T.ProviderVerificationStatusValues) satisfies Codec<T.ProviderVerificationStatus>;
export const ProviderScene = z.enum(T.ProviderSceneValues) satisfies Codec<T.ProviderScene>;

const ProviderModel = z.object({
  id: z.string(),
  owner: z.string(),
  capabilities: z.array(ModelCapability),
}) satisfies Codec<T.ProviderModel>;

const ProviderVerification = z.object({
  status: ProviderVerificationStatus,
  checkedAt: z.exactOptional(z.number().int()),
  error: z.exactOptional(z.string()),
}) satisfies Codec<T.ProviderVerification>;

const ProviderConnection = z.object({
  id: z.string(),
  name: z.string(),
  adapter: ProviderConnectionAdapter,
  enabled: z.boolean(),
  key: KeyStatus,
  baseUrl: z.exactOptional(z.string()),
  models: z.array(ProviderModel),
  verification: z.exactOptional(ProviderVerification),
}) satisfies Codec<T.ProviderConnection>;

const ProviderBinding = z.object({ connection: z.string(), model: z.string() }) satisfies Codec<T.ProviderBinding>;
const ProviderScenePolicy = z.object({
  scene: ProviderScene,
  fallbacks: z.array(ProviderBinding),
}) satisfies Codec<T.ProviderScenePolicy>;

export const ProviderStatus = z.object({
  revision: z.number().int(),
  connections: z.array(ProviderConnection),
  orchestrator: ProviderBinding.nullable(),
  polish: ProviderBinding.nullable(),
  image: ProviderBinding.nullable(),
  live: ProviderBinding.nullable(),
  speakers: ProviderBinding.nullable(),
  voiceDesign: ProviderBinding.nullable(),
  transcription: ProviderBinding.nullable(),
  vision: ProviderBinding.nullable(),
  understanding: ProviderBinding.nullable(),
  speech: ProviderBinding.nullable(),
  scenePolicies: z.array(ProviderScenePolicy),
}) satisfies Codec<T.ProviderStatus>;

const ProviderConnectionUpdate = z.object({
  id: z.string(),
  name: z.string(),
  adapter: ProviderConnectionAdapter,
  enabled: z.boolean(),
  key: z.exactOptional(z.string().nullable()),
  baseUrl: z.exactOptional(z.string().nullable()),
}) satisfies Codec<T.ProviderConnectionUpdate>;

export const ProviderUpdate = z.object({
  revision: z.number().int(),
  connections: z.array(ProviderConnectionUpdate),
  orchestrator: ProviderBinding.nullable(),
  polish: ProviderBinding.nullable(),
  speech: ProviderBinding.nullable(),
  understanding: ProviderBinding.nullable(),
  image: ProviderBinding.nullable(),
  live: ProviderBinding.nullable(),
  speakers: ProviderBinding.nullable(),
  voiceDesign: ProviderBinding.nullable(),
  transcription: ProviderBinding.nullable(),
  vision: ProviderBinding.nullable(),
  scenePolicies: z.array(ProviderScenePolicy),
}) satisfies Codec<T.ProviderUpdate>;

export const ProviderVerifyRequest = z.object({ connection: z.string(), revision: z.number().int() }) satisfies Codec<T.ProviderVerifyRequest>;
export const ProviderModelRequest = z.object({ connection: z.string(), revision: z.number().int() }) satisfies Codec<T.ProviderModelRequest>;
export const ProviderVoiceRequest = z.object({
  connection: z.string(),
  revision: z.number().int(),
  limit: z.exactOptional(z.number().int().min(1).max(150)),
  offset: z.exactOptional(z.number().int().min(0).max(100000)),
  after: z.exactOptional(z.string().check(codePoints(1, 8192))),
  status: z.exactOptional(z.string().check(codePoints(1, 128))),
}) satisfies Codec<T.ProviderVoiceRequest>;
export const ProviderVoiceListing = z.object({
  connection: z.string(),
  revision: z.number().int(),
  voices: z.array(z.object({ id: z.string(), name: z.string(), createdAtSeconds: z.number().int() })),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
}) satisfies Codec<T.ProviderVoiceListing>;
export const ProviderModelListing = z.object({
  connection: z.string(),
  revision: z.number().int(),
  models: z.array(ProviderModel),
}) satisfies Codec<T.ProviderModelListing>;
