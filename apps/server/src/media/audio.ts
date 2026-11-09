import { Clock, Effect, Fiber, FiberMap, FileSystem, Option, Schedule, Schema, Semaphore } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";

import { type ApiError, refused } from "#/base/errors.ts";
import { Channel } from "#/channel/channel.ts";
import { Db } from "#/infra/db.ts";
import { fileBlob } from "#/infra/files.ts";
import { bestEffort } from "#/infra/log.ts";
import { PublicHttp } from "#/infra/publicHttp.ts";
import { type Account, Provider } from "#/provider/provider.ts";
import * as q from "#db/media_audio.sql.ts";

import { inspectAudio } from "./audioMetadata.ts";
import { type MediaInputs, releaseAudioResult, saveAudioResult } from "./audioResult.ts";
import type { MediaCaller } from "./media.ts";
import { receiveTranscriptionStream, type TranscriptionCheckpoint } from "./transcriptionStream.ts";

interface AudioInputs extends MediaInputs {
  get: (id: string) => Effect.Effect<T.MediaInput, ApiError>;
  content: (id: string) => Effect.Effect<{ path: string; mime: string; size: number; name: string }, ApiError>;
  blob: (id: string, holder: string) => Effect.Effect<Blob, ApiError>;
  pin: (ids: readonly string[], holder: string, admit: Effect.Effect<void, ApiError>) => Effect.Effect<T.MediaInput[], ApiError>;
  release: (holder: string) => Effect.Effect<void, ApiError>;
}
interface AudioRemoteFiles {
  upload: (holder: string, input: string, account: Account) => Effect.Effect<string, ApiError>;
  remove: (holder: string, input: string, account: Account) => Effect.Effect<void, ApiError>;
  list: (holder: string) => Effect.Effect<readonly { input_id: string; phase: string; remote_id: string | null }[]>;
}
interface AudioPorts {
  inputs: AudioInputs;
  remote: AudioRemoteFiles;
  lock: Semaphore.Semaphore;
  slots: Semaphore.Semaphore;
  publish: () => Effect.Effect<void, ApiError>;
  capacity: () => Effect.Effect<void, ApiError>;
  otherExists: (id: string) => Effect.Effect<boolean>;
}
export interface AudioWorkflow {
  createSpeakers: (input: T.MediaSpeakersRequest, caller: MediaCaller) => Effect.Effect<T.MediaAudioJob, ApiError>;
  createVoiceDesign: (input: T.MediaVoiceDesignRequest, caller: MediaCaller) => Effect.Effect<T.MediaAudioJob, ApiError>;
  createClone: (input: T.MediaCloneRequest, caller: MediaCaller) => Effect.Effect<T.MediaAudioJob, ApiError>;
  createTranscription: (input: T.MediaTranscriptionRequest, caller: MediaCaller) => Effect.Effect<T.MediaAudioJob, ApiError>;
  get: (id: string) => Effect.Effect<T.MediaAudioJob, ApiError>;
  list: () => Effect.Effect<T.MediaAudioJob[], ApiError>;
  has: (id: string) => Effect.Effect<boolean>;
  pending: () => Effect.Effect<number>;
  cancel: (id: string) => Effect.Effect<T.MediaAudioJob, ApiError>;
  retryDownload: (id: string) => Effect.Effect<T.MediaAudioJob, ApiError>;
  resume: (id: string) => Effect.Effect<T.MediaAudioJob, ApiError>;
  previewCleanup: (id: string) => Effect.Effect<T.Preview, ApiError>;
  cleanup: (id: string) => Effect.Effect<T.MediaAudioJob, ApiError>;
  restore: () => Effect.Effect<void, ApiError>;
}

const encodeJson = <A, I>(schema: Schema.Codec<A, I>) => Schema.encodeEffect(Schema.fromJsonString(schema));
const attachmentJson = encodeJson(S.Attachment);
const referenceJson = encodeJson(S.MediaInputReference);
const metadataJson = encodeJson(S.MediaAudioMetadata);
const resultJson = encodeJson(S.MediaAudioResult);
const usageJson = encodeJson(S.MediaAudioUsage);
const requestJson = encodeJson(S.MediaAudioRequest);
const sourceJson = encodeJson(S.MediaSource);

export const makeAudio = Effect.fnUntraced(function* (ports: AudioPorts) {
  const db = yield* Db;
  const provider = yield* Provider;
  const channel = yield* Channel;
  const downloads = yield* PublicHttp;
  const fs = yield* FileSystem.FileSystem;
  const fibers = yield* FiberMap.make<string, void, ApiError>();
  const cleanupSlot = yield* Semaphore.make(1);
  const active = (phase: T.MediaPhase) => phase === "queued" || phase === "generating" || phase === "downloading";
  const invalid = () => refused(t("server.media.audioInvalid"));
  const corrupt = () => refused(t("server.media.corrupt"));
  const request = (row: q.AudioResult) => Schema.decodeEffect(Schema.fromJsonString(S.MediaAudioRequest))(row.request).pipe(Effect.mapError(corrupt));
  const found = Effect.fnUntraced(function* (id: string) {
    const row = yield* db.one(q.audio({ id }));
    if (!row) return yield* Effect.fail(refused(t("server.media.missing")));
    return row;
  });
  const view = Effect.fnUntraced(function* (row: q.AudioResult): Effect.fn.Return<T.MediaAudioJob, ApiError> {
    const input = yield* request(row);
    const attachment =
      row.attachment === null ? undefined : yield* Schema.decodeEffect(Schema.fromJsonString(S.Attachment))(row.attachment).pipe(Effect.mapError(corrupt));
    const remote = row.phase === "ready" || row.phase === "failed" ? yield* ports.remote.list(row.id) : [];
    const base = {
      id: row.id,
      model: row.model,
      connection: row.connection,
      revision: row.revision,
      source: yield* Schema.decodeEffect(Schema.fromJsonString(S.MediaSource))(row.source).pipe(Effect.mapError(corrupt)),
      phase: row.phase,
      phaseText: t(`server.media.phase.${row.phase}`),
      problem: row.problem,
      format: row.result_format,
      contentType: row.content_type,
      ...(row.metadata === null
        ? {}
        : { metadata: yield* Schema.decodeEffect(Schema.fromJsonString(S.MediaAudioMetadata))(row.metadata).pipe(Effect.mapError(corrupt)) }),
      ...(row.usage === null ? {} : { usage: yield* Schema.decodeEffect(Schema.fromJsonString(S.MediaAudioUsage))(row.usage).pipe(Effect.mapError(corrupt)) }),
      input: row.input === null ? null : yield* Schema.decodeEffect(Schema.fromJsonString(S.MediaInputReference))(row.input).pipe(Effect.mapError(corrupt)),
      resultInput:
        row.result_input === null
          ? null
          : yield* Schema.decodeEffect(Schema.fromJsonString(S.MediaInputReference))(row.result_input).pipe(Effect.mapError(corrupt)),
      ...(attachment ? { attachment } : {}),
      previewInput: row.preview_input,
      result: row.result === null ? null : yield* Schema.decodeEffect(Schema.fromJsonString(S.MediaAudioResult))(row.result).pipe(Effect.mapError(corrupt)),
      canCancel: active(row.phase),
      canRetryDownload: row.assets_released === 0 && row.result_url !== null && (row.phase === "download_failed" || row.phase === "canceled"),
      canResume:
        row.assets_released === 0 &&
        !(input.kind === "transcription" && input.streaming === true) &&
        row.remote_task_id !== null &&
        row.result_url === null &&
        row.result === null &&
        (row.phase === "unknown" || row.phase === "canceled"),
      canCleanup: remote.some((file) => file.remote_id !== null && file.phase !== "deleted"),
      canRelease: !active(row.phase) && row.assets_released === 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    switch (input.kind) {
      case "speakers":
        return { ...base, kind: input.kind, request: input, prompt: input.segments.map((segment) => `${segment.speaker}: ${segment.text}`).join("\n") };
      case "voiceDesign":
        return { ...base, kind: input.kind, request: input, prompt: input.text };
      case "clone":
        return { ...base, kind: input.kind, request: input, prompt: input.name ?? "" };
      case "transcription":
        return { ...base, kind: input.kind, request: input, prompt: base.input?.name ?? "" };
    }
  });
  const get = Effect.fn("Media.audioGet")(function* (id: string) {
    const found2 = yield* found(id);
    return yield* view(found2);
  });
  const change = Effect.fnUntraced(
    function* (
      id: string,
      before: readonly T.MediaPhase[],
      patch: Partial<
        Pick<
          q.AudioResult,
          | "phase"
          | "remote_task_id"
          | "result_url"
          | "result_format"
          | "content_type"
          | "metadata"
          | "usage"
          | "result"
          | "attachment"
          | "result_input"
          | "preview_input"
          | "problem"
        >
      >,
    ) {
      const row = yield* found(id);
      if (!before.includes(row.phase)) return false;
      yield* db.run(q.changeAudio({ ...row, ...patch, now: yield* Clock.currentTimeMillis }));
      yield* ports.publish();
      return true;
    },
    ports.lock.withPermits(1),
    Effect.uninterruptible,
  );
  const originalAccount = Effect.fnUntraced(function* (row: q.AudioResult): Effect.fn.Return<Account, ApiError> {
    const account = yield* provider.account({ connection: row.connection, model: row.model });
    if (account.fingerprint !== row.fingerprint) return yield* Effect.fail(refused(t("server.media.audioAccountChanged")));
    return { ...account, revision: row.revision };
  });
  const clean = Effect.fnUntraced(function* (id: string) {
    const row = yield* found(id);
    if (row.phase !== "ready" && row.phase !== "failed" && !(row.phase === "canceled" && row.remote_task_id === null)) return;
    const remote = yield* ports.remote.list(id);
    if (row.phase === "canceled" && remote.length > 0) return;
    if (remote.some((file) => file.remote_id === null && (file.phase === "unknown" || file.phase === "uploading"))) return;
    yield* Effect.forEach(
      remote,
      (file) =>
        Effect.gen(function* () {
          if (file.phase !== "deleted") {
            const account = yield* originalAccount(row);
            yield* ports.remote.remove(id, file.input_id, account);
          }
        }),
      { discard: true },
    );
    // Saved results retain their source until the owner explicitly releases local assets.
    if (row.input !== null && row.result === null) yield* ports.inputs.release(id);
    if (row.problem === t("server.media.audioCleanupPending")) yield* change(id, ["ready", "failed", "canceled"], { problem: "" });
    else yield* ports.publish();
  });
  const cleanSafely = (id: string) =>
    cleanupSlot.withPermits(1)(
      clean(id).pipe(
        Effect.catch(() => change(id, ["ready", "failed", "canceled"], { problem: t("server.media.audioCleanupPending") })),
        Effect.asVoid,
      ),
    );
  const download = Effect.fnUntraced(function* (id: string) {
    const row = yield* found(id);
    if (row.phase !== "downloading" || row.result_url === null) return;
    const resultUrl = row.result_url;
    const input = yield* request(row);
    if (input.kind !== "speakers" && input.kind !== "voiceDesign") return yield* Effect.fail(corrupt());
    yield* Effect.uninterruptibleMask((resume) =>
      Effect.gen(function* () {
        if (row.result_format === null || row.content_type === null) return yield* Effect.fail(corrupt());
        const format = row.result_format;
        const saved = yield* resume(
          saveAudioResult(id, resultUrl, format, ports.inputs).pipe(
            Effect.provideService(PublicHttp, downloads),
            Effect.provideService(Channel, channel),
            Effect.provideService(FileSystem.FileSystem, fs),
          ),
        );
        let retained = saved;
        yield* Effect.gen(function* () {
          let preview: T.MediaInputReference | undefined;
          if (
            input.kind === "voiceDesign" &&
            ["wav", "mp3", "flac"].includes(format) &&
            saved.attachment &&
            saved.attachment.size <= 10_000_000 &&
            saved.metadata?.duration !== undefined &&
            saved.metadata.duration <= 30
          ) {
            const file = yield* channel.attachment(saved.attachment.id);
            if (!file) return yield* Effect.fail(corrupt());
            preview = yield* ports.inputs.storeResult(
              {
                path: file.path,
                hash: saved.attachment.id,
                size: saved.attachment.size,
                mime: saved.attachment.type,
                name: saved.attachment.name,
                metadata: saved.metadata,
              },
              id,
              true,
            );
            retained = { ...saved, resultInput: preview };
          }
          yield* ports.lock.withPermits(1)(
            Effect.gen(function* () {
              const current = yield* found(id);
              if (current.phase !== "downloading") {
                yield* releaseAudioResult(id, retained, ports.inputs);
                return;
              }
              yield* db
                .attempt(
                  q.changeAudio({
                    ...current,
                    phase: "ready",
                    attachment: saved.attachment ? yield* attachmentJson(saved.attachment).pipe(Effect.mapError(corrupt)) : null,
                    result_input: saved.resultInput ? yield* referenceJson(saved.resultInput).pipe(Effect.mapError(corrupt)) : null,
                    metadata: saved.metadata ? yield* metadataJson(saved.metadata).pipe(Effect.mapError(corrupt)) : null,
                    result_url: null,
                    preview_input: preview?.id ?? null,
                    problem: "",
                    now: yield* Clock.currentTimeMillis,
                  }),
                )
                .pipe(Effect.mapError(corrupt));
              yield* ports.publish();
            }),
          );
        }).pipe(
          Effect.onError(() =>
            Effect.gen(function* () {
              if ((yield* found(id)).phase !== "ready") yield* releaseAudioResult(id, retained, ports.inputs);
            }).pipe(bestEffort("Media audio result rollback is pending")),
          ),
        );
      }),
    ).pipe(
      Effect.catch(() => change(id, ["downloading"], { phase: "download_failed", problem: t("server.media.speechDownloadFailed") })),
      Effect.asVoid,
    );
  });
  const poll = Effect.fnUntraced(function* (id: string) {
    const once = Effect.gen(function* () {
      const row = yield* found(id);
      if (row.phase !== "generating" || row.remote_task_id === null) return true;
      const remoteId = row.remote_task_id;
      const task = yield* Effect.gen(function* () {
        const account = yield* originalAccount(row);
        return yield* account.tasks.get(remoteId);
      }).pipe(
        Effect.retry({
          times: 3,
          schedule: Schedule.exponential("1 second"),
          while: (error) => error._tag === "AudioFailure" && error.retryable,
        }),
      );
      const expected = row.kind === "transcription" ? "transcription" : row.kind === "voiceDesign" ? "voiceGeneration" : "speech";
      if (task.kind !== expected) return yield* Effect.fail(invalid());
      if (task.status !== "ready") {
        if (task.status !== "failed") return false;
        yield* change(id, ["generating"], { phase: "failed", problem: t("server.media.audioRejected") });
        return true;
      }
      if (task.kind === "transcription") {
        const result: T.MediaAudioResult = { kind: "transcription", text: task.text, segments: [...(task.segments ?? [])] };
        yield* change(id, ["generating"], {
          phase: "ready",
          result: yield* resultJson(result).pipe(Effect.mapError(corrupt)),
          usage: task.usage === undefined ? null : yield* usageJson(task.usage).pipe(Effect.mapError(corrupt)),
          problem: "",
        });
      } else {
        if (
          yield* change(id, ["generating"], {
            phase: "downloading",
            result_url: task.url,
            result_format: task.format,
            content_type: task.contentType,
            usage: task.usage === undefined ? null : yield* usageJson(task.usage).pipe(Effect.mapError(corrupt)),
            problem: "",
          })
        )
          yield* download(id);
      }
      return true;
    });
    yield* once.pipe(
      Effect.repeat(
        Schedule.spaced("3 seconds").pipe(
          Schedule.upTo({ times: 600 }),
          Schedule.setInputType<boolean>(),
          Schedule.while(({ input }) => !input),
        ),
      ),
      Effect.catch(() => change(id, ["generating"], { phase: "unknown", problem: t("server.media.audioPollingPaused") })),
    );
    yield* change(id, ["generating"], { phase: "unknown", problem: t("server.media.audioPollingPaused") });
  });
  const run = Effect.fnUntraced(function* (id: string, work: Effect.Effect<void, ApiError>) {
    yield* FiberMap.run(
      fibers,
      id,
      ports.slots
        .withPermits(1)(work.pipe(Effect.andThen(cleanSafely(id))))
        .pipe(
          Effect.onError(() =>
            change(id, ["generating"], { phase: "unknown", problem: t("server.media.audioUnknown") }).pipe(
              bestEffort("Media audio interruption could not be recorded"),
            ),
          ),
        ),
    );
  });
  const submit = Effect.fnUntraced(function* (id: string) {
    if (!(yield* change(id, ["queued"], { phase: "generating" }))) return;
    const found2 = yield* found(id);
    const input = yield* request(found2);
    let attempted = false;
    yield* Effect.gen(function* () {
      const found3 = yield* found(id);
      const account = yield* originalAccount(found3);
      if (input.kind === "clone") {
        const blob = yield* ports.inputs.blob(input.input, id);
        const metadata = yield* inspectAudio(blob).pipe(Effect.mapError(invalid));
        if (blob.size > 10_000_000 || metadata.duration > 30 || !["wav", "mp3", "m4a", "flac"].includes(metadata.format)) return yield* Effect.fail(invalid());
        const found5 = yield* found(id);
        yield* originalAccount(found5);
        attempted = true;
        yield* Effect.uninterruptibleMask((resume) =>
          Effect.gen(function* () {
            const voice = yield* resume(
              account.voices.clone({
                audio: blob,
                filename: `sample.${metadata.format}`,
                durationSeconds: metadata.duration,
                ...(input.name !== undefined ? { name: input.name } : {}),
              }),
            );
            const result = yield* resultJson({ kind: "clone", voice }).pipe(Effect.mapError(corrupt));
            return yield* change(id, ["generating", "canceled", "unknown"], { phase: "ready", result, problem: "" });
          }),
        );
        return;
      }
      if (input.kind === "transcription" && input.streaming === true) {
        const fileId = yield* ports.remote.upload(id, input.input, account);
        const found6 = yield* found(id);
        yield* originalAccount(found6);
        attempted = true;
        yield* receiveTranscriptionStream(
          account.transcription.stream({
            fileId,
            ...(input.diarize === undefined ? {} : { diarize: input.diarize }),
            ...(input.keyterms === undefined ? {} : { keyterms: input.keyterms }),
          }),
          {
            task: (taskId) => change(id, ["generating", "canceled"], { remote_task_id: taskId }).pipe(Effect.asVoid),
            save: Effect.fnUntraced(function* (checkpoint: TranscriptionCheckpoint) {
              const patch = {
                result: yield* resultJson(checkpoint.result).pipe(Effect.mapError(corrupt)),
                usage: checkpoint.usage === undefined ? null : yield* usageJson(checkpoint.usage).pipe(Effect.mapError(corrupt)),
              };
              if (checkpoint.complete) {
                if (!(yield* change(id, ["generating"], { ...patch, phase: "ready", problem: "" }))) yield* change(id, ["canceled", "unknown"], patch);
              } else yield* change(id, ["generating", "canceled", "unknown"], patch);
            }),
          },
        );
        return;
      }
      const synthesis =
        input.kind === "speakers"
          ? account.speakers.createTask({ speakers: input.speakers, segments: input.segments, format: input.format })
          : input.kind === "voiceDesign"
            ? account.voiceDesign.createTask({ text: input.text, instruction: input.instruction, format: input.format })
            : account.transcription.createTask({
                fileId: yield* ports.remote.upload(id, input.input, account),
                ...(input.diarize !== undefined ? { diarize: input.diarize } : {}),
                ...(input.keyterms !== undefined ? { keyterms: input.keyterms } : {}),
              });
      const found4 = yield* found(id);
      yield* originalAccount(found4);
      attempted = true;
      // Only the HTTP wait is interruptible: a returned task ID must reach durable storage before polling or cancellation can intervene.
      yield* Effect.uninterruptibleMask((resume) =>
        resume(synthesis).pipe(Effect.flatMap((taskId) => change(id, ["generating", "canceled", "unknown"], { remote_task_id: taskId }))),
      );
      yield* poll(id);
    }).pipe(
      Effect.catchTag("AudioFailure", (error) =>
        change(id, ["generating"], {
          phase: error.outcome === "Unknown" ? "unknown" : "failed",
          problem: error.outcome === "Unknown" ? t("server.media.audioUnknown") : t("server.media.audioRejected"),
        }),
      ),
      Effect.catch(() =>
        Effect.gen(function* () {
          const uncertainUpload = (yield* ports.remote.list(id)).some((file) => file.phase === "unknown" || file.phase === "uploading");
          yield* change(id, ["generating"], {
            phase: attempted || uncertainUpload ? "unknown" : "failed",
            problem: attempted || uncertainUpload ? t("server.media.audioUnknown") : t("server.media.audioRejected"),
          });
        }),
      ),
      Effect.asVoid,
    );
  });
  const create = Effect.fnUntraced(function* (given: T.MediaAudioRequest, caller: MediaCaller): Effect.fn.Return<T.MediaAudioJob, ApiError> {
    if ((caller.kind === "orchestrator" && !caller.forOwner) || ((given.kind === "clone" || given.kind === "transcription") && caller.kind !== "owner"))
      return yield* Effect.fail(refused(t("server.media.ownerRequired")));
    const source = yield* Schema.decodeEffect(S.MediaSource)(caller).pipe(Effect.mapError(invalid));
    const input = yield* Schema.decodeEffect(S.MediaAudioRequest)(given, { onExcessProperty: "error" }).pipe(Effect.mapError(invalid));
    return yield* ports.lock.withPermits(1)(
      Effect.gen(function* () {
        const existing = yield* db.one(q.audio({ id: input.id }));
        if (existing) {
          const storedRequest = yield* request(existing);
          if (!same(storedRequest, input) || !same((yield* view(existing)).source, source)) return yield* Effect.fail(refused(t("server.media.reusedId")));
          return yield* view(existing);
        }
        if (yield* ports.otherExists(input.id)) return yield* Effect.fail(refused(t("server.media.reusedId")));
        yield* ports.capacity();
        const account =
          input.kind === "speakers"
            ? yield* provider.speakers()
            : input.kind === "voiceDesign"
              ? yield* provider.voiceDesign()
              : input.kind === "transcription"
                ? yield* provider.transcription()
                : yield* provider.account({ connection: input.connection, model: "" });
        if (account.connection !== input.connection || account.revision !== input.revision)
          return yield* Effect.fail(refused(t("server.media.audioAccountChanged")));
        let reference: T.MediaInputReference | null = null;
        if (input.kind === "clone" || input.kind === "transcription") {
          const local = yield* ports.inputs.get(input.input);
          if (local.kind !== "audio" || local.phase !== "ready" || local.hash === null) return yield* Effect.fail(invalid());
          reference = { id: local.id, kind: local.kind, mime: local.mime, name: local.name, size: local.size, hash: local.hash };
          const content = yield* ports.inputs.content(input.input);
          const fileBlob2 = yield* fileBlob(content.path, content.mime).pipe(Effect.mapError(invalid));
          const metadata = yield* inspectAudio(fileBlob2).pipe(Effect.mapError(invalid));
          if (
            metadata.duration > 3600 ||
            (input.kind === "clone" && (local.size > 10_000_000 || metadata.duration > 30 || !["wav", "mp3", "m4a", "flac"].includes(metadata.format)))
          )
            return yield* Effect.fail(invalid());
        }
        if (input.kind === "speakers")
          yield* account.speakers.check({ speakers: input.speakers, segments: input.segments, format: input.format }).pipe(Effect.mapError(invalid));
        if (input.kind === "voiceDesign")
          yield* account.voiceDesign.check({ text: input.text, instruction: input.instruction, format: input.format }).pipe(Effect.mapError(invalid));
        if (input.kind === "transcription")
          yield* account.transcription
            .check({
              fileId: input.input,
              ...(input.diarize !== undefined ? { diarize: input.diarize } : {}),
              ...(input.keyterms !== undefined ? { keyterms: input.keyterms } : {}),
              streaming: input.streaming === true,
            })
            .pipe(Effect.mapError(invalid));
        const insert = db.run(
          q.insertAudio({
            id: input.id,
            kind: input.kind,
            request: yield* requestJson(input).pipe(Effect.mapError(invalid)),
            source: yield* sourceJson(source).pipe(Effect.mapError(invalid)),
            input: reference === null ? null : yield* referenceJson(reference).pipe(Effect.mapError(invalid)),
            connection: account.connection,
            revision: account.revision,
            model: account.model,
            fingerprint: account.fingerprint,
            now: yield* Clock.currentTimeMillis,
          }),
        );
        if (reference) yield* ports.inputs.pin([reference.id], input.id, insert);
        else yield* insert;
        yield* ports.publish();
        yield* run(input.id, submit(input.id));
        return yield* get(input.id);
      }).pipe(Effect.uninterruptible),
    );
  });
  const api: AudioWorkflow = {
    createSpeakers: Effect.fn("Media.createSpeakers")((input, caller) => create({ ...input, kind: "speakers" }, caller)),
    createVoiceDesign: Effect.fn("Media.createVoiceDesign")((input, caller) => create({ ...input, kind: "voiceDesign" }, caller)),
    createClone: Effect.fn("Media.createClone")((input, caller) => create({ ...input, kind: "clone" }, caller)),
    createTranscription: Effect.fn("Media.createTranscription")((input, caller) => create({ ...input, kind: "transcription" }, caller)),
    get,
    list: Effect.fn("Media.audioList")(function* () {
      const recentAudio2 = yield* db.run(q.recentAudio());
      return yield* Effect.forEach(recentAudio2, view);
    }),
    has: (id) => db.one(q.audio({ id })).pipe(Effect.map((row) => row !== undefined)),
    pending: () => db.run(q.pendingAudio()).pipe(Effect.map((rows) => rows.length)),
    previewCleanup: Effect.fn("Media.audioPreviewCleanup")(function* (id): Effect.fn.Return<T.Preview, ApiError> {
      const row = yield* found(id);
      if (row.phase !== "ready" && row.phase !== "failed") return yield* Effect.fail(refused(t("server.media.busy")));
      const files = yield* ports.remote.list(id);
      const count = files.filter((file) => file.remote_id !== null && file.phase !== "deleted").length;
      return { does: count === 0 ? [] : [t("server.media.cleanupPreview", { count, connection: row.connection })] };
    }),
    cleanup: Effect.fn("Media.audioCleanup")(function* (id) {
      const row = yield* found(id);
      if (row.phase !== "ready" && row.phase !== "failed") return yield* Effect.fail(refused(t("server.media.busy")));
      yield* cleanSafely(id);
      return yield* get(id);
    }),
    cancel: Effect.fn("Media.audioCancel")(function* (id) {
      const fiber = yield* ports.lock.withPermits(1)(
        Effect.gen(function* () {
          const row = yield* found(id);
          if (!active(row.phase)) return Option.none();
          yield* db.run(q.changeAudio({ ...row, phase: "canceled", problem: t("server.media.canceled"), now: yield* Clock.currentTimeMillis }));
          yield* ports.publish();
          return FiberMap.getUnsafe(fibers, id);
        }),
      );
      if (Option.isSome(fiber)) yield* Fiber.interrupt(fiber.value);
      yield* cleanSafely(id);
      return yield* get(id);
    }, Effect.uninterruptible),
    retryDownload: Effect.fn("Media.audioRetryDownload")(function* (id) {
      return yield* ports.lock.withPermits(1)(
        Effect.gen(function* () {
          const row = yield* found(id);
          if (row.phase === "ready" || row.phase === "downloading") return yield* view(row);
          if (!(yield* view(row)).canRetryDownload) return yield* Effect.fail(refused(t("server.media.noDownload")));
          yield* ports.capacity();
          yield* db.run(q.changeAudio({ ...row, phase: "downloading", problem: "", now: yield* Clock.currentTimeMillis }));
          yield* ports.publish();
          yield* run(id, download(id));
          return yield* get(id);
        }).pipe(Effect.uninterruptible),
      );
    }),
    resume: Effect.fn("Media.audioResume")(function* (id) {
      return yield* ports.lock.withPermits(1)(
        Effect.gen(function* () {
          const row = yield* found(id);
          if (row.phase === "ready" || active(row.phase)) return yield* view(row);
          if (!(yield* view(row)).canResume) return yield* Effect.fail(refused(t("server.media.audioPollingPaused")));
          yield* originalAccount(row);
          yield* ports.capacity();
          yield* db.run(q.changeAudio({ ...row, phase: "generating", problem: "", now: yield* Clock.currentTimeMillis }));
          yield* ports.publish();
          yield* run(id, poll(id));
          return yield* get(id);
        }).pipe(Effect.uninterruptible),
      );
    }),
    restore: Effect.fn("Media.audioRestore")(function* () {
      yield* db.run(q.interruptAudio({ now: yield* Clock.currentTimeMillis, problem: t("server.media.restarted") }));
      yield* ports.publish();
      const pendingAudio2 = yield* db.run(q.pendingAudio());
      yield* Effect.forEach(
        pendingAudio2,
        (row) =>
          Effect.gen(function* () {
            if (row.phase === "downloading") yield* run(row.id, download(row.id));
            else if (row.remote_task_id !== null)
              yield* originalAccount(row).pipe(
                Effect.andThen(run(row.id, poll(row.id))),
                Effect.catch(() => change(row.id, ["generating"], { phase: "unknown", problem: t("server.media.audioAccountChanged") })),
              );
          }),
        { discard: true },
      );
      const audioCleanup2 = yield* db.run(q.audioCleanup());
      yield* Effect.forEach(audioCleanup2, (row) => cleanSafely(row.id), { discard: true });
    }),
  };
  return api;
});
