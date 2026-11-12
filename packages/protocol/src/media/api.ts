import { z } from "zod";

import { Preview } from "../common/schema";
import { type Endpoint, input } from "../endpoint";
import type * as T from "../shapes";
import * as A from "./audio-schema";
import * as S from "./schema";

const libraryItemInput = input({ id: z.string() });

export interface MediaHandlers {
  readonly "media.dialogue.create": (a: T.MediaSpeakersRequest) => Promise<T.MediaAudioJob>;
  readonly "media.voiceDesign.create": (a: T.MediaVoiceDesignRequest) => Promise<T.MediaAudioJob>;
  readonly "media.clone.create": (a: T.MediaCloneRequest) => Promise<T.MediaAudioJob>;
  readonly "media.transcription.create": (a: T.MediaTranscriptionRequest) => Promise<T.MediaAudioJob>;
  readonly "media.audio.resume": (a: T.MediaJobRequest) => Promise<T.MediaAudioJob>;
  readonly "media.audio.previewCleanup": (a: T.MediaJobRequest) => Promise<T.Preview>;
  readonly "media.audio.cleanup": (a: T.MediaJobRequest) => Promise<T.MediaAudioJob>;
  readonly "media.input.create": (a: T.MediaInputRequest) => Promise<T.MediaInput>;
  /** A kept attachment (a library item) taken as an input, checked as an upload is. */
  readonly "media.input.adopt": (a: { readonly attachment: string }) => Promise<T.MediaInput>;
  readonly "media.input.get": (a: T.MediaJobRequest) => Promise<T.MediaInput>;
  readonly "media.input.list": () => Promise<T.MediaInput[]>;
  readonly "media.input.previewDelete": (a: T.MediaJobRequest) => Promise<T.Preview>;
  readonly "media.input.delete": (a: T.MediaJobRequest) => Promise<void>;
  readonly "media.image.create": (a: T.MediaImageRequest) => Promise<T.MediaImageJob>;
  readonly "media.understanding.create": (a: T.MediaUnderstandingRequest) => Promise<T.MediaUnderstandingJob>;
  readonly "media.understanding.authorize": (a: T.MediaUnderstandingAuthorizationRequest) => Promise<T.MediaUnderstandingJob>;
  readonly "media.understanding.start": (a: T.MediaJobRequest) => Promise<T.MediaUnderstandingJob>;
  readonly "media.speech.create": (a: T.MediaSpeechRequest) => Promise<T.MediaSpeechJob>;
  readonly "media.speech.resume": (a: T.MediaJobRequest) => Promise<T.MediaSpeechJob>;
  readonly "media.understanding.previewCleanup": (a: T.MediaJobRequest) => Promise<T.Preview>;
  readonly "media.understanding.cleanup": (a: T.MediaJobRequest) => Promise<T.MediaUnderstandingJob>;
  readonly "media.job.get": (a: T.MediaJobRequest) => Promise<T.MediaJob>;
  readonly "media.job.cancel": (a: T.MediaJobRequest) => Promise<T.MediaJob>;
  readonly "media.job.previewRelease": (a: T.MediaJobRequest) => Promise<T.Preview>;
  readonly "media.job.release": (a: T.MediaJobRequest) => Promise<T.MediaJob>;
  readonly "media.job.download": (a: T.MediaJobRequest) => Promise<T.MediaJob>;
  readonly "media.job.list": () => Promise<T.MediaJob[]>;
  /** Newest first. */
  readonly "library.item.list": (a: T.LibraryListRequest) => Promise<T.LibraryItem[]>;
  readonly "library.item.add": (a: T.LibraryAddRequest) => Promise<T.LibraryItem>;
  /** Only the item goes: a message that has the file still opens it. */
  readonly "library.item.delete": (a: { readonly id: string }) => Promise<void>;
  readonly "library.item.previewDelete": (a: { readonly id: string }) => Promise<T.Preview>;
}

export const mediaEndpoints: readonly Endpoint[] = [
  { op: "media.dialogue.create", about: [], input: A.MediaSpeakersRequest, result: A.MediaAudioJob, can: ["user", "orchestrator"] },
  { op: "media.voiceDesign.create", about: [], input: A.MediaVoiceDesignRequest, result: A.MediaAudioJob, can: ["user", "orchestrator"] },
  { op: "media.clone.create", about: [], input: A.MediaCloneRequest, result: A.MediaAudioJob, can: ["user"] },
  { op: "media.transcription.create", about: [], input: A.MediaTranscriptionRequest, result: A.MediaAudioJob, can: ["user"] },
  { op: "media.audio.resume", about: ["id"], input: S.MediaJobRequest, result: A.MediaAudioJob, can: ["user"] },
  { op: "media.audio.previewCleanup", about: ["id"], input: S.MediaJobRequest, result: Preview, can: ["user"] },
  { op: "media.audio.cleanup", about: ["id"], input: S.MediaJobRequest, result: A.MediaAudioJob, can: ["user"], dryRun: "media.audio.previewCleanup" },
  { op: "media.input.create", about: [], input: S.MediaInputRequest, result: S.MediaInput, can: ["user"] },
  { op: "media.input.adopt", about: [], input: input({ attachment: z.string() }), result: S.MediaInput, can: ["user"] },
  { op: "media.input.get", about: ["id"], input: S.MediaJobRequest, result: S.MediaInput, can: ["user"] },
  { op: "media.input.list", about: [], input: undefined, result: z.array(S.MediaInput), can: ["user"] },
  { op: "media.input.delete", about: ["id"], input: S.MediaJobRequest, result: undefined, can: ["user"], dryRun: "media.input.previewDelete" },
  { op: "media.input.previewDelete", about: ["id"], input: S.MediaJobRequest, result: Preview, can: ["user"] },
  { op: "media.image.create", about: [], input: S.MediaImageRequest, result: S.MediaImageJob, can: ["user", "orchestrator"] },
  { op: "media.understanding.create", about: [], input: S.MediaUnderstandingRequest, result: S.MediaUnderstandingJob, can: ["user"] },
  { op: "media.understanding.authorize", about: ["id"], input: S.MediaUnderstandingAuthorizationRequest, result: S.MediaUnderstandingJob, can: ["user"] },
  { op: "media.understanding.start", about: ["id"], input: S.MediaJobRequest, result: S.MediaUnderstandingJob, can: ["orchestrator"] },
  { op: "media.speech.create", about: [], input: S.MediaSpeechRequest, result: S.MediaSpeechJob, can: ["user", "orchestrator"] },
  { op: "media.speech.resume", about: ["id"], input: S.MediaJobRequest, result: S.MediaSpeechJob, can: ["user"] },
  { op: "media.understanding.previewCleanup", about: ["id"], input: S.MediaJobRequest, result: Preview, can: ["user"] },
  {
    op: "media.understanding.cleanup",
    about: ["id"],
    input: S.MediaJobRequest,
    result: S.MediaUnderstandingJob,
    can: ["user"],
    dryRun: "media.understanding.previewCleanup",
  },
  { op: "media.job.get", about: ["id"], input: S.MediaJobRequest, result: S.MediaJob, can: ["user", "orchestrator"] },
  { op: "media.job.cancel", about: ["id"], input: S.MediaJobRequest, result: S.MediaJob, can: ["user", "orchestrator"] },
  { op: "media.job.previewRelease", about: ["id"], input: S.MediaJobRequest, result: Preview, can: ["user"] },
  { op: "media.job.release", about: ["id"], input: S.MediaJobRequest, result: S.MediaJob, can: ["user"], dryRun: "media.job.previewRelease" },
  { op: "media.job.download", about: ["id"], input: S.MediaJobRequest, result: S.MediaJob, can: ["user", "orchestrator"] },
  { op: "media.job.list", about: [], input: undefined, result: z.array(S.MediaJob), can: ["user", "orchestrator"] },
  { op: "library.item.list", about: [], input: S.LibraryListRequest, result: S.LibraryItems, can: ["user", "remote", "orchestrator", "session"] },
  { op: "library.item.add", about: [], input: S.LibraryAddRequest, result: S.LibraryItem, can: ["user", "remote", "orchestrator", "session"] },
  { op: "library.item.delete", about: ["id"], input: libraryItemInput, result: undefined, can: ["user", "remote"], dryRun: "library.item.previewDelete" },
  { op: "library.item.previewDelete", about: ["id"], input: libraryItemInput, result: Preview, can: ["user", "remote"] },
];
