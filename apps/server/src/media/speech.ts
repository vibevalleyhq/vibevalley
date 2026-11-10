import { type Cause, Clock, Effect, Fiber, FiberMap, FileSystem, Option, Queue, Schedule, Schema, Stream, type Semaphore } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { MediaAudioFormatValues } from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";

import { type ApiError, refused } from "#/base/errors.ts";
import { Channel } from "#/channel/channel.ts";
import { Db } from "#/infra/db.ts";
import { bestEffort } from "#/infra/log.ts";
import { PublicHttp } from "#/infra/publicHttp.ts";
import { type Account, Provider } from "#/provider/provider.ts";
import type { SpeechRequest } from "#/provider/vendors.ts";
import * as q from "#db/media_speech.sql.ts";

import { saveAudioResult, releaseAudioResult, type MediaInputs } from "./audioResult.ts";
import type { MediaCaller } from "./media.ts";
import { receiveSpeechStream, type SpeechStreamSaved } from "./speechStream.ts";

interface Ports {
  inputs: MediaInputs;
  lock: Semaphore.Semaphore;
  slots: Semaphore.Semaphore;
  publish: () => Effect.Effect<void, ApiError>;
  capacity: () => Effect.Effect<void, ApiError>;
  otherExists: (id: string) => Effect.Effect<boolean>;
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

export const makeSpeech = Effect.fnUntraced(function* (ports: Ports) {
  const db = yield* Db;
  const channel = yield* Channel;
  const provider = yield* Provider;
  const downloads = yield* PublicHttp;
  const fs = yield* FileSystem.FileSystem;
  const fibers = yield* FiberMap.make<string, void, ApiError>();
  const streams = new Map<string, { queue: Queue.Queue<T.MediaSpeechEvent, Cause.Done>; claimed: boolean }>();
  const streamCleanup = yield* FiberMap.make<string, void, never>();
  const active = (phase: T.MediaPhase) => phase === "queued" || phase === "generating" || phase === "downloading";
  const decodeRequest = (text: string) =>
    Schema.decodeEffect(Schema.fromJsonString(S.MediaSpeechRequest))(text).pipe(Effect.mapError(() => refused(t("server.media.corrupt"))));
  const found = Effect.fnUntraced(function* (id: string) {
    const row = yield* db.one(q.speech({ id }));
    if (!row) return yield* Effect.fail(refused(t("server.media.missing")));
    return row;
  });
  const view = Effect.fnUntraced(function* (row: q.SpeechResult): Effect.fn.Return<T.MediaSpeechJob, ApiError> {
    const input = yield* decodeRequest(row.request);
    const source = yield* Schema.decodeEffect(Schema.fromJsonString(S.MediaSource))(row.source).pipe(Effect.mapError(() => refused(t("server.media.corrupt"))));
    const attachment =
      row.attachment === null
        ? undefined
        : yield* Schema.decodeEffect(Schema.fromJsonString(S.Attachment))(row.attachment).pipe(Effect.mapError(() => refused(t("server.media.corrupt"))));
    const format =
      row.result_format === null
        ? input.format
        : yield* Schema.decodeEffect(Schema.Literals(MediaAudioFormatValues))(row.result_format).pipe(
            Effect.mapError(() => refused(t("server.media.corrupt"))),
          );
    const metadata =
      row.metadata === null
        ? undefined
        : yield* Schema.decodeEffect(Schema.fromJsonString(S.MediaAudioMetadata))(row.metadata).pipe(Effect.mapError(() => refused(t("server.media.corrupt"))));
    const usage =
      row.usage === null
        ? undefined
        : yield* Schema.decodeEffect(Schema.fromJsonString(S.MediaAudioUsage))(row.usage).pipe(Effect.mapError(() => refused(t("server.media.corrupt"))));
    const resultInput =
      row.result_input === null
        ? null
        : yield* Schema.decodeEffect(Schema.fromJsonString(S.MediaInputReference))(row.result_input).pipe(
            Effect.mapError(() => refused(t("server.media.corrupt"))),
          );
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
      source,
      phase: row.phase,
      phaseText: t(`server.media.phase.${row.phase}`),
      problem: row.problem,
      ...(attachment ? { attachment } : {}),
      resultInput,
      canCancel: active(row.phase),
      canRelease: !active(row.phase) && row.assets_released === 0,
      canRetryDownload: row.assets_released === 0 && row.result_url !== null && (row.phase === "download_failed" || row.phase === "canceled"),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
  const get = Effect.fn("Media.speechGet")(function* (id: string) {
    const found2 = yield* found(id);
    return yield* view(found2);
  });
  const change = Effect.fnUntraced(
    function* (
      id: string,
      before: readonly T.MediaPhase[],
      patch: Partial<
        Pick<
          q.SpeechResult,
          "phase" | "result_url" | "attachment" | "problem" | "remote_task" | "result_format" | "content_type" | "metadata" | "usage" | "result_input"
        >
      >,
    ) {
      const row = yield* found(id);
      if (!before.includes(row.phase) || (row.assets_released !== 0 && patch.result_input !== undefined)) return false;
      yield* db.run(q.changeSpeech({ ...row, ...patch, now: yield* Clock.currentTimeMillis }));
      yield* ports.publish();
      return true;
    },
    ports.lock.withPermits(1),
    Effect.uninterruptible,
  );
  const download = Effect.fnUntraced(function* (id: string) {
    const row = yield* found(id);
    if (row.phase !== "downloading" || row.result_url === null) return;
    const job = yield* view(row);
    const address = row.result_url;
    yield* Effect.uninterruptibleMask((resume) =>
      Effect.gen(function* () {
        const saved = yield* resume(
          saveAudioResult(id, address, job.format, ports.inputs).pipe(
            Effect.provideService(PublicHttp, downloads),
            Effect.provideService(Channel, channel),
            Effect.provideService(FileSystem.FileSystem, fs),
          ),
        );
        const committed = yield* Effect.gen(function* () {
          return yield* change(id, ["downloading"], {
            phase: "ready",
            attachment: saved.attachment === undefined ? null : yield* attachmentJson(saved.attachment),
            result_input: saved.resultInput === null ? null : yield* referenceJson(saved.resultInput),
            result_url: null,
            problem: "",
            metadata: saved.metadata === undefined ? null : yield* metadataJson(saved.metadata),
          });
        }).pipe(Effect.onError(() => releaseAudioResult(id, saved, ports.inputs)));
        if (!committed) yield* releaseAudioResult(id, saved, ports.inputs);
      }),
    ).pipe(
      Effect.catch(() => change(id, ["downloading"], { phase: "download_failed", problem: t("server.media.speechDownloadFailed") })),
      Effect.asVoid,
    );
  });
  const run = Effect.fnUntraced(function* (id: string, work: Effect.Effect<void, ApiError>) {
    yield* FiberMap.run(
      fibers,
      id,
      ports.slots
        .withPermits(1)(work)
        .pipe(
          Effect.onError(() =>
            change(id, ["generating"], { phase: "unknown", problem: t("server.media.speechUnknown") }).pipe(
              bestEffort("Media speech interruption could not be recorded"),
            ),
          ),
        ),
    );
  });

  const poll = Effect.fnUntraced(function* (id: string) {
    const once = Effect.gen(function* () {
      const row = yield* found(id);
      if (row.phase !== "generating" || row.remote_task === null) return true;
      const account = yield* provider.account({ connection: row.connection, model: row.model });
      if (account.fingerprint !== row.credential_hash) return yield* Effect.fail(refused(t("server.media.remoteAccountChanged")));
      const result = yield* account.tasks.get(row.remote_task).pipe(
        Effect.retry(($) =>
          $(Schedule.exponential("1 second")).pipe(
            Schedule.upTo({ times: 4 }),
            Schedule.while(({ input }) => input.retryable),
          ),
        ),
      );
      if (result.kind !== "speech") return yield* Effect.fail(refused(t("server.media.corrupt")));
      if (result.status !== "ready") {
        if (result.status !== "failed") return false;
        yield* change(id, ["generating"], { phase: "failed", problem: t("server.media.speechRejected") });
        return true;
      }
      if (
        yield* change(id, ["generating"], {
          phase: "downloading",
          result_url: result.url,
          result_format: result.format,
          content_type: result.contentType,
          usage: result.usage === undefined ? null : yield* usageJson(result.usage),
        })
      )
        yield* download(id);
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
      Effect.catch(() => change(id, ["generating"], { phase: "unknown", problem: t("server.media.speechPollPaused") })),
    );
    yield* change(id, ["generating"], { phase: "unknown", problem: t("server.media.speechPollPaused") });
  });

  const receive = Effect.fnUntraced(function* (id: string, account: Account, synthesis: SpeechRequest) {
    const session = streams.get(id);
    if (!session) return yield* Effect.fail(refused(t("server.media.speechInvalid")));
    yield* receiveSpeechStream(id, account.speech.stream(synthesis), {
      inputs: ports.inputs,
      task: (taskId) => change(id, ["generating", "canceled"], { remote_task: taskId }).pipe(Effect.asVoid),
      emit: (event) => Queue.offer(session.queue, event).pipe(Effect.asVoid),
      save: Effect.fnUntraced(function* (saved: SpeechStreamSaved) {
        const patch = {
          attachment: saved.attachment === undefined ? null : yield* attachmentJson(saved.attachment),
          result_format: "wav",
          content_type: "audio/wav",
          result_input: saved.resultInput === null ? null : yield* referenceJson(saved.resultInput),
          metadata: yield* metadataJson(saved.metadata),
          usage: saved.usage === undefined ? null : yield* usageJson(saved.usage),
        } satisfies Partial<q.SpeechResult>;
        if (
          !(yield* change(id, ["generating"], {
            ...patch,
            phase: saved.complete ? "ready" : "unknown",
            problem: saved.complete ? "" : t("server.media.speechPartial"),
          })) &&
          !(yield* change(id, ["canceled"], patch))
        )
          yield* releaseAudioResult(id, saved, ports.inputs);
      }),
    }).pipe(
      Effect.provideService(Channel, channel),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.catch(() =>
        Effect.gen(function* () {
          yield* change(id, ["generating"], { phase: "unknown", problem: t("server.media.speechUnknown") });
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

  return {
    get,
    events: Effect.fn("Media.speechEvents")(function* (id: string) {
      const session = yield* ports.lock.withPermits(1)(
        Effect.gen(function* () {
          const session = streams.get(id);
          if (!session || session.claimed) return yield* Effect.fail(refused(t("server.media.speechStreamUnavailable")));
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
            yield* change(id, ["queued", "generating"], { phase: "canceled", problem: t("server.media.canceled") }).pipe(
              bestEffort("Speech stream disconnect could not be recorded"),
            );
            yield* FiberMap.remove(fibers, id);
          }),
        ),
      );
    }),
    has: (id: string) => db.one(q.speech({ id })).pipe(Effect.map((row) => row !== undefined)),
    pending: () => db.run(q.pendingSpeech()).pipe(Effect.map((rows) => rows.length)),
    list: Effect.fn("Media.speechList")(function* () {
      const recentSpeech2 = yield* db.run(q.recentSpeech());
      return yield* Effect.forEach(recentSpeech2, view);
    }),
    create: Effect.fn("Media.createSpeech")(function* (given: T.MediaSpeechRequest, caller: MediaCaller) {
      if (caller.kind === "orchestrator" && !caller.forUser) return yield* Effect.fail(refused(t("server.media.userRequired")));
      const source: T.MediaSource = yield* Schema.decodeEffect(S.MediaSource)(caller).pipe(Effect.mapError(() => refused(t("server.media.speechInvalid"))));
      const input = yield* Schema.decodeEffect(S.MediaSpeechRequest)(given).pipe(Effect.mapError(() => refused(t("server.media.speechInvalid"))));
      if (input.streaming === true && (caller.kind !== "user" || input.asynchronous === true || input.format !== "pcm"))
        return yield* Effect.fail(refused(t("server.media.speechInvalid")));
      return yield* ports.lock.withPermits(1)(
        Effect.gen(function* () {
          const existing = yield* db.one(q.speech({ id: input.id }));
          if (existing) {
            const storedRequest = yield* decodeRequest(existing.request);
            if (!same(storedRequest, input) || !same((yield* view(existing)).source, source)) return yield* Effect.fail(refused(t("server.media.reusedId")));
            return yield* view(existing);
          }
          if (yield* ports.otherExists(input.id)) return yield* Effect.fail(refused(t("server.media.reusedId")));
          yield* ports.capacity();
          const account = yield* provider.speech();
          if (input.connection !== account.connection || input.revision !== account.revision)
            return yield* Effect.fail(refused(t("server.media.speechChanged")));
          const synthesis: SpeechRequest = { text: input.text, voice: input.voice, format: input.format };
          yield* account.speech
            .check({ ...synthesis, streaming: input.streaming === true })
            .pipe(Effect.mapError(() => refused(t("server.media.speechInvalid"))));
          if (input.streaming === true && streams.size >= 8) return yield* Effect.fail(refused(t("server.media.speechInvalid")));
          yield* db.run(
            q.insertSpeech({
              id: input.id,
              request: yield* requestJson(input).pipe(Effect.mapError(() => refused(t("server.media.speechInvalid")))),
              source: yield* sourceJson(source).pipe(Effect.mapError(() => refused(t("server.media.speechInvalid")))),
              connection: account.connection,
              revision: account.revision,
              model: account.model,
              credential_hash: account.fingerprint,
              now: yield* Clock.currentTimeMillis,
            }),
          );
          if (input.streaming === true) streams.set(input.id, { queue: yield* Queue.bounded<T.MediaSpeechEvent, Cause.Done>(16), claimed: false });
          yield* ports.publish();
          const work = Effect.gen(function* () {
            if (!(yield* change(input.id, ["queued"], { phase: "generating" }))) return;
            if (input.streaming === true) {
              yield* receive(input.id, account, synthesis);
              return;
            }
            if (input.asynchronous === true) {
              yield* Effect.uninterruptibleMask((resume) =>
                resume(account.speech.createTask(synthesis)).pipe(
                  Effect.flatMap((taskId) => change(input.id, ["generating", "canceled"], { remote_task: taskId })),
                ),
              ).pipe(
                Effect.catchTag("AudioFailure", (error) =>
                  change(input.id, ["generating"], {
                    phase: error.outcome === "Unknown" ? "unknown" : "failed",
                    problem: error.outcome === "Unknown" ? t("server.media.speechUnknown") : t("server.media.speechRejected"),
                  }),
                ),
              );
              yield* poll(input.id);
              return;
            }
            yield* account.speech.generate(synthesis).pipe(
              Effect.flatMap((result) =>
                Effect.gen(function* () {
                  if (
                    yield* change(input.id, ["generating"], {
                      phase: "downloading",
                      result_url: result.url,
                      result_format: result.format,
                      content_type: result.contentType,
                      usage: result.usage === undefined ? null : yield* usageJson(result.usage),
                    })
                  )
                    yield* download(input.id);
                }),
              ),
              Effect.catchTag("AudioFailure", (error) =>
                change(input.id, ["generating"], {
                  phase: error.outcome === "Unknown" ? "unknown" : "failed",
                  problem: error.outcome === "Unknown" ? t("server.media.speechUnknown") : t("server.media.speechRejected"),
                }),
              ),
              Effect.asVoid,
            );
          });
          yield* run(input.id, work);
          return yield* get(input.id);
        }).pipe(Effect.uninterruptible),
      );
    }),
    cancel: Effect.fn("Media.speechCancel")(function* (id: string) {
      const fiber = yield* ports.lock.withPermits(1)(
        Effect.gen(function* () {
          const row = yield* found(id);
          if (!active(row.phase)) return Option.none();
          yield* db.run(q.changeSpeech({ ...row, phase: "canceled", problem: t("server.media.canceled"), now: yield* Clock.currentTimeMillis }));
          yield* ports.publish();
          return FiberMap.getUnsafe(fibers, id);
        }),
      );
      const session = streams.get(id);
      if (session) {
        yield* Queue.shutdown(session.queue);
        streams.delete(id);
      }
      if (Option.isSome(fiber)) yield* Fiber.interrupt(fiber.value);
      return yield* get(id);
    }, Effect.uninterruptible),
    retryDownload: Effect.fn("Media.speechRetryDownload")(function* (id: string) {
      return yield* ports.lock.withPermits(1)(
        Effect.gen(function* () {
          const row = yield* found(id);
          if (row.phase === "ready" || row.phase === "downloading") return yield* view(row);
          if (row.result_url === null || (row.phase !== "download_failed" && row.phase !== "canceled"))
            return yield* Effect.fail(refused(t("server.media.noDownload")));
          yield* ports.capacity();
          yield* db.run(q.changeSpeech({ ...row, phase: "downloading", problem: "", now: yield* Clock.currentTimeMillis }));
          yield* ports.publish();
          yield* run(id, download(id));
          return yield* get(id);
        }).pipe(Effect.uninterruptible),
      );
    }),
    resume: Effect.fn("Media.speechResume")(function* (id: string) {
      return yield* ports.lock.withPermits(1)(
        Effect.gen(function* () {
          const row = yield* found(id);
          if (row.phase === "generating") return yield* view(row);
          if ((yield* view(row)).canResume !== true) return yield* Effect.fail(refused(t("server.media.speechNoResume")));
          const account = yield* provider.account({ connection: row.connection, model: row.model });
          if (account.fingerprint !== row.credential_hash) return yield* Effect.fail(refused(t("server.media.remoteAccountChanged")));
          yield* ports.capacity();
          yield* db.run(q.changeSpeech({ ...row, phase: "generating", problem: "", now: yield* Clock.currentTimeMillis }));
          yield* ports.publish();
          yield* run(id, poll(id));
          return yield* get(id);
        }).pipe(Effect.uninterruptible),
      );
    }),
    restore: Effect.fn("Media.speechRestore")(function* () {
      yield* db.run(q.interruptSpeech({ problem: t("server.media.restarted"), now: yield* Clock.currentTimeMillis }));
      yield* ports.publish();
      const pendingSpeech2 = yield* db.run(q.pendingSpeech());
      yield* Effect.forEach(pendingSpeech2, (row) => run(row.id, row.phase === "generating" ? poll(row.id) : download(row.id)), {
        discard: true,
      });
    }),
  };
});
