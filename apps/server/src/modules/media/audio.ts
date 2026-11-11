import { Clock, Effect, FileSystem, Option, Schema } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { MediaPhaseValues } from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";

import { type ApiError, BizCode, refuseIn } from "#/base/errors.ts";
import { Db } from "#/infra/db.ts";
import { fileBlob } from "#/infra/files.ts";
import { bestEffort } from "#/infra/log.ts";
import { PublicHttp } from "#/infra/publicHttp.ts";
import { Attachment } from "#/modules/attachment/attachment.ts";
import { type Account, Provider } from "#/modules/provider/provider.ts";
import * as q from "#db/media_job.sql.ts";

import { inspectAudio } from "./audioMetadata.ts";
import { type MediaInputs, releaseAudioResult, saveAudioResult } from "./audioResult.ts";
import { jobsOf, newJob, type Row } from "./job.ts";
import type { Machine, Patch, Words } from "./machine.ts";
import type { MediaCaller } from "./media.ts";
import { receiveTranscriptionStream, type TranscriptionCheckpoint } from "./transcriptionStream.ts";

const refused = refuseIn(BizCode.MediaRefused);

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
  readonly inputs: AudioInputs;
  readonly remote: AudioRemoteFiles;
  readonly machine: Machine;
}
/** The audio kinds this file runs, in media_job. */
export const audioKinds: readonly string[] = ["speakers", "voiceDesign", "clone", "transcription"];
const jobs = jobsOf({ kinds: audioKinds, phases: MediaPhaseValues });

const encodeJson = <A, I>(schema: Schema.Codec<A, I>) => Schema.encodeEffect(Schema.fromJsonString(schema));
const attachmentJson = encodeJson(S.Attachment);
const referenceJson = encodeJson(S.MediaInputReference);
const metadataJson = encodeJson(S.MediaAudioMetadata);
const resultJson = encodeJson(S.MediaAudioResult);
const usageJson = encodeJson(S.MediaAudioUsage);
const requestJson = encodeJson(S.MediaAudioRequest);
const sourceJson = encodeJson(S.MediaSource);

/** Several voices, a designed voice, a cloned voice and transcription (MOSS): vendor tasks the machine follows, a clone
 * asked at once, and a transcript streamed in. What it uploads to the vendor goes again once the job is done. */
export const makeAudio = Effect.fnUntraced(function* ({ inputs, remote, machine }: AudioPorts) {
  const db = yield* Db;
  const provider = yield* Provider;
  const kept = yield* Attachment;
  const downloads = yield* PublicHttp;
  const fs = yield* FileSystem.FileSystem;
  const audioStorage = { http: downloads, files: kept, fs };
  const invalid = () => refused(t("server.media.audioInvalid"));
  const corrupt = () => refused(t("server.media.corrupt"));
  const words: Words = {
    unknown: t("server.media.audioUnknown"),
    rejected: t("server.media.audioRejected"),
    paused: t("server.media.audioPollingPaused"),
    downloadFailed: t("server.media.speechDownloadFailed"),
    accountChanged: t("server.media.audioAccountChanged"),
    noResume: t("server.media.audioPollingPaused"),
  };
  const request = (row: Row) => Schema.decodeEffect(Schema.fromJsonString(S.MediaAudioRequest))(row.request).pipe(Effect.mapError(corrupt));
  const decoded = <A, I>(schema: Schema.Codec<A, I>, text: string) => Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(Effect.mapError(corrupt));
  const view = Effect.fnUntraced(function* (given: Row): Effect.fn.Return<T.MediaAudioJob, ApiError> {
    const row = jobs.one(given);
    if (row === undefined) return yield* corrupt();
    const input = yield* request(row);
    const attachment = row.attachment === null ? undefined : yield* decoded(S.Attachment, row.attachment);
    const uploaded = row.phase === "ready" || row.phase === "failed" ? yield* remote.list(row.id) : [];
    const base = {
      id: row.id,
      model: row.model,
      connection: row.connection,
      revision: row.revision,
      source: yield* decoded(S.MediaSource, row.source),
      phase: row.phase,
      phaseText: t(`server.media.phase.${row.phase}`),
      problem: row.problem,
      format: row.result_format,
      contentType: row.content_type,
      ...(row.metadata === null ? {} : { metadata: yield* decoded(S.MediaAudioMetadata, row.metadata) }),
      ...(row.usage === null ? {} : { usage: yield* decoded(S.MediaAudioUsage, row.usage) }),
      input: row.input === null ? null : yield* decoded(S.MediaInputReference, row.input),
      resultInput: row.result_input === null ? null : yield* decoded(S.MediaInputReference, row.result_input),
      ...(attachment ? { attachment } : {}),
      previewInput: row.preview_input,
      result: row.result === null ? null : yield* decoded(S.MediaAudioResult, row.result),
      canCancel: machine.active(row.phase),
      canRetryDownload: row.assets_released === 0 && row.result_url !== null && (row.phase === "download_failed" || row.phase === "canceled"),
      canResume:
        row.assets_released === 0 &&
        !(input.kind === "transcription" && input.streaming === true) &&
        row.remote_task !== null &&
        row.result_url === null &&
        row.result === null &&
        (row.phase === "unknown" || row.phase === "canceled"),
      canCleanup: uploaded.some((file) => file.remote_id !== null && file.phase !== "deleted"),
      canRelease: !machine.active(row.phase) && row.assets_released === 0,
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
    const row = yield* machine.found(id, audioKinds);
    return yield* view(row);
  });
  const originalAccount = Effect.fnUntraced(function* (row: Row): Effect.fn.Return<Account, ApiError> {
    const account = yield* provider.account({ connection: row.connection, model: row.model });
    if (account.fingerprint !== row.fingerprint) return yield* refused(words.accountChanged);
    return { ...account, revision: row.revision };
  });

  /** What it uploaded to the vendor goes, and the input it read unless it made something of it. */
  const clean = Effect.fnUntraced(function* (id: string) {
    const row = yield* machine.found(id, audioKinds);
    if (row.phase !== "ready" && row.phase !== "failed" && !(row.phase === "canceled" && row.remote_task === null)) return;
    const uploaded = yield* remote.list(id);
    if (row.phase === "canceled" && uploaded.length > 0) return;
    if (uploaded.some((file) => file.remote_id === null && (file.phase === "unknown" || file.phase === "uploading"))) return;
    yield* Effect.forEach(
      uploaded,
      (file) => (file.phase === "deleted" ? Effect.void : Effect.flatMap(originalAccount(row), (account) => remote.remove(id, file.input_id, account))),
      { discard: true },
    );
    // Saved results retain their source until the user explicitly releases local assets.
    if (row.input !== null && row.result === null) yield* inputs.release(id);
    if (row.problem === t("server.media.audioCleanupPending")) yield* machine.change(id, ["ready", "failed", "canceled"], { problem: "" });
    else yield* machine.publish();
  });
  const cleanSafely = (id: string) =>
    machine.cleaning.withPermits(1)(
      clean(id).pipe(
        Effect.catch(() => machine.change(id, ["ready", "failed", "canceled"], { problem: t("server.media.audioCleanupPending") })),
        Effect.asVoid,
      ),
    );

  const submit = Effect.fnUntraced(function* (id: string) {
    if (!(yield* machine.change(id, ["queued"], { phase: "generating" }))) return;
    const asked = yield* machine.found(id);
    const input = yield* request(asked);
    // Past this point the vendor may have been asked: a failure no longer says the job never ran.
    let attempted = false;
    /** Checks the key once more, right before the vendor is asked. */
    const lastLook = Effect.flatMap(machine.found(id), originalAccount);
    yield* Effect.gen(function* () {
      const current = yield* machine.found(id);
      const account = yield* originalAccount(current);
      if (input.kind === "clone") {
        const blob = yield* inputs.blob(input.input, id);
        const metadata = yield* inspectAudio(blob).pipe(Effect.mapError(invalid));
        if (blob.size > 10_000_000 || metadata.duration > 30 || !["wav", "mp3", "m4a", "flac"].includes(metadata.format)) return yield* invalid();
        yield* lastLook;
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
            return yield* machine.change(id, ["generating", "canceled", "unknown"], { phase: "ready", result, problem: "" });
          }),
        );
        return;
      }
      if (input.kind === "transcription" && input.streaming === true) {
        const fileId = yield* remote.upload(id, input.input, account);
        yield* lastLook;
        attempted = true;
        yield* receiveTranscriptionStream(
          account.transcription.stream({
            fileId,
            ...(input.diarize === undefined ? {} : { diarize: input.diarize }),
            ...(input.keyterms === undefined ? {} : { keyterms: input.keyterms }),
          }),
          {
            task: (taskId) => machine.change(id, ["generating", "canceled"], { remote_task: taskId }).pipe(Effect.asVoid),
            save: Effect.fnUntraced(function* (checkpoint: TranscriptionCheckpoint) {
              const patch = {
                result: yield* resultJson(checkpoint.result).pipe(Effect.mapError(corrupt)),
                usage: checkpoint.usage === undefined ? null : yield* usageJson(checkpoint.usage).pipe(Effect.mapError(corrupt)),
              };
              if (checkpoint.complete) {
                if (!(yield* machine.change(id, ["generating"], { ...patch, phase: "ready", problem: "" })))
                  yield* machine.change(id, ["canceled", "unknown"], patch);
              } else yield* machine.change(id, ["generating", "canceled", "unknown"], patch);
            }),
          },
        );
        return;
      }
      const task =
        input.kind === "speakers"
          ? account.speakers.createTask({ speakers: input.speakers, segments: input.segments, format: input.format })
          : input.kind === "voiceDesign"
            ? account.voiceDesign.createTask({ text: input.text, instruction: input.instruction, format: input.format })
            : account.transcription.createTask({
                fileId: yield* remote.upload(id, input.input, account),
                ...(input.diarize !== undefined ? { diarize: input.diarize } : {}),
                ...(input.keyterms !== undefined ? { keyterms: input.keyterms } : {}),
              });
      yield* lastLook;
      attempted = true;
      yield* machine.follow(id, task);
    }).pipe(
      Effect.catchTag("AudioFailure", (error) => machine.failed(id, error.outcome, words)),
      Effect.catch(() =>
        Effect.gen(function* () {
          const uncertain = attempted || (yield* remote.list(id)).some((file) => file.phase === "unknown" || file.phase === "uploading");
          yield* machine.failed(id, uncertain ? "Unknown" : "Rejected", words);
        }),
      ),
      Effect.asVoid,
    );
  });

  machine.register({
    kinds: audioKinds,
    words,
    view,
    keep: Effect.fnUntraced(function* (row) {
      const input = yield* request(row);
      if ((input.kind !== "speakers" && input.kind !== "voiceDesign") || row.result_format === null || row.content_type === null) return yield* corrupt();
      const format = row.result_format;
      const saved = yield* saveAudioResult(audioStorage, row.id, row.result_url ?? "", format, inputs);
      let retained = saved;
      const undo = Effect.suspend(() => releaseAudioResult(row.id, retained, inputs)).pipe(bestEffort("Media audio result rollback is pending"));
      return yield* Effect.gen(function* () {
        // A short designed voice is also kept as an input, to clone from or listen to again.
        let preview: T.MediaInputReference | undefined;
        if (
          input.kind === "voiceDesign" &&
          ["wav", "mp3", "flac"].includes(format) &&
          saved.attachment &&
          saved.attachment.size <= 10_000_000 &&
          saved.metadata?.duration !== undefined &&
          saved.metadata.duration <= 30
        ) {
          const file = yield* kept.get(saved.attachment.id);
          if (!file) return yield* corrupt();
          preview = yield* inputs.storeResult(
            {
              path: file.path,
              hash: saved.attachment.id,
              size: saved.attachment.size,
              mime: saved.attachment.type,
              name: saved.attachment.name,
              metadata: saved.metadata,
            },
            row.id,
            true,
          );
          retained = { ...saved, resultInput: preview };
        }
        const patch: Patch = {
          attachment: saved.attachment ? yield* attachmentJson(saved.attachment).pipe(Effect.mapError(corrupt)) : null,
          result_input: saved.resultInput ? yield* referenceJson(saved.resultInput).pipe(Effect.mapError(corrupt)) : null,
          metadata: saved.metadata ? yield* metadataJson(saved.metadata).pipe(Effect.mapError(corrupt)) : null,
          preview_input: preview?.id ?? null,
        };
        return { patch, undo };
      }).pipe(Effect.onError(() => undo));
    }),
    task: {
      kind: (row) => (row.kind === "transcription" ? "transcription" : row.kind === "voiceDesign" ? "voiceGeneration" : "speech"),
      done: Effect.fnUntraced(function* (_row, task) {
        const usage = task.usage === undefined ? null : yield* usageJson(task.usage);
        if (task.kind === "transcription") {
          const result: T.MediaAudioResult = { kind: "transcription", text: task.text, segments: [...(task.segments ?? [])] };
          return { phase: "ready" as const, result: yield* resultJson(result), usage };
        }
        return { phase: "downloading" as const, result_url: task.url, result_format: task.format, content_type: task.contentType, usage };
      }, Effect.mapError(corrupt)),
    },
    ran: cleanSafely,
    canceled: cleanSafely,
    restarted: Effect.fnUntraced(function* () {
      const left = yield* Effect.map(db.run(q.audioCleanup()), jobs.many);
      yield* Effect.forEach(left, (row) => cleanSafely(row.id), { discard: true });
    }),
  });

  const create = Effect.fnUntraced(function* (given: T.MediaAudioRequest, caller: MediaCaller): Effect.fn.Return<T.MediaAudioJob, ApiError> {
    if ((caller.kind === "orchestrator" && !caller.forUser) || ((given.kind === "clone" || given.kind === "transcription") && caller.kind !== "user"))
      return yield* refused(t("server.media.userRequired"));
    const source = yield* Schema.decodeEffect(S.MediaSource)(caller).pipe(Effect.mapError(invalid));
    const input = yield* Schema.decodeEffect(S.MediaAudioRequest)(given, { onExcessProperty: "error" }).pipe(Effect.mapError(invalid));
    return yield* machine.lock.withPermits(1)(
      Effect.gen(function* () {
        const existing = yield* machine.admit(input.id, audioKinds, (row) =>
          Effect.gen(function* () {
            const stored = yield* request(row);
            const shown = yield* view(row);
            return same(stored, input) && same(shown.source, source);
          }),
        );
        if (Option.isSome(existing)) return yield* view(existing.value);
        const account =
          input.kind === "speakers"
            ? yield* provider.speakers()
            : input.kind === "voiceDesign"
              ? yield* provider.voiceDesign()
              : input.kind === "transcription"
                ? yield* provider.transcription()
                : yield* provider.account({ connection: input.connection, model: "" });
        if (account.connection !== input.connection || account.revision !== input.revision) return yield* refused(words.accountChanged);
        let reference: T.MediaInputReference | null = null;
        if (input.kind === "clone" || input.kind === "transcription") {
          const local = yield* inputs.get(input.input);
          if (local.kind !== "audio" || local.phase !== "ready" || local.hash === null) return yield* invalid();
          reference = { id: local.id, kind: local.kind, mime: local.mime, name: local.name, size: local.size, hash: local.hash };
          const content = yield* inputs.content(input.input);
          const blob = yield* fileBlob(content.path, content.mime).pipe(Effect.mapError(invalid));
          const metadata = yield* inspectAudio(blob).pipe(Effect.mapError(invalid));
          if (
            metadata.duration > 3600 ||
            (input.kind === "clone" && (local.size > 10_000_000 || metadata.duration > 30 || !["wav", "mp3", "m4a", "flac"].includes(metadata.format)))
          )
            return yield* invalid();
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
          q.insertMediaJob(
            newJob({
              id: input.id,
              kind: input.kind,
              phase: "queued",
              request: yield* requestJson(input).pipe(Effect.mapError(invalid)),
              source: yield* sourceJson(source).pipe(Effect.mapError(invalid)),
              input: reference === null ? null : yield* referenceJson(reference).pipe(Effect.mapError(invalid)),
              connection: account.connection,
              revision: account.revision,
              model: account.model,
              fingerprint: account.fingerprint,
              now: yield* Clock.currentTimeMillis,
            }),
          ),
        );
        if (reference) yield* inputs.pin([reference.id], input.id, insert);
        else yield* insert;
        yield* machine.publish();
        yield* machine.run(input.id, submit(input.id));
        return yield* get(input.id);
      }).pipe(Effect.uninterruptible),
    );
  });

  return {
    createSpeakers: Effect.fn("Media.createSpeakers")((input: T.MediaSpeakersRequest, caller: MediaCaller) => create({ ...input, kind: "speakers" }, caller)),
    createVoiceDesign: Effect.fn("Media.createVoiceDesign")((input: T.MediaVoiceDesignRequest, caller: MediaCaller) =>
      create({ ...input, kind: "voiceDesign" }, caller),
    ),
    createClone: Effect.fn("Media.createClone")((input: T.MediaCloneRequest, caller: MediaCaller) => create({ ...input, kind: "clone" }, caller)),
    createTranscription: Effect.fn("Media.createTranscription")((input: T.MediaTranscriptionRequest, caller: MediaCaller) =>
      create({ ...input, kind: "transcription" }, caller),
    ),
    get,
    previewCleanup: Effect.fn("Media.audioPreviewCleanup")(function* (id: string): Effect.fn.Return<T.Preview, ApiError> {
      const row = yield* machine.found(id, audioKinds);
      if (row.phase !== "ready" && row.phase !== "failed") return yield* refused(t("server.media.busy"));
      const files = yield* remote.list(id);
      const count = files.filter((file) => file.remote_id !== null && file.phase !== "deleted").length;
      return { does: count === 0 ? [] : [t("server.media.cleanupPreview", { count, connection: row.connection })] };
    }),
    cleanup: Effect.fn("Media.audioCleanup")(function* (id: string) {
      const row = yield* machine.found(id, audioKinds);
      if (row.phase !== "ready" && row.phase !== "failed") return yield* refused(t("server.media.busy"));
      yield* cleanSafely(id);
      return yield* get(id);
    }),
  };
});
