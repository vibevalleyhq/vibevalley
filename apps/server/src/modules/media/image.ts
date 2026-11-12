import { z } from "zod";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { MediaPhaseValues } from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";

import { head } from "#/base/clip.ts";
import { BizCode, refuseIn } from "#/base/errors.ts";
import { jsonOrNone, jsonText } from "#/base/json.ts";
import type { Db } from "#/infra/db.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import type { PublicFetch } from "#/infra/publicHttp.ts";
import type { Time } from "#/infra/time.ts";
import type { Channel } from "#/modules/channel/channel.ts";
import type { Attachment } from "#/platform/attachment/attachment.ts";
import type { Provider } from "#/platform/provider/provider.ts";
import { ImageFailure } from "#/platform/provider/vendors.ts";
import * as q from "#db/media_job.sql.ts";

import { downloadImage } from "./download.ts";
import { jobsOf, newJob, type Row, storedAs } from "./job.ts";
import type { Machine } from "./machine.ts";
import type { MediaCaller } from "./media.ts";

const refused = refuseIn(BizCode.MediaRefused);

const jobs = jobsOf({ kinds: ["image"], phases: MediaPhaseValues });

export interface ImageDeps {
  readonly db: Db;
  readonly clock: Time;
  readonly log: Logger;
  readonly channel: Channel;
  readonly attachment: Attachment;
  readonly provider: Provider;
  readonly publicFetch: PublicFetch;
}

/** Images (MOSS): asked once, the made image fetched from its signed address and kept as an attachment. */
export function makeImage(deps: ImageDeps, machine: Machine) {
  const { db, clock, channel, attachment: kept, provider, publicFetch } = deps;
  const log = deps.log.child("media/image");
  const corrupt = () => refused(t("server.media.corrupt"));
  const invalid = () => refused(t("server.media.invalid"));
  const decodeRequest = storedAs(S.MediaImageRequest, corrupt);
  const decodeSource = storedAs(S.MediaSource, corrupt);
  const decodeUsage = storedAs(S.MediaImageUsage, corrupt);
  const decodeAttachment = storedAs(S.Attachment, corrupt);
  const words = {
    unknown: t("server.media.unknown"),
    rejected: t("server.media.rejected"),
    paused: t("server.media.unknown"),
    downloadFailed: t("server.media.downloadFailed"),
    accountChanged: t("server.media.remoteAccountChanged"),
    noResume: t("server.media.noDownload"),
  };

  const view = async (given: Row): Promise<T.MediaImageJob> => {
    const row = jobs.one(given);
    if (row === undefined) throw corrupt();
    const request = decodeRequest(row.request);
    const source = decodeSource(row.source);
    const usage = row.usage === null ? undefined : decodeUsage(row.usage);
    const attachment = row.attachment === null ? undefined : decodeAttachment(row.attachment);
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
  };

  /** A made image goes back to the channel an orchestrator was asked for it in, under its name, once: the send key is the
   * job's, so a retried download or a restart says nothing again. The user's own jobs (the library's Generate dialog) stay where they are. */
  const postBack = async (id: string) => {
    const row = jobs.one(await machine.found(id));
    if (row === undefined || row.phase !== "ready" || row.attachment === null) return;
    const source = decodeSource(row.source);
    if (source.kind !== "orchestrator") return;
    const attachment = decodeAttachment(row.attachment);
    const request = decodeRequest(row.request);
    await channel.post({
      from: source.agent,
      channel: source.channel,
      text: t("server.media.imageMade", { prompt: head(request.prompt, 80) }),
      made: { attachments: [attachment.id] },
      sendKey: `media:${id}`,
    });
  };
  const postSafely = (id: string) => bestEffort(log, `media: posting image ${id}`, () => postBack(id));

  machine.register({
    kinds: ["image"],
    words,
    view,
    keep: async (row, signal) => {
      const request = decodeRequest(row.request);
      let bytes: Buffer;
      try {
        bytes = await downloadImage(publicFetch, row.result_url ?? "", request.width, request.height, { clock }, signal);
      } catch (e) {
        if (signal.aborted) throw e;
        throw refused(words.downloadFailed);
      }
      const attachment = await kept.attach({ name: `moss-${row.id}.png`, type: "image/png", data: bytes.toString("base64") });
      return { patch: { attachment: jsonText(attachment) }, undo: async () => undefined };
    },
    // Whether or not the channel takes it, the image is ready.
    kept: postSafely,
    // A stop between ready and the post leaves it unposted: the recent ones are posted again, the send key keeping each once.
    restarted: async () => {
      for (const row of jobs.many(await q.recentMediaJobs(db.sql))) await postSafely(row.id);
    },
  });

  const generate = async (id: string, connection: Awaited<ReturnType<Provider["image"]>>, signal: AbortSignal) => {
    if (!(await machine.change(id, ["queued"], { phase: "generating" }))) return;
    let result;
    try {
      result = await connection.run(signal);
    } catch (error) {
      if (!(error instanceof ImageFailure)) throw error;
      await machine.failed(id, error.outcome, words);
      return;
    }
    if (await machine.change(id, ["generating"], { phase: "downloading", result_url: result.url, usage: jsonText(result.usage) }))
      await machine.download(id, signal);
  };

  return {
    // Not stopped by the caller: a job once admitted is written and started.
    create: async (given: T.MediaImageRequest, caller: MediaCaller): Promise<T.MediaImageJob> => {
      if (caller.kind === "orchestrator" && !caller.forUser) throw refused(t("server.media.userRequired"));
      const source = S.MediaSource.safeParse(caller);
      if (!source.success) throw invalid();
      const parsed = S.MediaImageRequest.safeParse(given);
      if (!parsed.success) throw invalid();
      const input = parsed.data;
      return machine.lock.with(async () => {
        const existing = await machine.admit(input.id, ["image"], async (row) => {
          const stored = decodeRequest(row.request);
          const shown = await view(row);
          return same(stored, input) && same(shown.source, source.data);
        });
        if (existing !== undefined) return view(existing);
        let prompt: unknown = input.prompt;
        if (input.format === "layout") {
          prompt = jsonOrNone(z.unknown())(input.prompt);
          if (prompt === undefined) throw invalid();
        }
        const connection = await provider.image({
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
        await q.insertMediaJob(
          db.sql,
          newJob({
            id: input.id,
            kind: "image",
            phase: "queued",
            request: jsonText(input),
            source: jsonText(source.data),
            connection: connection.connection,
            revision: connection.revision,
            model: connection.model,
            now: clock.now(),
          }),
        );
        await machine.publish();
        await machine.run(input.id, (signal) => generate(input.id, connection, signal));
        return view(await machine.found(input.id));
      });
    },
  };
}
