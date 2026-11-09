import { Effect } from "effect";

import type { MediaHandlers } from "@vibevalley/protocol/api";

import { Media } from "#/media/media.ts";

export const mediaHandlers = Effect.gen(function* () {
  const media = yield* Media;
  return {
    "media.input.create": media.inputs.create,
    "media.input.get": ({ id }) => media.inputs.get(id),
    "media.input.list": media.inputs.list,
    "media.input.delete": ({ id }) => media.inputs.delete(id),
    "media.input.previewDelete": ({ id }) => media.inputs.previewDelete(id),
    "media.understanding.create": media.createUnderstanding,
    "media.understanding.authorize": media.authorizeUnderstanding,
    "media.understanding.start": ({ id }) => media.startUnderstanding(id, { kind: "owner" }),
    "media.speech.create": (input) => media.createSpeech(input, { kind: "owner" }),
    "media.speech.resume": ({ id }) => media.speechResume(id),
    "media.dialogue.create": (input) => media.createSpeakers(input, { kind: "owner" }),
    "media.voiceDesign.create": (input) => media.createVoiceDesign(input, { kind: "owner" }),
    "media.clone.create": media.createClone,
    "media.transcription.create": media.createTranscription,
    "media.audio.resume": ({ id }) => media.audioResume(id),
    "media.audio.previewCleanup": ({ id }) => media.audioPreviewCleanup(id),
    "media.audio.cleanup": ({ id }) => media.audioCleanup(id),
    "media.understanding.previewCleanup": ({ id }) => media.previewUnderstandingCleanup(id),
    "media.understanding.cleanup": ({ id }) => media.cleanupUnderstanding(id),
    "media.image.create": (input) => media.createImage(input, { kind: "owner" }),
    "media.job.get": ({ id }) => media.get(id),
    "media.job.previewRelease": ({ id }) => media.previewRelease(id),
    "media.job.release": ({ id }) => media.release(id),
    "media.job.list": () => media.list(),
    "media.job.cancel": ({ id }) => media.cancel(id),
    "media.job.download": ({ id }) => media.retryDownload(id),
  } satisfies MediaHandlers;
});
