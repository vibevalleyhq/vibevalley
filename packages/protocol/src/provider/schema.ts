import { Schema } from "effect";

import type { Codec } from "../codec";
import { KeyStatus } from "../common/schema";
import type * as T from "./shapes";

const ProviderModel: Codec<T.ProviderModel> = Schema.Struct({ id: Schema.String, owner: Schema.String });
const ProviderConnection: Codec<T.ProviderConnection> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  adapter: Schema.Literal("moss"),
  enabled: Schema.Boolean,
  key: KeyStatus,
});
const ProviderBinding: Codec<T.ProviderBinding> = Schema.Struct({ connection: Schema.String, model: Schema.String });
export const ProviderStatus: Codec<T.ProviderStatus> = Schema.Struct({
  revision: Schema.Int,
  connections: Schema.mutable(Schema.Array(ProviderConnection)),
  dictation: Schema.NullOr(ProviderBinding),
  image: Schema.NullOr(ProviderBinding),
  live: Schema.NullOr(ProviderBinding),
  liveModels: Schema.mutable(Schema.Array(Schema.String)),
  speakers: Schema.NullOr(ProviderBinding),
  speakersModels: Schema.mutable(Schema.Array(Schema.String)),
  voiceDesign: Schema.NullOr(ProviderBinding),
  voiceDesignModels: Schema.mutable(Schema.Array(Schema.String)),
  transcription: Schema.NullOr(ProviderBinding),
  transcriptionModels: Schema.mutable(Schema.Array(Schema.String)),
  vision: Schema.NullOr(ProviderBinding),
  visionModels: Schema.mutable(Schema.Array(Schema.String)),
  dictationModels: Schema.mutable(Schema.Array(Schema.String)),
  imageModels: Schema.mutable(Schema.Array(Schema.String)),
  understanding: Schema.NullOr(ProviderBinding),
  understandingModels: Schema.mutable(Schema.Array(Schema.String)),
  speech: Schema.NullOr(ProviderBinding),
  speechModels: Schema.mutable(Schema.Array(Schema.String)),
});
export const ProviderConnectionUpdate: Codec<T.ProviderConnectionUpdate> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  adapter: Schema.Literal("moss"),
  enabled: Schema.Boolean,
  key: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export const ProviderUpdate: Codec<T.ProviderUpdate> = Schema.Struct({
  speech: Schema.NullOr(ProviderBinding),
  revision: Schema.Int,
  connections: Schema.mutable(Schema.Array(ProviderConnectionUpdate)),
  understanding: Schema.NullOr(ProviderBinding),
  dictation: Schema.NullOr(ProviderBinding),
  image: Schema.NullOr(ProviderBinding),
  live: Schema.NullOr(ProviderBinding),
  speakers: Schema.NullOr(ProviderBinding),
  voiceDesign: Schema.NullOr(ProviderBinding),
  transcription: Schema.NullOr(ProviderBinding),
  vision: Schema.NullOr(ProviderBinding),
});
export const ProviderModelRequest: Codec<T.ProviderModelRequest> = Schema.Struct({ connection: Schema.String, revision: Schema.Int });
export const ProviderVoiceRequest: Codec<T.ProviderVoiceRequest> = Schema.Struct({
  connection: Schema.String,
  revision: Schema.Int,
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 150 }))),
  offset: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100000 }))),
  after: Schema.optionalKey(Schema.String.check(Schema.isBetweenCodePoints(1, 8192))),
  status: Schema.optionalKey(Schema.String.check(Schema.isBetweenCodePoints(1, 128))),
});
export const ProviderVoiceListing: Codec<T.ProviderVoiceListing> = Schema.Struct({
  connection: Schema.String,
  revision: Schema.Int,
  voices: Schema.mutable(Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, createdAtSeconds: Schema.Int }))),
  hasMore: Schema.Boolean,
  nextCursor: Schema.NullOr(Schema.String),
});
export const ProviderModelListing: Codec<T.ProviderModelListing> = Schema.Struct({
  connection: Schema.String,
  revision: Schema.Int,
  models: Schema.mutable(Schema.Array(ProviderModel)),
});
