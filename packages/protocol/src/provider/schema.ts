import { z } from "zod";

import type { Codec } from "../codec";
import { codePoints, KeyStatus } from "../common/schema";
import type * as T from "./shapes";

const ProviderModel = z.object({ id: z.string(), owner: z.string() }) satisfies Codec<T.ProviderModel>;
const ProviderConnection = z.object({
  id: z.string(),
  name: z.string(),
  adapter: z.literal("moss"),
  enabled: z.boolean(),
  key: KeyStatus,
}) satisfies Codec<T.ProviderConnection>;
const ProviderBinding = z.object({ connection: z.string(), model: z.string() }) satisfies Codec<T.ProviderBinding>;
export const ProviderStatus = z.object({
  revision: z.number().int(),
  connections: z.array(ProviderConnection),
  dictation: ProviderBinding.nullable(),
  image: ProviderBinding.nullable(),
  live: ProviderBinding.nullable(),
  liveModels: z.array(z.string()),
  speakers: ProviderBinding.nullable(),
  speakersModels: z.array(z.string()),
  voiceDesign: ProviderBinding.nullable(),
  voiceDesignModels: z.array(z.string()),
  transcription: ProviderBinding.nullable(),
  transcriptionModels: z.array(z.string()),
  vision: ProviderBinding.nullable(),
  visionModels: z.array(z.string()),
  dictationModels: z.array(z.string()),
  imageModels: z.array(z.string()),
  understanding: ProviderBinding.nullable(),
  understandingModels: z.array(z.string()),
  speech: ProviderBinding.nullable(),
  speechModels: z.array(z.string()),
}) satisfies Codec<T.ProviderStatus>;
const ProviderConnectionUpdate = z.object({
  id: z.string(),
  name: z.string(),
  adapter: z.literal("moss"),
  enabled: z.boolean(),
  key: z.exactOptional(z.string().nullable()),
}) satisfies Codec<T.ProviderConnectionUpdate>;
export const ProviderUpdate = z.object({
  speech: ProviderBinding.nullable(),
  revision: z.number().int(),
  connections: z.array(ProviderConnectionUpdate),
  understanding: ProviderBinding.nullable(),
  dictation: ProviderBinding.nullable(),
  image: ProviderBinding.nullable(),
  live: ProviderBinding.nullable(),
  speakers: ProviderBinding.nullable(),
  voiceDesign: ProviderBinding.nullable(),
  transcription: ProviderBinding.nullable(),
  vision: ProviderBinding.nullable(),
}) satisfies Codec<T.ProviderUpdate>;
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
