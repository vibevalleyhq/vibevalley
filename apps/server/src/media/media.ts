import { Clock, Context, Effect, Fiber, FiberHandle, FiberMap, Layer, Option, Schedule, Schema, Semaphore, type Stream } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { MediaPhaseValues } from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";

import { Attachment } from "#/attachment/attachment.ts";
import { head } from "#/base/clip.ts";
import { type ApiError, refused } from "#/base/errors.ts";
import { Channel } from "#/channel/channel.ts";
import { Core } from "#/core/core.ts";
import { Db } from "#/infra/db.ts";
import { bestEffort } from "#/infra/log.ts";
import { PublicHttp } from "#/infra/publicHttp.ts";
import { Provider } from "#/provider/provider.ts";
import * as q from "#db/media_job.sql.ts";

import { makeAudio } from "./audio.ts";
import { downloadImage } from "./download.ts";
import { makeInputs } from "./inputs.ts";
import { type JobRow, jobsOf, newJob } from "./job.ts";
import { makeRemoteFiles } from "./remoteFiles.ts";
import { makeSpeech } from "./speech.ts";
import { makeUnderstanding } from "./understanding.ts";

/** This file's media jobs, as it reads media_job. */
const jobs = jobsOf({ kinds: ["image"], phases: MediaPhaseValues });

export type MediaCaller =
  | { readonly kind: "user" }
  | { readonly kind: "orchestrator"; readonly agent: string; readonly channel: string; readonly forUser: boolean };

export class Media extends Context.Service<
  Media,
  {
    readonly inputs: Pick<Effect.Success<typeof makeInputs>, "create" | "upload" | "get" | "list" | "delete" | "previewDelete" | "content">;
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
>()("@vibevalley/server/media/media") {
  static readonly layer = Layer.effect(
    Media,
    Effect.suspend(() => make),
  );
}

const attachmentJson = Schema.encodeEffect(Schema.fromJsonString(S.Attachment));
const requestJson = Schema.encodeEffect(Schema.fromJsonString(S.MediaImageRequest));
const sourceJson = Schema.encodeEffect(Schema.fromJsonString(S.MediaSource));
const usageJson = Schema.encodeEffect(Schema.fromJsonString(S.MediaImageUsage));

const make = Effect.gen(function* () {
  const db = yield* Db;
  const inputs = yield* makeInputs;
  const remoteFiles = yield* makeRemoteFiles(inputs);
  const cleanup = yield* FiberHandle.make<void>();
  const core = yield* Core;
  const channel = yield* Channel;
  const kept = yield* Attachment;
  const provider = yield* Provider;
  const downloads = yield* PublicHttp;
  const lock = yield* Semaphore.make(1);
  const slots = yield* Semaphore.make(1);
  const fibers = yield* FiberMap.make<string, void, ApiError>();
  const active = (phase: T.MediaPhase) => phase === "queued" || phase === "generating" || phase === "downloading";
  const decodeRequest = (text: string) =>
    Schema.decodeEffect(Schema.fromJsonString(S.MediaImageRequest))(text).pipe(Effect.mapError(() => refused(t("server.media.corrupt"))));
  /** The job with this id, of any kind: one id is one job (media_job). */
  const kindOf = (id: string) => Effect.map(db.one(q.mediaJob({ id })), (row) => row?.kind);
  /** Whether the id is a job of a kind other than these: a reused id the caller must change. */
  const takenBesides = (kinds: readonly string[]) => (id: string) => Effect.map(kindOf(id), (kind) => kind !== undefined && !kinds.includes(kind));
  const image = (id: string) => Effect.map(db.one(q.mediaJob({ id })), jobs.one);
  const found = Effect.fnUntraced(function* (id: string) {
    const row = yield* image(id);
    if (!row) return yield* Effect.fail(refused(t("server.media.missing")));
    return row;
  });
  const view = Effect.fnUntraced(function* (row: JobRow<T.MediaPhase>): Effect.fn.Return<T.MediaImageJob, ApiError> {
    const request = yield* decodeRequest(row.request);
    const source = yield* Schema.decodeEffect(Schema.fromJsonString(S.MediaSource))(row.source).pipe(Effect.mapError(() => refused(t("server.media.corrupt"))));
    const usage =
      row.usage === null
        ? undefined
        : yield* Schema.decodeEffect(Schema.fromJsonString(S.MediaImageUsage))(row.usage).pipe(Effect.mapError(() => refused(t("server.media.corrupt"))));
    const attachment =
      row.attachment === null
        ? undefined
        : yield* Schema.decodeEffect(Schema.fromJsonString(S.Attachment))(row.attachment).pipe(Effect.mapError(() => refused(t("server.media.corrupt"))));
    return {
      kind: "image",
      id: row.id,
      prompt: request.prompt,
      connection: row.connection,
      revision: row.revision,
      source,
      ...(usage !== undefined ? { usage } : {}),
      model: row.model,
      phase: row.phase,
      phaseText: t(`server.media.phase.${row.phase}`),
      problem: row.problem,
      ...(attachment ? { attachment } : {}),
      canCancel: active(row.phase),
      canRetryDownload: row.result_url !== null && (row.phase === "download_failed" || row.phase === "canceled"),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
  const list = Effect.fn("Media.list")(function* (): Effect.fn.Return<T.MediaJob[], ApiError> {
    const recentGenerations2 = yield* Effect.map(db.run(q.recentMediaJobs({ kinds: ["image"] })), jobs.many);
    const images = yield* Effect.forEach(recentGenerations2, view);
    const understood = yield* understanding.list();
    const spoken = yield* speech.list();
    const audioJobs = yield* audio.list();
    return [...images, ...understood, ...spoken, ...audioJobs]
      .toSorted((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : b.createdAt - a.createdAt))
      .slice(0, 100);
  });
  const publish = Effect.fnUntraced(function* () {
    yield* core.apply({ type: "mediaChanged", jobs: yield* list() });
  });
  const get = Effect.fn("Media.get")(function* (id: string): Effect.fn.Return<T.MediaJob, ApiError> {
    const kind = yield* kindOf(id);
    if (kind === "image") {
      const row = yield* found(id);
      return yield* view(row);
    }
    if (kind === "speech") return yield* speech.get(id);
    if (kind === "understanding" || kind === undefined) return yield* understanding.get(id);
    return yield* audio.get(id);
  });
  const change = Effect.fnUntraced(
    function* (
      id: string,
      before: readonly T.MediaPhase[],
      patch: Partial<Pick<JobRow<T.MediaPhase>, "phase" | "result_url" | "attachment" | "problem" | "usage">>,
    ) {
      const row = yield* found(id);
      if (!before.includes(row.phase)) return false;
      yield* db.run(q.changeImageJob({ ...row, ...patch, now: yield* Clock.currentTimeMillis }));
      yield* publish();
      return true;
    },
    lock.withPermits(1),
    Effect.uninterruptible,
  );

  /** A made image goes back to the channel an orchestrator was asked for it in, under its name, once: the send key is the
   * job's, so a retried download or a restart says nothing again. The user's own jobs (the media page) stay where they are. */
  const postBack = Effect.fnUntraced(function* (id: string) {
    const row = yield* found(id);
    if (row.phase !== "ready" || row.attachment === null) return;
    const source = yield* Schema.decodeEffect(Schema.fromJsonString(S.MediaSource))(row.source);
    if (source.kind !== "orchestrator") return;
    const attachment = yield* Schema.decodeEffect(Schema.fromJsonString(S.Attachment))(row.attachment);
    const request = yield* decodeRequest(row.request);
    const words = t("server.media.imageMade", { prompt: head(request.prompt, 80) });
    yield* channel.post({
      _tag: "Announce",
      from: source.agent,
      channel: source.channel,
      text: words,
      made: { attachments: [attachment.id] },
      sendKey: `media:${id}`,
    });
  });

  const download = Effect.fnUntraced(function* (id: string) {
    const row = yield* found(id);
    if (row.phase !== "downloading" || row.result_url === null) return;
    const request = yield* decodeRequest(row.request);
    yield* Effect.gen(function* () {
      const bytes = yield* downloadImage(row.result_url ?? "", request.width, request.height).pipe(Effect.provideService(PublicHttp, downloads));
      const attachment = yield* kept.attach({ name: `moss-${id}.png`, type: "image/png", data: bytes.toString("base64") });
      yield* change(id, ["downloading"], { phase: "ready", attachment: yield* attachmentJson(attachment), result_url: null, problem: "" });
    }).pipe(
      Effect.catch(() => change(id, ["downloading"], { phase: "download_failed", problem: t("server.media.downloadFailed") })),
      Effect.asVoid,
    );
    // Outside the download's failure: the image is ready whether or not the channel takes it.
    yield* postBack(id).pipe(bestEffort(`media: posting image ${id}`));
  });
  const run = Effect.fnUntraced(function* (id: string, work: Effect.Effect<void, ApiError>) {
    yield* FiberMap.run(
      fibers,
      id,
      slots
        .withPermits(1)(work)
        .pipe(
          Effect.onError(() =>
            change(id, ["generating"], { phase: "unknown", problem: t("server.media.unknown") }).pipe(
              Effect.catch(() => Effect.logError("Media task state could not be recorded")),
            ),
          ),
        ),
    );
  });
  const capacity = Effect.fnUntraced(function* (): Effect.fn.Return<void, ApiError> {
    if (
      (yield* Effect.map(db.run(q.pendingMediaJobs({ kinds: ["image"] })), jobs.many)).length +
        (yield* understanding.pending()) +
        (yield* speech.pending()) +
        (yield* audio.pending()) >=
      8
    )
      return yield* Effect.fail(refused(t("server.media.busy")));
  });

  const understanding = yield* makeUnderstanding({
    inputs,
    remote: remoteFiles,
    lock,
    slots,
    publish,
    capacity,
    otherExists: takenBesides(["understanding"]),
  });
  const speech = yield* makeSpeech({
    inputs,
    lock,
    slots,
    publish,
    capacity,
    otherExists: takenBesides(["speech"]),
  });
  const audio = yield* makeAudio({
    inputs,
    remote: remoteFiles,
    lock,
    slots,
    publish,
    capacity,
    otherExists: takenBesides(["speakers", "voiceDesign", "clone", "transcription"]),
  });

  const releasable = Effect.fnUntraced(function* (id: string) {
    const job = yield* get(id);
    if (job.kind === "image" || job.kind === "understanding" || active(job.phase)) return yield* Effect.fail(refused(t("server.media.releaseUnavailable")));
    return job;
  });

  return Media.of({
    inputs,
    createUnderstanding: understanding.create,
    authorizeUnderstanding: understanding.authorize,
    startUnderstanding: understanding.start,
    createSpeech: speech.create,
    speechResume: speech.resume,
    speechEvents: speech.events,
    createSpeakers: audio.createSpeakers,
    createVoiceDesign: audio.createVoiceDesign,
    createClone: Effect.fn("Media.createClone")((input) => audio.createClone(input, { kind: "user" })),
    createTranscription: Effect.fn("Media.createTranscription")((input) => audio.createTranscription(input, { kind: "user" })),
    audioResume: audio.resume,
    audioPreviewCleanup: audio.previewCleanup,
    audioCleanup: audio.cleanup,
    cleanupUnderstanding: understanding.cleanup,
    previewUnderstandingCleanup: understanding.previewCleanup,
    get,
    list,
    previewRelease: Effect.fn("Media.previewRelease")(function* (id) {
      const job = yield* releasable(id);
      return { does: job.canRelease ? [t("server.media.releasePreview"), t("server.media.releasePreserves"), t("server.media.releaseAbandons")] : [] };
    }, lock.withPermits(1)),
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
          .pipe(Effect.ensuring(publish().pipe(Effect.catch(() => Effect.logError("Media asset release could not be published")))));
        return yield* get(id);
      },
      lock.withPermits(1),
      Effect.uninterruptible,
    ),
    createImage: Effect.fn("Media.createImage")(function* (given, caller) {
      if (caller.kind === "orchestrator" && !caller.forUser) return yield* Effect.fail(refused(t("server.media.userRequired")));
      const source: T.MediaSource = yield* Schema.decodeEffect(S.MediaSource)(caller).pipe(Effect.mapError(() => refused(t("server.media.invalid"))));
      const input = yield* Schema.decodeEffect(S.MediaImageRequest)(given).pipe(Effect.mapError(() => refused(t("server.media.invalid"))));
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const request = yield* requestJson(input).pipe(Effect.mapError(() => refused(t("server.media.invalid"))));
          const existing = yield* image(input.id);
          if (existing) {
            const storedRequest = yield* decodeRequest(existing.request);
            if (!same(storedRequest, input) || !same((yield* view(existing)).source, source)) return yield* Effect.fail(refused(t("server.media.reusedId")));
            return yield* view(existing);
          }
          if (yield* takenBesides(["image"])(input.id)) return yield* Effect.fail(refused(t("server.media.reusedId")));
          yield* capacity();
          const prompt =
            input.format === "layout"
              ? yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(input.prompt).pipe(Effect.mapError(() => refused(t("server.media.invalid"))))
              : input.prompt;
          const connection = yield* provider.image({
            prompt,
            width: input.width,
            height: input.height,
            ...(input.seed !== undefined ? { seed: input.seed } : {}),
            ...(input.steps !== undefined ? { steps: input.steps } : {}),
            ...(input.guidance !== undefined ? { guidance: input.guidance } : {}),
            ...(input.negativePrompt !== undefined ? { negativePrompt: input.negativePrompt } : {}),
            enhance: input.enhance,
            watermark: input.watermark,
          });
          yield* db.run(
            q.insertMediaJob(
              newJob({
                id: input.id,
                kind: "image",
                phase: "queued",
                request,
                source: yield* sourceJson(source).pipe(Effect.mapError(() => refused(t("server.media.invalid")))),
                connection: connection.connection,
                revision: connection.revision,
                model: connection.model,
                now: yield* Clock.currentTimeMillis,
              }),
            ),
          );
          yield* publish();
          const work = Effect.gen(function* () {
            if (!(yield* change(input.id, ["queued"], { phase: "generating" }))) return;
            yield* connection.run.pipe(
              Effect.flatMap((result) =>
                Effect.gen(function* () {
                  if (
                    yield* change(input.id, ["generating"], {
                      phase: "downloading",
                      result_url: result.url,
                      usage: yield* usageJson(result.usage).pipe(Effect.mapError(() => refused(t("server.media.corrupt")))),
                    })
                  )
                    yield* download(input.id);
                }),
              ),
              Effect.catchTag("ImageFailure", (error) =>
                change(input.id, ["generating"], {
                  phase: error.outcome === "Unknown" ? "unknown" : "failed",
                  problem: error.outcome === "Unknown" ? t("server.media.unknown") : t("server.media.rejected"),
                }),
              ),
              Effect.asVoid,
            );
          });
          yield* run(input.id, work);
          const found2 = yield* found(input.id);
          return yield* view(found2);
        }).pipe(Effect.uninterruptible),
      );
    }),
    cancel: Effect.fn("Media.cancel")(function* (id) {
      const kind = yield* kindOf(id);
      if (kind === "speech") return yield* speech.cancel(id);
      if (kind === "understanding") return yield* understanding.cancel(id);
      if (kind !== undefined && kind !== "image") return yield* audio.cancel(id);
      const fiber = yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const row = yield* found(id);
          if (!active(row.phase)) return Option.none();
          yield* db.run(q.changeImageJob({ ...row, phase: "canceled", problem: t("server.media.canceled"), now: yield* Clock.currentTimeMillis }));
          yield* publish();
          return FiberMap.getUnsafe(fibers, id);
        }).pipe(Effect.uninterruptible),
      );
      if (Option.isSome(fiber)) yield* Fiber.interrupt(fiber.value);
      return yield* get(id);
    }),
    retryDownload: Effect.fn("Media.retryDownload")(function* (id) {
      const kind = yield* kindOf(id);
      if (kind === "speech") return yield* speech.retryDownload(id);
      if (kind !== undefined && kind !== "image" && kind !== "understanding") return yield* audio.retryDownload(id);
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const row = yield* found(id);
          if (row.phase === "ready" || row.phase === "downloading") return yield* view(row);
          if (row.result_url === null || (row.phase !== "download_failed" && row.phase !== "canceled"))
            return yield* Effect.fail(refused(t("server.media.noDownload")));
          yield* capacity();
          yield* db.run(q.changeImageJob({ ...row, phase: "downloading", problem: "", now: yield* Clock.currentTimeMillis }));
          yield* publish();
          yield* run(id, download(id));
          return yield* get(id);
        }).pipe(Effect.uninterruptible),
      );
    }),
    restore: Effect.fn("Media.restore")(function* () {
      yield* remoteFiles.restore();
      yield* understanding.restore();
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
      yield* db.run(q.interruptImageJobs({ problem: t("server.media.restarted"), now: yield* Clock.currentTimeMillis }));
      yield* speech.restore();
      yield* audio.restore();
      yield* publish();
      // A stop between ready and the post leaves it unposted: the recent ones are posted again, the send key keeping each once.
      const recent = yield* Effect.map(db.run(q.recentMediaJobs({ kinds: ["image"] })), jobs.many);
      yield* Effect.forEach(recent, (row) => postBack(row.id).pipe(bestEffort(`media: posting image ${row.id}`)), { discard: true });
      const pendingGenerations2 = yield* Effect.map(db.run(q.pendingMediaJobs({ kinds: ["image"] })), jobs.many);
      yield* Effect.forEach(pendingGenerations2, (row) => (row.phase === "downloading" ? run(row.id, download(row.id)) : Effect.void), {
        discard: true,
      });
    }),
  });
});

export const start = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* (yield* Media).restore();
  }),
);
