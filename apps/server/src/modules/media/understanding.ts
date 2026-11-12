import { z } from "zod";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { userId, MediaUnderstandingPhaseValues } from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";

import { BizCode, refuseIn } from "#/base/errors.ts";
import { jsonText } from "#/base/json.ts";
import type { Db } from "#/infra/db.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Channel } from "#/modules/channel/channel.ts";
import type { Account, Provider } from "#/platform/provider/provider.ts";
import { UnderstandingFailure } from "#/platform/provider/vendors.ts";
import * as q from "#db/media_job.sql.ts";

import type { Inputs } from "./inputs.ts";
import { type JobRow, jobsOf, newJob, type Row, storedAs } from "./job.ts";
import type { Machine } from "./machine.ts";
import type { MediaCaller } from "./media.ts";
import type { RemoteFiles } from "./remoteFiles.ts";

const refused = refuseIn(BizCode.MediaRefused);

interface Ports {
  readonly inputs: Inputs;
  readonly remote: RemoteFiles;
  readonly machine: Machine;
}

export interface UnderstandingDeps {
  readonly db: Db;
  readonly clock: Time;
  readonly log: Logger;
  readonly provider: Provider;
  readonly channel: Channel;
}

const Authorization = z.object({
  channel: z.string().min(1),
  expiresAt: z.number(),
  fingerprint: z.string(),
});

const jobs = jobsOf({ kinds: ["understanding"], phases: MediaUnderstandingPhaseValues });
const terminal: readonly T.MediaUnderstandingPhase[] = ["ready", "incomplete", "failed", "unknown", "canceled"];

/** Understanding images and video: the user's inputs uploaded to the vendor, asked once, and deleted there afterwards.
 * A model may only start one the user authorized for its channel. */
export function makeUnderstanding(deps: UnderstandingDeps, { inputs, remote, machine }: Ports) {
  const { db, clock, provider, channel: channels } = deps;
  const log = deps.log.child("media/understanding");
  const invalid = () => refused(t("server.media.inputInvalid"));
  const words = {
    unknown: t("server.media.understandingUnknown"),
    rejected: t("server.media.understandingRejected"),
    paused: t("server.media.understandingUnknown"),
    downloadFailed: t("server.media.noDownload"),
    accountChanged: t("server.media.consentChanged"),
    noResume: t("server.media.noDownload"),
  };
  const own = (row: Row) => {
    const read = jobs.one(row);
    if (read === undefined) throw invalid();
    return read;
  };
  const request = (row: Row) => storedAs(S.MediaUnderstandingRequest, invalid)(row.request);
  const authorization = (row: Row) => (row.authorization === null ? null : storedAs(Authorization, invalid)(row.authorization));
  const referencesOf = storedAs(z.array(S.MediaInputReference), invalid);
  const sourceOf = storedAs(S.MediaSource, invalid);
  const resultOf = storedAs(S.MediaUnderstandingResult, invalid);
  const view = async (given: Row): Promise<T.MediaUnderstandingJob> => {
    const row = own(given);
    const input = request(row);
    const approval = authorization(row);
    return {
      kind: "understanding",
      id: row.id,
      prompt: input.prompt,
      inputs: referencesOf(row.inputs ?? ""),
      model: row.model,
      connection: row.connection,
      revision: row.revision,
      source: sourceOf(row.source),
      authorization: approval ? { channel: approval.channel, expiresAt: approval.expiresAt } : null,
      phase: row.phase,
      phaseText: t(`server.media.understandingPhase.${row.phase}`),
      problem: row.problem,
      result: row.result === null ? null : resultOf(row.result),
      cleanup: row.cleanup,
      cleanupText: t(`server.media.cleanup.${row.cleanup}`),
      canCancel: machine.active(row.phase),
      canCleanup: !machine.active(row.phase) && (row.cleanup === "pending" || row.cleanup === "blocked"),
      canRetryDownload: false,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  };
  const get = async (id: string) => view(await machine.found(id, ["understanding"]));

  /** The files it uploaded go at the vendor, and its inputs are let go; one the vendor never answered for is unknown.
   * Stopped part way, or failed, the cleanup is blocked: it can be asked for again. */
  const clean = (id: string, signal?: AbortSignal) =>
    machine.cleaning.with(async () => {
      try {
        const rows = await remote.list(id);
        for (const row of rows.filter((row) => row.remote_id !== null && row.phase !== "deleted")) {
          const account = await provider.account({ connection: row.connection, model: "" });
          await remote.remove(id, row.input_id, account, signal);
        }
        const unresolved = rows.filter((row) => row.remote_id === null && row.phase !== "rejected" && row.phase !== "deleted");
        await inputs.release(id);
        await machine.change(id, terminal, {
          cleanup: unresolved.length > 0 ? "unknown" : "done",
          ...(unresolved.length > 0 ? { problem: t("server.media.remoteUnresolved", { files: unresolved.map((row) => row.filename).join(", ") }) } : {}),
        });
      } catch (e) {
        if (signal?.aborted === true) {
          await bestEffort(log, "Media understanding cleanup interruption could not be recorded", () => machine.change(id, terminal, { cleanup: "blocked" }));
          throw e;
        }
        log.warn(`media: understanding ${id} cleanup is blocked`, e);
        await machine.change(id, terminal, { cleanup: "blocked" });
      }
    });

  const approvedAccount = async (row: JobRow<T.MediaUnderstandingPhase>) => {
    const approval = authorization(row);
    const account = await provider.understanding();
    if (
      !approval ||
      approval.expiresAt <= clock.now() ||
      account.connection !== row.connection ||
      account.revision !== row.revision ||
      account.model !== row.model ||
      account.fingerprint !== approval.fingerprint
    )
      throw refused(t("server.media.consentChanged"));
    return account;
  };
  const expire = async (id: string) => {
    if (await machine.change(id, ["authorized", "queued"], { phase: "canceled", cleanup: "done", problem: t("server.media.authorizationExpired") }))
      await inputs.release(id);
  };

  const ask = async (
    row: JobRow<T.MediaUnderstandingPhase>,
    input: T.MediaUnderstandingRequest,
    references: readonly T.MediaInputReference[],
    account: Account,
    signal: AbortSignal,
  ) => {
    if (row.authorization !== null) {
      // An approval that no longer holds (expired, the account changed) ends the job as expired: nothing to log.
      const valid = await approvedAccount(row).then(
        () => true,
        () => false,
      );
      if (!valid) {
        await expire(input.id);
        return;
      }
    }
    if (!(await machine.change(input.id, ["queued"], { phase: "uploading" }))) return;
    const media: { kind: T.MediaInputReference["kind"]; fileId: string }[] = [];
    for (const item of references) media.push({ kind: item.kind, fileId: await remote.upload(input.id, item.id, account, signal) });
    if (!(await machine.change(input.id, ["uploading"], { phase: "generating" }))) return;
    const result = await account.understanding.ask({ text: input.prompt, media, maxOutputTokens: input.maxOutputTokens }, signal);
    if (
      await machine.change(input.id, ["generating"], {
        phase: result.status === "completed" ? "ready" : "incomplete",
        result: jsonText(result),
        cleanup: "running",
        problem: "",
      })
    )
      await clean(input.id, signal);
  };

  const enqueue = async (row: JobRow<T.MediaUnderstandingPhase>, account: Account) => {
    const input = request(row);
    const references = (await view(row)).inputs;
    await machine.run(input.id, async (signal) => {
      try {
        await ask(row, input, references, account, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof UnderstandingFailure) {
          await machine.failed(input.id, error.outcome, words);
          return;
        }
        log.warn(`media: understanding ${input.id} failed`, error);
        const uncertain = (await remote.list(input.id)).some((file) => file.phase === "unknown" || file.phase === "uploading");
        await machine.change(input.id, ["uploading"], {
          phase: uncertain ? "unknown" : "failed",
          problem: uncertain ? t("server.media.remoteUploadUnknown") : t("server.media.remoteUploadRejected"),
        });
      }
    });
  };

  machine.register({
    kinds: ["understanding"],
    words,
    view,
    running: ["uploading", "generating"],
    canceling: (row) => {
      const unsubmitted = row.phase === "authorized" || row.phase === "queued";
      return { patch: unsubmitted ? { cleanup: "done" } : {}, after: unsubmitted ? () => inputs.release(row.id) : async () => undefined };
    },
    // What never started lets go of its inputs before the restart cancels it.
    restarting: async (rows) => {
      for (const row of rows.filter((row) => row.phase === "authorized" || row.phase === "queued")) await inputs.release(row.id);
    },
  });

  // Not stopped by a caller: a job once admitted is written and started.
  const create = (given: T.MediaUnderstandingRequest, channel: string | null) =>
    machine.lock.with(async (): Promise<T.MediaUnderstandingJob> => {
      const parsed = S.MediaUnderstandingRequest.safeParse(given);
      if (!parsed.success) throw invalid();
      const input = parsed.data;
      const existing = await machine.admit(input.id, ["understanding"], async (row) => {
        const stored = request(row);
        const allowed = authorization(row);
        return same(stored, input) && allowed?.channel === (channel ?? undefined);
      });
      if (existing !== undefined) return view(existing);
      const account = await provider.understanding();
      if (input.connection !== account.connection || input.revision !== account.revision) throw refused(t("server.media.consentChanged"));
      if (channel !== null && (await channels.placeOf(userId, channel)) !== channel) throw invalid();
      const references: T.MediaInputReference[] = [];
      for (const id of input.inputs) {
        let reference;
        try {
          reference = S.MediaInputReference.safeParse(await inputs.get(id));
        } catch {
          // An input not there is one this job cannot take: refused like a malformed one.
          throw invalid();
        }
        if (!reference.success) throw invalid();
        references.push(reference.data);
      }
      try {
        await account.understanding.check({
          text: input.prompt,
          maxOutputTokens: input.maxOutputTokens,
          media: references.map((item) => ({ kind: item.kind, fileId: item.id })),
        });
      } catch {
        // The vendor would not take it as asked: said as invalid input.
        throw invalid();
      }
      const now = clock.now();
      await inputs.pin(input.inputs, input.id, async () => {
        await q.insertMediaJob(
          db.sql,
          newJob({
            id: input.id,
            kind: "understanding",
            cleanup: "pending",
            request: jsonText(input),
            inputs: jsonText(references),
            source: jsonText({ kind: "user" }),
            authorization: channel === null ? null : jsonText({ channel, expiresAt: now + 15 * 60_000, fingerprint: account.fingerprint }),
            connection: account.connection,
            revision: account.revision,
            model: account.model,
            phase: channel === null ? "queued" : "authorized",
            now,
          }),
        );
      });
      await machine.publish();
      const row = own(await machine.found(input.id));
      if (channel === null) await enqueue(row, account);
      return view(row);
    });

  return {
    get,
    create: (input: T.MediaUnderstandingRequest) => create(input, null),
    authorize: async (given: T.MediaUnderstandingAuthorizationRequest) => {
      const parsed = S.MediaUnderstandingAuthorizationRequest.safeParse(given);
      if (!parsed.success) throw invalid();
      const { channel, ...input } = parsed.data;
      return create(input, channel);
    },
    start: (id: string, caller: MediaCaller) =>
      machine.lock.with(async (): Promise<T.MediaUnderstandingJob> => {
        if (caller.kind !== "orchestrator" || !caller.forUser) throw refused(t("server.media.userRequired"));
        const row = own(await machine.found(id, ["understanding"]));
        const approval = authorization(row);
        if (!approval || approval.channel !== caller.channel) throw refused(t("server.media.authorizationRequired"));
        const source: T.MediaSource = { kind: "orchestrator", agent: caller.agent, channel: caller.channel };
        if (row.phase !== "authorized") {
          const existing = await view(row);
          if (existing.source.kind === "orchestrator" && !same(existing.source, source)) throw refused(t("server.media.authorizationRequired"));
          return existing;
        }
        const account = await approvedAccount(row);
        await channels.placeOf(userId, approval.channel);
        const next = { ...row, source: jsonText(source), phase: "queued" as const };
        await machine.write(row, { source: next.source, phase: "queued" });
        await enqueue(next, account);
        return view(next);
      }),
    /** Authorizations that ran out before a model started them. */
    sweep: async () => {
      const now = clock.now();
      for (const row of jobs.many(await q.activeMediaJobs(db.sql))) {
        if (row.phase !== "authorized") continue;
        const approval = authorization(row);
        if (approval && approval.expiresAt <= now) await expire(row.id);
      }
    },
    previewCleanup: (id: string) =>
      machine.lock.with(async (): Promise<T.Preview> => {
        const row = await machine.found(id, ["understanding"]);
        if (machine.active(row.phase) || row.cleanup === "running" || machine.running(id)) throw refused(t("server.media.busy"));
        if (row.cleanup === "done" || row.cleanup === "unknown") return { does: [] };
        const files = await remote.list(id);
        return {
          does: [
            t("server.media.cleanupPreview", {
              connection: row.connection,
              count: files.filter((file) => file.remote_id !== null && file.phase !== "deleted").length,
            }),
            t("server.media.cleanupReleasePreview"),
          ],
        };
      }),
    // Stopped by the signal only while deleting at the vendor; stopped there, the cleanup is blocked and can be asked again.
    cleanup: async (id: string, signal?: AbortSignal) => {
      const start = await machine.lock.with(async () => {
        const row = await machine.found(id, ["understanding"]);
        if (machine.active(row.phase) || row.cleanup === "running" || machine.running(id)) throw refused(t("server.media.busy"));
        if (row.cleanup === "done" || row.cleanup === "unknown") return false;
        await machine.capacity();
        await machine.write(row, { cleanup: "running" });
        return true;
      });
      if (start) await clean(id, signal);
      return get(id);
    },
  };
}
