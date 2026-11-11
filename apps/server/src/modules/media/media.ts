import { Clock, Context, Effect, FiberHandle, Layer, Schedule, type Stream } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { type ApiError, BizCode, refuseIn } from "#/base/errors.ts";
import { Db } from "#/infra/db.ts";
import * as q from "#db/media_job.sql.ts";

import { audioKinds, makeAudio } from "./audio.ts";
import { makeImage } from "./image.ts";
import { makeInputs } from "./inputs.ts";
import { makeMachine } from "./machine.ts";
import { makeRemoteFiles } from "./remoteFiles.ts";
import { makeSpeech } from "./speech.ts";
import { makeUnderstanding } from "./understanding.ts";

const refused = refuseIn(BizCode.MediaRefused);

export type MediaCaller =
  | { readonly kind: "user" }
  | { readonly kind: "orchestrator"; readonly agent: string; readonly channel: string; readonly forUser: boolean };

export class Media extends Context.Service<
  Media,
  {
    readonly inputs: Pick<Effect.Success<typeof makeInputs>, "create" | "adopt" | "upload" | "get" | "list" | "delete" | "previewDelete" | "content">;
    readonly createImage: (input: T.MediaImageRequest, caller: MediaCaller) => Effect.Effect<T.MediaImageJob, ApiError>;
    readonly createUnderstanding: (input: T.MediaUnderstandingRequest) => Effect.Effect<T.MediaUnderstandingJob, ApiError>;
    readonly authorizeUnderstanding: (input: T.MediaUnderstandingAuthorizationRequest) => Effect.Effect<T.MediaUnderstandingJob, ApiError>;
    readonly startUnderstanding: (id: string, caller: MediaCaller) => Effect.Effect<T.MediaUnderstandingJob, ApiError>;
    readonly createSpeech: (input: T.MediaSpeechRequest, caller: MediaCaller) => Effect.Effect<T.MediaSpeechJob, ApiError>;
    readonly speechResume: (id: string) => Effect.Effect<T.MediaSpeechJob, ApiError>;
    readonly speechEvents: (id: string) => Effect.Effect<Stream.Stream<T.MediaSpeechEvent>, ApiError>;
    readonly createSpeakers: (input: T.MediaSpeakersRequest, caller: MediaCaller) => Effect.Effect<T.MediaAudioJob, ApiError>;
    readonly createVoiceDesign: (input: T.MediaVoiceDesignRequest, caller: MediaCaller) => Effect.Effect<T.MediaAudioJob, ApiError>;
    readonly createClone: (input: T.MediaCloneRequest) => Effect.Effect<T.MediaAudioJob, ApiError>;
    readonly createTranscription: (input: T.MediaTranscriptionRequest) => Effect.Effect<T.MediaAudioJob, ApiError>;
    readonly audioResume: (id: string) => Effect.Effect<T.MediaAudioJob, ApiError>;
    readonly audioPreviewCleanup: (id: string) => Effect.Effect<T.Preview, ApiError>;
    readonly audioCleanup: (id: string) => Effect.Effect<T.MediaAudioJob, ApiError>;
    readonly previewUnderstandingCleanup: (id: string) => Effect.Effect<T.Preview, ApiError>;
    readonly cleanupUnderstanding: (id: string) => Effect.Effect<T.MediaUnderstandingJob, ApiError>;
    readonly get: (id: string) => Effect.Effect<T.MediaJob, ApiError>;
    readonly list: () => Effect.Effect<T.MediaJob[], ApiError>;
    readonly cancel: (id: string) => Effect.Effect<T.MediaJob, ApiError>;
    readonly retryDownload: (id: string) => Effect.Effect<T.MediaJob, ApiError>;
    readonly previewRelease: (id: string) => Effect.Effect<T.Preview, ApiError>;
    readonly release: (id: string) => Effect.Effect<T.MediaJob, ApiError>;
    readonly restore: () => Effect.Effect<void, ApiError>;
  }
>()("@vibevalley/server/modules/media/media") {
  static readonly layer = Layer.effect(
    Media,
    Effect.suspend(() => make),
  );
}

const make = Effect.gen(function* () {
  const db = yield* Db;
  const inputs = yield* makeInputs;
  const remoteFiles = yield* makeRemoteFiles(inputs);
  const cleanup = yield* FiberHandle.make<void>();
  const machine = yield* makeMachine;
  const image = yield* makeImage(machine);
  const understanding = yield* makeUnderstanding({ inputs, remote: remoteFiles, machine });
  const speech = yield* makeSpeech({ inputs, machine });
  const audio = yield* makeAudio({ inputs, remote: remoteFiles, machine });

  const releasable = Effect.fnUntraced(function* (id: string) {
    const job = yield* machine.get(id);
    if (job.kind === "image" || job.kind === "understanding" || machine.active(job.phase)) return yield* refused(t("server.media.releaseUnavailable"));
    return job;
  });

  return Media.of({
    inputs,
    createImage: image.create,
    createUnderstanding: understanding.create,
    authorizeUnderstanding: understanding.authorize,
    startUnderstanding: understanding.start,
    createSpeech: speech.create,
    speechResume: Effect.fn("Media.speechResume")(function* (id) {
      yield* machine.resume(id, ["speech"]);
      return yield* speech.get(id);
    }),
    speechEvents: speech.events,
    createSpeakers: audio.createSpeakers,
    createVoiceDesign: audio.createVoiceDesign,
    createClone: Effect.fn("Media.createClone")((input) => audio.createClone(input, { kind: "user" })),
    createTranscription: Effect.fn("Media.createTranscription")((input) => audio.createTranscription(input, { kind: "user" })),
    audioResume: Effect.fn("Media.audioResume")(function* (id) {
      yield* machine.resume(id, audioKinds);
      return yield* audio.get(id);
    }),
    audioPreviewCleanup: audio.previewCleanup,
    audioCleanup: audio.cleanup,
    cleanupUnderstanding: understanding.cleanup,
    previewUnderstandingCleanup: understanding.previewCleanup,
    get: machine.get,
    list: machine.list,
    cancel: machine.cancel,
    retryDownload: machine.retryDownload,
    previewRelease: Effect.fn("Media.previewRelease")(function* (id) {
      const job = yield* releasable(id);
      return { does: job.canRelease ? [t("server.media.releasePreview"), t("server.media.releasePreserves"), t("server.media.releaseAbandons")] : [] };
    }, machine.lock.withPermits(1)),
    release: Effect.fn("Media.release")(
      function* (id) {
        const job = yield* releasable(id);
        if (!job.canRelease) return job;
        const ids = job.kind === "speech" ? [job.resultInput?.id] : [job.input?.id, job.resultInput?.id, job.previewInput];
        const now = yield* Clock.currentTimeMillis;
        const clear = db.run(q.releaseMediaJobAssets({ id, now }));
        yield* inputs
          .releaseAssets(
            ids.filter((value): value is string => value != null),
            [id],
            clear,
          )
          .pipe(Effect.ensuring(machine.publish().pipe(Effect.catch(() => Effect.logError("Media asset release could not be published")))));
        return yield* machine.get(id);
      },
      machine.lock.withPermits(1),
      Effect.uninterruptible,
    ),
    restore: Effect.fn("Media.restore")(function* () {
      yield* remoteFiles.restore();
      yield* machine.interrupt();
      yield* inputs.restore();
      yield* inputs.sweep();
      yield* understanding.sweep();
      yield* FiberHandle.run(
        cleanup,
        Effect.andThen(understanding.sweep(), inputs.sweep()).pipe(
          Effect.catch(() => Effect.logError("Media input cleanup failed")),
          Effect.repeat(Schedule.spaced("1 minute")),
          Effect.asVoid,
        ),
      );
      yield* machine.pickUp();
    }),
  });
});

export const start = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* (yield* Media).restore();
  }),
);
