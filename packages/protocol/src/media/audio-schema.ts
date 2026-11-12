import { z } from "zod";

import { Attachment } from "../attachment/schema";
import type { Codec } from "../codec";
import { codePoints } from "../common/schema";
import type * as T from "./audio-shapes";
import { MediaAudioMetadata, MediaInputReference, MediaPhase, MediaSource, MediaAudioUsage } from "./common-schema";
import { MediaAudioFormatValues } from "./shapes";

const Id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/u);
const VoiceId = z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/u);
const SpeakerId = z.string().check(codePoints(1, 256)).regex(/\S/u);
const MediaAudioFormat = z.enum(MediaAudioFormatValues);
const MediaAudioAccountRequest = z.object({
  id: Id,
  connection: z.string().min(1),
  revision: z.number().int().min(0),
}) satisfies Codec<T.MediaAudioAccountRequest>;
const SpeakersFields = {
  ...MediaAudioAccountRequest.shape,
  speakers: z
    .array(z.object({ id: SpeakerId, voice: VoiceId }))
    .min(1)
    .max(100),
  segments: z
    .array(
      z.object({
        speaker: SpeakerId,
        text: z.string().check(codePoints(1, 10000)).regex(/\S/u),
      }),
    )
    .min(1)
    .max(1000),
  format: MediaAudioFormat,
};
const validSpeakers = (input: T.MediaSpeakersRequest) => {
  const ids = new Set(input.speakers.map((speaker) => speaker.id));
  if (ids.size !== input.speakers.length) return false;
  let count = 0;
  for (const segment of input.segments) {
    if (!ids.has(segment.speaker)) return false;
    for (const _character of segment.text) {
      count++;
      if (count > 10000) return false;
    }
  }
  return true;
};
export const MediaSpeakersRequest = z.object(SpeakersFields).refine(validSpeakers) satisfies Codec<T.MediaSpeakersRequest>;
export const MediaVoiceDesignRequest = z.object({
  ...MediaAudioAccountRequest.shape,
  text: z.string().check(codePoints(1, 10000)).regex(/\S/u),
  instruction: z.string().check(codePoints(1, 10000)).regex(/\S/u),
  format: MediaAudioFormat,
}) satisfies Codec<T.MediaVoiceDesignRequest>;
export const MediaCloneRequest = z.object({
  ...MediaAudioAccountRequest.shape,
  input: z.string().min(1),
  name: z.exactOptional(z.string().check(codePoints(1, 1000))),
  consent: z.literal(true),
}) satisfies Codec<T.MediaCloneRequest>;
export const MediaTranscriptionRequest = z.object({
  ...MediaAudioAccountRequest.shape,
  input: z.string().min(1),
  allowUpload: z.literal(true),
  diarize: z.exactOptional(z.boolean()),
  keyterms: z.exactOptional(z.array(z.string().check(codePoints(1, 30)).regex(/\S/u)).max(20)),
  streaming: z.exactOptional(z.boolean()),
}) satisfies Codec<T.MediaTranscriptionRequest>;
export const MediaAudioRequest = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("speakers"), ...SpeakersFields }).refine(validSpeakers),
  z.object({ kind: z.literal("voiceDesign"), ...MediaVoiceDesignRequest.shape }),
  z.object({ kind: z.literal("clone"), ...MediaCloneRequest.shape }),
  z.object({ kind: z.literal("transcription"), ...MediaTranscriptionRequest.shape }),
]) satisfies Codec<T.MediaAudioRequest>;
const MediaAudioVoice = z.object({
  id: z.string().min(1),
  name: z.string(),
  createdAtSeconds: z.number(),
}) satisfies Codec<T.MediaAudioVoice>;
const MediaAudioSegment = z
  .object({
    speaker: z.string(),
    text: z.string(),
    start: z.number().min(0),
    end: z.number().min(0),
  })
  .refine((segment) => segment.end >= segment.start) satisfies Codec<T.MediaAudioSegment>;
export const MediaAudioResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("clone"), voice: MediaAudioVoice }),
  z.object({ kind: z.literal("transcription"), text: z.string(), segments: z.array(MediaAudioSegment) }),
]) satisfies Codec<T.MediaAudioResult>;
const Job = {
  id: z.string(),
  prompt: z.string(),
  model: z.string(),
  connection: z.string(),
  revision: z.number().int(),
  source: MediaSource,
  phase: MediaPhase,
  phaseText: z.string(),
  problem: z.string(),
  format: MediaAudioFormat.nullable(),
  contentType: z.string().nullable(),
  metadata: z.exactOptional(MediaAudioMetadata),
  usage: z.exactOptional(MediaAudioUsage),
  input: MediaInputReference.nullable(),
  resultInput: MediaInputReference.nullable(),
  attachment: z.exactOptional(Attachment),
  previewInput: z.string().nullable(),
  result: MediaAudioResult.nullable(),
  canCancel: z.boolean(),
  canRetryDownload: z.boolean(),
  canResume: z.boolean(),
  canCleanup: z.boolean(),
  canRelease: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
};
export const MediaAudioJob = z.discriminatedUnion("kind", [
  z.object({ ...Job, kind: z.literal("speakers"), request: MediaSpeakersRequest }),
  z.object({ ...Job, kind: z.literal("voiceDesign"), request: MediaVoiceDesignRequest }),
  z.object({ ...Job, kind: z.literal("clone"), request: MediaCloneRequest }),
  z.object({ ...Job, kind: z.literal("transcription"), request: MediaTranscriptionRequest }),
]) satisfies Codec<T.MediaAudioJob>;
