import type { MediaHandlers } from "@vibevalley/protocol/api";

import type { Media } from "#/modules/media/media.ts";

export function mediaHandlers(deps: { readonly media: Media }): MediaHandlers {
  const { media } = deps;
  return {
    "media.input.create": (input) => media.inputs.create(input),
    "media.input.adopt": ({ attachment }) => media.inputs.adopt(attachment),
    "media.input.get": ({ id }) => media.inputs.get(id),
    "media.input.list": () => media.inputs.list(),
    "media.input.delete": ({ id }) => media.inputs.delete(id),
    "media.input.previewDelete": ({ id }) => media.inputs.previewDelete(id),
    "media.understanding.create": (input) => media.createUnderstanding(input),
    "media.understanding.authorize": (input) => media.authorizeUnderstanding(input),
    "media.understanding.start": ({ id }) => media.startUnderstanding(id, { kind: "user" }),
    "media.speech.create": (input) => media.createSpeech(input, { kind: "user" }),
    "media.speech.resume": ({ id }) => media.speechResume(id),
    "media.dialogue.create": (input) => media.createSpeakers(input, { kind: "user" }),
    "media.voiceDesign.create": (input) => media.createVoiceDesign(input, { kind: "user" }),
    "media.clone.create": (input) => media.createClone(input),
    "media.transcription.create": (input) => media.createTranscription(input),
    "media.audio.resume": ({ id }) => media.audioResume(id),
    "media.audio.previewCleanup": ({ id }) => media.audioPreviewCleanup(id),
    "media.audio.cleanup": ({ id }) => media.audioCleanup(id),
    "media.understanding.previewCleanup": ({ id }) => media.previewUnderstandingCleanup(id),
    "media.understanding.cleanup": ({ id }) => media.cleanupUnderstanding(id),
    "media.image.create": (input) => media.createImage(input, { kind: "user" }),
    "media.job.get": ({ id }) => media.get(id),
    "media.job.previewRelease": ({ id }) => media.previewRelease(id),
    "media.job.release": ({ id }) => media.release(id),
    "media.job.list": () => media.list(),
    "media.job.cancel": ({ id }) => media.cancel(id),
    "media.job.download": ({ id }) => media.retryDownload(id),
    // Over HTTP it is the user (here or through the gate); helpers and assistants reach the library through their tools.
    "library.item.list": (req) => media.libraryItems(req),
    "library.item.add": (req) => media.addLibraryItem(req, { kind: "user" }),
    "library.item.delete": ({ id }) => media.removeLibraryItem(id),
    "library.item.previewDelete": ({ id }) => media.previewRemoveLibraryItem(id),
  };
}
