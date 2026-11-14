import { exponential, retry, Semaphore, type Task, TaskGroup } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { BizCode, refuseIn } from "#/base/errors.ts";
import type { Core } from "#/core/core.ts";
import type { Db } from "#/infra/db.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Account, Provider } from "#/platform/provider/provider.ts";
import { AudioFailure, type AudioTask } from "#/platform/provider/vendors.ts";
import * as q from "#db/media_job.sql.ts";

import { jobsOf, type MediaJobPhase, mediaJobPhases, type Row } from "./job.ts";

const refused = refuseIn(BizCode.MediaRefused);

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
  readonly undo: () => Promise<void>;
}

export type DoneTask = Extract<AudioTask, { readonly status: "ready" }>;

export interface JobKind {
  readonly kinds: readonly string[];
  readonly words: Words;
  readonly view: (row: Row) => Promise<T.MediaJob>;
  /** Interrupted by the signal (a cancel, the server closing); the result is then not taken. */
  readonly keep?: (row: Row, signal: AbortSignal) => Promise<Kept>;
  /** Runs after download whether `keep` succeeded or failed. */
  readonly kept?: (id: string) => Promise<void>;
  readonly task?: {
    readonly kind: (row: Row) => AudioTask["kind"];
    readonly done: (row: Row, task: DoneTask) => Promise<Patch & { readonly phase: "ready" | "downloading" }>;
  };
  /** Runs inside the execution slot right after work finishes. */
  readonly ran?: (id: string) => Promise<void>;
  /** Runs inside `lock` before the job's task is stopped. */
  readonly canceling?: (row: Row) => { readonly patch: Patch; readonly after: () => Promise<void> };
  /** Runs outside `lock` after the job's task is stopped. */
  readonly canceled?: (id: string) => Promise<void>;
  /** Phases a stopped or failed run marks `unknown`; defaults to `["generating"]`. */
  readonly running?: readonly MediaJobPhase[];
  /** Runs on startup before `interruptMediaJobs` rewrites active rows. */
  readonly restarting?: (rows: readonly Row[]) => Promise<void>;
  readonly restarted?: () => Promise<void>;
}

const allKinds = ["image", "understanding", "speech", "speakers", "voiceDesign", "clone", "transcription"] as const;
const anyJob = jobsOf({ kinds: allKinds, phases: mediaJobPhases });
const activePhases: ReadonlySet<string> = new Set<MediaJobPhase>(["authorized", "queued", "uploading", "generating", "downloading"]);
const admitted = 8;
const pollMs = 3_000;
const pollTimes = 600;

export interface MachineDeps {
  readonly db: Db;
  readonly core: Core;
  readonly provider: Provider;
  readonly clock: Time;
  readonly log: Logger;
}

/** One job's work, given the signal that stops it (a cancel, a newer run of the same job, the server closing). */
export type Work = (signal: AbortSignal) => Promise<void>;

export function makeMachine(deps: MachineDeps) {
  const { db, core, provider, clock } = deps;
  const log = deps.log.child("media");
  const lock = new Semaphore(1);
  const slots = new Semaphore(1);
  const cleaning = new Semaphore(1);
  // One task per job id: a new run of the same job stops the one before it.
  const tasks = new TaskGroup({ name: "media", onError: (task, e) => log.warn(`media: ${task} failed`, e) });
  /** The task running each job now: a cancel takes the one it saw under the lock, never a retry started after it. */
  const runs = new Map<string, Task<unknown>>();
  const registry = new Map<string, JobKind>();
  const parts = () => [...new Set(registry.values())];

  const missing = () => refused(t("server.media.missing"));
  const corrupt = () => refused(t("server.media.corrupt"));
  const active = (phase: MediaJobPhase) => activePhases.has(phase);
  const read = async (id: string) => anyJob.one(await q.mediaJob(db.sql, { id }));
  const partOf = (row: Row) => {
    const part = registry.get(row.kind);
    if (part === undefined) throw missing();
    return part;
  };
  const found = async (id: string, kinds?: readonly string[]) => {
    const row = await read(id);
    if (row === undefined || !registry.has(row.kind) || (kinds !== undefined && !kinds.includes(row.kind))) throw missing();
    return row;
  };
  const view = (row: Row) => partOf(row).view(row);
  const list = async () => {
    const recent = anyJob.many(await q.recentMediaJobs(db.sql));
    const out: T.MediaJob[] = [];
    for (const row of recent) if (registry.has(row.kind)) out.push(await view(row));
    return out;
  };
  const publish = async () => {
    core.apply({ type: "mediaChanged", jobs: await list() });
  };
  const get = async (id: string) => view(await found(id));

  /** Caller must hold `lock`. */
  const write = async (row: Row, patch: Patch) => {
    await q.changeMediaJob(db.sql, { ...row, ...patch, now: clock.now() });
    await publish();
  };
  /** Never writes `result_input` back once `assets_released` is set. Takes no signal: a change once begun is written. */
  const change = (id: string, before: readonly MediaJobPhase[], patch: Patch) =>
    lock.with(async () => {
      const row = await found(id);
      if (!before.includes(row.phase) || (row.assets_released !== 0 && patch.result_input !== undefined)) return false;
      await write(row, patch);
      return true;
    });
  const failed = (id: string, outcome: "Rejected" | "Unknown", words: Words, before: readonly MediaJobPhase[] = ["generating"]) =>
    change(id, before, { phase: outcome === "Unknown" ? "unknown" : "failed", problem: outcome === "Unknown" ? words.unknown : words.rejected });

  const capacity = async (): Promise<void> => {
    if ((await q.activeMediaJobs(db.sql)).length >= admitted) throw refused(t("server.media.busy"));
  };
  const pending = async (kinds: readonly string[]) => (await q.activeMediaJobs(db.sql)).filter((row) => kinds.includes(row.kind)).length;

  /** Caller must hold `lock`. The job already under id, when it is the same request; undefined when there is room for a new one. */
  const admit = async (id: string, kinds: readonly string[], alike: (row: Row) => Promise<boolean>): Promise<Row | undefined> => {
    const row = await read(id);
    if (row !== undefined) {
      if (!kinds.includes(row.kind) || !(await alike(row))) throw refused(t("server.media.reusedId"));
      return row;
    }
    await capacity();
    return undefined;
  };

  /** work in the background, one job at a time: however it ends short (failed, stopped), a job still running is marked unknown. */
  const run = async (id: string, work: Work) => {
    const part = partOf(await found(id));
    const after = part.ran;
    const task = tasks.keyed(id, async (signal) => {
      try {
        await slots.with(
          async () => {
            await work(signal);
            if (after !== undefined) await after(id);
          },
          1,
          signal,
        );
      } catch (e) {
        if (!signal.aborted) log.warn(`media: job ${id} failed`, e);
        await bestEffort(log, `media: job ${id} cut short`, () =>
          change(id, part.running ?? ["generating"], { phase: "unknown", problem: part.words.unknown }),
        );
      }
    });
    runs.set(id, task);
    void task.done.then(() => {
      if (runs.get(id) === task) runs.delete(id);
    });
  };

  const download = async (id: string, signal: AbortSignal) => {
    const row = await found(id);
    if (row.phase !== "downloading" || row.result_url === null) return;
    const part = partOf(row);
    const keep = part.keep;
    if (keep === undefined) throw corrupt();
    try {
      // Only the keeping is stopped by the signal: once it has kept the result, taking it into the row (or undoing it) is not.
      const kept = await keep(row, signal);
      let taken: boolean;
      try {
        taken = await change(id, ["downloading"], { ...kept.patch, phase: "ready", result_url: null, problem: "" });
      } catch (e) {
        await kept.undo();
        throw e;
      }
      if (!taken) await kept.undo();
    } catch (e) {
      if (signal.aborted) throw e;
      log.warn(`media: job ${id} download failed`, e);
      await change(id, ["downloading"], { phase: "download_failed", problem: part.words.downloadFailed });
    }
    if (part.kept !== undefined) await part.kept(id);
  };

  const accountOf = async (row: Row, words: Words): Promise<Account> => {
    const account = await provider.account({ connection: row.connection, model: row.model });
    if (account.fingerprint !== row.fingerprint) throw refused(words.accountChanged);
    return { ...account, revision: row.revision };
  };

  const poll = async (id: string, signal: AbortSignal) => {
    const part = partOf(await found(id));
    const task = part.task;
    if (task === undefined) throw corrupt();
    /** Whether the job is done being polled. */
    const once = async () => {
      const row = await found(id);
      if (row.phase !== "generating" || row.remote_task === null) return true;
      const remote = row.remote_task;
      const answer = await retry(async () => (await accountOf(row, part.words)).tasks.get(remote, signal), {
        retries: 3,
        delay: exponential(1_000),
        when: (error) => error instanceof AudioFailure && error.retryable,
        clock,
        signal,
      });
      if (answer.kind !== task.kind(row)) throw corrupt();
      if (answer.status !== "ready") {
        if (answer.status !== "failed") return false;
        await change(id, ["generating"], { phase: "failed", problem: part.words.rejected });
        return true;
      }
      const next = await task.done(row, answer);
      if ((await change(id, ["generating"], { ...next, problem: "" })) && next.phase === "downloading") await download(id, signal);
      return true;
    };
    try {
      for (let n = 0; !(await once()) && n < pollTimes; n++) await clock.sleep(pollMs, signal);
    } catch (e) {
      if (signal.aborted) throw e;
      log.warn(`media: job ${id} could not be polled`, e);
      await change(id, ["generating"], { phase: "unknown", problem: part.words.paused });
    }
    await change(id, ["generating"], { phase: "unknown", problem: part.words.paused });
  };

  /** Only `create` is stopped by the signal, so a returned `remote_task` is kept before a cancel can stop the job. */
  const follow = async (id: string, create: (signal: AbortSignal) => Promise<string>, signal: AbortSignal) => {
    const task = await create(signal);
    await change(id, ["generating", "canceled", "unknown"], { remote_task: task });
    await poll(id, signal);
  };

  // Not stopped by the caller: a cancel once begun is written, and the job's task is stopped.
  const cancel = async (id: string) => {
    const { live, part } = await lock.with(async () => {
      const row = await found(id);
      const part = partOf(row);
      if (!active(row.phase)) return { live: undefined, part };
      const more = part.canceling?.(row);
      await write(row, { ...more?.patch, phase: "canceled", problem: t("server.media.canceled") });
      if (more !== undefined) await more.after();
      return { live: runs.get(id), part };
    });
    // Outside the lock: the stopped task marks itself under it.
    if (live !== undefined) await live.abort();
    if (part.canceled !== undefined) await part.canceled(id);
    return get(id);
  };

  const retryDownload = (id: string) =>
    lock.with(async () => {
      const row = await found(id);
      if (row.phase === "ready" || row.phase === "downloading") return view(row);
      if (row.assets_released !== 0 || row.result_url === null || (row.phase !== "download_failed" && row.phase !== "canceled"))
        throw refused(t("server.media.noDownload"));
      await capacity();
      await write(row, { phase: "downloading", problem: "" });
      await run(id, (signal) => download(id, signal));
      return get(id);
    });

  const resume = (id: string, kinds: readonly string[]) =>
    lock.with(async () => {
      const row = await found(id, kinds);
      const part = partOf(row);
      if (row.phase === "ready" || active(row.phase)) return part.view(row);
      const job = await part.view(row);
      if (!("canResume" in job) || !job.canResume) throw refused(part.words.noResume);
      await accountOf(row, part.words);
      await capacity();
      await write(row, { phase: "generating", problem: "" });
      await run(id, (signal) => poll(id, signal));
      return get(id);
    });

  /** Must run before `pickUp` on startup. */
  const interrupt = async () => {
    const before = anyJob.many(await q.activeMediaJobs(db.sql));
    for (const part of parts()) if (part.restarting !== undefined) await part.restarting(before.filter((row) => part.kinds.includes(row.kind)));
    await q.interruptMediaJobs(db.sql, { problem: t("server.media.restarted"), now: clock.now() });
  };
  const pickUp = async () => {
    await publish();
    const pendingRows = anyJob.many(await q.activeMediaJobs(db.sql));
    for (const row of pendingRows) {
      const part = registry.get(row.kind);
      if (part === undefined) continue;
      if (row.phase === "downloading") await run(row.id, (signal) => download(row.id, signal));
      else if (row.phase === "generating" && row.remote_task !== null) {
        try {
          await accountOf(row, part.words);
          await run(row.id, (signal) => poll(row.id, signal));
        } catch (e) {
          log.warn(`media: job ${row.id} not picked up`, e);
          await change(row.id, ["generating"], { phase: "unknown", problem: part.words.accountChanged });
        }
      }
    }
    for (const part of parts()) if (part.restarted !== undefined) await part.restarted();
  };

  return {
    lock,
    cleaning,
    log,
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
    running: (id: string) => runs.has(id),
    stop: async (id: string) => {
      await runs.get(id)?.abort();
    },
    /** Stops every job's task; each marks itself as its run says. */
    close: () => tasks.close(),
  };
}

export type Machine = ReturnType<typeof makeMachine>;
