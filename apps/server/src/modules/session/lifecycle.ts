import { readFile, realpath, stat } from "node:fs/promises";

import type { Event, SessionOptions as OarSessionOptions } from "@botiverse/oar";
import type { SubagentReport } from "@botiverse/oar/agents";

import { Hub, Semaphore, type Subscription, TaskGroup, throwIfAborted } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { dayMs, maxRunning } from "@vibevalley/protocol";
import { isBusy, omitUndefined } from "@vibevalley/protocol/rules";
import { sessionId } from "@vibevalley/protocol/schema";

import { worker as sessionActor } from "#/base/actor.ts";
import { BizCode, errnoOf, lookIn, messageOf, missing, refuseIn } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import { jsonText } from "#/base/json.ts";
import type { Core, Fact } from "#/core/core.ts";
import { serverAddress, type ServerConfig } from "#/infra/config.ts";
import { causeMessage, type Db, SqlError } from "#/infra/db.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Agent } from "#/modules/agent/agent.ts";
import { goOn, helperKey, vibevalleyRuntime } from "#/modules/agent/vibevalley.ts";
import type { Memory } from "#/modules/memory/memory.ts";
import type { Repo } from "#/modules/repo/repo.ts";
import { type Merged, MergeFailure, type Workplace, type WorkplaceCleanup, type WorkplaceRelease } from "#/modules/repo/workplace.ts";
import * as qs from "#db/session.sql.ts";
import * as qr from "#db/session_run.sql.ts";

import {
  briefBreak,
  instructions,
  noRoom,
  notTakenIn,
  recallBlock,
  sessionName,
  type SessionLimits,
  type Settle,
  toOarMcp,
  whoMakesRoom,
  withRecall,
} from "./briefing.ts";
import { type Execution, type ExecutionInput, type Started, type StartFailure } from "./executor.ts";
import { type Hand, handStack, makeHandRoster } from "./hands.ts";
import { endedSession, heardOf, pendingReportOf, placeOf, policyOf, restoredSession, scopeRow, sessionState } from "./history.ts";
import { type AgentHost, type HostOptions, makeHost } from "./host.ts";
import { NotRecorded, recording } from "./inProcessRun.ts";
import { type Journal, makeTrajectories } from "./journal.ts";
import type { Machine } from "./machine.ts";
import { channelRules, restartedContextNote, restartedNote, workerInstructions, workplaceRules } from "./prompts.ts";
import { type Op, phaseFact, reactionTo, since } from "./reaction.ts";
import { handsToUser, readReport, restsAfter, settlesFirst } from "./report.ts";
import { isHired, isOnDuty } from "./roster.ts";
import {
  channelSessionPolicy,
  dutySessionPolicy,
  type IssueReport,
  refinementSessionPolicy,
  type SessionClose,
  type SessionPolicy,
  type Trigger,
  workSessionPolicy,
} from "./shapes.ts";
import { contextPlace, releaseContextPlace } from "./shell.ts";
import {
  type Consumed,
  type Delivered,
  type DeliveryInput,
  DeliveryRefused,
  type LaunchActivity,
  type RunFinished,
  type SessionIdentity,
  type SessionNews,
} from "./signals.ts";
import { type WorkerAccess, workerAccess } from "./worker.ts";

export type { SessionNews };
export type { RunFinished };
export { channelSessionPolicy, DeliveryRefused, NotRecorded, refinementSessionPolicy, workSessionPolicy };
export { runOf } from "./history.ts";

const endedListed = 200;
const saveAfterMs = 300;
const refused = refuseIn(BizCode.SessionRefused);

export interface RunStore {
  readonly start: (id: string, session: T.SessionId, issue: T.IssueId | undefined, trigger: T.RunTrigger) => Promise<void>;
  /** The run took an input of issue (told as IssueStarted). */
  readonly link: (run: string, issue: T.IssueId) => void;
  readonly heard: (run: string, heard: readonly string[]) => Promise<void>;
  readonly unended: (session: string) => Promise<{ readonly id: string; readonly startedAt: number } | undefined>;
  readonly finish: (id: string, outcome: T.Outcome, summary: string, spent?: T.Spent) => Promise<void>;
  readonly finished: (r: RunFinished) => void;
  readonly consumed: (c: Consumed) => void;
  readonly register: (session: string, currentRun: () => string) => void;
}

/** Work that did not go in (see handOver); the session stays. */
export class NotTakenIn extends Error {
  override readonly name = "NotTakenIn";
  readonly failure: MergeFailure;
  /** What the helper is sent back with; "" when the user settles it. */
  readonly fix: string;
  /** What the user is told; also the message. */
  readonly user: string;
  readonly notice: string;
  readonly short: string;
  constructor(failure: MergeFailure, words: { readonly fix: string; readonly user: string; readonly notice: string; readonly short: string }) {
    super(words.user);
    this.failure = failure;
    this.fix = words.fix;
    this.user = words.user;
    this.notice = words.notice;
    this.short = words.short;
  }
}

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
  readonly trigger?: T.RunTrigger;
  /** Prompt instructions appended to `brief` on initial launch without altering `session.brief`. */
  readonly preamble?: string;
  /** Runs after the session row is written, before any report or hired fact is visible; throws NotRecorded when it cannot be kept. */
  readonly hiring?: (s: T.Session, launch: string) => Promise<void>;
}

export interface SendOptions extends HireOptions {
  readonly envelopeIds?: readonly string[];
  readonly scope: T.SessionScope;
  readonly policy: SessionPolicy;
  /** Checkout number passed to repos.checkout when `policy.workplace === "checkout"`. */
  readonly checkoutNumber?: number;
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
  readonly clearWorkplace: (scopeId: string, repo: string, number: number, work?: WorkplaceCleanup) => Promise<WorkplaceRelease>;
  readonly sessionOf: (id: string) => T.Session | undefined;
  readonly hired: () => readonly T.Session[];
  /** True when this process holds the session's `Hand` (including between launches). */
  readonly isReachable: (id: string) => boolean;
  readonly lastTextOf: (id: string) => string;
  readonly cwdOf: (id: string) => string | undefined;
  /** Rejects `..` segments and symlinks escaping the session's working directory; throws NotWorkFile. */
  readonly workFile: (id: string, path: string, max: number) => Promise<{ readonly name: string; readonly bytes: Uint8Array }>;
  readonly runOf: (id: string) => string | undefined;
  readonly report: (id: string, report: IssueReport) => Promise<void>;
  /** Throws NotTakenIn when use fails (the session stays), ApiError when the session cannot hand over now. */
  readonly handOver: (id: string, closed: SessionClose, use: (place: Workplace, lastText: string) => Promise<Merged>, settle?: Settle) => Promise<Merged>;
  /** Pass `""` for all agents. */
  readonly list: (agent: string) => Promise<T.Session[]>;
  readonly get: (id: string) => Promise<T.Session | undefined>;
  readonly events: (id: string, run?: string) => Promise<T.SessionEvent[] | undefined>;
  /** Everything Session tells, subscribed before it returns: nothing told after is missed. */
  readonly news: () => Subscription<SessionNews>;
  /** Session id owning `token`, or `""` when unrecognized. */
  readonly who: (token: string) => string;
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
}

export interface SessionOptions {
  /** How helpers reach the worker CLI; a test gives its own. */
  readonly workerAccess?: () => Promise<WorkerAccess>;
}

/** A turn submitted and not opened yet, counted from sinceAt: its slot is taken, as one thinking. */
const reserved = (sinceAt: number): T.Session["phase"] => ({ _tag: "working", since: sinceAt, doing: { action: "thinking", label: "" } });

/** Whether a session's place is still on disk to go back to. */
const placeThere = (cwd: string, log: Logger) =>
  stat(cwd).then(
    () => true,
    (e: unknown) => {
      if (errnoOf(e) !== "ENOENT") log.warn(`vibevalley: ${cwd} cannot be read`, e);
      return false;
    },
  );

const handRow = (h: Hand): qs.KeepHandParams => ({
  id: h.id,
  place: jsonText(h.place),
  oar_session: h.oarSessionId || null,
  last_text: h.lastText || null,
  recalled: h.recalled.size > 0 ? jsonText([...h.recalled].toSorted()) : null,
});

const recordOp = (j: Journal, op: Op) => {
  switch (op.type) {
    case "prompt":
      return j.asked(op.text, op.from);
    case "response":
      return j.said(op.text, op.from);
    case "thought":
      return j.thought(op.text, op.from);
    case "toolStarted":
      return j.toolStarted(op.callId, op.start, op.from);
    case "toolInput":
      return j.toolInput(op.callId, op.input, op.text, op.from);
    case "toolEnded":
      return j.toolEnded(op.callId, op.output, op.ok, op.from);
    case "note":
      return j.note(op.kind, op.text, op.from);
  }
};

export function newsOf(fact: Fact, after: T.SpaceState): SessionNews | undefined {
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
  const agents = deps.agent;
  const memories = deps.memory;
  const repos = deps.repo;
  const machines = deps.machine;
  const executor = machines.executions(machines.here());
  const tasks = new TaskGroup({ name: "session", onError: (task, e) => log.error(`${task} failed`, e) });
  /** Background work nobody waits for (a run's memories kept). */
  const fire = (name: string, work: () => Promise<unknown>) => void tasks.run(name, work);
  /** One timer per key (the save, each conversation's idle suspension): a new one stops the one before. */
  const later = (key: string, work: (signal: AbortSignal) => Promise<unknown>) => void tasks.keyed(key, work);
  const runWriteLock = new Semaphore(1);
  // Run records are written one at a time, in the order asked: a run's start before its end.
  const recordRun = (what: string, write: () => Promise<unknown>) => {
    void runWriteLock.with(() => bestEffort(log, what, write));
  };
  /** Every run record asked for before this, written. */
  const flushRuns = () => runWriteLock.with(async () => undefined);

  const mcpUrl = `http://${serverAddress(config)}/mcp`;
  const stallMs = config.session.stallSeconds * 1000;
  const trajectories = makeTrajectories(config.home, (id, e) => core.sessionEvent(sessionId(id), e), { clock, log });
  const admission = new Semaphore(1);
  const roster = makeHandRoster(admission);
  const newsHub = new Hub<SessionNews>();
  const moves = core.transitions().changes;
  const tell = (news: SessionNews) => newsHub.publish(news);
  const signal = (a: LaunchActivity) => tell(a);
  const executions = new Map<string, () => string>();
  let launches = 0;
  const launchOf = (id: string) => `${id}#${++launches}`;
  let hired = 0;
  let closing = false;

  const keepHands = () =>
    bestEffort(log, "session: recovery state was not saved", () =>
      db.tx(async () => {
        for (const session of core.state().sessions) await qs.keepSessionState(db.sql, sessionState(session));
        for (const h of roster.values()) await qs.keepHand(db.sql, handRow(h));
      }),
    );

  const save = () => {
    if (closing) return;
    later("save", async (abort) => {
      await clock.sleep(saveAfterMs, abort);
      await keepHands();
    });
  };

  for (const row of await qs.activeSessions(db.sql)) core.apply({ type: "sessionChanged", session: restoredSession(row) });

  const keepRow = async (row: qs.KeepSessionParams) => {
    try {
      await qs.keepSession(db.sql, row);
    } catch (e) {
      if (e instanceof SqlError) throw new NotRecorded(causeMessage(e), { cause: e });
      throw e;
    }
  };

  const register = async (session: SessionIdentity) => {
    const hiredAt = clock.now();
    const id = sessionId(session.id);
    const scope: T.SessionScope = { kind: "duty", id };
    await keepRow({
      ...session,
      id,
      repo: null,
      ...scopeRow(scope),
      policy: jsonText(dutySessionPolicy),
      channel: null,
      hired_at: hiredAt,
      machine: null,
    });
    const kept = core.session(id);
    if (kept === undefined || kept.name !== session.name)
      core.apply({
        type: "sessionChanged",
        session: kept === undefined ? { ...session, id, scope, hiredAt, runs: 0, phase: { _tag: "resting" } } : { ...kept, name: session.name },
      });
  };

  // Ensure on-duty orchestrators have a persisted `session` row before any Run foreign key or mailbox delivery references them.
  const keepOnDuty = async (profile: T.Agent) => {
    if (!isOnDuty(profile)) return;
    const name = profile.name.trim() || t("server.channel.name.orchestrator");
    if (core.session(profile.id)?.name === name) return;
    await register({ id: profile.id, agent: profile.id, name, role: profile.role, runtime: profile.runtime, brief: profile.duty });
  };
  for (const profile of agents.all()) await keepOnDuty(profile);
  agents.whenKept(async (profile) => {
    try {
      await keepOnDuty(profile);
    } catch (e) {
      if (e instanceof NotRecorded) throw refused(e.message);
      throw e;
    }
  });

  const keep = (s: T.Session, policy: SessionPolicy) =>
    keepRow({
      id: s.id,
      role: s.role,
      agent: s.agent,
      name: s.name,
      runtime: s.runtime,
      brief: s.brief,
      repo: s.repo ?? null,
      ...scopeRow(s.scope),
      policy: jsonText(policy),
      channel: s.channel ?? null,
      hired_at: s.hiredAt,
      machine: s.machine ?? null,
    });

  const ended = (id: T.SessionId, closed: SessionClose) =>
    bestEffort(log, `vibevalley: session ${id}'s end not kept`, () => qs.endSession(db.sql, { ended_at: clock.now(), closed, id }));

  const forget = (id: T.SessionId) => bestEffort(log, `vibevalley: unstarted session ${id} not forgotten`, () => qs.forgetSession(db.sql, { id }));

  const logOf = async (s: T.Session, policy: SessionPolicy, journal: Journal) => {
    await keep(s, policy);
    await qs.keepSessionState(db.sql, sessionState(s));
    return journal;
  };

  const runs = recording({ db, clock });

  const runStore: RunStore = {
    ...runs,
    start: async (id, session, issue, trigger) => {
      await runs.start(id, session, trigger);
      if (issue) tell({ _tag: "IssueStarted", issue, run: id });
    },
    link: (run, issue) => tell({ _tag: "IssueStarted", issue, run }),
    finished: (r) => tell({ _tag: "RunFinished", ...r }),
    consumed: (c) => tell({ _tag: "Consumed", ...c }),
    register: (session, current) => void executions.set(session, current),
  };

  /** Queued before dispatching to the runtime so `startRun` finds it if the turn opens synchronously. */
  const expect = (h: Hand, input: DeliveryInput, inputId?: string) =>
    void h.triggers.push({ trigger: input.trigger, envelopeIds: input.envelopeIds, ...(inputId === undefined ? {} : { inputId }) });
  const unexpect = (h: Hand) => void h.triggers.pop();

  const consume = (h: Hand, envelopeIds: readonly string[]) => {
    const fresh = envelopeIds.filter((id) => !h.heard.includes(id));
    if (fresh.length === 0) return;
    h.heard.push(...fresh);
    if (h.run) {
      const run = h.run;
      const heard = [...h.heard];
      recordRun(`vibevalley: run ${run}`, () => runs.heard(run, heard));
    }
    tell({ _tag: "Consumed", session: h.id, envelopeIds: fresh });
  };

  const startRun = (h: Hand) => {
    if (h.goesOn !== undefined) {
      // Started before the restart, and recorded then: the turn takes it up as it was.
      h.run = h.goesOn;
      h.journal.runResumed(h.goesOn);
      delete h.goesOn;
      return;
    }
    const expected = h.triggers.shift();
    const by = expected?.trigger ?? { kind: "runtime" };
    const id = newId();
    const at = clock.now();
    // Assign `h.run` synchronously before async DB persistence so an immediate `report` finds it.
    h.run = id;
    h.heard = [];
    h.report = undefined;
    recordRun(`vibevalley: ${h.id}'s previous report was not cleared`, () => qs.clearPendingReport(db.sql, { id: h.id }));
    h.journal.runStarted(id);
    recordRun(`vibevalley: a run not kept (session ${h.id})`, () => runs.start(id, h.id, by, at));
    if (expected?.inputId === undefined && expected !== undefined && expected.envelopeIds.length > 0) consume(h, expected.envelopeIds);
  };

  const inputChanged = (h: Hand, input: ExecutionInput) => {
    const envelopeIds = h.inputs.get(input.inputId);
    if (envelopeIds === undefined) return;
    h.inputs.delete(input.inputId);
    if (input.kind === "consumed") consume(h, envelopeIds);
    else tell({ _tag: "Returned", session: h.id, envelopeIds });
  };

  const endRun = (h: Hand, outcome: T.Outcome, summary: string, spent?: T.Spent) => {
    const id = h.run;
    h.run = "";
    h.heard = [];
    if (!id) return;
    h.journal.runEnded(id, outcome);
    recordRun(`vibevalley: run ${id}`, async () => {
      let endedSession: T.Session | undefined;
      await db.tx(async () => {
        await runs.finish(id, outcome, summary, spent);
        endedSession = core.session(h.id);
        if (endedSession) await qs.keepSessionState(db.sql, sessionState(endedSession));
        await qs.clearPendingReport(db.sql, { id: h.id });
      });
      if (endedSession) tell({ _tag: "RunFinished", id, session: h.id, outcome });
    });
  };

  const release = (h: Hand) => executor.detach(h.id);
  const closeExecution = (h: Hand) => executor.close(h.id);

  const closedLaunch = (h: Hand) => {
    if (h.launch) signal({ _tag: "Closed", id: h.id, launch: h.launch });
    h.launch = "";
  };

  const finishReport = (h: Hand, reportData: SubagentReport, completedBefore: number) => {
    const session = core.session(h.id);
    if (!session) return;
    const read = readReport(reportData.outcome, reportData.text);
    const declared = h.report;
    const canRest = restsAfter(read.outcome === "completed", h.policy.restAfterTurn, declared);
    h.report = undefined;
    const summary = declared?.summary.trim() || read.summary;
    const spent = session.spent ? since(session.spent, h.tracking.runFrom) : undefined;
    h.lastText = read.text;
    h.tracking = omitUndefined({ ...h.tracking, runFrom: undefined });
    const { launch, spoke } = h;
    core.apply({
      type: "sessionReported",
      id: h.id,
      outcome: read.outcome,
      ...(canRest ? { phase: { _tag: "resting" as const } } : {}),
      summary,
      runs: completedBefore + reportData.turn,
      ...(spent ? { spent } : {}),
      ...(h.run ? { run: h.run } : {}),
      questions: declared?.questions ?? read.questions,
      checks: declared?.checks ?? read.checks,
      ...(declared?.answer ? { answer: declared.answer } : {}),
    });
    // reduce folds the fact synchronously; the reported phase tells whether the session rests.
    const waiting = core.session(h.id)?.phase._tag === "resting";
    endRun(h, read.outcome, summary, spent);
    fire(`memories of ${h.id}'s run`, () =>
      memories.keep({
        agent: session.agent,
        session: h.id,
        ...(h.policy.workplace === "checkout" && session.scope ? { issue: session.scope.id } : {}),
        repo: h.place.repo,
        brief: session.brief,
        outcome: read.outcome,
        said: read.text,
        summary,
      }),
    );
    if (declared && declared.remember.length > 0)
      fire(`declared memories of ${h.id}`, () =>
        bestEffort(log, `vibevalley: ${h.id}'s declared memories were not kept`, async () => {
          for (const memory of declared.remember)
            await memories.write({ agent: session.agent, text: memory.text, repo: memory.scope === "all" ? "" : h.place.repo, by: sessionActor(h.id) });
        }),
      );
    if (read.needsYou) core.notice("error", t("server.session.life.stoppedNeedsYou", { name: session.name, why: read.failure }));
    if (launch) signal({ _tag: read.outcome === "completed" && !waiting ? "HandedOff" : "Ended", id: h.id, launch, outcome: read.outcome, spoke });
    agents.usageSoon(session.runtime);
    save();
  };

  const applyReport = (h: Hand, reportData: SubagentReport, completedBefore: number) => {
    if (settlesFirst(reportData.outcome.kind === "completed", h.report, executor.find(h.id)?.pendingTasks ?? 0)) {
      h.settling = { report: reportData, completedBefore };
      const channel = core.session(h.id)?.channel;
      core.apply({
        type: "sessionPhaseChanged",
        id: h.id,
        ...(channel !== undefined ? { channel } : {}),
        phase: { _tag: "working", since: clock.now(), doing: { action: "wait", label: "" } },
      });
      signal({ _tag: "Settling", id: h.id, launch: h.launch });
      return;
    }
    delete h.settling;
    finishReport(h, reportData, completedBefore);
  };

  // oar's observer callbacks are synchronous: each fact is applied (synchronously) in callback order.
  const watch = (h: Hand, launch: string, runtime: string) => (event: Event) => {
    if (event.kind === "task_ended" && h.settling && event.status !== "completed") {
      const pending = h.settling;
      h.settling = {
        ...pending,
        report: {
          ...pending.report,
          outcome: event.status === "stopped" ? { kind: "aborted" } : { kind: "failed", failure: "unknown", reason: event.summary ?? event.taskId },
        },
      };
    }
    let opened = false;
    const signals: LaunchActivity[] = [];
    if (h.launch && h.launch === launch && event.agentPath.length === 0) {
      if (event.kind === "turn_started") {
        if (h.settling) {
          const pending = h.settling;
          delete h.settling;
          finishReport(h, pending.report, pending.completedBefore);
        }
        h.spoke = false;
        opened = true;
      } else if (event.kind === "reasoning" || event.kind === "text_delta" || event.kind === "tool_call_started") {
        if (!h.spoke) {
          h.spoke = true;
          signals.push({ _tag: "Spoke", id: h.id, launch: h.launch });
        }
      } else if (event.kind === "compaction_started") signals.push({ _tag: "Compacting", id: h.id, on: true });
      else if (event.kind === "compaction_ended") signals.push({ _tag: "Compacting", id: h.id, on: false });
    }
    const reaction = reactionTo(event, core.session(h.id), h.tracking, { id: h.id, runtime, cwd: h.place.cwd });
    h.tracking = reaction.tracking;
    if (reaction.model) h.tracking = omitUndefined({ ...h.tracking, rate: agents.quote(runtime, reaction.model) });
    if (opened) startRun(h);
    for (const a of signals) signal(a);
    for (const op of reaction.journal) recordOp(h.journal, op);
    for (const fact of reaction.facts) {
      if (fact.type === "sessionReported") {
        const reported = h.run ? { ...fact, run: h.run } : fact;
        core.apply(reported);
        endRun(h, reported.outcome, reported.summary, reported.spent);
      } else core.apply(fact);
    }
    if (reaction.spentCny !== 0) agents.spend(runtime, reaction.spentCny);
    if (reaction.warn) core.notice("warn", reaction.warn);
    if (event.kind === "exited") {
      delete h.settling;
      closedLaunch(h);
    }
  };

  const stalled = (h: Hand, silentForMs: number, at: number) => {
    const session = core.session(h.id);
    if (session?.phase._tag !== "working") return;
    h.tracking = { ...h.tracking, quiet: true };
    core.apply(phaseFact(session, { ...session.phase, quietSince: at - silentForMs }));
    const quiet =
      silentForMs < 60_000
        ? t("server.session.life.seconds", { n: Math.round(silentForMs / 1000) })
        : t("server.session.life.minutes", { n: Math.round(silentForMs / 60_000) });
    const last = session.phase.doing.label ? t("server.session.log.quietLast", { label: session.phase.doing.label }) : "";
    h.journal.note("run/error", t("server.session.log.quiet", { span: quiet, last }));
    core.notice("warn", t("server.session.life.quietNotice", { name: session.name, span: quiet, last }));
  };

  const attach = (h: Hand, s: Execution, runtime: string, launch = launchOf(h.id)) => {
    h.launch = launch;
    h.spoke = false;
    if (s.sessionId) h.oarSessionId = s.sessionId;
    h.tracking = omitUndefined({ ...h.tracking, oarTokens: undefined });
    core.apply({ type: "sessionToolsReset", id: h.id });
    const completedBefore = core.session(h.id)?.runs ?? 0;
    executor.observe(h.id, {
      event: watch(h, launch, runtime),
      connection: (connection) => {
        h.journal.connection(connection);
        core.apply({ type: "sessionToolChanged", id: h.id, connection });
      },
      input: (input) => inputChanged(h, input),
      report: (reportData) => applyReport(h, reportData, completedBefore),
      tasksChanged: (pending) => {
        if (pending === 0 && h.settling) {
          const waiting = h.settling;
          delete h.settling;
          finishReport(h, waiting.report, waiting.completedBefore);
        }
      },
      stalled: (silentForMs, at) => stalled(h, silentForMs, at),
      stallMs,
    });
    save();
  };

  const failedOpening = async (id: string, why: string): Promise<StartFailure> => {
    const failure = await executor.failed(id, why);
    if (failure.retained) core.notice("error", failure.refused);
    return failure;
  };

  let cli: WorkerAccess | undefined;
  try {
    cli = await (options.workerAccess ?? workerAccess)();
  } catch (e) {
    // No helper starts without it: each hire is refused with workerUnavailable.
    log.warn("vibevalley: the worker CLI's credentials cannot be kept", e);
  }

  const revokeAccess = async (hand: Hand) => {
    roster.revokeToken(hand);
    if (cli) await cli.revoke(hand.id).catch((e: unknown) => log.warn(`vibevalley: ${hand.id}'s worker credential was not removed`, e));
  };

  const opening = async (agent: T.Agent, owner: T.Session, hand: Hand, place: Workplace, input: string, resume: string): Promise<Started> => {
    if (!cli) return { refused: t("server.session.life.workerUnavailable"), retained: false };
    const token = roster.issueToken(hand);
    let access: { readonly authenticated: boolean; readonly command: string } | undefined;
    try {
      access = await cli.prepare(hand.id, mcpUrl, token);
    } catch (e) {
      // Taken as not let in: the hire is refused with workerAuthenticationFailed.
      log.warn(`vibevalley: ${hand.id}'s worker credential was not prepared`, e);
    }
    if (access?.authenticated !== true) {
      return { refused: t("server.session.life.workerAuthenticationFailed"), retained: false };
    }
    const checkout = hand.policy.workplace === "checkout";
    const houseRules = checkout ? await repos.houseRules() : "";
    const text = [
      workerInstructions(access.command),
      instructions(agent, agents.skills()),
      checkout ? workplaceRules(place, houseRules, owner.id, repos.usesPullRequests(place.repo)) : channelRules(place.cwd, owner.channel ?? "", owner.id),
    ]
      .filter((s) => s !== "")
      .join("\n\n");
    const mcp = [{ name: "vibevalley", type: "http" as const, url: mcpUrl, headers: { authorization: "Bearer " + token } }, ...agent.mcpServers.map(toOarMcp)];
    const oarOptions: Partial<OarSessionOptions> = {
      mcpServers: mcp,
      ...(text && agent.personaMode === "append" ? { appendSystemPrompt: text } : {}),
      ...(text && agent.personaMode === "replace" ? { systemPrompt: text } : {}),
      ...(agent.disallowedTools.length > 0 ? { disallowedTools: agent.disallowedTools } : {}),
    };
    const opened = await executor.start({
      agent,
      owner,
      cwd: place.cwd,
      // goOn adds nothing: the run it goes on with was asked with its persona already.
      input: text && agent.personaMode === "prompt" && input !== goOn ? text + briefBreak + input : input,
      resume,
      options: oarOptions,
    });
    if (opened.retained === true) core.notice("error", opened.refused);
    return opened;
  };

  /** An execution opened for the hand; its credential revoked again when none opened, however that ended. */
  const open = async (agent: T.Agent, owner: T.Session, hand: Hand, place: Workplace, input: string, resume: string): Promise<Started> => {
    if (!cli || !(await cli.executableAvailable())) return { refused: t("server.session.life.workerUnavailable"), retained: false };
    let opened: Started | undefined;
    try {
      opened = await opening(agent, owner, hand, place, input, resume);
      return opened;
    } finally {
      if (!opened?.execution) await revokeAccess(hand);
    }
  };

  const leave = async (h: Hand, closed: SessionClose, merged: number) => {
    await tasks.stop(`idle:${h.id}`);
    release(h);
    await flushRuns();
    await h.stack.disposeAsync();
    await ended(h.id, closed);
    closedLaunch(h);
    roster.delete(h);
    const session = core.session(h.id);
    if (session) await memories.endSession({ agent: session.agent, session: h.id, repo: h.place.repo });
    core.apply({ type: "sessionLeft", id: h.id, closed, ...(merged > 0 ? { merged } : {}) });
    save();
  };

  /** Lets the oar session go, keeping its id to resume. */
  const rest = async (h: Hand) => {
    await closeExecution(h);
    release(h);
    closedLaunch(h);
    save();
  };

  const missingHelper = (id: string) => missing(t("server.session.life.helperRef", { id }), [lookIn.session]);

  const accessWorkplace = async <A>(id: string, use: (place: Workplace) => Promise<A>, idle: boolean): Promise<A> =>
    roster.withHand(
      id,
      () => {
        throw missingHelper(id);
      },
      async (hand) => {
        const session = core.session(id);
        if (!session) throw missingHelper(id);
        if (idle) {
          if (isBusy(session) || hand.triggers.length > 0) throw refused(t("server.session.life.stillWorking", { name: session.name }));
          await rest(hand);
        }
        return use(hand.place);
      },
    );

  const capacity = (): Pick<T.Session, "id" | "agent" | "runtime" | "repo" | "phase">[] => {
    const visible = core.state().sessions.filter(isHired);
    return [
      ...visible.map((s) => {
        const h = roster.get(s.id);
        const allocation = executor.find(s.id);
        const openingExecution = allocation !== undefined && (!allocation.attached || allocation.closing);
        // A submitted turn owns its slot before oar opens it: its trigger is the reservation.
        return (openingExecution || (h !== undefined && h.triggers.length > 0)) && !isBusy(s) ? { ...s, phase: reserved(clock.now()) } : s;
      }),
      ...executor
        .all()
        .filter((a) => !visible.some((s) => s.id === a.owner.id))
        .map((a) => ({ ...a.owner, phase: reserved(clock.now()) })),
    ];
  };

  const limits = (runtime: string): SessionLimits => ({
    space: maxRunning,
    perRepo: repos.limit,
    perRuntime: agents.settings(runtime).maxWorking ?? 0,
  });

  const roomFor = (runtime: string, repo: string) => noRoom(capacity(), runtime, repo.trim(), limits(runtime));

  const remind = async (agent: string, session: string, repo: string, input: string, recalled: Set<string>) => {
    const found = await memories.recall({ agent, session, repo, text: input, skip: new Set(recalled) });
    for (const id of found.ids) recalled.add(id);
    if (found.ids.length > 0) save();
    return recallBlock(found.lines);
  };

  const wake = async (h: Hand, session: T.Session, input: string, recall: string): Promise<Delivered> => {
    const agent = agents.agent(session.agent);
    if (!agent) throw new DeliveryRefused(t("server.session.life.agentGone", { name: session.name }));
    try {
      await rest(h);
    } catch (e) {
      throw new DeliveryRefused(messageOf(e), { cause: e });
    }
    const resume = h.oarSessionId;
    let opened = await open(agent, session, h, h.place, withRecall(recall, input), resume);
    if (!opened.execution && !opened.retained && resume) {
      h.recalled.clear();
      const again = await remind(session.agent, h.id, h.place.repo, input, h.recalled);
      opened = await open(
        agent,
        session,
        h,
        h.place,
        withRecall(again, (h.policy.workplace === "checkout" ? restartedNote : restartedContextNote) + input),
        "",
      );
    }
    if (!opened.execution) {
      throw new DeliveryRefused(t("server.session.life.cannotWake", { name: session.name, why: opened.refused }));
    }
    attach(h, opened.execution, session.runtime);
    return { kind: "run", launch: h.launch || h.id, woke: true };
  };

  const noHelperDelivered = (id: string) => new DeliveryRefused(t("server.session.life.noHelper", { id }));

  const deliver = async (id: string, text: string, input: DeliveryInput): Promise<Delivered> =>
    roster.withHandAndAdmission(
      id,
      () => {
        throw noHelperDelivered(id);
      },
      async (h): Promise<Delivered> => {
        const session = core.session(id);
        if (!session) throw noHelperDelivered(id);
        const execution = executor.find(id);
        if (execution?.closing === true) throw new DeliveryRefused(t("server.session.life.stillClosing", { name: session.name }));
        const starts = !isBusy(session);
        let recall = "";
        if (starts) {
          const full = noRoom(capacity(), session.runtime, h.place.repo, limits(session.runtime), id, input.byUserComment);
          if (full) throw new DeliveryRefused(t("server.session.life.noRoom", { name: session.name, full }));
          recall = await remind(session.agent, id, h.place.repo, text, h.recalled);
        }
        if (execution?.attached !== true || !h.launch) {
          expect(h, input);
          try {
            return await wake(h, session, text, recall);
          } catch (e) {
            unexpect(h);
            throw e;
          }
        }
        const launch = h.launch;
        const inputId = newId();
        h.inputs.set(inputId, input.envelopeIds);
        if (starts) expect(h, input);
        let sent: Awaited<ReturnType<typeof executor.deliver>>;
        try {
          sent = await executor.deliver(id, withRecall(recall, text), inputId);
        } catch (e) {
          h.inputs.delete(inputId);
          if (starts) unexpect(h);
          throw e;
        }
        if (sent.kind === "accepted" && sent.landed === "prompted") {
          h.inputs.delete(inputId);
          return { kind: "run", launch };
        }
        if (starts) unexpect(h);
        if (sent.kind !== "accepted") {
          h.inputs.delete(inputId);
          throw new DeliveryRefused(t("server.session.life.notReceived", { name: session.name, why: sent.reason }));
        }
        if (sent.landed === "queued") {
          if (sent.inputId === undefined) h.inputs.delete(inputId);
          expect(h, input, sent.inputId);
          return { kind: "queued", launch };
        }
        if (sent.inputId === undefined) {
          h.inputs.delete(inputId);
          consume(h, input.envelopeIds);
        }
        return { kind: "steered", launch };
      },
    );

  /** The work taken in by use; NotTakenIn (the session stays) when use fails, whatever it failed with. */
  const handOver = async (
    id: string,
    closed: SessionClose,
    use: (place: Workplace, lastText: string) => Promise<Merged>,
    settle: Settle = "user",
  ): Promise<Merged> =>
    roster.withHand(
      id,
      () => {
        throw missingHelper(id);
      },
      async (h) => {
        const current = core.session(id);
        if (!current) throw missingHelper(id);
        if (h.policy.workplace !== "checkout") throw refused(t("server.session.life.noIssue"));
        if (isBusy(current) || h.triggers.length > 0) throw refused(t("server.session.life.stillWorking", { name: current.name }));
        await rest(h);
        let merged: Merged;
        try {
          merged = await use(h.place, h.lastText);
        } catch (e) {
          const f = e instanceof MergeFailure ? e : MergeFailure.error(messageOf(e));
          throw new NotTakenIn(f, notTakenIn(f, current.name, settle));
        }
        if (merged.pullRequest) return merged;
        await leave(h, closed, closed === "merged" ? merged.commits : 0);
        if (merged.warning) core.notice("warn", merged.warning);
        return merged;
      },
    );

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

  tasks.run("session news", async (signal) => {
    for (let n = await moves.next(signal); n.done !== true; n = await moves.next(signal)) {
      const { before, fact, after } = n.value;
      if (before.sessions !== after.sessions) save();
      const news = newsOf(fact, after);
      if (news?._tag === "Reported" && news.session !== undefined && roster.get(news.session.id)?.policy.idleSuspend === true) {
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

  const expireLogs = async (days: number) => {
    if (days <= 0) return;
    const ids = await qs.sessionsEndedBefore(db.sql, { before: clock.now() - days * dayMs });
    for (const row of ids) await trajectories.forget(row.id);
  };

  const finishInterrupted = (run: string) =>
    bestEffort(log, `vibevalley: run ${run}`, async () => {
      await runs.finish(run, "interrupted", t("server.session.log.restarted"));
      tell({ _tag: "RunFinished", id: run, outcome: "interrupted" });
    });

  /** A helper on VibeValley's own runtime that was answering when the farm stopped is opened again on its conversation,
   * and the turn that goes on is the run it was in; false when it cannot be, and its run is then cut off. */
  const goOnWith = async (h: Hand, session: T.Session, run: string): Promise<boolean> => {
    const agent = agents.agent(session.agent);
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
      if (!isOnDuty(row) && row.runtime === vibevalleyRuntime && row.oar_session && (await agents.durable.busy(helperKey(row.oar_session))))
        goingOn.add(row.id);
    const openRun = new Map<string, string>();
    for (const row of await qr.openRuns(db.sql)) {
      if (goingOn.has(row.session)) openRun.set(row.session, row.id);
      // Its durable conversation goes on with it: its host ends it once the answer comes.
      else if (!(await agents.durable.busy(row.session))) await finishInterrupted(row.id);
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
      const policy = policyOf(row.policy);
      const stack = handStack();
      const trajectory = await trajectories.openLog(session.id);
      stack.defer(() => trajectories.finish(session.id));
      const journal = await logOf(session, policy, trajectory);
      const hand: Hand = {
        id: session.id,
        stack,
        place: s.place,
        policy,
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
      stack.defer(() => revokeAccess(hand));
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

  const dismiss = (id: string, work: "keep" | "discard" = "keep", closed: "dismissed" | "completed" = "dismissed") =>
    roster.withHand(
      id,
      () => false,
      async (h) => {
        const current = core.session(id);
        const name = current?.name ?? id;
        if (work === "discard" && h.policy.workplace !== "checkout") throw refused(t("server.session.life.noIssue"));
        await closeExecution(h);
        if (work === "discard" && h.place.branch)
          await repos.resetCheckout(h.place).catch((e: unknown) => core.notice("warn", t("server.session.life.notReset", { name, why: messageOf(e) })));
        await leave(h, closed, 0);
        const kept = h.place.repo ? await repos.releaseCheckout(h.place) : await releaseContextPlace(h.place);
        if (kept.kept) core.notice("info", t("server.session.life.left", { name, why: kept.reason }));
        return true;
      },
    );

  const makeRoom = async (runtime: string, repo: string): Promise<{ readonly evicted?: string }> => {
    const full = roomFor(runtime, repo);
    if (full) throw new HireRefused(full);
    const oldest = whoMakesRoom(
      core.state().sessions.filter((s) => executor.find(s.id) !== undefined),
      maxRunning,
    );
    if (!oldest) return {};
    try {
      const action = roster.get(oldest.id)?.policy.onEvict ?? "dismiss";
      await (action === "dismiss" ? dismiss(oldest.id) : suspend(oldest.id));
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
      const checkout = opt.policy.workplace === "checkout";
      const channel = opt.channel ?? (checkout ? undefined : opt.scope.id);
      const repo = checkout ? where : "";
      const unclosed = executor
        .all()
        .find((a) => (checkout ? a.owner.scope?.id === opt.scope.id : a.owner.agent === agent.id && a.owner.channel === channel && a.owner.repo === undefined));
      if (unclosed) throw new HireRefused(unclosed.failure ?? t(checkout ? "server.session.life.issueNotReturned" : "server.session.life.notReturned"), true);
      const full = roomFor(agent.runtime, repo);
      if (full) throw new HireRefused(full);
      hired++;
      const id = sessionId(`w${hired}`);
      let place: Workplace;
      try {
        place =
          checkout && repo && opt.checkoutNumber !== undefined
            ? await repos.checkout({
                repo,
                issue: opt.checkoutNumber,
                worktree: opt.worktree ?? agent.worktree,
                base: opt.base ?? "",
                ...(signal ? { signal } : {}),
              })
            : await contextPlace(config.workRoot, id);
      } catch (e) {
        throw new HireRefused(t("server.session.life.noPlace", { name: agent.name, why: messageOf(e) }), undefined, { cause: e });
      }
      const releasePlace = () => (place.repo ? repos.releaseCheckout(place) : releaseContextPlace(place));
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
          policy: opt.policy,
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
              trigger: opt.trigger ?? (checkout ? { kind: "issue" } : { kind: "comment", ...(channel ? { channel } : {}) }),
              envelopeIds: [...new Set([...(opt.envelopeIds ?? []), ...initial.map((input) => input.id)])],
            },
          ],
          inputs: new Map(),
          run: "",
          heard: [],
          report: undefined,
        };
        handScope.defer(async () => {
          if (startup.phase !== "retained") await revokeAccess(h);
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
          scope: opt.scope,
          ...(place.branch ? { branch: place.branch, worktree: place.cwd } : {}),
          machine: machines.here().id,
        };
        const initialText = initial.map((input) => `${input.id}\n${input.card.summary}\n${input.card.readUri}`).join("\n\n");
        const prompt = [brief, opt.preamble ?? "", initialText].filter(Boolean).join("\n\n");
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
            await logOf(session, opt.policy, journal);
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
          const failed = await failedOpening(id, t("server.session.life.notRecorded", { name: agent.name, why: messageOf(error) }));
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

  const discardWork = async (id: string) => {
    if (roster.get(id)?.policy.workplace !== "checkout") throw refused(t("server.session.life.noIssue"));
    if (!roster.get(id)?.place.branch) return;
    await roster.withHand(
      id,
      () => undefined,
      async (h) => {
        const s = core.session(id);
        if (!s || isBusy(s) || !h.place.branch) return;
        await repos.resetCheckout(h.place).catch((e: unknown) => core.notice("warn", t("server.session.life.notReset", { name: s.name, why: messageOf(e) })));
      },
    );
  };

  const clearWorkplace = (scopeId: string, repo: string, number: number, work?: WorkplaceCleanup) =>
    admission.with(async () => {
      const unclosed = executor.all().find((a) => a.owner.scope?.id === scopeId);
      if (unclosed) throw refused(unclosed.failure ?? t("server.session.life.issueNotReturned"));
      if (core.state().sessions.some((s) => s.scope?.id === scopeId)) throw refused(t("server.session.life.stillHasHelper"));
      return repos.clearCheckout(repo, number, work);
    });

  const report = async (id: string, given: IssueReport) => {
    const noReport = () => refused(t("server.session.life.noHelper", { id }));
    if (roster.get(id)?.policy.structuredReport !== true) throw noReport();
    await roster.withHand(
      id,
      () => {
        throw noReport();
      },
      async (h) => {
        if (!h.policy.structuredReport || !h.run) throw noReport();
        await flushRuns();
        try {
          await qs.setPendingReport(db.sql, { id: h.id, report: jsonText(given) });
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
      durable: agents.durable,
    });
  };

  // Flush recovery state and detach before executor shutdown so interrupted turns reconcile on next startup rather than mid-exit.
  const close = async () => {
    // A helper answering on VibeValley's own runtime is let go with its run under way: restore goes on with it.
    agents.durable.leave();
    closing = true;
    moves.close();
    await tasks.stop("session news");
    await tasks.stop("save");
    await cli?.close();
    await flushRuns();
    await keepHands();
    for (const h of roster.values()) {
      h.journal.close();
      release(h);
      await h.stack.disposeAsync();
    }
    newsHub.end();
    roster.clearTokens();
    await tasks.close();
    await flushRuns();
    await trajectories.close();
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
    get: async (rawId) => {
      const live = core.session(rawId);
      if (live) return live;
      const id = sessionId(rawId);
      const row = await qs.sessionByID(db.sql, { id });
      if (row === undefined || row.ended_at === null) return undefined;
      return endedSession(row, await qr.runsOfSession(db.sql, { session: id }));
    },
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
    host,
    restore,
    boot: restore,
    close,
  };
}
