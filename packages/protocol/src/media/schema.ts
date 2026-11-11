import { z } from "zod";

import { Attachment } from "../attachment/schema";
import type { Codec } from "../codec";
import { codePoints } from "../common/schema";
import { MediaAudioJob } from "./audio-schema";
import { MediaAudioMetadata, MediaInputReference, MediaPhase, MediaSource, MediaAudioUsage } from "./common-schema";
import * as T from "./shapes";

export { MediaAudioMetadata, MediaInputReference, MediaSource, MediaAudioUsage } from "./common-schema";

const MediaImageMimeValues = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/tiff"] as const;
const MediaVideoMimeValues = ["video/mp4", "video/x-m4v", "video/quicktime", "video/x-msvideo", "video/webm", "video/x-matroska"] as const;
const MediaAudioMimeValues = ["audio/wav", "audio/mpeg", "audio/mp4", "audio/flac", "audio/ogg", "audio/webm"] as const;

const InputName = z
  .string()
  .check(codePoints(1, 256))
  .regex(/^[^\p{Cc}/\\]+$/u)
  .regex(/\S/u);
const mediaInputLimits: Record<T.MediaInputRequest["kind"], { readonly mimes: readonly string[]; readonly max: number }> = {
  image: { mimes: MediaImageMimeValues, max: 30_000_000 },
  video: { mimes: MediaVideoMimeValues, max: 200_000_000 },
  audio: { mimes: MediaAudioMimeValues, max: 512_000_000 },
};
// One object, its kind's mime types and size limit checked after: an endpoint's input is an object, whose fields the
// command line takes.
export const MediaInputRequest = z
  .object({
    kind: z.enum(T.MediaInputKindValues),
    name: InputName,
    mime: z.string(),
    size: z.number().int().min(16),
  })
  .superRefine((r, ctx) => {
    const limits = mediaInputLimits[r.kind];
    if (!limits.mimes.includes(r.mime)) ctx.addIssue({ code: "custom", path: ["mime"], message: `not one of ${limits.mimes.join(", ")}` });
    if (r.size > limits.max) ctx.addIssue({ code: "custom", path: ["size"], message: `at most ${limits.max}` });
  }) satisfies Codec<T.MediaInputRequest>;
export const MediaInput = z.object({
  id: z.string(),
  kind: z.enum(T.MediaInputKindValues),
  name: z.string(),
  mime: z.string(),
  size: z.number().int(),
  phase: z.enum(T.MediaInputPhaseValues),
  hash: z.string().nullable(),
  createdAt: z.number(),
  expiresAt: z.number(),
  canDelete: z.boolean(),
}) satisfies Codec<T.MediaInput>;

export const MediaImageRequest = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/u),
  prompt: z.string().check(codePoints(1, 4000)),
  format: z.enum(T.MediaImageFormatValues),
  width: z.number().int(),
  height: z.number().int(),
  seed: z.exactOptional(z.number().int()),
  steps: z.exactOptional(z.number().int()),
  guidance: z.exactOptional(z.number()),
  negativePrompt: z.exactOptional(z.string().check(codePoints(0, 4000))),
  enhance: z.boolean(),
  watermark: z.boolean(),
}) satisfies Codec<T.MediaImageRequest>;
export const MediaImageUsage = z.object({
  images: z.literal(1),
  width: z.number().int().min(256).max(2048),
  height: z.number().int().min(256).max(2048),
}) satisfies Codec<T.MediaImageUsage>;
export const MediaImageJob = z.object({
  kind: z.literal("image"),
  id: z.string(),
  prompt: z.string(),
  model: z.string(),
  connection: z.string(),
  revision: z.number().int(),
  source: MediaSource,
  usage: z.exactOptional(MediaImageUsage),
  phase: MediaPhase,
  phaseText: z.string(),
  problem: z.string(),
  attachment: z.exactOptional(Attachment),
  canCancel: z.boolean(),
  canRetryDownload: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
}) satisfies Codec<T.MediaImageJob>;
export const MediaUnderstandingRequest = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/u),
  prompt: z.string().check(codePoints(1, 64000)).regex(/\S/u),
  inputs: z
    .array(z.string().min(1))
    .min(1)
    .max(5)
    .refine((ids) => new Set(ids).size === ids.length),
  connection: z.string().min(1),
  revision: z.number().int().min(0),
  allowUpload: z.literal(true),
  maxOutputTokens: z.number().int().min(1).max(8192),
}) satisfies Codec<T.MediaUnderstandingRequest>;
export const MediaUnderstandingAuthorizationRequest = z.object({
  ...MediaUnderstandingRequest.shape,
  channel: z.string().min(1),
}) satisfies Codec<T.MediaUnderstandingAuthorizationRequest>;
const MediaUnderstandingAuthorization = z.object({
  channel: z.string().min(1),
  expiresAt: z.number(),
}) satisfies Codec<T.MediaUnderstandingAuthorization>;
const Tokens = z.number().int().min(0);
export const MediaUnderstandingResult = z.object({
  model: z.string().min(1),
  text: z.string(),
  status: z.enum(T.MediaUnderstandingStatusValues),
  incompleteReason: z.literal("max_output_tokens").nullable(),
  usage: z.object({ inputTokens: Tokens, outputTokens: Tokens, totalTokens: Tokens }),
}) satisfies Codec<T.MediaUnderstandingResult>;
export const MediaUnderstandingJob = z.object({
  kind: z.literal("understanding"),
  id: z.string(),
  prompt: z.string(),
  inputs: z.array(MediaInputReference),
  model: z.string(),
  connection: z.string(),
  revision: z.number().int(),
  source: MediaSource,
  authorization: MediaUnderstandingAuthorization.nullable(),
  phase: z.enum(T.MediaUnderstandingPhaseValues),
  phaseText: z.string(),
  problem: z.string(),
  result: MediaUnderstandingResult.nullable(),
  cleanup: z.enum(T.MediaCleanupValues),
  cleanupText: z.string(),
  canCancel: z.boolean(),
  canCleanup: z.boolean(),
  canRetryDownload: z.literal(false),
  createdAt: z.number(),
  updatedAt: z.number(),
}) satisfies Codec<T.MediaUnderstandingJob>;
export const MediaSpeechEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("format"),
    sampleRate: z.number().int().min(8000).max(192000),
    channels: z.number().int().min(1).max(8),
    bitDepth: z.literal(16),
  }),
  z.object({
    type: z.literal("audio"),
    sequence: z.number().int().min(0),
    audio: z.string().max(2_000_000),
  }),
  z.object({ type: z.literal("done") }),
  z.object({ type: z.literal("failed") }),
]) satisfies Codec<T.MediaSpeechEvent>;
export const MediaSpeechRequest = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/u),
  text: z.string().check(codePoints(1, 10000)).regex(/\S/u),
  voice: z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/u),
  format: z.enum(T.MediaAudioFormatValues),
  asynchronous: z.exactOptional(z.boolean()),
  streaming: z.exactOptional(z.boolean()),
  connection: z.string().min(1),
  revision: z.number().int().min(0),
}) satisfies Codec<T.MediaSpeechRequest>;
export const MediaSpeechJob = z.object({
  kind: z.literal("speech"),
  id: z.string(),
  prompt: z.string(),
  model: z.string(),
  connection: z.string(),
  revision: z.number().int(),
  source: MediaSource,
  voice: z.string(),
  format: z.enum(T.MediaAudioFormatValues),
  contentType: z.exactOptional(z.string()),
  metadata: z.exactOptional(MediaAudioMetadata),
  usage: z.exactOptional(MediaAudioUsage),
  canResume: z.exactOptional(z.boolean()),
  canRelease: z.boolean(),
  phase: MediaPhase,
  phaseText: z.string(),
  problem: z.string(),
  attachment: z.exactOptional(Attachment),
  resultInput: MediaInputReference.nullable(),
  canCancel: z.boolean(),
  canRetryDownload: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
}) satisfies Codec<T.MediaSpeechJob>;
export const MediaJob = z.union([MediaImageJob, MediaUnderstandingJob, MediaSpeechJob, MediaAudioJob]) satisfies Codec<T.MediaJob>;
export const MediaJobRequest = z.object({ id: z.string() }) satisfies Codec<T.MediaJobRequest>;
export const FactMediaChanged = z.object({
  type: z.literal("mediaChanged"),
  at: z.number(),
  jobs: z.array(MediaJob),
}) satisfies Codec<T.FactMediaChanged>;
