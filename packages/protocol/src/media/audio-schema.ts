import { Schema } from "effect";

import { Attachment } from "../channel/schema";
import type { Codec } from "../codec";
import * as T from "./audio-shapes";
import { MediaAudioMetadata, MediaInputReference, MediaPhase, MediaSource, MediaAudioUsage } from "./common-schema";
import { MediaAudioFormatValues } from "./shapes";

const Id = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,80}$/u));
const VoiceId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,256}$/u));
const SpeakerId = Schema.String.check(Schema.isBetweenCodePoints(1, 256), Schema.isPattern(/\S/u));
const MediaAudioFormat = Schema.Literals(MediaAudioFormatValues);
export const MediaAudioAccountRequest = Schema.Struct({
  id: Id,
  connection: Schema.NonEmptyString,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}) satisfies Codec<T.MediaAudioAccountRequest>;
export const MediaAudioKind: Codec<T.MediaAudioKind> = Schema.Literals(T.MediaAudioKindValues);
const SpeakersFields = {
  ...MediaAudioAccountRequest.fields,
  speakers: Schema.mutable(Schema.Array(Schema.Struct({ id: SpeakerId, voice: VoiceId })).check(Schema.isMinLength(1), Schema.isMaxLength(100))),
  segments: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        speaker: SpeakerId,
        text: Schema.String.check(Schema.isBetweenCodePoints(1, 10000), Schema.isPattern(/\S/u)),
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  ),
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
export const MediaSpeakersRequest = Schema.Struct(SpeakersFields).check(Schema.makeFilter(validSpeakers)) satisfies Codec<T.MediaSpeakersRequest>;
export const MediaVoiceDesignRequest = Schema.Struct({
  ...MediaAudioAccountRequest.fields,
  text: Schema.String.check(Schema.isBetweenCodePoints(1, 10000), Schema.isPattern(/\S/u)),
  instruction: Schema.String.check(Schema.isBetweenCodePoints(1, 10000), Schema.isPattern(/\S/u)),
  format: MediaAudioFormat,
}) satisfies Codec<T.MediaVoiceDesignRequest>;
export const MediaCloneRequest = Schema.Struct({
  ...MediaAudioAccountRequest.fields,
  input: Schema.NonEmptyString,
  name: Schema.optionalKey(Schema.String.check(Schema.isBetweenCodePoints(1, 1000))),
  consent: Schema.Literal(true),
}) satisfies Codec<T.MediaCloneRequest>;
export const MediaTranscriptionRequest = Schema.Struct({
  ...MediaAudioAccountRequest.fields,
  input: Schema.NonEmptyString,
  allowUpload: Schema.Literal(true),
  diarize: Schema.optionalKey(Schema.Boolean),
  keyterms: Schema.optionalKey(
    Schema.mutable(Schema.Array(Schema.String.check(Schema.isBetweenCodePoints(1, 30), Schema.isPattern(/\S/u))).check(Schema.isMaxLength(20))),
  ),
  streaming: Schema.optionalKey(Schema.Boolean),
}) satisfies Codec<T.MediaTranscriptionRequest>;
export const MediaAudioRequest: Codec<T.MediaAudioRequest> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("speakers"), ...SpeakersFields }).check(Schema.makeFilter(validSpeakers)),
  Schema.Struct({ kind: Schema.Literal("voiceDesign"), ...MediaVoiceDesignRequest.fields }),
  Schema.Struct({ kind: Schema.Literal("clone"), ...MediaCloneRequest.fields }),
  Schema.Struct({ kind: Schema.Literal("transcription"), ...MediaTranscriptionRequest.fields }),
]);
export const MediaAudioVoice: Codec<T.MediaAudioVoice> = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.String,
  createdAtSeconds: Schema.Finite,
});
export const MediaAudioSegment: Codec<T.MediaAudioSegment> = Schema.Struct({
  speaker: Schema.String,
  text: Schema.String,
  start: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  end: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
}).check(Schema.makeFilter((segment) => segment.end >= segment.start));
export const MediaAudioResult: Codec<T.MediaAudioResult> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("clone"), voice: MediaAudioVoice }),
  Schema.Struct({ kind: Schema.Literal("transcription"), text: Schema.String, segments: Schema.mutable(Schema.Array(MediaAudioSegment)) }),
]);
const Job = {
  id: Schema.String,
  prompt: Schema.String,
  model: Schema.String,
  connection: Schema.String,
  revision: Schema.Int,
  source: MediaSource,
  phase: MediaPhase,
  phaseText: Schema.String,
  problem: Schema.String,
  format: Schema.NullOr(MediaAudioFormat),
  contentType: Schema.NullOr(Schema.String),
  metadata: Schema.optionalKey(MediaAudioMetadata),
  usage: Schema.optionalKey(MediaAudioUsage),
  input: Schema.NullOr(MediaInputReference),
  resultInput: Schema.NullOr(MediaInputReference),
  attachment: Schema.optionalKey(Attachment),
  previewInput: Schema.NullOr(Schema.String),
  result: Schema.NullOr(MediaAudioResult),
  canCancel: Schema.Boolean,
  canRetryDownload: Schema.Boolean,
  canResume: Schema.Boolean,
  canCleanup: Schema.Boolean,
  canRelease: Schema.Boolean,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
};
export const MediaAudioJob: Codec<T.MediaAudioJob> = Schema.Union([
  Schema.Struct({ ...Job, kind: Schema.Literal("speakers"), request: MediaSpeakersRequest }),
  Schema.Struct({ ...Job, kind: Schema.Literal("voiceDesign"), request: MediaVoiceDesignRequest }),
  Schema.Struct({ ...Job, kind: Schema.Literal("clone"), request: MediaCloneRequest }),
  Schema.Struct({ ...Job, kind: Schema.Literal("transcription"), request: MediaTranscriptionRequest }),
]);
