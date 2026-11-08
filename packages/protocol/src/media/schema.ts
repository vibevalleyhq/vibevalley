import { Schema } from "effect";

import { Attachment } from "../channel/schema";
import type { Codec } from "../codec";
import * as T from "./shapes";

const InputName = Schema.String.check(Schema.isBetweenCodePoints(1, 256), Schema.isPattern(/^[^\p{Cc}/\\]+$/u), Schema.isPattern(/\S/u));
export const MediaInputRequest = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("image"),
    name: InputName,
    mime: Schema.Literals(["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/tiff"]),
    size: Schema.Int.check(Schema.isBetween({ minimum: 16, maximum: 30_000_000 })),
  }),
  Schema.Struct({
    kind: Schema.Literal("video"),
    name: InputName,
    mime: Schema.Literals(["video/mp4", "video/x-m4v", "video/quicktime", "video/x-msvideo", "video/webm", "video/x-matroska"]),
    size: Schema.Int.check(Schema.isBetween({ minimum: 16, maximum: 200_000_000 })),
  }),
]) satisfies Codec<T.MediaInputRequest>;
export const MediaInput: Codec<T.MediaInput> = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["image", "video"]),
  name: Schema.String,
  mime: Schema.String,
  size: Schema.Int,
  phase: Schema.Literals(T.MediaInputPhaseValues),
  hash: Schema.NullOr(Schema.String),
  createdAt: Schema.Finite,
  expiresAt: Schema.Finite,
  canDelete: Schema.Boolean,
});

export const MediaImageRequest = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,80}$/u)),
  prompt: Schema.String.check(Schema.isBetweenCodePoints(1, 4000)),
  format: Schema.Literals(["text", "layout"]),
  width: Schema.Int,
  height: Schema.Int,
  seed: Schema.optionalKey(Schema.Int),
  steps: Schema.optionalKey(Schema.Int),
  guidance: Schema.optionalKey(Schema.Finite),
  negativePrompt: Schema.optionalKey(Schema.String.check(Schema.isBetweenCodePoints(0, 4000))),
  enhance: Schema.Boolean,
  watermark: Schema.Boolean,
}) satisfies Codec<T.MediaImageRequest>;
export const MediaPhase: Codec<T.MediaPhase> = Schema.Literals(T.MediaPhaseValues);
export const MediaSource: Codec<T.MediaSource> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("owner") }),
  Schema.Struct({ kind: Schema.Literal("orchestrator"), agent: Schema.NonEmptyString, channel: Schema.String }),
]);
export const MediaImageUsage: Codec<T.MediaImageUsage> = Schema.Struct({
  images: Schema.Literal(1),
  width: Schema.Int.check(Schema.isBetween({ minimum: 256, maximum: 2048 })),
  height: Schema.Int.check(Schema.isBetween({ minimum: 256, maximum: 2048 })),
});
export const MediaImageJob: Codec<T.MediaImageJob> = Schema.Struct({
  kind: Schema.Literal("image"),
  id: Schema.String,
  prompt: Schema.String,
  model: Schema.String,
  connection: Schema.String,
  revision: Schema.Int,
  source: MediaSource,
  usage: Schema.optionalKey(MediaImageUsage),
  phase: MediaPhase,
  phaseText: Schema.String,
  problem: Schema.String,
  attachment: Schema.optionalKey(Attachment),
  canCancel: Schema.Boolean,
  canRetryDownload: Schema.Boolean,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
});
export const MediaUnderstandingRequest = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,80}$/u)),
  prompt: Schema.String.check(Schema.isBetweenCodePoints(1, 64000), Schema.isPattern(/\S/u)),
  inputs: Schema.mutable(
    Schema.Array(Schema.NonEmptyString).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(5),
      Schema.makeFilter((ids) => new Set(ids).size === ids.length),
    ),
  ),
  connection: Schema.NonEmptyString,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  allowUpload: Schema.Literal(true),
  maxOutputTokens: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8192 })),
}) satisfies Codec<T.MediaUnderstandingRequest>;
export const MediaInputReference: Codec<T.MediaInputReference> = Schema.Struct({
  id: Schema.NonEmptyString,
  kind: Schema.Literals(["image", "video"]),
  name: Schema.String,
  mime: Schema.String,
  size: Schema.Int,
  hash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
});
const Tokens = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const MediaUnderstandingResult: Codec<T.MediaUnderstandingResult> = Schema.Struct({
  model: Schema.NonEmptyString,
  text: Schema.String,
  status: Schema.Literals(["completed", "incomplete"]),
  incompleteReason: Schema.NullOr(Schema.Literal("max_output_tokens")),
  usage: Schema.Struct({ inputTokens: Tokens, outputTokens: Tokens, totalTokens: Tokens }),
});
export const MediaUnderstandingJob: Codec<T.MediaUnderstandingJob> = Schema.Struct({
  kind: Schema.Literal("understanding"),
  id: Schema.String,
  prompt: Schema.String,
  inputs: Schema.mutable(Schema.Array(MediaInputReference)),
  model: Schema.String,
  connection: Schema.String,
  revision: Schema.Int,
  source: MediaSource,
  phase: Schema.Literals(T.MediaUnderstandingPhaseValues),
  phaseText: Schema.String,
  problem: Schema.String,
  result: Schema.NullOr(MediaUnderstandingResult),
  cleanup: Schema.Literals(T.MediaCleanupValues),
  cleanupText: Schema.String,
  canCancel: Schema.Boolean,
  canCleanup: Schema.Boolean,
  canRetryDownload: Schema.Literal(false),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
});
export const MediaJob: Codec<T.MediaJob> = Schema.Union([MediaImageJob, MediaUnderstandingJob]);
export const MediaJobRequest = Schema.Struct({ id: Schema.String }) satisfies Codec<T.MediaJobRequest>;
export const FactMediaChanged: Codec<T.FactMediaChanged> = Schema.Struct({
  type: Schema.Literal("mediaChanged"),
  at: Schema.Finite,
  jobs: Schema.mutable(Schema.Array(MediaJob)),
});
