import { TaskGroup } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { BizCode, refuseIn } from "#/base/errors.ts";
import type { Core } from "#/core/core.ts";
import type { Db } from "#/infra/db.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import type { PublicFetch } from "#/infra/publicHttp.ts";
import type { Time } from "#/infra/time.ts";
import type { Attachment } from "#/modules/attachment/attachment.ts";
import type { Channel } from "#/modules/channel/channel.ts";
import type { Provider } from "#/modules/provider/provider.ts";
import type { Session } from "#/modules/session/session.ts";
import * as q from "#db/media_job.sql.ts";

import { audioKinds, makeAudio } from "./audio.ts";
import { makeImage } from "./image.ts";
import { type Inputs, makeInputs } from "./inputs.ts";
import { type AddedBy, makeLibrary } from "./library.ts";
import { makeMachine } from "./machine.ts";
import { makeRemoteFiles } from "./remoteFiles.ts";
import { makeSpeech } from "./speech.ts";
import { makeUnderstanding } from "./understanding.ts";

const refused = refuseIn(BizCode.MediaRefused);

export type MediaCaller =
  | { readonly kind: "user" }
  | { readonly kind: "orchestrator"; readonly agent: string; readonly channel: string; readonly forUser: boolean };

export interface Media {
  readonly inputs: Pick<Inputs, "create" | "adopt" | "upload" | "get" | "list" | "delete" | "previewDelete" | "content">;
  readonly createImage: (input: T.MediaImageRequest, caller: MediaCaller) => Promise<T.MediaImageJob>;
  readonly createUnderstanding: (input: T.MediaUnderstandingRequest) => Promise<T.MediaUnderstandingJob>;
  readonly authorizeUnderstanding: (input: T.MediaUnderstandingAuthorizationRequest) => Promise<T.MediaUnderstandingJob>;
  readonly startUnderstanding: (id: string, caller: MediaCaller) => Promise<T.MediaUnderstandingJob>;
  readonly createSpeech: (input: T.MediaSpeechRequest, caller: MediaCaller) => Promise<T.MediaSpeechJob>;
  readonly speechResume: (id: string) => Promise<T.MediaSpeechJob>;
  /** A streamed speech job's events for the one page that claims them: refused on the first next() when it cannot. */
  readonly speechEvents: (id: string, signal?: AbortSignal) => AsyncIterable<T.MediaSpeechEvent>;
  readonly createSpeakers: (input: T.MediaSpeakersRequest, caller: MediaCaller) => Promise<T.MediaAudioJob>;
  readonly createVoiceDesign: (input: T.MediaVoiceDesignRequest, caller: MediaCaller) => Promise<T.MediaAudioJob>;
  readonly createClone: (input: T.MediaCloneRequest) => Promise<T.MediaAudioJob>;
  readonly createTranscription: (input: T.MediaTranscriptionRequest) => Promise<T.MediaAudioJob>;
  readonly audioResume: (id: string) => Promise<T.MediaAudioJob>;
  readonly audioPreviewCleanup: (id: string) => Promise<T.Preview>;
  readonly audioCleanup: (id: string) => Promise<T.MediaAudioJob>;
  readonly previewUnderstandingCleanup: (id: string) => Promise<T.Preview>;
  /** The signal stops it while it deletes at the vendor: the cleanup is then blocked, to be asked for again. */
  readonly cleanupUnderstanding: (id: string, signal?: AbortSignal) => Promise<T.MediaUnderstandingJob>;
  readonly get: (id: string) => Promise<T.MediaJob>;
  readonly list: () => Promise<T.MediaJob[]>;
  readonly cancel: (id: string) => Promise<T.MediaJob>;
  readonly retryDownload: (id: string) => Promise<T.MediaJob>;
  readonly previewRelease: (id: string) => Promise<T.Preview>;
  readonly release: (id: string) => Promise<T.MediaJob>;
  /** The library: what media made, what the user said with a file and what a helper brought in, kept as items. */
  readonly libraryItems: (req: T.LibraryListRequest) => Promise<T.LibraryItem[]>;
  readonly addLibraryItem: (req: T.LibraryAddRequest, by: AddedBy, signal?: AbortSignal) => Promise<T.LibraryItem>;
  /** Removes the library entry only; messages referencing the attachment still open it. */
  readonly removeLibraryItem: (id: string) => Promise<void>;
  readonly previewRemoveLibraryItem: (id: string) => Promise<T.Preview>;
  /** At startup: jobs and inputs a stop cut short are marked as such, and the ones still out at the vendor are followed again. */
  readonly boot: () => Promise<void>;
  /** Stops every job's work, the input sweep, the streams' timers and the library's recording. */
  readonly close: () => Promise<void>;
}

export interface MediaDeps {
  readonly db: Db;
  readonly core: Core;
  readonly clock: Time;
  readonly log: Logger;
  readonly attachment: Attachment;
  readonly session: Session;
  readonly channel: Channel;
  readonly provider: Provider;
  readonly publicFetch: PublicFetch;
}

const sweepMs = 60_000;

export async function makeMedia(deps: MediaDeps): Promise<Media> {
  const { db, clock } = deps;
  const log = deps.log.child("media");
  const inputs = makeInputs(deps);
  const remoteFiles = makeRemoteFiles(deps, inputs);
  // The minute's input sweep, one at a time.
  const cleanup = new TaskGroup({ name: "media.cleanup", onError: (task, e) => log.warn(`${task} failed`, e) });
  const machine = makeMachine(deps);
  const image = makeImage(deps, machine);
  const understanding = makeUnderstanding(deps, { inputs, remote: remoteFiles, machine });
  const speech = makeSpeech(deps, { inputs, machine });
  const audio = makeAudio(deps, { inputs, remote: remoteFiles, machine });
  // Records what the farm hears from now on, until close.
  const library = await makeLibrary(deps);

  const releasable = async (id: string) => {
    const job = await machine.get(id);
    if (job.kind === "image" || job.kind === "understanding" || machine.active(job.phase)) throw refused(t("server.media.releaseUnavailable"));
    return job;
  };

  return {
    inputs,
    createImage: image.create,
    createUnderstanding: understanding.create,
    authorizeUnderstanding: understanding.authorize,
    startUnderstanding: understanding.start,
    createSpeech: speech.create,
    speechResume: async (id) => {
      await machine.resume(id, ["speech"]);
      return speech.get(id);
    },
    speechEvents: (id, signal) => speech.events(id, signal),
    createSpeakers: audio.createSpeakers,
    createVoiceDesign: audio.createVoiceDesign,
    createClone: (input) => audio.createClone(input, { kind: "user" }),
    createTranscription: (input) => audio.createTranscription(input, { kind: "user" }),
    audioResume: async (id) => {
      await machine.resume(id, audioKinds);
      return audio.get(id);
    },
    audioPreviewCleanup: audio.previewCleanup,
    audioCleanup: audio.cleanup,
    cleanupUnderstanding: understanding.cleanup,
    previewUnderstandingCleanup: understanding.previewCleanup,
    get: machine.get,
    list: machine.list,
    cancel: machine.cancel,
    retryDownload: machine.retryDownload,
    previewRelease: (id) =>
      machine.lock.with(async () => {
        const job = await releasable(id);
        return { does: job.canRelease ? [t("server.media.releasePreview"), t("server.media.releasePreserves"), t("server.media.releaseAbandons")] : [] };
      }),
    // Not stopped by the caller: assets once being released are released, and the farm told.
    release: (id) =>
      machine.lock.with(async () => {
        const job = await releasable(id);
        if (!job.canRelease) return job;
        const ids = job.kind === "speech" ? [job.resultInput?.id] : [job.input?.id, job.resultInput?.id, job.previewInput];
        const now = clock.now();
        try {
          await inputs.releaseAssets(
            ids.filter((value): value is string => value != null),
            [id],
            async () => {
              await q.releaseMediaJobAssets(db.sql, { id, now });
            },
          );
        } finally {
          await bestEffort(log, "Media asset release could not be published", () => machine.publish());
        }
        return machine.get(id);
      }),
    libraryItems: library.list,
    addLibraryItem: library.add,
    removeLibraryItem: library.remove,
    previewRemoveLibraryItem: library.previewRemove,
    boot: async () => {
      await remoteFiles.restore();
      await machine.interrupt();
      await inputs.restore();
      await inputs.sweep();
      await understanding.sweep();
      cleanup.keyed("sweep", async (signal) => {
        for (;;) {
          try {
            await understanding.sweep();
            await inputs.sweep();
          } catch (e) {
            log.error("Media input cleanup failed", e);
          }
          await clock.sleep(sweepMs, signal);
        }
      });
      await machine.pickUp();
    },
    close: async () => {
      await library.close();
      await cleanup.close();
      await machine.close();
      await speech.close();
    },
  };
}
