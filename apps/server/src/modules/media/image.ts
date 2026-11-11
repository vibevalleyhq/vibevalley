import { Clock, Effect, Option, Schema } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { MediaPhaseValues } from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";

import { head } from "#/base/clip.ts";
import { type ApiError, BizCode, refuseIn } from "#/base/errors.ts";
import { Db } from "#/infra/db.ts";
import { bestEffort } from "#/infra/log.ts";
import { PublicHttp } from "#/infra/publicHttp.ts";
import { Attachment } from "#/modules/attachment/attachment.ts";
import { Channel } from "#/modules/channel/channel.ts";
import { Provider } from "#/modules/provider/provider.ts";
import * as q from "#db/media_job.sql.ts";

import { downloadImage } from "./download.ts";
import { jobsOf, newJob, type Row } from "./job.ts";
import type { Machine } from "./machine.ts";
import type { MediaCaller } from "./media.ts";

const refused = refuseIn(BizCode.MediaRefused);

const jobs = jobsOf({ kinds: ["image"], phases: MediaPhaseValues });

const attachmentJson = Schema.encodeEffect(Schema.fromJsonString(S.Attachment));
const requestJson = Schema.encodeEffect(Schema.fromJsonString(S.MediaImageRequest));
const sourceJson = Schema.encodeEffect(Schema.fromJsonString(S.MediaSource));
const usageJson = Schema.encodeEffect(Schema.fromJsonString(S.MediaImageUsage));

/** Images (MOSS): asked once, the made image fetched from its signed address and kept as an attachment. */
export const makeImage = Effect.fnUntraced(function* (machine: Machine) {
  const db = yield* Db;
  const channel = yield* Channel;
  const kept = yield* Attachment;
  const provider = yield* Provider;
  const downloads = yield* PublicHttp;
  const corrupt = () => refused(t("server.media.corrupt"));
  const decodeRequest = (text: string) => Schema.decodeEffect(Schema.fromJsonString(S.MediaImageRequest))(text).pipe(Effect.mapError(corrupt));
  const words = {
    unknown: t("server.media.unknown"),
    rejected: t("server.media.rejected"),
    paused: t("server.media.unknown"),
    downloadFailed: t("server.media.downloadFailed"),
    accountChanged: t("server.media.remoteAccountChanged"),
    noResume: t("server.media.noDownload"),
  };

  const view = Effect.fnUntraced(function* (given: Row): Effect.fn.Return<T.MediaImageJob, ApiError> {
    const row = jobs.one(given);
    if (row === undefined) return yield* corrupt();
    const request = yield* decodeRequest(row.request);
    const source = yield* Schema.decodeEffect(Schema.fromJsonString(S.MediaSource))(row.source).pipe(Effect.mapError(corrupt));
    const usage =
      row.usage === null ? undefined : yield* Schema.decodeEffect(Schema.fromJsonString(S.MediaImageUsage))(row.usage).pipe(Effect.mapError(corrupt));
    const attachment =
      row.attachment === null ? undefined : yield* Schema.decodeEffect(Schema.fromJsonString(S.Attachment))(row.attachment).pipe(Effect.mapError(corrupt));
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
      canCancel: machine.active(row.phase),
      canRetryDownload: row.result_url !== null && (row.phase === "download_failed" || row.phase === "canceled"),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });

  /** A made image goes back to the channel an orchestrator was asked for it in, under its name, once: the send key is the
   * job's, so a retried download or a restart says nothing again. The user's own jobs (the library's Generate dialog) stay where they are. */
  const postBack = Effect.fnUntraced(function* (id: string) {
    const row = yield* Effect.map(machine.found(id), jobs.one);
    if (row === undefined || row.phase !== "ready" || row.attachment === null) return;
    const source = yield* Schema.decodeEffect(Schema.fromJsonString(S.MediaSource))(row.source);
    if (source.kind !== "orchestrator") return;
    const attachment = yield* Schema.decodeEffect(Schema.fromJsonString(S.Attachment))(row.attachment);
    const request = yield* decodeRequest(row.request);
    yield* channel.post({
      _tag: "Announce",
      from: source.agent,
      channel: source.channel,
      text: t("server.media.imageMade", { prompt: head(request.prompt, 80) }),
      made: { attachments: [attachment.id] },
      sendKey: `media:${id}`,
    });
  });
  const postSafely = (id: string) => postBack(id).pipe(bestEffort(`media: posting image ${id}`));

  machine.register({
    kinds: ["image"],
    words,
    view,
    keep: Effect.fnUntraced(function* (row) {
      const request = yield* decodeRequest(row.request);
      const bytes = yield* downloadImage(downloads, row.result_url ?? "", request.width, request.height).pipe(
        Effect.mapError(() => refused(words.downloadFailed)),
      );
      const attachment = yield* kept.attach({ name: `moss-${row.id}.png`, type: "image/png", data: bytes.toString("base64") });
      return { patch: { attachment: yield* attachmentJson(attachment).pipe(Effect.mapError(corrupt)) }, undo: Effect.void };
    }),
    // Whether or not the channel takes it, the image is ready.
    kept: postSafely,
    // A stop between ready and the post leaves it unposted: the recent ones are posted again, the send key keeping each once.
    restarted: Effect.fnUntraced(function* () {
      const recent = yield* Effect.map(db.run(q.recentMediaJobs()), jobs.many);
      yield* Effect.forEach(recent, (row) => postSafely(row.id), { discard: true });
    }),
  });

  return {
    create: Effect.fn("Media.createImage")(function* (given: T.MediaImageRequest, caller: MediaCaller) {
      if (caller.kind === "orchestrator" && !caller.forUser) return yield* refused(t("server.media.userRequired"));
      const source: T.MediaSource = yield* Schema.decodeEffect(S.MediaSource)(caller).pipe(Effect.mapError(() => refused(t("server.media.invalid"))));
      const input = yield* Schema.decodeEffect(S.MediaImageRequest)(given).pipe(Effect.mapError(() => refused(t("server.media.invalid"))));
      return yield* machine.lock.withPermits(1)(
        Effect.gen(function* () {
          const existing = yield* machine.admit(input.id, ["image"], (row) =>
            Effect.gen(function* () {
              const stored = yield* decodeRequest(row.request);
              const shown = yield* view(row);
              return same(stored, input) && same(shown.source, source);
            }),
          );
          if (Option.isSome(existing)) return yield* view(existing.value);
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
                request: yield* requestJson(input).pipe(Effect.mapError(() => refused(t("server.media.invalid")))),
                source: yield* sourceJson(source).pipe(Effect.mapError(() => refused(t("server.media.invalid")))),
                connection: connection.connection,
                revision: connection.revision,
                model: connection.model,
                now: yield* Clock.currentTimeMillis,
              }),
            ),
          );
          yield* machine.publish();
          yield* machine.run(
            input.id,
            Effect.gen(function* () {
              if (!(yield* machine.change(input.id, ["queued"], { phase: "generating" }))) return;
              yield* connection.run.pipe(
                Effect.flatMap((result) =>
                  Effect.gen(function* () {
                    const usage = yield* usageJson(result.usage).pipe(Effect.mapError(corrupt));
                    if (yield* machine.change(input.id, ["generating"], { phase: "downloading", result_url: result.url, usage }))
                      yield* machine.download(input.id);
                  }),
                ),
                Effect.catchTag("ImageFailure", (error) => machine.failed(input.id, error.outcome, words)),
                Effect.asVoid,
              );
            }),
          );
          const made = yield* machine.found(input.id);
          return yield* view(made);
        }).pipe(Effect.uninterruptible),
      );
    }),
  };
});
