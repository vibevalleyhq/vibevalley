import { Schema } from "effect";

import type { Codec } from "../codec";
import * as T from "./shapes";

export const MediaPhase: Codec<T.MediaPhase> = Schema.Literals(T.MediaPhaseValues);
export const MediaSource: Codec<T.MediaSource> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user") }),
  Schema.Struct({ kind: Schema.Literal("orchestrator"), agent: Schema.NonEmptyString, channel: Schema.String }),
]);
export const MediaInputReference: Codec<T.MediaInputReference> = Schema.Struct({
  id: Schema.NonEmptyString,
  kind: Schema.Literals(T.MediaInputKindValues),
  name: Schema.String,
  mime: Schema.String,
  size: Schema.Int,
  hash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
});
export const MediaAudioMetadata: Codec<T.MediaAudioMetadata> = Schema.Struct({
  source: Schema.Literals(T.MediaAudioMetadataSourceValues),
  sampleRate: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThan(0))),
  duration: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThan(0))),
  channels: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  bitDepth: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
});
export const MediaAudioUsage: Codec<T.MediaAudioUsage> = Schema.Struct({
  inputCharacters: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  promptTokens: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  completionTokens: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  totalTokens: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  inputAudioSeconds: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
});
