import { readFile, realpath, stat } from "node:fs/promises";

import { Semaphore, type Subscription, TaskGroup, throwIfAborted } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { dayMs, maxRunning } from "@vibevalley/protocol";
import { isBusy } from "@vibevalley/protocol/rules";
import { sessionId } from "@vibevalley/protocol/schema";

import { worker as sessionActor } from "#/base/actor.ts";
import { BizCode, errnoOf, messageOf, refuseIn } from "#/base/errors.ts";
import { jsonText } from "#/base/json.ts";
import type { Core } from "#/core/core.ts";
import type { ServerConfig } from "#/infra/config.ts";
import { causeMessage, type Db, SqlError } from "#/infra/db.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Agent } from "#/modules/agent/agent.ts";
import type { Memory } from "#/modules/memory/memory.ts";
import type { Repo } from "#/modules/repo/repo.ts";
import { type Merged, type Workplace, type WorkplaceCleanup, type WorkplaceRelease } from "#/modules/repo/workplace.ts";
import type { Runtime } from "#/modules/runtime/runtime.ts";
import { goOn, helperKey, vibevalleyRuntime } from "#/modules/runtime/vibevalley.ts";
import * as qs from "#db/session.sql.ts";
import * as qr from "#db/session_run.sql.ts";

import { sessionName, type Settle, whoMakesRoom, withRecall } from "./briefing.ts";
import { handStack } from "./hands.ts";
import { endedSession, heardOf, pendingReportOf, placeOf, restoredSession, runOf, sessionState } from "./history.ts";
import { type AgentHost, type HostOptions, makeHost } from "./host.ts";
import { NotRecorded } from "./inProcessRun.ts";
import { makeLaunch, NotTakenIn, reasonText } from "./launch.ts";
import type { Machine } from "./machine.ts";
import { sourceBrief } from "./prompts.ts";
import { type Hand, makeRegistry, type RunStore } from "./registry.ts";
import { handsToUser } from "./report.ts";
import { isHired, isOnDuty } from "./roster.ts";
import type { Trigger } from "./shapes.ts";
import { contextPlace, releaseContextPlace } from "./shell.ts";
import { type Delivered, type DeliveryInput, DeliveryRefused, type RunFinished, type SessionNews } from "./signals.ts";
import { makeWatch } from "./watch.ts";
import { type WorkerAccess, workerAccess } from "./worker.ts";

export type { SessionNews };
export type { RunFinished, RunStore };
export { DeliveryRefused, NotRecorded, NotTakenIn };
export { runOf } from "./history.ts";

const endedListed = 200;
const refused = refuseIn(BizCode.SessionRefused);

/** A helper not hired; retainedWork when a workplace or execution stays behind with the issue. */
export class HireRefused extends Error {
  override readonly name = "HireRefused";
  readonly reason: string;
  readonly retainedWork?: boolean;
  constructor(reason: string, retainedWork?: boolean, options?: ErrorOptions) {
    super(reason, options);
    this.reason = reason;
    if (retainedWork !== undefined) this.retainedWork = retainedWork;
  }
}

const hireRefused = (reason: string, retainedWork: boolean) => (retainedWork ? new HireRefused(reason, true) : new HireRefused(reason));

export type NotWorkFileReason = "noPlace" | "notFile" | "outside" | "tooBig" | "unreadable";

/** A file asked of a session's working directory that is not one it may hand out. */
export class NotWorkFile extends Error {
  override readonly name = "NotWorkFile";
  readonly reason: NotWorkFileReason;
  constructor(reason: NotWorkFileReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface Hired {
  readonly session: T.Session;
  readonly evicted?: string;
}

export interface HireOptions {
  readonly inputs?: readonly Trigger[];
  /** Base branch to fork from; "" uses the repo's main branch. */
  readonly base?: string;
  readonly worktree?: boolean;
  readonly channel?: string;
  readonly issue?: string;
  readonly trigger?: T.RunTrigger;
  readonly refining?: boolean;
  /** Runs after the session row is written, before any report or hired fact is visible; throws NotRecorded when it cannot be kept. */
  readonly hiring?: (s: T.Session, launch: string) => Promise<void>;
}

interface SendOptions extends Omit<HireOptions, "issue"> {
  readonly envelopeIds?: readonly string[];
  readonly context:
    | { readonly kind: "issue"; readonly issue: Pick<T.Issue, "id" | "number"> & { readonly mandate?: T.IssueMandate } }
    | { readonly kind: "channel"; readonly channel: string };
}

export interface Lifecycle {
  readonly noRoom: (runtime: string, repo: string) => string;
  /** Evicts the longest-idle session when at capacity; throws `HireRefused` when runtime or repo limits block admission. */
  readonly makeRoom: (runtime: string, repo: string) => Promise<{ readonly evicted?: string }>;
  /** Throws HireRefused. The signal stops the hire until it is committed: what it opened is closed again. */
  readonly hire: (agent: T.Agent, brief: string, where: string, opt: SendOptions, signal?: AbortSignal) => Promise<{ readonly session: T.Session }>;
  /** Throws DeliveryRefused. */
  readonly deliver: (id: string, text: string, input: DeliveryInput) => Promise<Delivered>;
  readonly stop: (id: string) => Promise<boolean>;
  /** Closes an idle execution while preserving native session continuity for the next input. */
  readonly suspend: (id: string, signal?: AbortSignal) => Promise<boolean>;
  readonly withIdleWorkplace: <A>(id: string, use: (place: Workplace) => Promise<A>) => Promise<A>;
  readonly withWorkplace: <A>(id: string, use: (place: Workplace) => Promise<A>) => Promise<A>;
  /** `work: "discard"` resets the branch only after the runtime stops writing. */
  readonly dismiss: (id: string, work?: "keep" | "discard", closed?: "dismissed" | "completed") => Promise<boolean>;
  /** Resets a read-only turn's worktree back to main while keeping the session open. */
  readonly discardWork: (id: string) => Promise<void>;
  readonly clearWorkplace: (issue: string, repo: string, number: number, work?: WorkplaceCleanup) => Promise<WorkplaceRelease>;
  readonly sessionOf: (id: string) => T.Session | undefined;
  readonly hired: () => readonly T.Session[];
  /** True when this process holds the session's `Hand` (including between launches). */
  readonly isReachable: (id: string) => boolean;
  readonly lastTextOf: (id: string) => string;
  readonly cwdOf: (id: string) => string | undefined;
  /** Rejects `..` segments and symlinks escaping the session's working directory; throws NotWorkFile. */
  readonly workFile: (id: string, path: string, max: number) => Promise<{ readonly name: string; readonly bytes: Uint8Array }>;
  readonly runOf: (id: string) => string | undefined;
  readonly report: (id: string, report: T.IssueReport) => Promise<void>;
  /** Throws NotTakenIn when use fails (the session stays), ApiError when the session cannot hand over now. */
  readonly handOver: (id: string, closed: T.SessionClose, use: (place: Workplace, lastText: string) => Promise<Merged>, settle?: Settle) => Promise<Merged>;
  /** Pass `""` for all agents. */
  readonly list: (agent: string) => Promise<T.Session[]>;
  readonly get: (id: string) => Promise<T.Session | undefined>;
  readonly issueRuns: (issue: string) => Promise<T.Run[]>;
  readonly events: (id: string, run?: string) => Promise<T.SessionEvent[] | undefined>;
  /** Everything Session tells, subscribed before it returns: nothing told after is missed. */
  readonly news: () => Subscription<SessionNews>;
  /** Session id owning `token`, or `""` when unrecognized. */
  readonly who: (token: string) => string;
  readonly setAddress: (address: string) => void;
  /** An in-process agent's host; the caller owns it and closes it (`await using`). Throws NotRecorded. */
  readonly host: <R>(options: HostOptions<R>) => Promise<AgentHost<R>>;
  /** Brings back the sessions a restart left: their hands, their interrupted runs. */
  readonly restore: () => Promise<void>;
  /** At startup, after the modules below it started: restore. */
  readonly boot: () => Promise<void>;
  /** Saves what a restart needs, lets every hand go and removes the helpers' credentials. */
  readonly close: () => Promise<void>;
}

export interface LifecycleDeps {
  readonly config: ServerConfig;
  readonly clock: Time;
  readonly log: Logger;
  readonly db: Db;
  readonly core: Core;
  readonly agent: Agent;
  readonly memory: Memory;
  readonly repo: Repo;
  readonly machine: Machine;
  readonly runtime: Runtime;
}

export interface SessionOptions {
  /** How helpers reach the worker CLI; a test gives its own. */
  readonly workerAccess?: () => Promise<WorkerAccess>;
}

/** Whether a session's place is still on disk to go back to. */
const placeThere = (cwd: string, log: Logger) =>
  stat(cwd).then(
    () => true,
    (e: unknown) => {
      if (errnoOf(e) !== "ENOENT") log.warn(`vibevalley: ${cwd} cannot be read`, e);
      return false;
    },
  );

export function newsOf(fact: T.Fact, after: T.SpaceState): SessionNews | undefined {
  switch (fact.type) {
    case "sessionChanged": {
      const session = after.sessions.find((h) => h.id === fact.session.id);
      return session !== undefined && isHired(session) ? { _tag: "Hired", session } : undefined;
    }
    case "sessionReported": {
      const session = after.sessions.find((h) => h.id === fact.id);
      return session !== undefined && isHired(session) ? { _tag: "Reported", report: fact, session } : undefined;
    }
    case "sessionLeft":
      return { _tag: "Left", left: fact };
    default:
      return undefined;
  }
}

export async function makeLifecycle(deps: LifecycleDeps, options: SessionOptions = {}): Promise<Lifecycle> {
  const { config, core, db, clock } = deps;
  const log = deps.log.child("session");
  const memories = deps.memory;
  const repos = deps.repo;
  const machines = deps.machine;
  const executor = machines.executions(machines.here());
  const r = await makeRegistry({ ...deps, log });
  const wt = makeWatch(r, { ...deps, log });
  let cli: WorkerAccess | undefined;
  try {
    cli = await (options.workerAccess ?? workerAccess)();
  } catch (e) {
    // No helper starts without it: each hire is refused with workerUnavailable.
    log.warn("vibevalley: the worker CLI's credentials cannot be kept", e);
  }
  const l = makeLaunch(r, wt, cli, { ...deps, log });
  const {
    flushRuns,
    later,
    mcpEndpoint,
    trajectories,
    admission,
    newsHub,
    tell,
    moves,
    roster,
    executions,
    launchOf,
    keepHands,
    register,
    ended,
    forget,
    logOf,
    runs,
    closeExecution,
    runStore,
  } = r;
  const { open, leave, rest, accessWorkplace, capacity, roomFor, remind, deliver, handOver } = l;
  const { closedLaunch, finishReport, attach, failedOpening } = wt;
  const tasks = new TaskGroup({ name: "session news", onError: (task, e) => log.error(`${task} failed`, e) });

  tasks.run("session news", async (signal) => {
    for (let n = await moves.next(signal); n.done !== true; n = await moves.next(signal)) {
      const { fact, after } = n.value;
      const news = newsOf(fact, after);
      if (news?._tag === "Reported" && news.session !== undefined && isHired(news.session) && news.session.issue === undefined) {
        const id = news.session.id;
        const deadline = fact.at + 10 * 60_000;
        later(`idle:${id}`, (abort) =>
          bestEffort(
            log,
            `vibevalley: suspending conversation ${id}`,
            async () => {
              await clock.sleep(Math.max(0, deadline - clock.now()), abort);
              await suspend(id, abort);
            },
            abort,
          ),
        );
      }
      if (news) newsHub.publish(news);
    }
  });
  let hired = 0;

  const expireLogs = async (days: number) => {
    if (days <= 0) return;
    const ids = await qs.sessionsEndedBefore(db.sql, { before: clock.now() - days * dayMs });
    for (const row of ids) await trajectories.forget(row.id);
  };

  const finishInterrupted = (run: string) =>
    bestEffort(log, `vibevalley: run ${run}`, async () => {
      await runs.finish(run, "interrupted", t("server.session.log.restarted"));
      const linked = await runs.issues(run);
      tell({ _tag: "RunFinished", id: run, issues: linked, outcome: "interrupted" });
    });

  /** A helper on VibeValley's own runtime that was answering when the farm stopped is opened again on its conversation,
   * and the turn that goes on is the run it was in; false when it cannot be, and its run is then cut off. */
  const goOnWith = async (h: Hand, session: T.Session, run: string): Promise<boolean> => {
    const agent = deps.agent.agent(session.agent);
    if (!agent) return false;
    h.goesOn = run;
    try {
      const opened = await open(agent, session, h, h.place, goOn, h.oarSessionId);
      if (opened.execution) {
        attach(h, opened.execution, session.runtime);
        return true;
      }
      log.warn(`vibevalley: ${session.id} did not go on with its run: ${opened.refused}`);
    } catch (e) {
      log.warn(`vibevalley: ${session.id} did not go on with its run`, e);
    }
    delete h.goesOn;
    return false;
  };

  const restore = async () => {
    await expireLogs(config.session.trajectoryDays);
    const kept = await qs.activeSessions(db.sql);
    // pi-durable keeps a conversation's run under way across a restart; the other runtimes cannot take a turn up again.
    const goingOn = new Set<string>();
    for (const row of kept)
      if (!isOnDuty(row) && row.runtime === vibevalleyRuntime && row.oar_session && (await deps.runtime.durable.busy(helperKey(row.oar_session))))
        goingOn.add(row.id);
    const openRun = new Map<string, string>();
    for (const row of await qr.openRuns(db.sql)) {
      if (goingOn.has(row.session)) openRun.set(row.session, row.id);
      // Its durable conversation goes on with it: its host ends it once the answer comes.
      else if (!(await deps.runtime.durable.busy(row.session))) await finishInterrupted(row.id);
    }
    // Continue numbering past the highest historical session id so trajectory files are never reused.
    hired = Math.max(
      0,
      (await qs.highestSessionNumber(db.sql))?.n ?? 0,
      ...core
        .state()
        .sessions.map((s) => Number.parseInt(s.id.replace(/^w/u, ""), 10))
        .filter((n) => Number.isFinite(n)),
    );
    for (const row of kept) {
      if (isOnDuty(row)) continue;
      const session = core.session(row.id) ?? restoredSession(row);
      const place = row.place ? placeOf(row.place) : undefined;
      if (!place || !(await placeThere(place.cwd, log))) {
        core.apply({ type: "sessionLeft", id: session.id, closed: "lost" });
        await trajectories.finish(session.id);
        await ended(session.id, "lost");
        core.notice(
          "warn",
          t("server.session.life.notBack", {
            name: session.name,
            why: place ? t("server.session.life.placeGone", { cwd: place.cwd }) : t("server.session.life.noRecord"),
          }),
        );
        continue;
      }
      const s = {
        place,
        oarSessionId: row.oar_session ?? "",
        lastText: row.last_text ?? "",
        recalled: heardOf(row.recalled) ?? [],
        report: pendingReportOf(row.pending_report),
      };
      const stack = handStack();
      const trajectory = await trajectories.openLog(session.id);
      stack.defer(() => trajectories.finish(session.id));
      const journal = await logOf(session, trajectory);
      const hand: Hand = {
        id: session.id,
        stack,
        place: s.place,
        issue: session.issue ?? "",
        access: new Semaphore(1),
        journal,
        oarSessionId: s.oarSessionId,
        lastText: s.lastText,
        tracking: {},
        launch: "",
        spoke: false,
        token: "",
        recalled: new Set(s.recalled),
        triggers: [],
        inputs: new Map(),
        run: "",
        heard: [],
        report: s.report,
      };
      stack.defer(() => l.revokeAccess(hand));
      roster.set(hand);
      const run = openRun.get(session.id);
      if (run !== undefined) {
        if (await goOnWith(hand, session, run)) continue;
        await finishInterrupted(run);
      }
      if (isBusy(session)) {
        core.apply({
          type: "sessionReported",
          id: session.id,
          outcome: "interrupted",
          summary: s.report?.summary ?? t("server.session.log.restarted"),
          runs: session.runs,
          questions: s.report?.questions ?? [],
          checks: s.report?.checks ?? [],
          ...(s.report?.answer ? { answer: s.report.answer } : {}),
        });
        const restoredReport = s.report;
        if (restoredReport && restoredReport.remember.length > 0)
          await bestEffort(log, `vibevalley: ${session.id}'s restored memories were not kept`, async () => {
            for (const memory of restoredReport.remember)
              await memories.write({ agent: session.agent, text: memory.text, repo: memory.scope === "all" ? "" : place.repo, by: sessionActor(session.id) });
          });
        await db.tx(async () => {
          const restored = core.session(session.id);
          if (restored) await qs.keepSessionState(db.sql, sessionState(restored));
          await qs.clearPendingReport(db.sql, { id: session.id });
        });
        core.notice("info", t("server.session.life.restartedNotice", { name: session.name }));
      }
    }
    if (roster.size > 0) log.info(`vibevalley: brought back ${roster.size} helpers`);
  };

  const workFile = async (id: string, path: string, max: number) => {
    const cwd = roster.get(id)?.place.cwd;
    if (cwd === undefined) throw new NotWorkFile("noPlace", path);
    const unreadable = (e: unknown) => new NotWorkFile("unreadable", messageOf(e));
    const root = await realpath(cwd).catch((e: unknown) => {
      throw unreadable(e);
    });
    // Resolve `..` and symlinks via realpath before checking prefix containment.
    const full = await realpath(root + "/" + path).catch(() => {
      throw new NotWorkFile("notFile", path);
    });
    if (full !== root && !full.startsWith(root + "/")) throw new NotWorkFile("outside", path);
    const info = await stat(full).catch((e: unknown) => {
      throw unreadable(e);
    });
    if (!info.isFile()) throw new NotWorkFile("notFile", path);
    if (info.size > max) throw new NotWorkFile("tooBig", path);
    const bytes = await readFile(full).catch((e: unknown) => {
      throw unreadable(e);
    });
    return { name: full.split("/").at(-1) ?? full, bytes };
  };

  const makeRoom = async (runtime: string, repo: string): Promise<{ readonly evicted?: string }> => {
    const full = roomFor(runtime, repo);
    if (full) throw new HireRefused(full);
    const oldest = whoMakesRoom(
      core.state().sessions.filter((s) => executor.find(s.id) !== undefined),
      maxRunning,
    );
    if (!oldest) return {};
    try {
      await (oldest.issue ? dismiss(oldest.id) : suspend(oldest.id));
    } catch (e) {
      throw new HireRefused(messageOf(e), undefined, { cause: e });
    }
    return { evicted: oldest.name };
  };

  const hire = async (agent: T.Agent, brief: string, where: string, opt: SendOptions, signal?: AbortSignal): Promise<{ readonly session: T.Session }> => {
    await admission.take(1, signal);
    let admitted = true;
    const releaseAdmission = () => {
      if (!admitted) return;
      admitted = false;
      admission.release(1);
    };
    try {
      const issue = opt.context.kind === "issue" ? opt.context.issue : undefined;
      const channel = opt.context.kind === "channel" ? opt.context.channel : opt.channel;
      const repo = issue ? where : "";
      const unclosed = executor
        .all()
        .find((a) => (issue ? a.owner.issue === issue.id : !a.owner.issue && a.owner.agent === agent.id && a.owner.channel === channel));
      if (unclosed) throw new HireRefused(unclosed.failure ?? t(issue ? "server.session.life.issueNotReturned" : "server.session.life.notReturned"), true);
      const full = roomFor(agent.runtime, repo);
      if (full) throw new HireRefused(full);
      hired++;
      const id = sessionId(`w${hired}`);
      let place: Workplace;
      try {
        place =
          issue && repo
            ? await repos.checkout({
                _tag: "Open",
                repo,
                issue: issue.number,
                worktree: opt.worktree ?? agent.worktree,
                base: opt.base ?? "",
                ...(signal ? { signal } : {}),
              })
            : await contextPlace(config.workRoot, id);
      } catch (e) {
        throw new HireRefused(t("server.session.life.noPlace", { name: agent.name, why: messageOf(e) }), undefined, { cause: e });
      }
      const releasePlace = () => (place.repo ? repos.checkout({ _tag: "Release", place }) : releaseContextPlace(place));
      // The hand's own cleanups (its log, its credential) close when it leaves; the startup's undo an opening that did
      // not commit. Both run last-deferred first.
      const handScope = handStack();
      const startupScope = handStack();
      const startup: { phase: "opening" | "retained" | "committed"; releaseKept: boolean } = {
        phase: "opening",
        releaseKept: false,
      };
      startupScope.defer(async () => {
        if (startup.phase !== "opening") return;
        const result = await releasePlace();
        if (!result.kept) return;
        startup.releaseKept = true;
        core.notice("warn", result.reason);
      });
      try {
        const recalled = new Set<string>();
        const journal = await trajectories.openLog(id);
        handScope.defer(() => trajectories.finish(id));
        const initial = opt.inputs ?? [];
        const h: Hand = {
          id,
          stack: handScope,
          place,
          issue: issue?.id ?? "",
          access: new Semaphore(1),
          journal,
          oarSessionId: "",
          lastText: "",
          tracking: {},
          launch: "",
          spoke: false,
          token: "",
          recalled,
          triggers: [
            {
              trigger: opt.trigger ?? (issue ? { kind: "issue" } : { kind: "comment", ...(channel ? { channel } : {}) }),
              envelopeIds: [...new Set([...(opt.envelopeIds ?? []), ...initial.map((input) => input.id)])],
            },
          ],
          inputs: new Map(),
          run: "",
          heard: [],
          report: undefined,
        };
        handScope.defer(async () => {
          if (startup.phase !== "retained") await l.revokeAccess(h);
        });
        startupScope.defer(async () => {
          if (startup.phase !== "committed") await handScope.disposeAsync();
        });
        startupScope.defer(async () => {
          if (startup.phase !== "opening") return;
          const allocation = executor.find(id);
          if (allocation?.attached === true) {
            startup.phase = "retained";
            return;
          }
          if (allocation) {
            let stopFailed = false;
            try {
              await executor.close(id);
            } catch (e) {
              core.notice("error", allocation.failure ?? messageOf(e));
              stopFailed = true;
            }
            if (stopFailed) {
              startup.phase = "retained";
              return;
            }
          }
          await forget(id);
        });
        const recall = await remind(agent.id, id, place.repo, brief, recalled);
        const hiredAt = clock.now();
        const session: T.Session = {
          id,
          role: "worker",
          name: sessionName(capacity(), agent.id, agent.name),
          agent: agent.id,
          runtime: agent.runtime,
          brief,
          ...(place.repo ? { repo: place.repo } : {}),
          hiredAt,
          runs: 0,
          phase: { _tag: "working", since: hiredAt, doing: { action: "none", label: "" } },
          ...(channel ? { channel } : {}),
          refining: issue ? (opt.refining ?? false) : false,
          ...(issue ? { issue: issue.id } : {}),
          ...(place.branch ? { branch: place.branch, worktree: place.cwd } : {}),
          machine: machines.here().id,
        };
        const initialText = initial.map((input) => `${input.id}\n${input.card.summary}\n${input.card.readUri}`).join("\n\n");
        const source = issue?.mandate?.originTriggerId;
        const prompt = [brief, source ? sourceBrief(source) : "", initialText].filter(Boolean).join("\n\n");
        const opened = await open(agent, session, h, place, withRecall(recall, prompt), "");
        if (!opened.execution) {
          if (opened.retained) startup.phase = "retained";
          await startupScope.disposeAsync();
          throw hireRefused(t("server.session.life.cannotSend", { name: agent.name, why: opened.refused }), opened.retained || startup.releaseKept);
        }
        throwIfAborted(signal);
        // Release admission before `opt.hiring`, which may acquire channel locks whose delivery path waits on admission.
        releaseAdmission();
        const launch = launchOf(id);
        try {
          await db.tx(async () => {
            await logOf(session, journal);
            try {
              await qs.keepHand(db.sql, {
                id,
                place: jsonText(place),
                oar_session: opened.execution.sessionId,
                last_text: null,
                recalled: recalled.size > 0 ? jsonText([...recalled]) : null,
              });
            } catch (e) {
              if (e instanceof SqlError) throw new NotRecorded(causeMessage(e), { cause: e });
              throw e;
            }
          });
          if (opt.hiring) await opt.hiring(session, launch);
          throwIfAborted(signal);
        } catch (error) {
          if (!(error instanceof NotRecorded)) throw error;
          const failed = await failedOpening(id, t("server.session.life.notRecorded", { name: agent.name, why: reasonText(error) }));
          if (failed.retained) startup.phase = "retained";
          await startupScope.disposeAsync();
          throw hireRefused(failed.refused, failed.retained || startup.releaseKept);
        }
        // Committed in one go, with no await between: the hand is on the roster exactly when the core says it is hired.
        roster.set(h);
        core.apply({ type: "sessionChanged", session });
        attach(h, opened.execution, agent.runtime, launch);
        startup.phase = "committed";
        await startupScope.disposeAsync();
        return { session };
      } finally {
        await startupScope.disposeAsync();
      }
    } finally {
      releaseAdmission();
    }
  };

  const stop = async (id: string) => {
    const execution = executor.find(id);
    const hand = roster.get(id);
    if (!hand || execution?.attached !== true || execution.closing || core.session(id)?.phase._tag !== "working") return false;
    if (hand.settling) {
      try {
        return await roster.withHand(
          id,
          () => false,
          async (locked) => {
            const pending = locked.settling;
            if (!pending) return false;
            executor.detach(id);
            await executor.close(id);
            delete locked.settling;
            finishReport(locked, { ...pending.report, outcome: { kind: "aborted" } }, pending.completedBefore);
            closedLaunch(locked);
            return true;
          },
        );
      } catch (error) {
        log.warn(`vibevalley: background work did not close: ${messageOf(error)}`);
        return false;
      }
    }
    const outcome = await executor.interrupt(id);
    if (outcome.kind !== "accepted") {
      log.warn(`vibevalley: the stop of ${id} was not taken: ${"reason" in outcome ? outcome.reason : ""}`);
      return false;
    }
    return true;
  };

  const suspend = (id: string, signal?: AbortSignal) =>
    roster.withHand(
      id,
      () => false,
      async (h) => {
        const session = core.session(id);
        if (!session || isBusy(session) || h.triggers.length > 0) return false;
        await rest(h);
        await keepHands();
        return true;
      },
      signal,
    );

  const dismiss = (id: string, work: "keep" | "discard" = "keep", closed: "dismissed" | "completed" = "dismissed") =>
    roster.withHand(
      id,
      () => false,
      async (h) => {
        const current = core.session(id);
        const name = current?.name ?? id;
        if (work === "discard" && !current?.issue) throw refused(t("server.session.life.noIssue"));
        await closeExecution(h);
        if (work === "discard" && h.place.branch)
          await repos
            .checkout({ _tag: "Reset", place: h.place })
            .catch((e: unknown) => core.notice("warn", t("server.session.life.notReset", { name, why: messageOf(e) })));
        await leave(h, closed, 0);
        const kept = h.place.repo ? await repos.checkout({ _tag: "Release", place: h.place }) : await releaseContextPlace(h.place);
        if (kept.kept) core.notice("info", t("server.session.life.left", { name, why: kept.reason }));
        return true;
      },
    );

  const discardWork = async (id: string) => {
    if (!core.session(id)?.issue) throw refused(t("server.session.life.noIssue"));
    if (!roster.get(id)?.place.branch) return;
    await roster.withHand(
      id,
      () => undefined,
      async (h) => {
        const s = core.session(id);
        if (!s || isBusy(s) || !h.place.branch) return;
        await repos
          .checkout({ _tag: "Reset", place: h.place })
          .catch((e: unknown) => core.notice("warn", t("server.session.life.notReset", { name: s.name, why: messageOf(e) })));
      },
    );
  };

  const clearWorkplace = (issue: string, repo: string, number: number, work?: WorkplaceCleanup) =>
    admission.with(async () => {
      const unclosed = executor.all().find((a) => a.owner.issue === issue);
      if (unclosed) throw refused(unclosed.failure ?? t("server.session.life.issueNotReturned"));
      if (core.state().sessions.some((s) => s.issue === issue)) throw refused(t("server.session.life.stillHasHelper"));
      return repos.checkout({ _tag: "Clear", repo, issue: number, ...(work ? { work } : {}) });
    });

  const report = async (id: string, given: T.IssueReport) => {
    const noReport = () => refused(t("server.session.life.noHelper", { id }));
    if (!core.session(id)?.issue) throw noReport();
    await roster.withHand(
      id,
      () => {
        throw noReport();
      },
      async (h) => {
        if (!core.session(id)?.issue || !h.run) throw noReport();
        await flushRuns();
        try {
          await qs.setPendingReport(db.sql, { id, report: jsonText(given) });
        } catch (e) {
          if (e instanceof SqlError) throw refused(causeMessage(e));
          throw e;
        }
        h.report = given;
        if (h.settling && handsToUser(given)) {
          const pending = h.settling;
          delete h.settling;
          finishReport(h, pending.report, pending.completedBefore);
        }
      },
    );
  };

  const host = async <R>(o: HostOptions<R>): Promise<AgentHost<R>> => {
    await register(o.session);
    const hostedRuns: RunStore = {
      ...runStore,
      finish: async (run, outcome, summary, spent) => {
        await runStore.finish(run, outcome, summary, spent);
        const session = core.session(o.session.id);
        if (session)
          core.apply({
            type: "sessionReported",
            id: session.id,
            run,
            outcome,
            summary,
            runs: session.runs + 1,
            questions: [],
            checks: [],
            ...(spent ? { spent } : {}),
          });
      },
    };
    const journal = await trajectories.openLog(o.session.id, o.keepEvents);
    return makeHost({ ...o, memory: memories.forAgent(o.session.agent, o.session.id) }, journal, hostedRuns, {
      core,
      clock,
      log,
      durable: deps.runtime.durable,
    });
  };

  const close = async () => {
    // A helper answering on VibeValley's own runtime is let go with its run under way: restore goes on with it.
    deps.runtime.durable.leave();
    moves.close();
    await tasks.close();
    await cli?.close();
    await r.close();
  };

  return {
    noRoom: roomFor,
    makeRoom,
    hire,
    deliver,
    stop,
    suspend,
    dismiss,
    discardWork,
    clearWorkplace,
    handOver,
    withIdleWorkplace: (id, use) => accessWorkplace(id, use, true),
    withWorkplace: (id, use) => accessWorkplace(id, use, false),
    list: async (agent) => {
      const out = core.state().sessions.filter((s) => !agent || s.agent === agent);
      const rows = await qs.endedSessions(db.sql, { agent, n: endedListed });
      const ran = await qr.runsOfSessions(db.sql, { sessions: rows.map((row) => row.id) });
      const bySession = Map.groupBy(ran, (row) => row.session);
      for (const row of rows) if (!out.some((s) => s.id === row.id)) out.push(endedSession(row, bySession.get(row.id) ?? []));
      return out.toSorted((a, b) => b.hiredAt - a.hiredAt);
    },
    get: async (id) => {
      const live = core.session(id);
      if (live) return live;
      const row = await qs.sessionByID(db.sql, { id });
      if (row === undefined || row.ended_at === null) return undefined;
      return endedSession(row, await qr.runsOfSession(db.sql, { session: id }));
    },
    issueRuns: async (issue) => (await qr.runsOfIssue(db.sql, { issue_id: issue })).map(runOf),
    events: (id, run) => trajectories.events(id, run),
    sessionOf: (id) => core.session(id),
    hired: () => core.state().sessions.filter(isHired),
    isReachable: (id) => roster.has(id),
    lastTextOf: (id) => roster.get(id)?.lastText ?? "",
    cwdOf: (id) => roster.get(id)?.place.cwd,
    workFile,
    runOf: (id) => {
      const run = roster.get(id)?.run ?? executions.get(id)?.() ?? "";
      return run === "" ? undefined : run;
    },
    report,
    news: () => newsHub.subscribe(),
    who: roster.who,
    setAddress: (address) => void (mcpEndpoint.url = `http://${address}/mcp`),
    host,
    restore,
    boot: restore,
    close,
  };
}
