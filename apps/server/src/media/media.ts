import { Clock, Context, Effect, Fiber, FiberHandle, FiberMap, Layer, Option, Schedule, Schema, Semaphore } from "effect";
import { HttpClient } from "effect/http";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";
import { generateMossImage, prepareMossImage } from "@vibevalley/provider/moss/image";

import { type ApiError, refused } from "#/base/errors.ts";
import { Channel } from "#/channel/channel.ts";
import { Core } from "#/core/core.ts";
import { Db } from "#/infra/db.ts";
import { PublicHttp } from "#/infra/publicHttp.ts";
import { Provider } from "#/provider/provider.ts";
import * as q from "#db/media_generation.sql.ts";

import { downloadImage } from "./download.ts";
import { makeInputs } from "./inputs.ts";
import { makeRemoteFiles } from "./remoteFiles.ts";
import { makeUnderstanding } from "./understanding.ts";

export type MediaCaller =
  | { readonly kind: "owner" }
  | { readonly kind: "orchestrator"; readonly agent: string; readonly channel: string; readonly forOwner: boolean };

export class Media extends Context.Service<
  Media,
  {
    readonly inputs: Pick<Effect.Success<typeof makeInputs>, "create" | "upload" | "get" | "list" | "delete" | "previewDelete">;
    readonly createImage: (input: T.MediaImageRequest, caller: MediaCaller) => Effect.Effect<T.MediaImageJob, ApiError>;
    readonly createUnderstanding: (input: T.MediaUnderstandingRequest) => Effect.Effect<T.MediaUnderstandingJob, ApiError>;
    readonly previewUnderstandingCleanup: (id: string) => Effect.Effect<T.Preview, ApiError>;
    readonly cleanupUnderstanding: (id: string) => Effect.Effect<T.MediaUnderstandingJob, ApiError>;
    readonly get: (id: string) => Effect.Effect<T.MediaJob, ApiError>;
    readonly list: () => Effect.Effect<T.MediaJob[], ApiError>;
    readonly cancel: (id: string) => Effect.Effect<T.MediaJob, ApiError>;
    readonly retryDownload: (id: string) => Effect.Effect<T.MediaJob, ApiError>;
    readonly restore: () => Effect.Effect<void, ApiError>;
  }
>()("vibevalley/Media") {
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
  const core = yield* Core;
  const channel = yield* Channel;
  const provider = yield* Provider;
  const http = yield* HttpClient.HttpClient;
  const downloads = yield* PublicHttp;
  const lock = yield* Semaphore.make(1);
  const slots = yield* Semaphore.make(1);
  const fibers = yield* FiberMap.make<string, void, ApiError>();
  const active = (phase: T.MediaPhase) => phase === "queued" || phase === "generating" || phase === "downloading";
  const decodeRequest = (text: string) =>
    Schema.decodeEffect(Schema.fromJsonString(S.MediaImageRequest))(text).pipe(Effect.mapError(() => refused(t("server.media.corrupt"))));
  const found = Effect.fnUntraced(function* (id: string) {
    const row = yield* db.one(q.generation({ id }));
    if (!row) return yield* Effect.fail(refused(t("server.media.missing")));
    return row;
  });
  const view = Effect.fnUntraced(function* (row: q.GenerationResult): Effect.fn.Return<T.MediaImageJob, ApiError> {
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
    const images = yield* Effect.forEach(yield* db.run(q.recentGenerations()), view);
    const understood = yield* understanding.list();
    return [...images, ...understood]
      .toSorted((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : b.createdAt - a.createdAt))
      .slice(0, 100);
  });
  const publish = Effect.fnUntraced(function* () {
    yield* core.apply({ type: "mediaChanged", jobs: yield* list() });
  });
  const get = Effect.fn("Media.get")(function* (id: string): Effect.fn.Return<T.MediaJob, ApiError> {
    const image = yield* db.one(q.generation({ id }));
    return image ? yield* view(image) : yield* understanding.get(id);
  });
  const change = Effect.fnUntraced(
    function* (
      id: string,
      before: readonly T.MediaPhase[],
      patch: Partial<Pick<q.GenerationResult, "phase" | "result_url" | "attachment" | "problem" | "usage">>,
    ) {
      const row = yield* found(id);
      if (!before.includes(row.phase)) return false;
      yield* db.run(q.changeGeneration({ ...row, ...patch, now: yield* Clock.currentTimeMillis }));
      yield* publish();
      return true;
    },
    lock.withPermits(1),
    Effect.uninterruptible,
  );

  const download = Effect.fnUntraced(function* (id: string) {
    const row = yield* found(id);
    if (row.phase !== "downloading" || row.result_url === null) return;
    const request = yield* decodeRequest(row.request);
    yield* Effect.gen(function* () {
      const bytes = yield* downloadImage(row.result_url ?? "", request.width, request.height).pipe(Effect.provideService(PublicHttp, downloads));
      const attachment = yield* channel.attach({ name: `moss-${id}.png`, type: "image/png", data: bytes.toString("base64") });
      yield* change(id, ["downloading"], { phase: "ready", attachment: JSON.stringify(attachment), result_url: null, problem: "" });
    }).pipe(
      Effect.catch(() => change(id, ["downloading"], { phase: "download_failed", problem: t("server.media.downloadFailed") })),
      Effect.asVoid,
    );
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
    if ((yield* db.run(q.pendingGenerations())).length + (yield* understanding.pending()) >= 8) return yield* Effect.fail(refused(t("server.media.busy")));
  });

  const understanding = yield* makeUnderstanding({
    inputs,
    remote: remoteFiles,
    lock,
    slots,
    publish,
    capacity,
    imageExists: (id) => db.one(q.generation({ id })).pipe(Effect.map((row) => row !== undefined)),
  });

  return Media.of({
    inputs,
    createUnderstanding: understanding.create,
    cleanupUnderstanding: understanding.cleanup,
    previewUnderstandingCleanup: understanding.previewCleanup,
    get,
    list,
    createImage: Effect.fn("Media.createImage")(function* (given, caller) {
      if (caller.kind === "orchestrator" && !caller.forOwner) return yield* Effect.fail(refused(t("server.media.ownerRequired")));
      const source: T.MediaSource = yield* Schema.decodeEffect(S.MediaSource)(caller).pipe(Effect.mapError(() => refused(t("server.media.invalid"))));
      const input = yield* Schema.decodeEffect(S.MediaImageRequest)(given).pipe(Effect.mapError(() => refused(t("server.media.invalid"))));
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const request = JSON.stringify(input);
          const existing = yield* db.one(q.generation({ id: input.id }));
          if (existing) {
            if (!same(yield* decodeRequest(existing.request), input) || !same((yield* view(existing)).source, source))
              return yield* Effect.fail(refused(t("server.media.reusedId")));
            return yield* view(existing);
          }
          if (yield* understanding.has(input.id)) return yield* Effect.fail(refused(t("server.media.reusedId")));
          yield* capacity();
          const connection = yield* provider.image();
          const prompt =
            input.format === "layout"
              ? yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(input.prompt).pipe(Effect.mapError(() => refused(t("server.media.invalid"))))
              : input.prompt;
          const prepared = yield* prepareMossImage({
            model: connection.model,
            prompt,
            size: { width: input.width, height: input.height },
            ...(input.seed !== undefined ? { seed: input.seed } : {}),
            ...(input.steps !== undefined ? { steps: input.steps } : {}),
            ...(input.guidance !== undefined ? { guidance: input.guidance } : {}),
            ...(input.negativePrompt !== undefined ? { negativePrompt: input.negativePrompt } : {}),
            enhance: input.enhance,
            watermark: input.watermark,
          }).pipe(Effect.mapError(() => refused(t("server.media.invalid"))));
          yield* db.run(
            q.insertGeneration({
              id: input.id,
              request,
              source: JSON.stringify(source),
              connection: connection.connection,
              revision: connection.revision,
              model: connection.model,
              now: yield* Clock.currentTimeMillis,
            }),
          );
          yield* publish();
          const work = Effect.gen(function* () {
            if (!(yield* change(input.id, ["queued"], { phase: "generating" }))) return;
            yield* generateMossImage(connection.key, prepared).pipe(
              Effect.provideService(HttpClient.HttpClient, http),
              Effect.flatMap((result) =>
                Effect.gen(function* () {
                  if (
                    yield* change(input.id, ["generating"], {
                      phase: "downloading",
                      result_url: result.url,
                      usage: JSON.stringify({ images: result.usage.generated_images, width: result.usage.output_width, height: result.usage.output_height }),
                    })
                  )
                    yield* download(input.id);
                }),
              ),
              Effect.catchTag("MossImageError", (error) =>
                change(input.id, ["generating"], {
                  phase: error.outcome === "Unknown" ? "unknown" : "failed",
                  problem: error.outcome === "Unknown" ? t("server.media.unknown") : t("server.media.rejected"),
                }),
              ),
              Effect.asVoid,
            );
          });
          yield* run(input.id, work);
          return yield* view(yield* found(input.id));
        }).pipe(Effect.uninterruptible),
      );
    }),
    cancel: Effect.fn("Media.cancel")(function* (id) {
      if (yield* understanding.has(id)) return yield* understanding.cancel(id);
      const fiber = yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const row = yield* found(id);
          if (!active(row.phase)) return Option.none();
          yield* db.run(q.changeGeneration({ ...row, phase: "canceled", problem: t("server.media.canceled"), now: yield* Clock.currentTimeMillis }));
          yield* publish();
          return FiberMap.getUnsafe(fibers, id);
        }).pipe(Effect.uninterruptible),
      );
      if (Option.isSome(fiber)) yield* Fiber.interrupt(fiber.value);
      return yield* get(id);
    }),
    retryDownload: Effect.fn("Media.retryDownload")(function* (id) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const row = yield* found(id);
          if (row.phase === "ready" || row.phase === "downloading") return yield* view(row);
          if (row.result_url === null || (row.phase !== "download_failed" && row.phase !== "canceled"))
            return yield* Effect.fail(refused(t("server.media.noDownload")));
          yield* capacity();
          yield* db.run(q.changeGeneration({ ...row, phase: "downloading", problem: "", now: yield* Clock.currentTimeMillis }));
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
      yield* FiberHandle.run(
        cleanup,
        inputs.sweep().pipe(
          Effect.catch(() => Effect.logError("Media input cleanup failed")),
          Effect.repeat(Schedule.spaced("1 minute")),
          Effect.asVoid,
        ),
      );
      yield* db.run(q.interruptGenerations({ problem: t("server.media.restarted"), now: yield* Clock.currentTimeMillis }));
      yield* publish();
      yield* Effect.forEach(yield* db.run(q.pendingGenerations()), (row) => (row.phase === "downloading" ? run(row.id, download(row.id)) : Effect.void), {
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
