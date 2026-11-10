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

/** What a job's run changes, column by column. */
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

/** A kind's words for how its jobs end. */
export interface Words {
  /** The vendor was asked and may or may not have done it. */
  readonly unknown: string;
  readonly rejected: string;
  /** Asking after a vendor task stopped before it finished. */
  readonly paused: string;
  readonly downloadFailed: string;
  readonly accountChanged: string;
  readonly noResume: string;
}

/** What the vendor made, kept: the columns that make the job ready, and how to let it go when the job does not take it. */
export interface Kept {
  readonly patch: Patch;
  readonly undo: Effect.Effect<void>;
}

/** A finished vendor task's answer. */
export type DoneTask = Extract<AudioTask, { readonly status: "ready" }>;

/** One kind's part: only what the machine does not do the same way for every kind. */
export interface JobKind {
  /** The media_job kinds it is. */
  readonly kinds: readonly string[];
  readonly words: Words;
  readonly view: (row: Row) => Effect.Effect<T.MediaJob, ApiError>;
  /** Fetches and keeps what the vendor made at the job's result_url. */
  readonly keep?: (row: Row) => Effect.Effect<Kept, ApiError>;
  /** After a download, kept or not (an image goes back to the channel that asked for it). */
  readonly kept?: (id: string) => Effect.Effect<void>;
  /** A vendor task this kind follows: which kind of task it is, and what a finished one makes of the job (ready, or
   * downloading what it made). */
  readonly task?: {
    readonly kind: (row: Row) => AudioTask["kind"];
    readonly done: (row: Row, task: DoneTask) => Effect.Effect<Patch & { readonly phase: "ready" | "downloading" }, ApiError>;
  };
  /** After each run, still in its slot (audio lets go of what it uploaded). */
  readonly ran?: (id: string) => Effect.Effect<void, ApiError>;
  /** Cancelling, inside the lock: more to write, and what to do once written. */
  readonly canceling?: (row: Row) => { readonly patch: Patch; readonly after: Effect.Effect<void, ApiError> };
  /** Once cancelled and its run stopped. */
  readonly canceled?: (id: string) => Effect.Effect<void, ApiError>;
  /** The phases a run cut short leaves unknown; generating when not given. */
  readonly running?: readonly MediaJobPhase[];
  /** On a restart, before the jobs are interrupted: its active jobs as they were. */
  readonly restarting?: (rows: readonly Row[]) => Effect.Effect<void, ApiError>;
  /** On a restart, once the machine has picked its jobs up again. */
  readonly restarted?: () => Effect.Effect<void, ApiError>;
}

const allKinds = ["image", "understanding", "speech", "speakers", "voiceDesign", "clone", "transcription"] as const;
const anyJob = jobsOf({ kinds: allKinds, phases: mediaJobPhases });
const activePhases: ReadonlySet<string> = new Set<MediaJobPhase>(["authorized", "queued", "uploading", "generating", "downloading"]);
/** At most this many jobs wait, run or clean up at once. */
const admitted = 8;

/** The one job machine every media kind runs on: admission, the lock, one slot at a time, a run cut short, downloading
 * what the vendor made, following a vendor task, cancel, retry, resume and a restart. Kinds register what differs. */
export const makeMachine = Effect.gen(function* () {
  const db = yield* Db;
  const core = yield* Core;
  const provider = yield* Provider;
  /** Every change to a job is made under it. */
  const lock = yield* Semaphore.make(1);
  /** Runs take turns: one vendor call at a time. */
  const slots = yield* Semaphore.make(1);
  /** Vendor-side cleanups take turns. */
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

  /** Writes the job as it is plus the patch; the caller holds the lock. */
  const write = Effect.fnUntraced(function* (row: Row, patch: Patch) {
    yield* db.run(q.changeMediaJob({ ...row, ...patch, now: yield* Clock.currentTimeMillis }));
    yield* publish();
  });
  /** The job moves on only from one of the phases it is expected in; a result kept as an input is never written back
   * once its assets were released. */
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
  /** How a vendor's answer that it refused (or may not have done) ends the job. */
  const failed = (id: string, outcome: "Rejected" | "Unknown", words: Words, before: readonly MediaJobPhase[] = ["generating"]) =>
    change(id, before, { phase: outcome === "Unknown" ? "unknown" : "failed", problem: outcome === "Unknown" ? words.unknown : words.rejected });

  const capacity = Effect.fnUntraced(function* (): Effect.fn.Return<void, ApiError> {
    if ((yield* db.run(q.activeMediaJobs())).length >= admitted) return yield* Effect.fail(refused(t("server.media.busy")));
  });
  const pending = (kinds: readonly string[]) => Effect.map(db.run(q.activeMediaJobs()), (rows) => Arr.filter(rows, (row) => kinds.includes(row.kind)).length);

  /** A create's first step, under the lock: the same id asked the same way is that job; asked differently, or another
   * kind's, is refused; a new one needs room. */
  const admit = Effect.fnUntraced(function* (id: string, kinds: readonly string[], alike: (row: Row) => Effect.Effect<boolean, ApiError>) {
    const row = yield* read(id);
    if (row !== undefined) {
      if (!kinds.includes(row.kind) || !(yield* alike(row))) return yield* Effect.fail(refused(t("server.media.reusedId")));
      return Option.some(row);
    }
    yield* capacity();
    return Option.none<Row>();
  });

  /** The job's run, in a slot, owned by the machine: a run that dies leaves the job unknown. */
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

  /** Keeps what the vendor made; the job is ready only once it is kept, and what is kept goes again when the job does not take it. */
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

  /** The account the job was asked with: another key behind the same connection is refused. */
  const accountOf = Effect.fnUntraced(function* (row: Row, words: Words): Effect.fn.Return<Account, ApiError> {
    const account = yield* provider.account({ connection: row.connection, model: row.model });
    if (account.fingerprint !== row.fingerprint) return yield* Effect.fail(refused(words.accountChanged));
    return { ...account, revision: row.revision };
  });

  /** Polls the vendor task every few seconds until it ends, for at most half an hour; then the job is paused. */
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

  /** Requests a vendor task, then polls it. Only the request is interruptible: a task id it returns is written before
   * a cancel or a poll can come between. */
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

  /** Polls again a vendor task the job had when it was cancelled or lost track of it, with the same key. */
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

  /** A restart, first half: what was running when the server stopped is told apart (media_job.sql's InterruptMediaJobs). */
  const interrupt = Effect.fn("Media.interrupt")(function* () {
    const before = yield* Effect.map(db.run(q.activeMediaJobs()), anyJob.many);
    yield* Effect.forEach(
      parts(),
      (part) => (part.restarting === undefined ? Effect.void : part.restarting(Arr.filter(before, (row) => part.kinds.includes(row.kind)))),
      { discard: true },
    );
    yield* db.run(q.interruptMediaJobs({ problem: t("server.media.restarted"), now: yield* Clock.currentTimeMillis }));
  });
  /** A restart, second half: downloads start again and followed tasks are asked after again, with the same key. */
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
    /** Whether a run of the job is going now. */
    running: (id: string) => Option.isSome(FiberMap.getUnsafe(fibers, id)),
    /** Stops the job's run, if any. */
    stop: (id: string) => FiberMap.remove(fibers, id),
  };
});

export type Machine = Effect.Success<typeof makeMachine>;
