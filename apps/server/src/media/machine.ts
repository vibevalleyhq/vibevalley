import { Array as Arr, Clock, Effect, Fiber, FiberMap, Option, Schedule, Semaphore } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { type ApiError, refused } from "#/base/errors.ts";
import { Core } from "#/core/core.ts";
import { Db } from "#/infra/db.ts";
import { bestEffort } from "#/infra/log.ts";
import { type Account, Provider } from "#/provider/provider.ts";
import type { AudioFailure, AudioTask } from "#/provider/vendors.ts";
import * as q from "#db/media_job.sql.ts";

import { jobsOf, type MediaJobPhase, mediaJobPhases, type Row } from "./job.ts";

export type Patch = Partial<
  Pick<
    Row,
    | "phase"
    | "source"
    | "result_url"
    | "attachment"
    | "result"
    | "usage"
    | "remote_task"
    | "result_format"
    | "content_type"
    | "metadata"
    | "result_input"
    | "preview_input"
    | "cleanup"
    | "problem"
  >
>;

export interface Words {
  readonly unknown: string;
  readonly rejected: string;
  readonly paused: string;
  readonly downloadFailed: string;
  readonly accountChanged: string;
  readonly noResume: string;
}

export interface Kept {
  readonly patch: Patch;
  /** Releases what `keep` stored when the job fails to transition to ready. */
  readonly undo: Effect.Effect<void>;
}

export type DoneTask = Extract<AudioTask, { readonly status: "ready" }>;

export interface JobKind {
  readonly kinds: readonly string[];
  readonly words: Words;
  readonly view: (row: Row) => Effect.Effect<T.MediaJob, ApiError>;
  readonly keep?: (row: Row) => Effect.Effect<Kept, ApiError>;
  /** Runs after download whether `keep` succeeded or failed. */
  readonly kept?: (id: string) => Effect.Effect<void>;
  readonly task?: {
    readonly kind: (row: Row) => AudioTask["kind"];
    readonly done: (row: Row, task: DoneTask) => Effect.Effect<Patch & { readonly phase: "ready" | "downloading" }, ApiError>;
  };
  /** Runs inside the execution slot right after work finishes. */
  readonly ran?: (id: string) => Effect.Effect<void, ApiError>;
  /** Runs inside `lock` before the fiber is interrupted. */
  readonly canceling?: (row: Row) => { readonly patch: Patch; readonly after: Effect.Effect<void, ApiError> };
  /** Runs outside `lock` after the fiber is interrupted. */
  readonly canceled?: (id: string) => Effect.Effect<void, ApiError>;
  /** Phases an interrupted run marks `unknown`; defaults to `["generating"]`. */
  readonly running?: readonly MediaJobPhase[];
  /** Runs on startup before `interruptMediaJobs` rewrites active rows. */
  readonly restarting?: (rows: readonly Row[]) => Effect.Effect<void, ApiError>;
  readonly restarted?: () => Effect.Effect<void, ApiError>;
}

const allKinds = ["image", "understanding", "speech", "speakers", "voiceDesign", "clone", "transcription"] as const;
const anyJob = jobsOf({ kinds: allKinds, phases: mediaJobPhases });
const activePhases: ReadonlySet<string> = new Set<MediaJobPhase>(["authorized", "queued", "uploading", "generating", "downloading"]);
const admitted = 8;

export const makeMachine = Effect.gen(function* () {
  const db = yield* Db;
  const core = yield* Core;
  const provider = yield* Provider;
  const lock = yield* Semaphore.make(1);
  const slots = yield* Semaphore.make(1);
  const cleaning = yield* Semaphore.make(1);
  const fibers = yield* FiberMap.make<string, void, ApiError>();
  const registry = new Map<string, JobKind>();
  const parts = () => [...new Set(registry.values())];

  const missing = () => refused(t("server.media.missing"));
  const corrupt = () => refused(t("server.media.corrupt"));
  const active = (phase: MediaJobPhase) => activePhases.has(phase);
  const read = (id: string) => Effect.map(db.one(q.mediaJob({ id })), (row) => anyJob.one(row));
  const partOf = (row: Row) => {
    const part = registry.get(row.kind);
    return part === undefined ? Effect.fail(missing()) : Effect.succeed(part);
  };
  const found = Effect.fnUntraced(function* (id: string, kinds?: readonly string[]) {
    const row = yield* read(id);
    if (row === undefined || !registry.has(row.kind) || (kinds !== undefined && !kinds.includes(row.kind))) return yield* Effect.fail(missing());
    return row;
  });
  const view = (row: Row) => Effect.flatMap(partOf(row), (part) => part.view(row));
  const list = Effect.fn("Media.list")(function* () {
    const recent = yield* Effect.map(db.run(q.recentMediaJobs()), anyJob.many);
    return yield* Effect.forEach(
      Arr.filter(recent, (row) => registry.has(row.kind)),
      view,
    );
  });
  const publish = Effect.fnUntraced(function* () {
    yield* core.apply({ type: "mediaChanged", jobs: yield* list() });
  });
  const get = Effect.fn("Media.get")(function* (id: string) {
    const row = yield* found(id);
    return yield* view(row);
  });

  /** Caller must hold `lock`. */
  const write = Effect.fnUntraced(function* (row: Row, patch: Patch) {
    yield* db.run(q.changeMediaJob({ ...row, ...patch, now: yield* Clock.currentTimeMillis }));
    yield* publish();
  });
  /** Never writes `result_input` back once `assets_released` is set. */
  const change = Effect.fnUntraced(
    function* (id: string, before: readonly MediaJobPhase[], patch: Patch) {
      const row = yield* found(id);
      if (!before.includes(row.phase) || (row.assets_released !== 0 && patch.result_input !== undefined)) return false;
      yield* write(row, patch);
      return true;
    },
    lock.withPermits(1),
    Effect.uninterruptible,
  );
  const failed = (id: string, outcome: "Rejected" | "Unknown", words: Words, before: readonly MediaJobPhase[] = ["generating"]) =>
    change(id, before, { phase: outcome === "Unknown" ? "unknown" : "failed", problem: outcome === "Unknown" ? words.unknown : words.rejected });

  const capacity = Effect.fnUntraced(function* (): Effect.fn.Return<void, ApiError> {
    if ((yield* db.run(q.activeMediaJobs())).length >= admitted) return yield* Effect.fail(refused(t("server.media.busy")));
  });
  const pending = (kinds: readonly string[]) => Effect.map(db.run(q.activeMediaJobs()), (rows) => Arr.filter(rows, (row) => kinds.includes(row.kind)).length);

  /** Caller must hold `lock`. */
  const admit = Effect.fnUntraced(function* (id: string, kinds: readonly string[], alike: (row: Row) => Effect.Effect<boolean, ApiError>) {
    const row = yield* read(id);
    if (row !== undefined) {
      if (!kinds.includes(row.kind) || !(yield* alike(row))) return yield* Effect.fail(refused(t("server.media.reusedId")));
      return Option.some(row);
    }
    yield* capacity();
    return Option.none<Row>();
  });

  const run = Effect.fnUntraced(function* (id: string, work: Effect.Effect<void, ApiError>) {
    const part = yield* Effect.flatMap(found(id), partOf);
    const after = part.ran;
    yield* FiberMap.run(
      fibers,
      id,
      slots
        .withPermits(1)(after === undefined ? work : Effect.andThen(work, after(id)))
        .pipe(
          Effect.onError(() =>
            change(id, part.running ?? ["generating"], { phase: "unknown", problem: part.words.unknown }).pipe(bestEffort(`media: job ${id} cut short`)),
          ),
        ),
    );
  });

  const download = Effect.fnUntraced(function* (id: string) {
    const row = yield* found(id);
    if (row.phase !== "downloading" || row.result_url === null) return;
    const part = yield* partOf(row);
    const keep = part.keep;
    if (keep === undefined) return yield* Effect.fail(corrupt());
    yield* Effect.uninterruptibleMask((resume) =>
      Effect.gen(function* () {
        const kept = yield* resume(keep(row));
        const taken = yield* change(id, ["downloading"], { ...kept.patch, phase: "ready", result_url: null, problem: "" }).pipe(
          Effect.onError(() => kept.undo),
        );
        if (!taken) yield* kept.undo;
      }),
    ).pipe(
      Effect.catch(() => change(id, ["downloading"], { phase: "download_failed", problem: part.words.downloadFailed })),
      Effect.asVoid,
    );
    if (part.kept !== undefined) yield* part.kept(id);
  });

  const accountOf = Effect.fnUntraced(function* (row: Row, words: Words): Effect.fn.Return<Account, ApiError> {
    const account = yield* provider.account({ connection: row.connection, model: row.model });
    if (account.fingerprint !== row.fingerprint) return yield* Effect.fail(refused(words.accountChanged));
    return { ...account, revision: row.revision };
  });

  const poll = Effect.fnUntraced(function* (id: string) {
    const part = yield* Effect.flatMap(found(id), partOf);
    const task = part.task;
    if (task === undefined) return yield* Effect.fail(corrupt());
    const once = Effect.gen(function* () {
      const row = yield* found(id);
      if (row.phase !== "generating" || row.remote_task === null) return true;
      const remote = row.remote_task;
      const answer = yield* Effect.flatMap(accountOf(row, part.words), (account) => account.tasks.get(remote)).pipe(
        Effect.retry({ times: 3, schedule: Schedule.exponential("1 second"), while: (error) => error._tag === "AudioFailure" && error.retryable }),
      );
      if (answer.kind !== task.kind(row)) return yield* Effect.fail(corrupt());
      if (answer.status !== "ready") {
        if (answer.status !== "failed") return false;
        yield* change(id, ["generating"], { phase: "failed", problem: part.words.rejected });
        return true;
      }
      const next = yield* task.done(row, answer);
      if ((yield* change(id, ["generating"], { ...next, problem: "" })) && next.phase === "downloading") yield* download(id);
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
      Effect.catch(() => change(id, ["generating"], { phase: "unknown", problem: part.words.paused })),
    );
    yield* change(id, ["generating"], { phase: "unknown", problem: part.words.paused });
  });

  /** Only `create` is interruptible, so a returned `remote_task` is persisted before cancel can interrupt. */
  const follow = Effect.fnUntraced(function* (id: string, create: Effect.Effect<string, AudioFailure | ApiError>) {
    yield* Effect.uninterruptibleMask((resume) =>
      resume(create).pipe(Effect.flatMap((task) => change(id, ["generating", "canceled", "unknown"], { remote_task: task }))),
    );
    yield* poll(id);
  });

  const cancel = Effect.fn("Media.cancel")(function* (id: string) {
    const { fiber, part } = yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const row = yield* found(id);
        const part = yield* partOf(row);
        if (!active(row.phase)) return { fiber: Option.none<Fiber.Fiber<void, ApiError>>(), part };
        const more = part.canceling?.(row);
        yield* write(row, { ...more?.patch, phase: "canceled", problem: t("server.media.canceled") });
        if (more !== undefined) yield* more.after;
        return { fiber: FiberMap.getUnsafe(fibers, id), part };
      }),
    );
    if (Option.isSome(fiber)) yield* Fiber.interrupt(fiber.value);
    if (part.canceled !== undefined) yield* part.canceled(id);
    return yield* get(id);
  }, Effect.uninterruptible);

  const retryDownload = Effect.fn("Media.retryDownload")(function* (id: string) {
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const row = yield* found(id);
        if (row.phase === "ready" || row.phase === "downloading") return yield* view(row);
        if (row.assets_released !== 0 || row.result_url === null || (row.phase !== "download_failed" && row.phase !== "canceled"))
          return yield* Effect.fail(refused(t("server.media.noDownload")));
        yield* capacity();
        yield* write(row, { phase: "downloading", problem: "" });
        yield* run(id, download(id));
        return yield* get(id);
      }).pipe(Effect.uninterruptible),
    );
  });

  const resume = Effect.fn("Media.resume")(function* (id: string, kinds: readonly string[]) {
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const row = yield* found(id, kinds);
        const part = yield* partOf(row);
        if (row.phase === "ready" || active(row.phase)) return yield* part.view(row);
        const job = yield* part.view(row);
        if (!("canResume" in job) || !job.canResume) return yield* Effect.fail(refused(part.words.noResume));
        yield* accountOf(row, part.words);
        yield* capacity();
        yield* write(row, { phase: "generating", problem: "" });
        yield* run(id, poll(id));
        return yield* get(id);
      }).pipe(Effect.uninterruptible),
    );
  });

  /** Must run before `pickUp` on startup. */
  const interrupt = Effect.fn("Media.interrupt")(function* () {
    const before = yield* Effect.map(db.run(q.activeMediaJobs()), anyJob.many);
    yield* Effect.forEach(
      parts(),
      (part) => (part.restarting === undefined ? Effect.void : part.restarting(Arr.filter(before, (row) => part.kinds.includes(row.kind)))),
      { discard: true },
    );
    yield* db.run(q.interruptMediaJobs({ problem: t("server.media.restarted"), now: yield* Clock.currentTimeMillis }));
  });
  const pickUp = Effect.fn("Media.pickUp")(function* () {
    yield* publish();
    const pendingRows = yield* Effect.map(db.run(q.activeMediaJobs()), anyJob.many);
    yield* Effect.forEach(
      pendingRows,
      (row) =>
        Effect.gen(function* () {
          const part = registry.get(row.kind);
          if (part === undefined) return;
          if (row.phase === "downloading") yield* run(row.id, download(row.id));
          else if (row.phase === "generating" && row.remote_task !== null)
            yield* accountOf(row, part.words).pipe(
              Effect.andThen(run(row.id, poll(row.id))),
              Effect.catch(() => change(row.id, ["generating"], { phase: "unknown", problem: part.words.accountChanged })),
            );
        }),
      { discard: true },
    );
    yield* Effect.forEach(parts(), (part) => (part.restarted === undefined ? Effect.void : part.restarted()), { discard: true });
  });

  return {
    lock,
    cleaning,
    register: (part: JobKind) => {
      for (const kind of part.kinds) registry.set(kind, part);
    },
    read,
    found,
    get,
    list,
    publish,
    write,
    change,
    failed,
    capacity,
    pending,
    admit,
    active,
    run,
    download,
    follow,
    cancel,
    retryDownload,
    resume,
    interrupt,
    pickUp,
    running: (id: string) => Option.isSome(FiberMap.getUnsafe(fibers, id)),
    stop: (id: string) => FiberMap.remove(fibers, id),
  };
});

export type Machine = Effect.Success<typeof makeMachine>;
