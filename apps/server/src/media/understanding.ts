import { Clock, Effect, Option, Schema } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { userId, MediaUnderstandingPhaseValues } from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";

import { type ApiError, refused } from "#/base/errors.ts";
import { Channel } from "#/channel/channel.ts";
import { Db } from "#/infra/db.ts";
import { bestEffort } from "#/infra/log.ts";
import { type Account, Provider } from "#/provider/provider.ts";
import * as q from "#db/media_job.sql.ts";

import type { makeInputs } from "./inputs.ts";
import { type JobRow, jobsOf, newJob, type Row } from "./job.ts";
import type { Machine } from "./machine.ts";
import type { MediaCaller } from "./media.ts";
import type { makeRemoteFiles } from "./remoteFiles.ts";

interface Ports {
  readonly inputs: Effect.Success<typeof makeInputs>;
  readonly remote: Effect.Success<ReturnType<typeof makeRemoteFiles>>;
  readonly machine: Machine;
}

const Authorization = Schema.Struct({
  channel: Schema.NonEmptyString,
  expiresAt: Schema.Finite,
  fingerprint: Schema.String,
});

const authorizationJson = Schema.encodeEffect(Schema.fromJsonString(Authorization));
const requestJson = Schema.encodeEffect(Schema.fromJsonString(S.MediaUnderstandingRequest));
const referencesJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(S.MediaInputReference)));
const sourceJson = Schema.encodeEffect(Schema.fromJsonString(S.MediaSource));
const resultJson = Schema.encodeEffect(Schema.fromJsonString(S.MediaUnderstandingResult));

const jobs = jobsOf({ kinds: ["understanding"], phases: MediaUnderstandingPhaseValues });
const terminal: readonly T.MediaUnderstandingPhase[] = ["ready", "incomplete", "failed", "unknown", "canceled"];

/** Understanding images and video: the user's inputs uploaded to the vendor, asked once, and deleted there afterwards.
 * A model may only start one the user authorized for its channel. */
export const makeUnderstanding = Effect.fnUntraced(function* ({ inputs, remote, machine }: Ports) {
  const db = yield* Db;
  const provider = yield* Provider;
  const channels = yield* Channel;
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
    return read === undefined ? Effect.fail(invalid()) : Effect.succeed(read);
  };
  const request = (row: Row) => Schema.decodeEffect(Schema.fromJsonString(S.MediaUnderstandingRequest))(row.request).pipe(Effect.mapError(invalid));
  const authorization = (row: Row) =>
    row.authorization === null
      ? Effect.succeed(null)
      : Schema.decodeEffect(Schema.fromJsonString(Authorization))(row.authorization).pipe(Effect.mapError(invalid));
  const view = Effect.fnUntraced(function* (given: Row): Effect.fn.Return<T.MediaUnderstandingJob, ApiError> {
    const row = yield* own(given);
    const input = yield* request(row);
    const approval = yield* authorization(row);
    return {
      kind: "understanding",
      id: row.id,
      prompt: input.prompt,
      inputs: yield* Schema.decodeEffect(Schema.fromJsonString(Schema.mutable(Schema.Array(S.MediaInputReference))))(row.inputs).pipe(Effect.mapError(invalid)),
      model: row.model,
      connection: row.connection,
      revision: row.revision,
      source: yield* Schema.decodeEffect(Schema.fromJsonString(S.MediaSource))(row.source).pipe(Effect.mapError(invalid)),
      authorization: approval ? { channel: approval.channel, expiresAt: approval.expiresAt } : null,
      phase: row.phase,
      phaseText: t(`server.media.understandingPhase.${row.phase}`),
      problem: row.problem,
      result:
        row.result === null ? null : yield* Schema.decodeEffect(Schema.fromJsonString(S.MediaUnderstandingResult))(row.result).pipe(Effect.mapError(invalid)),
      cleanup: row.cleanup,
      cleanupText: t(`server.media.cleanup.${row.cleanup}`),
      canCancel: machine.active(row.phase),
      canCleanup: !machine.active(row.phase) && (row.cleanup === "pending" || row.cleanup === "blocked"),
      canRetryDownload: false,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
  const get = Effect.fn("Media.understandingGet")(function* (id: string) {
    const row = yield* machine.found(id, ["understanding"]);
    return yield* view(row);
  });

  /** The files it uploaded go at the vendor, and its inputs are let go; one the vendor never answered for is unknown. */
  const clean = Effect.fnUntraced(function* (id: string) {
    yield* Effect.gen(function* () {
      const rows = yield* remote.list(id);
      yield* Effect.forEach(
        rows.filter((row) => row.remote_id !== null && row.phase !== "deleted"),
        (row) => Effect.flatMap(provider.account({ connection: row.connection, model: "" }), (account) => remote.remove(id, row.input_id, account)),
        { discard: true },
      );
      const unresolved = rows.filter((row) => row.remote_id === null && row.phase !== "rejected" && row.phase !== "deleted");
      yield* inputs.release(id);
      yield* machine.change(id, terminal, {
        cleanup: unresolved.length > 0 ? "unknown" : "done",
        ...(unresolved.length > 0 ? { problem: t("server.media.remoteUnresolved", { files: unresolved.map((row) => row.filename).join(", ") }) } : {}),
      });
    }).pipe(
      Effect.catch(() => machine.change(id, terminal, { cleanup: "blocked" })),
      Effect.onError(() =>
        machine.change(id, terminal, { cleanup: "blocked" }).pipe(bestEffort("Media understanding cleanup interruption could not be recorded")),
      ),
    );
  }, machine.cleaning.withPermits(1));

  const approvedAccount = Effect.fnUntraced(function* (row: JobRow<T.MediaUnderstandingPhase>) {
    const approval = yield* authorization(row);
    const account = yield* provider.understanding();
    if (
      !approval ||
      approval.expiresAt <= (yield* Clock.currentTimeMillis) ||
      account.connection !== row.connection ||
      account.revision !== row.revision ||
      account.model !== row.model ||
      account.fingerprint !== approval.fingerprint
    )
      return yield* Effect.fail(refused(t("server.media.consentChanged")));
    return account;
  });
  const expire = Effect.fnUntraced(function* (id: string) {
    if (yield* machine.change(id, ["authorized", "queued"], { phase: "canceled", cleanup: "done", problem: t("server.media.authorizationExpired") }))
      yield* inputs.release(id);
  });
  const enqueue = Effect.fnUntraced(function* (row: JobRow<T.MediaUnderstandingPhase>, account: Account) {
    const input = yield* request(row);
    const references = (yield* view(row)).inputs;
    yield* machine.run(
      input.id,
      Effect.gen(function* () {
        if (row.authorization !== null) {
          const valid = yield* approvedAccount(row).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
          if (!valid) return yield* expire(input.id);
        }
        if (!(yield* machine.change(input.id, ["queued"], { phase: "uploading" }))) return;
        const media = yield* Effect.forEach(references, (item) =>
          Effect.map(remote.upload(input.id, item.id, account), (fileId) => ({ kind: item.kind, fileId })),
        );
        if (!(yield* machine.change(input.id, ["uploading"], { phase: "generating" }))) return;
        const result = yield* account.understanding.ask({ text: input.prompt, media, maxOutputTokens: input.maxOutputTokens });
        if (
          yield* machine.change(input.id, ["generating"], {
            phase: result.status === "completed" ? "ready" : "incomplete",
            result: yield* resultJson(result).pipe(Effect.mapError(invalid)),
            cleanup: "running",
            problem: "",
          })
        )
          yield* clean(input.id);
      }).pipe(
        Effect.catchTag("UnderstandingFailure", (error) => machine.failed(input.id, error.outcome, words)),
        Effect.catch(() =>
          Effect.gen(function* () {
            const uncertain = (yield* remote.list(input.id)).some((file) => file.phase === "unknown" || file.phase === "uploading");
            yield* machine.change(input.id, ["uploading"], {
              phase: uncertain ? "unknown" : "failed",
              problem: uncertain ? t("server.media.remoteUploadUnknown") : t("server.media.remoteUploadRejected"),
            });
          }),
        ),
        Effect.asVoid,
      ),
    );
  });

  machine.register({
    kinds: ["understanding"],
    words,
    view,
    running: ["uploading", "generating"],
    canceling: (row) => {
      const unsubmitted = row.phase === "authorized" || row.phase === "queued";
      return { patch: unsubmitted ? { cleanup: "done" } : {}, after: unsubmitted ? inputs.release(row.id) : Effect.void };
    },
    // What never started lets go of its inputs before the restart cancels it.
    restarting: (rows) =>
      Effect.forEach(
        rows.filter((row) => row.phase === "authorized" || row.phase === "queued"),
        (row) => inputs.release(row.id),
        { discard: true },
      ),
  });

  const create = Effect.fn("Media.createUnderstanding")(
    function* (given: T.MediaUnderstandingRequest, channel: string | null) {
      const input = yield* Schema.decodeEffect(S.MediaUnderstandingRequest)(given).pipe(Effect.mapError(invalid));
      const existing = yield* machine.admit(input.id, ["understanding"], (row) =>
        Effect.gen(function* () {
          const stored = yield* request(row);
          const allowed = yield* authorization(row);
          return same(stored, input) && allowed?.channel === (channel ?? undefined);
        }),
      );
      if (Option.isSome(existing)) return yield* view(existing.value);
      const account = yield* provider.understanding();
      if (input.connection !== account.connection || input.revision !== account.revision) return yield* Effect.fail(refused(t("server.media.consentChanged")));
      if (channel !== null && (yield* channels.placeOf(userId, channel)) !== channel) return yield* Effect.fail(invalid());
      const references = yield* Effect.forEach(input.inputs, (id) =>
        inputs.get(id).pipe(Effect.flatMap(Schema.decodeUnknownEffect(S.MediaInputReference)), Effect.mapError(invalid)),
      );
      yield* account.understanding
        .check({ text: input.prompt, maxOutputTokens: input.maxOutputTokens, media: references.map((item) => ({ kind: item.kind, fileId: item.id })) })
        .pipe(Effect.mapError(invalid));
      const now = yield* Clock.currentTimeMillis;
      yield* inputs.pin(
        input.inputs,
        input.id,
        db.run(
          q.insertMediaJob(
            newJob({
              id: input.id,
              kind: "understanding",
              cleanup: "pending",
              request: yield* requestJson(input).pipe(Effect.mapError(invalid)),
              inputs: yield* referencesJson(references).pipe(Effect.mapError(invalid)),
              source: yield* sourceJson({ kind: "user" }).pipe(Effect.mapError(invalid)),
              authorization:
                channel === null
                  ? null
                  : yield* authorizationJson({ channel, expiresAt: now + 15 * 60_000, fingerprint: account.fingerprint }).pipe(Effect.mapError(invalid)),
              connection: account.connection,
              revision: account.revision,
              model: account.model,
              phase: channel === null ? "queued" : "authorized",
              now,
            }),
          ),
        ),
      );
      yield* machine.publish();
      const row = yield* Effect.flatMap(machine.found(input.id), own);
      if (channel === null) yield* enqueue(row, account);
      return yield* view(row);
    },
    machine.lock.withPermits(1),
    Effect.uninterruptible,
  );

  return {
    get,
    create: (input: T.MediaUnderstandingRequest) => create(input, null),
    authorize: Effect.fn("Media.authorizeUnderstanding")(function* (given: T.MediaUnderstandingAuthorizationRequest) {
      const { channel, ...input } = yield* Schema.decodeEffect(S.MediaUnderstandingAuthorizationRequest)(given).pipe(Effect.mapError(invalid));
      return yield* create(input, channel);
    }),
    start: Effect.fn("Media.startUnderstanding")(
      function* (id: string, caller: MediaCaller) {
        if (caller.kind !== "orchestrator" || !caller.forUser) return yield* Effect.fail(refused(t("server.media.userRequired")));
        const row = yield* Effect.flatMap(machine.found(id, ["understanding"]), own);
        const approval = yield* authorization(row);
        if (!approval || approval.channel !== caller.channel) return yield* Effect.fail(refused(t("server.media.authorizationRequired")));
        const source: T.MediaSource = { kind: "orchestrator", agent: caller.agent, channel: caller.channel };
        if (row.phase !== "authorized") {
          const existing = yield* view(row);
          if (existing.source.kind === "orchestrator" && !same(existing.source, source))
            return yield* Effect.fail(refused(t("server.media.authorizationRequired")));
          return existing;
        }
        const account = yield* approvedAccount(row);
        yield* channels.placeOf(userId, approval.channel);
        const next = { ...row, source: yield* sourceJson(source).pipe(Effect.mapError(invalid)), phase: "queued" as const };
        yield* machine.write(row, { source: next.source, phase: "queued" });
        yield* enqueue(next, account);
        return yield* view(next);
      },
      machine.lock.withPermits(1),
      Effect.uninterruptible,
    ),
    /** Authorizations that ran out before a model started them. */
    sweep: Effect.fn("Media.understandingSweep")(function* () {
      const now = yield* Clock.currentTimeMillis;
      const active = yield* Effect.map(db.run(q.activeMediaJobs()), jobs.many);
      for (const row of active) {
        if (row.phase !== "authorized") continue;
        const approval = yield* authorization(row);
        if (approval && approval.expiresAt <= now) yield* expire(row.id);
      }
    }),
    previewCleanup: Effect.fn("Media.understandingPreviewCleanup")(function* (id: string): Effect.fn.Return<T.Preview, ApiError> {
      const row = yield* machine.found(id, ["understanding"]);
      if (machine.active(row.phase) || row.cleanup === "running" || machine.running(id)) return yield* Effect.fail(refused(t("server.media.busy")));
      if (row.cleanup === "done" || row.cleanup === "unknown") return { does: [] };
      const files = yield* remote.list(id);
      return {
        does: [
          t("server.media.cleanupPreview", {
            connection: row.connection,
            count: files.filter((file) => file.remote_id !== null && file.phase !== "deleted").length,
          }),
          t("server.media.cleanupReleasePreview"),
        ],
      };
    }, machine.lock.withPermits(1)),
    cleanup: Effect.fn("Media.understandingCleanup")(function* (id: string) {
      return yield* Effect.uninterruptibleMask((resume) =>
        Effect.gen(function* () {
          const start = yield* machine.lock.withPermits(1)(
            Effect.gen(function* () {
              const row = yield* machine.found(id, ["understanding"]);
              if (machine.active(row.phase) || row.cleanup === "running" || machine.running(id)) return yield* Effect.fail(refused(t("server.media.busy")));
              if (row.cleanup === "done" || row.cleanup === "unknown") return false;
              yield* machine.capacity();
              yield* machine.write(row, { cleanup: "running" });
              return true;
            }),
          );
          if (start)
            yield* resume(clean(id)).pipe(
              Effect.onError(() =>
                machine.change(id, terminal, { cleanup: "blocked" }).pipe(bestEffort("Media understanding cleanup could not be interrupted")),
              ),
            );
          return yield* get(id);
        }),
      );
    }),
  };
});
