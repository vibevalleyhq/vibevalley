import { type Cause, Clock, Effect, FiberMap, FileSystem, Option, Queue, Schema, Stream } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { MediaAudioFormatValues, MediaPhaseValues } from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";

import { type ApiError, BizCode, refuseIn } from "#/base/errors.ts";
import { Db } from "#/infra/db.ts";
import { bestEffort } from "#/infra/log.ts";
import { PublicHttp } from "#/infra/publicHttp.ts";
import { Attachment } from "#/modules/attachment/attachment.ts";
import { type Account, Provider } from "#/modules/provider/provider.ts";
import type { SpeechRequest } from "#/modules/provider/vendors.ts";
import * as q from "#db/media_job.sql.ts";

import { saveAudioResult, releaseAudioResult, type MediaInputs } from "./audioResult.ts";
import { jobsOf, newJob, type Row } from "./job.ts";
import type { Machine, Patch } from "./machine.ts";
import type { MediaCaller } from "./media.ts";
import { receiveSpeechStream, type SpeechStreamSaved } from "./speechStream.ts";

const refused = refuseIn(BizCode.MediaRefused);

interface Ports {
  readonly inputs: MediaInputs;
  readonly machine: Machine;
}
const encodeJson = <A, I>(schema: Schema.Codec<A, I>) => {
  const encode = Schema.encodeEffect(Schema.fromJsonString(schema));
  return (value: A) => encode(value).pipe(Effect.mapError(() => refused(t("server.media.corrupt"))));
};
const attachmentJson = encodeJson(S.Attachment);
const referenceJson = encodeJson(S.MediaInputReference);
const metadataJson = encodeJson(S.MediaAudioMetadata);
const usageJson = encodeJson(S.MediaAudioUsage);
const requestJson = Schema.encodeEffect(Schema.fromJsonString(S.MediaSpeechRequest));
const sourceJson = Schema.encodeEffect(Schema.fromJsonString(S.MediaSource));

const jobs = jobsOf({ kinds: ["speech"], phases: MediaPhaseValues });

/** Single-voice speech: asked at once, as a vendor task followed until done, or streamed to the page as it is spoken. */
export const makeSpeech = Effect.fnUntraced(function* ({ inputs, machine }: Ports) {
  const db = yield* Db;
  const kept = yield* Attachment;
  const provider = yield* Provider;
  const downloads = yield* PublicHttp;
  const fs = yield* FileSystem.FileSystem;
  const audioStorage = { http: downloads, files: kept, fs };
  const streams = new Map<string, { queue: Queue.Queue<T.MediaSpeechEvent, Cause.Done>; claimed: boolean }>();
  const streamCleanup = yield* FiberMap.make<string, void, never>();
  const corrupt = () => refused(t("server.media.corrupt"));
  const words = {
    unknown: t("server.media.speechUnknown"),
    rejected: t("server.media.speechRejected"),
    paused: t("server.media.speechPollPaused"),
    downloadFailed: t("server.media.speechDownloadFailed"),
    accountChanged: t("server.media.remoteAccountChanged"),
    noResume: t("server.media.speechNoResume"),
  };
  const decodeRequest = (text: string) => Schema.decodeEffect(Schema.fromJsonString(S.MediaSpeechRequest))(text).pipe(Effect.mapError(corrupt));
  const view = Effect.fnUntraced(function* (given: Row): Effect.fn.Return<T.MediaSpeechJob, ApiError> {
    const row = jobs.one(given);
    if (row === undefined) return yield* corrupt();
    const input = yield* decodeRequest(row.request);
    const decoded = <A, I>(schema: Schema.Codec<A, I>, text: string) => Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(Effect.mapError(corrupt));
    const attachment = row.attachment === null ? undefined : yield* decoded(S.Attachment, row.attachment);
    const format =
      row.result_format === null
        ? input.format
        : yield* Schema.decodeEffect(Schema.Literals(MediaAudioFormatValues))(row.result_format).pipe(Effect.mapError(corrupt));
    const metadata = row.metadata === null ? undefined : yield* decoded(S.MediaAudioMetadata, row.metadata);
    const usage = row.usage === null ? undefined : yield* decoded(S.MediaAudioUsage, row.usage);
    const resultInput = row.result_input === null ? null : yield* decoded(S.MediaInputReference, row.result_input);
    return {
      kind: "speech",
      id: row.id,
      prompt: input.text,
      voice: input.voice,
      format,
      ...(row.content_type !== null ? { contentType: row.content_type } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
      ...(usage === undefined ? {} : { usage }),
      canResume:
        row.assets_released === 0 &&
        input.streaming !== true &&
        row.remote_task !== null &&
        (row.phase === "unknown" || row.phase === "canceled") &&
        row.result_url === null,
      model: row.model,
      connection: row.connection,
      revision: row.revision,
      source: yield* decoded(S.MediaSource, row.source),
      phase: row.phase,
      phaseText: t(`server.media.phase.${row.phase}`),
      problem: row.problem,
      ...(attachment ? { attachment } : {}),
      resultInput,
      canCancel: machine.active(row.phase),
      canRelease: !machine.active(row.phase) && row.assets_released === 0,
      canRetryDownload: row.assets_released === 0 && row.result_url !== null && (row.phase === "download_failed" || row.phase === "canceled"),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
  const get = Effect.fn("Media.speechGet")(function* (id: string) {
    const row = yield* machine.found(id, ["speech"]);
    return yield* view(row);
  });
  const audioFields = (made: { url: string; format: T.MediaAudioFormat; contentType: string; usage?: T.MediaAudioUsage }) =>
    Effect.gen(function* () {
      return {
        result_url: made.url,
        result_format: made.format,
        content_type: made.contentType,
        usage: made.usage === undefined ? null : yield* usageJson(made.usage),
      } satisfies Patch;
    });
  /** What a saved result writes, kept or kept as an input for later use. */
  const savedFields = Effect.fnUntraced(function* (saved: { attachment?: T.Attachment; resultInput: T.MediaInputReference | null }) {
    return {
      attachment: saved.attachment === undefined ? null : yield* attachmentJson(saved.attachment),
      result_input: saved.resultInput === null ? null : yield* referenceJson(saved.resultInput),
    } satisfies Patch;
  });

  /** Streamed speech goes to the page as it is spoken and is kept whole once done. */
  const receive = Effect.fnUntraced(function* (id: string, account: Account, synthesis: SpeechRequest) {
    const session = streams.get(id);
    if (!session) return yield* refused(t("server.media.speechInvalid"));
    yield* receiveSpeechStream(audioStorage, id, account.speech.stream(synthesis), {
      inputs,
      task: (taskId) => machine.change(id, ["generating", "canceled"], { remote_task: taskId }).pipe(Effect.asVoid),
      emit: (event) => Queue.offer(session.queue, event).pipe(Effect.asVoid),
      save: Effect.fnUntraced(function* (saved: SpeechStreamSaved) {
        const patch = {
          ...(yield* savedFields(saved)),
          result_format: "wav",
          content_type: "audio/wav",
          metadata: yield* metadataJson(saved.metadata),
          usage: saved.usage === undefined ? null : yield* usageJson(saved.usage),
        } satisfies Patch;
        if (
          !(yield* machine.change(id, ["generating"], {
            ...patch,
            phase: saved.complete ? "ready" : "unknown",
            problem: saved.complete ? "" : t("server.media.speechPartial"),
          })) &&
          !(yield* machine.change(id, ["canceled"], patch))
        )
          yield* releaseAudioResult(id, saved, inputs);
      }),
    }).pipe(
      Effect.catch(() =>
        Effect.gen(function* () {
          yield* machine.change(id, ["generating"], { phase: "unknown", problem: words.unknown });
          Queue.offerUnsafe(session.queue, { type: "failed" });
        }),
      ),
      Effect.ensuring(
        Effect.gen(function* () {
          yield* Queue.end(session.queue);
          yield* FiberMap.run(
            streamCleanup,
            id,
            Effect.gen(function* () {
              yield* Effect.sleep("1 minute");
              yield* Queue.shutdown(session.queue);
              streams.delete(id);
            }),
          );
        }),
      ),
    );
  });

  machine.register({
    kinds: ["speech"],
    words,
    view,
    keep: Effect.fnUntraced(function* (given) {
      const job = yield* view(given);
      const saved = yield* saveAudioResult(audioStorage, given.id, given.result_url ?? "", job.format, inputs);
      const undo = releaseAudioResult(given.id, saved, inputs).pipe(bestEffort(`media: letting go of speech ${given.id}`));
      const patch = yield* Effect.gen(function* () {
        return {
          ...(yield* savedFields(saved)),
          metadata: saved.metadata === undefined ? null : yield* metadataJson(saved.metadata),
        } satisfies Patch;
      }).pipe(Effect.onError(() => undo));
      return { patch, undo };
    }),
    task: {
      kind: () => "speech",
      done: Effect.fnUntraced(function* (_row, task) {
        if (task.kind === "transcription") return yield* corrupt();
        return { ...(yield* audioFields(task)), phase: "downloading" as const };
      }),
    },
    canceled: (id) =>
      Effect.gen(function* () {
        const session = streams.get(id);
        if (!session) return;
        yield* Queue.shutdown(session.queue);
        streams.delete(id);
      }),
  });

  return {
    get,
    events: Effect.fn("Media.speechEvents")(function* (id: string) {
      const session = yield* machine.lock.withPermits(1)(
        Effect.gen(function* () {
          const session = streams.get(id);
          if (!session || session.claimed) return yield* refused(t("server.media.speechStreamUnavailable"));
          session.claimed = true;
          return session;
        }),
      );
      return Stream.fromQueue(session.queue).pipe(
        Stream.takeUntil((event) => event.type === "done" || event.type === "failed"),
        Stream.ensuring(
          Effect.gen(function* () {
            yield* Queue.shutdown(session.queue);
            streams.delete(id);
            yield* machine
              .change(id, ["queued", "generating"], { phase: "canceled", problem: t("server.media.canceled") })
              .pipe(bestEffort("Speech stream disconnect could not be recorded"));
            yield* machine.stop(id);
          }),
        ),
      );
    }),
    create: Effect.fn("Media.createSpeech")(function* (given: T.MediaSpeechRequest, caller: MediaCaller) {
      if (caller.kind === "orchestrator" && !caller.forUser) return yield* refused(t("server.media.userRequired"));
      const source: T.MediaSource = yield* Schema.decodeEffect(S.MediaSource)(caller).pipe(Effect.mapError(() => refused(t("server.media.speechInvalid"))));
      const input = yield* Schema.decodeEffect(S.MediaSpeechRequest)(given).pipe(Effect.mapError(() => refused(t("server.media.speechInvalid"))));
      if (input.streaming === true && (caller.kind !== "user" || input.asynchronous === true || input.format !== "pcm"))
        return yield* refused(t("server.media.speechInvalid"));
      return yield* machine.lock.withPermits(1)(
        Effect.gen(function* () {
          const existing = yield* machine.admit(input.id, ["speech"], (row) =>
            Effect.gen(function* () {
              const stored = yield* decodeRequest(row.request);
              const shown = yield* view(row);
              return same(stored, input) && same(shown.source, source);
            }),
          );
          if (Option.isSome(existing)) return yield* view(existing.value);
          const account = yield* provider.speech();
          if (input.connection !== account.connection || input.revision !== account.revision) return yield* refused(t("server.media.speechChanged"));
          const synthesis: SpeechRequest = { text: input.text, voice: input.voice, format: input.format };
          yield* account.speech
            .check({ ...synthesis, streaming: input.streaming === true })
            .pipe(Effect.mapError(() => refused(t("server.media.speechInvalid"))));
          if (input.streaming === true && streams.size >= 8) return yield* refused(t("server.media.speechInvalid"));
          yield* db.run(
            q.insertMediaJob(
              newJob({
                id: input.id,
                kind: "speech",
                phase: "queued",
                request: yield* requestJson(input).pipe(Effect.mapError(() => refused(t("server.media.speechInvalid")))),
                source: yield* sourceJson(source).pipe(Effect.mapError(() => refused(t("server.media.speechInvalid")))),
                connection: account.connection,
                revision: account.revision,
                model: account.model,
                fingerprint: account.fingerprint,
                now: yield* Clock.currentTimeMillis,
              }),
            ),
          );
          if (input.streaming === true) streams.set(input.id, { queue: yield* Queue.bounded<T.MediaSpeechEvent, Cause.Done>(16), claimed: false });
          yield* machine.publish();
          yield* machine.run(
            input.id,
            Effect.gen(function* () {
              if (!(yield* machine.change(input.id, ["queued"], { phase: "generating" }))) return;
              if (input.streaming === true) return yield* receive(input.id, account, synthesis);
              if (input.asynchronous === true)
                return yield* machine
                  .follow(input.id, account.speech.createTask(synthesis))
                  .pipe(Effect.catchTag("AudioFailure", (error) => Effect.asVoid(machine.failed(input.id, error.outcome, words))));
              yield* account.speech.generate(synthesis).pipe(
                Effect.flatMap((made) =>
                  Effect.gen(function* () {
                    if (yield* machine.change(input.id, ["generating"], { ...(yield* audioFields(made)), phase: "downloading" }))
                      yield* machine.download(input.id);
                  }),
                ),
                Effect.catchTag("AudioFailure", (error) => machine.failed(input.id, error.outcome, words)),
                Effect.asVoid,
              );
            }),
          );
          return yield* get(input.id);
        }).pipe(Effect.uninterruptible),
      );
    }),
  };
});
