// Admission serializes room and opening turns; each hand owns its input, handover and departure, so one worktree's
// checks do not hold the other sessions.

import { randomBytes } from "node:crypto";

import type { Event, SessionOptions } from "@botiverse/oar";
import type { SubagentReport } from "@botiverse/oar/agents";
import {
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  FiberMap,
  FiberSet,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Queue,
  PubSub,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { dayMs, maxRunning } from "@vibevalley/protocol";
import { ApiError as ApiErrorSchema } from "@vibevalley/protocol/api";
import { isBusy, omitUndefined } from "@vibevalley/protocol/rules";
import { sessionId } from "@vibevalley/protocol/schema";
import * as S from "@vibevalley/protocol/schema";

import { Agent } from "@/agent/agent.ts";
import { session as sessionActor } from "@/base/actor.ts";
import { newId } from "@/base/ids.ts";
import { jsonOrNone } from "@/base/json.ts";
import { scopedPubSub } from "@/base/pubsub.ts";
import { Core, type FactIn } from "@/core/core.ts";
import { type ApiError, missing, lookIn, reasonOf, refused } from "@/errors.ts";
import { Executor, type Execution, type ExecutionInput, type Started, type StartFailure } from "@/executor/executor.ts";
import { serverAddress, ServerConfig } from "@/infra/config.ts";
import { causeMessage, Db } from "@/infra/db.ts";
import { bestEffort } from "@/infra/log.ts";
import { Memory } from "@/memory/memory.ts";
import { Project } from "@/project/project.ts";
import { type Merged, MergeFailure, type ProjectError, type Workplace, type WorkplaceCleanup, type WorkplaceRelease } from "@/project/workplace.ts";
import { Runtime } from "@/runtime/runtime.ts";

import {
  briefBreak,
  instructions,
  noRoom,
  notTakenIn,
  recallBlock,
  type SessionLimits,
  sessionName,
  type Settle,
  toOarMcp,
  whoMakesRoom,
  withRecall,
} from "./briefing.ts";
import { eventFacts, phaseFact, type Op, since, type Tracking } from "./facts.ts";
import { type AgentHost, type HostOptions, makeHost } from "./host.ts";
import { NotRecorded, recording } from "./inProcessRun.ts";
import { type Journal, makeTrajectories } from "./journal.ts";
import { channelRules, restartedContextNote, restartedNote, sourceBrief, workplaceRules } from "./prompts.ts";
import { handsToOwner, readReport, summaryOf } from "./report.ts";
import { sessionOnIssue } from "./roster.ts";
import { contextPlace, releaseContextPlace } from "./shell.ts";
import type { Delivered, DeliveryInput, InputConsumed, InputReturned, LaunchActivity, SessionIdentity, SessionNews } from "./signals.ts";

export type { SessionNews };
export { NotRecorded };
import * as qs from "../../db/generated/session.sql.ts";
import * as qr from "../../db/generated/session_run.sql.ts";

/** A burst of changes is one write. */
const saveAfterMs = 300;
/** The ended sessions a list shows, newest first: their trajectories expire after days anyway. */
const endedListed = 200;

export interface Hired {
  readonly session?: T.Session;
  readonly refused?: string;
  /** Who was sent home to make room. */
  readonly evicted?: string;
  /** A refused dispatch left work behind: its issue identity must be kept. */
  readonly retainedWork?: true;
}

export interface HireOptions {
  readonly inputs?: readonly T.Trigger[];
  /** The branch its own branch starts from; empty: the project's main branch. */
  readonly base?: string;
  readonly worktree?: boolean;
  readonly channel?: string;
  /** Empty: the Issue service writes one from the issue before opening its session. */
  readonly issue?: string;
  /** What its first run is for; the issue sent out when none. */
  readonly trigger?: T.RunTrigger;
  /** It drafts the issue rather than works it. */
  readonly refining?: boolean;
  /** The caller's transaction after the session row is kept, before any report can be seen. */
  readonly hiring?: (s: T.Session, launch: string) => Effect.Effect<void, NotRecorded>;
}

interface SendOptions extends Omit<HireOptions, "issue"> {
  readonly envelopeIds?: readonly string[];
  readonly context:
    | { readonly kind: "issue"; readonly issue: Pick<T.Issue, "id" | "number"> & { readonly mandate?: T.IssueMandate } }
    | { readonly kind: "channel"; readonly channel: string };
  /** Registers source routing before the hired fact or any report can be seen. */
  readonly hiring?: (s: T.Session, launch: string) => Effect.Effect<void, NotRecorded>;
}

export interface RunFinished {
  readonly id: string;
  readonly issues: T.IssueId[];
  readonly outcome: T.Outcome;
}

interface Hand {
  readonly id: T.SessionId;
  readonly place: Workplace;
  /** The issue it was opened for: the run keeps it even while the session is between assignments. */
  readonly issue: string;
  readonly access: Semaphore.Semaphore;
  readonly journal: Journal;
  /** The oar session it is attached to; undefined between launches. */
  oarSessionId: string;
  lastText: string;
  tracking: Tracking;
  /** As the chat names it: <id>#<n>; "" when it has none. */
  launch: string;
  spoke: boolean;
  /** What its tools carry to say whose they are; "" once it leaves. Kept in memory only. */
  token: string;
  recalled: Set<string>;
  /** The inputs of the turns asked for and not opened yet, oldest first. */
  triggers: { readonly trigger: T.RunTrigger; readonly envelopeIds: readonly string[]; readonly inputId?: string }[];
  /** Runtime input ids waiting for evidence that their envelopes entered or were returned. */
  readonly inputs: Map<string, readonly string[]>;
  /** The open turn's run and what it heard. */
  run: string;
  heard: string[];
  report: T.IssueReport | undefined;
  settling?: { readonly report: SubagentReport; readonly completedBefore: number };
}

export class Session extends Context.Service<
  Session,
  {
    readonly noRoom: (runtime: string, project: string) => string;
    /** Room for one more on runtime in project: refused when either is at its limit; a full farm sends home whoever has
     * been idle longest, and says who. */
    readonly makeRoom: (runtime: string, project: string) => Effect.Effect<{ readonly refused: string } | { readonly evicted?: string }>;
    readonly send: (agent: T.Agent, brief: string, where: string, opt: SendOptions) => Effect.Effect<Hired>;
    readonly deliver: (id: string, text: string, input: DeliveryInput) => Effect.Effect<Delivered>;
    readonly stop: (id: string) => Effect.Effect<boolean>;
    /** Closes an idle execution, keeping the context and native session identity for its next input. */
    readonly suspend: (id: string) => Effect.Effect<boolean, ApiError>;
    readonly withIdleWorkplace: <A, E>(id: string, use: (place: Workplace) => Effect.Effect<A, E>) => Effect.Effect<A, E | ApiError>;
    readonly withWorkplace: <A, E>(id: string, use: (place: Workplace) => Effect.Effect<A, E>) => Effect.Effect<A, E | ApiError>;
    /** Discard resets its branch only after the runtime has stopped writing. */
    /** closed: how it leaves, "dismissed" unless its issue was completed without a merge ("completed"). */
    readonly dismiss: (id: string, work?: "keep" | "discard", closed?: "dismissed" | "completed") => Effect.Effect<boolean, ApiError>;
    /** A read-only round's leftovers go: its worktree back to the main branch, what it changed or committed gone; the
     * session stays. Not while a round goes on (the next report resets it). */
    readonly discardWork: (id: string) => Effect.Effect<void, ApiError>;
    /** Removes an issue's unused workplace; an active or unclosed startup still owns it. */
    readonly clearWorkplace: (issue: string, project: string, number: number, work?: WorkplaceCleanup) => Effect.Effect<WorkplaceRelease, ApiError>;
    /** A session on the farm now, as the core state has it: what another module reads a session by. */
    readonly sessionOf: (id: string) => T.Session | undefined;
    readonly presentSessions: () => readonly T.Session[];
    /** On the farm now: it can be handed a message. */
    readonly present: (id: string) => boolean;
    /** Its complete last answer, kept out of the core frame. */
    readonly lastTextOf: (id: string) => string;
    /** Its host-local working directory, kept out of the protocol shape. */
    readonly cwdOf: (id: string) => string | undefined;
    /** The run it is in now; undefined between runs. */
    readonly runOf: (id: string) => string | undefined;
    /** Its report, from what it last said in full. */
    readonly reportOf: (id: string) => string;
    /** The structure the worker explicitly hands back for its current run. */
    readonly report: (id: string, report: T.IssueReport) => Effect.Effect<void, ApiError>;
    /** The helper working the issue now, if one is. */
    readonly onIssue: (issue: string) => string | undefined;
    /** The session hands its workplace over and leaves as closed says: use takes the work in (Source Control's merge, pull
     * request, merge into a task graph's branch), given the workplace and the session's last words in full. Refused while
     * it works. Work that does not go in keeps the session and its branch, and says in NotTakenIn what
     * the helper is sent back with and what the owner is told; settle says who settles a conflict. A pull request left
     * open keeps the session too. */
    readonly handOver: (
      id: string,
      closed: T.SessionClose,
      use: (place: Workplace, lastText: string) => Effect.Effect<Merged, MergeFailure | ProjectError>,
      settle?: Settle,
    ) => Effect.Effect<Merged, ApiError | NotTakenIn>;
    /** Every session of the agent, or of every agent when it is empty: on the farm and ended, newest first. */
    readonly list: (agent: string) => Effect.Effect<T.Session[]>;
    /** A session on the farm, or one that has ended. */
    readonly get: (id: string) => Effect.Effect<T.Session | undefined>;
    readonly issueRuns: (issue: string) => Effect.Effect<T.Run[]>;
    /** A session's log, oldest first; a run's only when run is given. */
    readonly events: (id: string, run?: string) => Effect.Effect<T.SessionEvent[] | undefined>;
    /** These four are subscribed before they return: nothing published after is missed. */
    readonly launches: Effect.Effect<Stream.Stream<LaunchActivity>, never, Scope.Scope>;
    /** A session hired, reported or gone, with the session as it stood after: what the issues and task graphs follow. */
    readonly news: Effect.Effect<Stream.Stream<SessionNews>, never, Scope.Scope>;
    readonly startedIssues: Effect.Effect<Stream.Stream<string>, never, Scope.Scope>;
    readonly finishedRuns: Effect.Effect<Stream.Stream<RunFinished>, never, Scope.Scope>;
    readonly inputsConsumed: Effect.Effect<Stream.Stream<InputConsumed>, never, Scope.Scope>;
    readonly inputsReturned: Effect.Effect<Stream.Stream<InputReturned>, never, Scope.Scope>;
    /** Persists an Agent's Session identity before anything can record a Run or address its mailbox. */
    readonly register: (session: SessionIdentity) => Effect.Effect<void, NotRecorded>;
    /** Whose token it is; "" when nobody's. */
    readonly who: (token: string) => string;
    /** For a farm listening on a free port: sessions opened from now on reach /mcp there. */
    readonly setAddress: (address: string) => void;
    /** An agent run in this process (the orchestrator), in the caller's scope: its log and its runs are kept as a session's are. */
    readonly host: <R>(options: HostOptions<R>) => Effect.Effect<AgentHost<R>, NotRecorded, Scope.Scope>;
    /** Brings back the sessions the farm had when it stopped, once every service is ready. */
    readonly restore: Effect.Effect<void, NotRecorded>;
  }
>()("vibevalley/Session") {
  static readonly layer = Layer.effect(
    Session,
    Effect.suspend(() => make),
  );
}

/** What inProcessRun.ts keeps runs with; a write that fails is an error the run retries. */
export interface RunStore {
  readonly start: (id: string, session: string, issue: string, trigger: T.RunTrigger) => Effect.Effect<void, NotRecorded>;
  readonly link: (run: string, issue: string) => Effect.Effect<void, NotRecorded>;
  readonly heard: (run: string, heard: readonly string[]) => Effect.Effect<void, NotRecorded>;
  readonly issues: (run: string) => Effect.Effect<T.IssueId[], NotRecorded>;
  readonly finish: (id: string, outcome: T.Outcome, summary: string, spent?: T.Spent) => Effect.Effect<void, NotRecorded>;
  readonly finished: (r: RunFinished) => void;
  readonly consumed: (c: InputConsumed) => void;
  readonly register: (session: string, currentRun: () => string) => void;
}

/** A session's own fact as news; the rest are not the sessions'. */
export function newsOf(fact: T.Fact, after: T.WorkspaceState): SessionNews | undefined {
  switch (fact.type) {
    case "session": {
      const session = after.sessions.find((h) => h.id === fact.session.id);
      return session?.role === "worker" ? { _tag: "hired", session } : undefined;
    }
    case "sessionReport": {
      const session = after.sessions.find((h) => h.id === fact.id);
      return session?.role === "worker" ? { _tag: "reported", report: fact, session } : undefined;
    }
    case "sessionGone":
      return { _tag: "left", left: fact };
    default:
      return undefined;
  }
}

/** Work that did not go in (see handOver); the session stays. */
export class NotTakenIn extends Schema.TaggedError<NotTakenIn, { readonly brand: unique symbol }>()("NotTakenIn", {
  failure: MergeFailure,
  /** What the helper is sent back with; "" when the owner settles it. */
  fix: Schema.String,
  /** What the owner is told; also the message. */
  owner: Schema.String,
  notice: Schema.String,
  short: Schema.String,
  message: Schema.String,
}) {}

/** A failure's words, whatever it is. */
const reasonText = (e: unknown): string => (e instanceof Error ? e.message : Schema.is(ApiErrorSchema)(e) ? reasonOf(e) : String(e));

import { restoredSession, sessionState, runOf, endedSession, placeOf, heardOf } from "./history.ts";
export { runOf } from "./history.ts";
/** A turn submitted and not opened yet, counted from since: its slot is taken, as one thinking. */
const reserved = (since: number): T.Session["phase"] => ({ _tag: "working", since, doing: { action: "thinking", label: "" } });
const make = Effect.gen(function* () {
  const runSync = Effect.runSyncWith(yield* Effect.context());
  const config = yield* ServerConfig;
  const core = yield* Core;
  const fs = yield* FileSystem.FileSystem;
  const store = yield* Agent;
  const memories = yield* Memory;
  const projects = yield* Project;
  const runtimes = yield* Runtime;
  const executor = yield* Executor;
  const db = yield* Db;
  // Fibers started from callbacks belong to this service: they end with it and keep its services (the logger).
  const forkHere = yield* FiberSet.makeRuntime();
  const fire = <A, E>(e: Effect.Effect<A, E>) => void forkHere(e);
  const pendingRuns = yield* Queue.unbounded<Effect.Effect<void>>();
  yield* Effect.forkScoped(Effect.forever(Effect.flatten(Queue.take(pendingRuns))));
  const recordRun = (write: Effect.Effect<void>) => void Queue.offerUnsafe(pendingRuns, write);
  const flushRuns = Effect.gen(function* () {
    const done = yield* Deferred.make<void>();
    recordRun(Effect.asVoid(Deferred.succeed(done, undefined)));
    yield* Deferred.await(done);
  });
  // Waits started from callbacks (the save, each session's stall): one fiber per key, a new one replacing the last,
  // all ended with the service.
  const timers = yield* FiberMap.make<string>();
  const later = yield* FiberMap.runtime(timers)();
  // For oar's callbacks (a session's events, its report, a stall), which run outside any fiber and must land in the
  // order oar gives them: core.apply and core.notice are synchronous and need no services. Effect code yields them.
  const apply = (...facts: FactIn[]) => runSync(core.apply(...facts));
  const notice = (level: "info" | "warn" | "error", text: string) => runSync(core.notice(level, text));

  const stallMs = config.session.stallSeconds * 1000;
  const clock = yield* Clock.Clock;
  let mcpUrl = `http://${serverAddress(config)}/mcp`;
  const trajectories = yield* makeTrajectories(config.home, (id, e) => runSync(core.sessionEvent(id, e)));
  // A hand is acquired before admission; no path holding admission waits for a hand.
  const admission = yield* Semaphore.make(1);

  const launchesHub = yield* scopedPubSub<LaunchActivity>();
  // The sessions' own facts, told as news in the order they were applied.
  const newsHub = yield* scopedPubSub<SessionNews>();
  const [, moves] = yield* core.transitions;
  yield* Effect.forkScoped(
    Stream.runForEach(moves, ({ fact, after }) => {
      const news = newsOf(fact, after);
      if (news?._tag === "reported" && news.session?.role === "worker" && news.session.issue === undefined) {
        const id = news.session.id;
        const deadline = fact.at + 10 * 60_000;
        void later(
          `idle:${id}`,
          Effect.gen(function* () {
            yield* Effect.sleep(Math.max(0, deadline - (yield* Clock.currentTimeMillis)));
            yield* shape.suspend(id);
          }).pipe(bestEffort(`vibevalley: suspending conversation ${id}`)),
        );
      }
      return news ? PubSub.publish(newsHub, news) : Effect.void;
    }),
  );
  const startedIssuesHub = yield* scopedPubSub<string>();
  const finishedHub = yield* scopedPubSub<RunFinished>();
  const consumedHub = yield* scopedPubSub<InputConsumed>();
  const returnedHub = yield* scopedPubSub<InputReturned>();
  const signal = (a: LaunchActivity) => PubSub.publishUnsafe(launchesHub, a);

  const hands = new Map<string, Hand>();
  const executions = new Map<string, () => string>();
  let hired = 0;
  let launches = 0;
  const launchOf = (id: string) => `${id}#${++launches}`;
  let closing = false;

  // Tokens tell sessions apart and guard nothing (sessions already run unsandboxed here), so they live on the hand.
  const issueToken = (h: Hand) => {
    const token = "hb_" + h.id + "_" + randomBytes(18).toString("base64url");
    h.token = token;
    return token;
  };
  const revokeToken = (h: Hand) => {
    h.token = "";
  };
  const who = (token: string) => (token === "" ? "" : ([...hands.values()].find((h) => h.token === token)?.id ?? ""));

  // A session's own row keeps what taking it up again needs, so it goes with the database: one made again from a new
  // schema brings back no session (and none on an issue the database no longer has).
  const handRow = (h: Hand) => {
    const oar = h.oarSessionId;
    return {
      id: h.id,
      place: JSON.stringify(h.place),
      oar_session: oar || null,
      last_text: h.lastText || null,
      recalled: h.recalled.size > 0 ? JSON.stringify([...h.recalled].toSorted()) : null,
    };
  };
  const keepHands = Effect.suspend(() =>
    db.inTx(
      Effect.gen(function* () {
        yield* Effect.forEach(core.state().sessions, (session) => db.run(qs.keepSessionState(sessionState(session))), { discard: true });
        yield* Effect.forEach([...hands.values()], (h) => db.run(qs.keepHand(handRow(h))), { discard: true });
      }),
    ),
  ).pipe(bestEffort("session: recovery state was not saved"));

  const save = () => {
    if (closing) return;
    later("save", Effect.delay(keepHands, saveAfterMs));
  };

  const [, changedSessions] = yield* core.transitions;
  yield* Effect.forkScoped(
    Stream.runForEach(changedSessions, (change) =>
      Effect.sync(() => {
        if (change.before.sessions !== change.after.sessions) save();
      }),
    ),
  );
  yield* Effect.forEach(
    yield* db.run(qs.activeSessions()),
    (row) =>
      Effect.gen(function* () {
        const session = restoredSession(row);
        yield* core.apply({ type: "session", session });
      }),
    { discard: true },
  );

  const keepRow = (row: qs.KeepSessionParams) =>
    db.attempt(qs.keepSession(row)).pipe(Effect.mapError((cause) => new NotRecorded({ message: causeMessage(cause), cause })));

  const register = Effect.fn("Session.register")(function* (session: SessionIdentity) {
    const hiredAt = yield* Clock.currentTimeMillis;
    yield* keepRow({
      ...session,
      project: null,
      issue: null,
      channel: null,
      hired_at: hiredAt,
    });
    if (!core.session(session.id))
      yield* core.apply({
        type: "session",
        session: {
          ...session,
          id: sessionId(session.id),
          hiredAt,
          runs: 0,
          refining: false,
          phase: { _tag: "resting" },
        },
      });
  });

  yield* Effect.forEach(
    store.orchestrators(),
    (agent) => register({ id: agent.id, role: "orchestrator", agent: agent.id, name: agent.name, runtime: agent.runtime, brief: agent.duty }),
    { discard: true },
  );

  const keep = (s: T.Session) =>
    keepRow({
      id: s.id,
      role: s.role,
      agent: s.agent,
      name: s.name,
      runtime: s.runtime,
      brief: s.brief,
      project: s.project ?? null,
      issue: s.issue ?? null,
      channel: s.channel ?? null,
      hired_at: s.hiredAt,
    });

  const ended = (id: string, closed: T.SessionClose) =>
    db.attempt(qs.endSession({ ended_at: clock.currentTimeMillisUnsafe(), closed, id })).pipe(bestEffort(`vibevalley: session ${id}'s end not kept`));

  const forget = (id: string) => db.attempt(qs.forgetSession({ id })).pipe(bestEffort(`vibevalley: unstarted session ${id} not forgotten`));

  /** The session kept, with its log. */
  const logOf = (s: T.Session, journal: Journal) => Effect.as(Effect.andThen(keep(s), db.run(qs.keepSessionState(sessionState(s)))), journal);

  const runs = yield* recording;

  /** Called before the input goes out, so the turn it opens finds it. */
  const expect = (h: Hand, input: DeliveryInput, inputId?: string) =>
    void h.triggers.push({ trigger: input.trigger, envelopeIds: input.envelopeIds, ...(inputId === undefined ? {} : { inputId }) });
  /** Undoes expect when the input did not open a turn. */
  const unexpect = (h: Hand) => void h.triggers.pop();

  const startRun = (h: Hand) => {
    const expected = h.triggers.shift();
    const by = expected?.trigger ?? { kind: "runtime" };
    const issue = core.session(h.id)?.issue ?? h.issue;
    const id = newId();
    // Known at once, so a report that follows closely finds the run; its row follows.
    h.run = id;
    h.heard = [];
    h.report = undefined;
    recordRun(db.run(qs.clearPendingReport({ id: h.id })).pipe(bestEffort(`vibevalley: ${h.id}'s previous report was not cleared`)));
    h.journal.runStarted(id);
    recordRun(runs.start(id, h.id, issue, by).pipe(bestEffort("vibevalley: a run not kept"), Effect.annotateLogs({ session: h.id })));
    if (expected?.inputId === undefined && expected !== undefined && expected.envelopeIds.length > 0) consume(h, expected.envelopeIds);
  };

  const consume = (h: Hand, envelopeIds: readonly string[]) => {
    const fresh = envelopeIds.filter((id) => !h.heard.includes(id));
    if (fresh.length === 0) return;
    h.heard.push(...fresh);
    if (h.run) recordRun(runs.heard(h.run, h.heard).pipe(bestEffort(`vibevalley: run ${h.run}`)));
    PubSub.publishUnsafe(consumedHub, { session: h.id, envelopeIds: fresh });
  };

  const inputChanged = (h: Hand, input: ExecutionInput) => {
    const envelopeIds = h.inputs.get(input.inputId);
    if (envelopeIds === undefined) return;
    h.inputs.delete(input.inputId);
    if (input.kind === "consumed") consume(h, envelopeIds);
    else PubSub.publishUnsafe(returnedHub, { session: h.id, envelopeIds });
  };

  const endRun = (h: Hand, outcome: T.Outcome, summary: string, spent?: T.Spent) => {
    const id = h.run;
    h.run = "";
    h.heard = [];
    if (!id) return;
    h.journal.runEnded(id, outcome);
    const issue = core.session(h.id)?.issue;
    recordRun(
      db
        .inTx(
          Effect.gen(function* () {
            yield* runs.finish(id, outcome, summary, spent);
            const session = core.session(h.id);
            if (session) yield* db.run(qs.keepSessionState(sessionState(session)));
            yield* db.run(qs.clearPendingReport({ id: h.id }));
          }),
        )
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (issue) PubSub.publishUnsafe(finishedHub, { id, issues: [issue], outcome });
            }),
          ),
          bestEffort(`vibevalley: run ${id}`),
        ),
    );
  };

  const closedLaunch = (h: Hand) => {
    if (h.launch) signal({ kind: "closed", id: h.id, launch: h.launch });
    h.launch = "";
  };

  const record = (j: Journal, op: Op) => {
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
          signals.push({ kind: "spoke", id: h.id, launch: h.launch });
        }
      } else if (event.kind === "compaction_started") signals.push({ kind: "compacting", id: h.id, on: true });
      else if (event.kind === "compaction_ended") signals.push({ kind: "compacting", id: h.id, on: false });
    }
    const reaction = eventFacts(event, core.session(h.id), h.tracking, { id: h.id, runtime, cwd: h.place.cwd });
    h.tracking = reaction.tracking;
    if (reaction.model) h.tracking = omitUndefined({ ...h.tracking, rate: runtimes.quote(runtime, reaction.model) });
    if (opened) startRun(h);
    for (const a of signals) signal(a);
    for (const op of reaction.journal) record(h.journal, op);
    for (const fact of reaction.facts) {
      if (fact.type === "sessionReport") {
        const report = h.run ? { ...fact, run: h.run } : fact;
        apply(report);
        endRun(h, report.outcome, report.summary, report.spent);
      } else apply(fact);
    }
    if (reaction.spentCny !== 0) runtimes.spend(runtime, reaction.spentCny);
    if (reaction.warn) notice("warn", reaction.warn);
    if (event.kind === "exited") {
      delete h.settling;
      closedLaunch(h);
    }
  };

  const applyReport = (h: Hand, report: SubagentReport, completedBefore: number) => {
    if (report.outcome.kind === "completed" && !handsToOwner(h.report) && (executor.find(h.id)?.pendingTasks ?? 0) > 0) {
      h.settling = { report, completedBefore };
      const channel = core.session(h.id)?.channel;
      apply({
        type: "sessionPhase",
        id: h.id,
        ...(channel !== undefined ? { channel } : {}),
        phase: { _tag: "working", since: clock.currentTimeMillisUnsafe(), doing: { action: "wait", label: "" } },
      });
      signal({ kind: "settling", id: h.id, launch: h.launch });
      return;
    }
    delete h.settling;
    finishReport(h, report, completedBefore);
  };

  const finishReport = (h: Hand, report: SubagentReport, completedBefore: number) => {
    const session = core.session(h.id);
    if (!session) return;
    const read = readReport(report.outcome, report.text);
    const declared = h.report;
    const canRest = read.outcome === "completed" && session.issue !== undefined && !handsToOwner(declared);
    h.report = undefined;
    const summary = declared?.summary.trim() || read.summary;
    const spent = session.spent ? since(session.spent, h.tracking.runFrom) : undefined;
    h.lastText = read.text;
    h.tracking = omitUndefined({ ...h.tracking, runFrom: undefined });
    const { launch, spoke } = h;
    apply({
      type: "sessionReport",
      id: h.id,
      outcome: read.outcome,
      ...(canRest ? { phase: { _tag: "resting" as const } } : {}),
      summary,
      runs: completedBefore + report.turn,
      ...(spent ? { spent } : {}),
      ...(h.run ? { run: h.run } : {}),
      questions: declared?.questions ?? read.questions,
      checks: declared?.checks ?? read.checks,
      ...(declared?.answer ? { answer: declared.answer } : {}),
    });
    // reduce folds the fact synchronously; the reported phase tells whether the session rests.
    const waiting = core.session(h.id)?.phase._tag === "resting";
    endRun(h, read.outcome, summary, spent);
    fire(
      memories.keep({
        agent: session.agent,
        session: h.id,
        ...(session.issue ? { issue: session.issue } : {}),
        project: h.place.project,
        brief: session.brief,
        outcome: read.outcome,
        said: read.text,
        summary,
      }),
    );
    if (declared && declared.remember.length > 0)
      fire(
        Effect.forEach(
          declared.remember,
          (memory) =>
            memories.write({ agent: session.agent, text: memory.text, project: memory.scope === "all" ? "" : h.place.project, by: sessionActor(h.id) }),
          { discard: true },
        ).pipe(bestEffort(`vibevalley: ${h.id}'s declared memories were not kept`)),
      );
    if (read.needsYou) notice("error", t("server.session.life.stoppedNeedsYou", { name: session.name, why: read.failure }));
    if (launch) signal({ kind: read.outcome === "completed" && !waiting ? "handedOff" : "ended", id: h.id, launch, outcome: read.outcome, spoke });
    runtimes.usageSoon(session.runtime);
    save();
  };

  const stalled = (h: Hand, silentForMs: number, at: number) => {
    const session = core.session(h.id);
    if (session?.phase._tag !== "working") return;
    h.tracking = { ...h.tracking, quiet: true };
    apply(phaseFact(session, { ...session.phase, quietSince: at - silentForMs }));
    const quiet =
      silentForMs < 60_000
        ? t("server.session.life.seconds", { n: Math.round(silentForMs / 1000) })
        : t("server.session.life.minutes", { n: Math.round(silentForMs / 60_000) });
    const last = session.phase.doing.label ? t("server.session.log.quietLast", { label: session.phase.doing.label }) : "";
    h.journal.note("run/error", t("server.session.log.quiet", { span: quiet, last }));
    notice("warn", t("server.session.life.quietNotice", { name: session.name, span: quiet, last }));
  };

  const release = (h: Hand) => executor.detach(h.id);

  const attach = (h: Hand, s: Execution, runtime: string, launch = launchOf(h.id)) => {
    h.launch = launch;
    h.spoke = false;
    if (s.sessionId) h.oarSessionId = s.sessionId;
    h.tracking = omitUndefined({ ...h.tracking, oarTokens: undefined });
    const completedBefore = core.session(h.id)?.runs ?? 0;
    executor.observe(h.id, {
      event: watch(h, launch, runtime),
      input: (input) => inputChanged(h, input),
      report: (report) => applyReport(h, report, completedBefore),
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

  const failedOpening = Effect.fnUntraced(function* (id: string, why: string): Effect.fn.Return<StartFailure> {
    const failure = yield* executor.failed(id, why);
    if (failure.retained) yield* core.notice("error", failure.refused);
    return failure;
  });

  const open = Effect.fnUntraced(function* (
    agent: T.Agent,
    owner: T.Session,
    hand: Hand,
    place: Workplace,
    input: string,
    resume: string,
  ): Effect.fn.Return<Started> {
    const text = [
      instructions(agent, store.skills()),
      owner.issue
        ? workplaceRules(place, yield* projects.houseRules(), owner.id, projects.usesPullRequests(place.project))
        : channelRules(place.cwd, owner.channel ?? "", owner.id),
    ]
      .filter((s) => s !== "")
      .join("\n\n");
    const mcp = [
      { name: "vibevalley", type: "http" as const, url: mcpUrl, headers: { authorization: "Bearer " + issueToken(hand) } },
      ...agent.mcpServers.map(toOarMcp),
    ];
    const options: Partial<SessionOptions> = {
      mcpServers: mcp,
      ...(text && agent.personaMode === "append" ? { appendSystemPrompt: text } : {}),
      ...(text && agent.personaMode === "replace" ? { systemPrompt: text } : {}),
      ...(agent.disallowedTools.length > 0 ? { disallowedTools: agent.disallowedTools } : {}),
    };
    const opened = yield* executor.start({
      agent,
      owner,
      cwd: place.cwd,
      input: text && agent.personaMode === "prompt" ? text + briefBreak + input : input,
      resume,
      options,
    });
    if (opened.retained === true) yield* core.notice("error", opened.refused);
    return opened;
  });

  const leave = Effect.fn("Session.leave")(function* (h: Hand, closed: T.SessionClose, merged: number) {
    yield* FiberMap.remove(timers, `idle:${h.id}`);
    release(h);
    yield* flushRuns;
    yield* trajectories.finish(h.id);
    yield* ended(h.id, closed);
    closedLaunch(h);
    revokeToken(h);
    hands.delete(h.id);
    const session = core.session(h.id);
    if (session) yield* memories.endSession({ agent: session.agent, session: h.id, project: h.place.project });
    yield* core.apply({ type: "sessionGone", id: h.id, closed, ...(merged > 0 ? { merged } : {}) });
    save();
  });

  const closeExecution = (h: Hand) => executor.close(h.id);

  /** Lets the oar session go, keeping its id to resume. */
  const rest = Effect.fn("Session.rest")(function* (h: Hand) {
    yield* closeExecution(h);
    release(h);
    closedLaunch(h);
    save();
  });

  const accessWorkplace = Effect.fn("Session.accessWorkplace")(function* <A, E>(id: string, use: (place: Workplace) => Effect.Effect<A, E>, idle: boolean) {
    const hand = hands.get(id);
    if (!hand) return yield* Effect.fail(missing(t("server.session.life.helperRef", { id }), [lookIn.session]));
    return yield* hand.access.withPermits(1)(
      Effect.gen(function* () {
        const session = core.session(id);
        if (hands.get(id) !== hand || !session) return yield* Effect.fail(missing(t("server.session.life.helperRef", { id }), [lookIn.session]));
        if (idle) {
          if (isBusy(session) || hand.triggers.length > 0) return yield* Effect.fail(refused(t("server.session.life.stillWorking", { name: session.name })));
          yield* rest(hand);
        }
        return yield* use(hand.place);
      }),
    );
  });

  const capacity = (): Pick<T.Session, "id" | "agent" | "runtime" | "project" | "phase">[] => {
    const visible = core.state().sessions.filter((s) => s.role === "worker");
    return [
      ...visible.map((s) => {
        const h = hands.get(s.id);
        const allocation = executor.find(s.id);
        const opening = allocation !== undefined && (!allocation.attached || allocation.closing);
        // A submitted turn owns its slot before oar opens it: its trigger is the reservation.
        return (opening || (h !== undefined && h.triggers.length > 0)) && !isBusy(s) ? { ...s, phase: reserved(clock.currentTimeMillisUnsafe()) } : s;
      }),
      ...executor
        .all()
        .filter((a) => !visible.some((s) => s.id === a.owner.id))
        .map((a) => ({ ...a.owner, phase: reserved(clock.currentTimeMillisUnsafe()) })),
    ];
  };

  const limits = (runtime: string): SessionLimits => ({
    workspace: maxRunning,
    perProject: projects.limit,
    perRuntime: store.settings(runtime).maxWorking ?? 0,
  });

  const roomFor = (runtime: string, project: string) => noRoom(capacity(), runtime, project.trim(), limits(runtime));

  const remind = Effect.fn("Session.remind")(function* (agent: string, session: string, project: string, input: string, recalled: Set<string>) {
    const found = yield* memories.recall({ agent, session, project, text: input, skip: new Set(recalled) });
    for (const id of found.ids) recalled.add(id);
    if (found.ids.length > 0) save();
    return recallBlock(found.lines);
  });

  const wake = Effect.fn("Session.wake")(function* (h: Hand, session: T.Session, input: string, recall: string): Effect.fn.Return<Delivered> {
    const agent = store.agent(session.agent);
    if (!agent) return { kind: "refused", reason: t("server.session.life.agentGone", { name: session.name }) };
    const stopped = yield* Effect.result(rest(h));
    if (stopped._tag === "Failure") return { kind: "refused", reason: reasonOf(stopped.failure) };
    const resume = h.oarSessionId;
    let opened = yield* open(agent, session, h, h.place, withRecall(recall, input), resume);
    if (!opened.execution && !opened.retained && resume) {
      h.recalled.clear();
      const again = yield* remind(session.agent, h.id, h.place.project, input, h.recalled);
      opened = yield* open(agent, session, h, h.place, withRecall(again, (session.issue ? restartedNote : restartedContextNote) + input), "");
    }
    if (!opened.execution) return { kind: "refused", reason: t("server.session.life.cannotWake", { name: session.name, why: opened.refused }) };
    attach(h, opened.execution, session.runtime);
    return { kind: "run", launch: h.launch || h.id, woke: true };
  });

  const deliver = Effect.fn("Session.deliver")(function* (id: string, text: string, input: DeliveryInput): Effect.fn.Return<Delivered> {
    const h = hands.get(id);
    if (!h) return { kind: "refused", reason: t("server.session.life.noHelper", { id }) };
    return yield* h.access.withPermits(1)(
      admission.withPermits(1)(
        Effect.gen(function* (): Effect.fn.Return<Delivered> {
          const session = core.session(id);
          if (hands.get(id) !== h || !session) return { kind: "refused", reason: t("server.session.life.noHelper", { id }) };
          const execution = executor.find(id);
          if (execution?.closing === true) return { kind: "refused", reason: t("server.session.life.stillClosing", { name: session.name }) };
          const starts = !isBusy(session);
          let recall = "";
          if (starts) {
            const full = noRoom(capacity(), session.runtime, h.place.project, limits(session.runtime), id, input.byOwnerComment);
            if (full) return { kind: "refused", reason: t("server.session.life.noRoom", { name: session.name, full }) };
            recall = yield* remind(session.agent, id, h.place.project, text, h.recalled);
          }
          if (execution?.attached !== true || !h.launch) {
            expect(h, input);
            const d = yield* wake(h, session, text, recall);
            if (d.kind === "refused") unexpect(h);
            return d;
          }
          const launch = h.launch;
          const inputId = newId();
          h.inputs.set(inputId, input.envelopeIds);
          if (starts) expect(h, input);
          const sent = yield* executor.deliver(id, withRecall(recall, text), inputId);
          if (sent.kind === "accepted" && sent.landed === "prompted") {
            h.inputs.delete(inputId);
            return { kind: "run", launch };
          }
          if (starts) unexpect(h);
          if (sent.kind !== "accepted") {
            h.inputs.delete(inputId);
            return { kind: "refused", reason: t("server.session.life.notReceived", { name: session.name, why: sent.reason }) };
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
        }),
      ),
    );
  });

  const handOver = Effect.fn("Session.handOver")(function* (
    id: string,
    closed: T.SessionClose,
    use: (place: Workplace, lastText: string) => Effect.Effect<Merged, MergeFailure | ProjectError>,
    settle: Settle = "owner",
  ) {
    const h = hands.get(id);
    if (!h) return yield* Effect.fail<ApiError | NotTakenIn>(missing(t("server.session.life.helperRef", { id }), [lookIn.session]));
    return yield* h.access.withPermits(1)(
      Effect.gen(function* () {
        const current = core.session(id);
        if (hands.get(id) !== h || !current)
          return yield* Effect.fail<ApiError | NotTakenIn>(missing(t("server.session.life.helperRef", { id }), [lookIn.session]));
        if (!current.issue) return yield* Effect.fail<ApiError | NotTakenIn>(refused(t("server.session.life.noIssue")));
        if (isBusy(current) || h.triggers.length > 0)
          return yield* Effect.fail<ApiError | NotTakenIn>(refused(t("server.session.life.stillWorking", { name: current.name })));
        yield* rest(h);
        const merged = yield* use(h.place, h.lastText).pipe(
          Effect.mapError((e) => {
            const f = Predicate.isTagged(e, "MergeFailure") ? e : MergeFailure.error(reasonText(e));
            const words = notTakenIn(f, current.name, settle);
            return new NotTakenIn({ failure: f, ...words, message: words.owner });
          }),
        );
        if (merged.pullRequest) return merged;
        yield* leave(h, closed, closed === "merged" ? merged.commits : 0);
        if (merged.warning) yield* core.notice("warn", merged.warning);
        return merged;
      }),
    );
  });

  const expireLogs = Effect.fn("Session.expireLogs")(function* (days: number) {
    if (days <= 0) return;
    const ids = yield* db.run(qs.sessionsEndedBefore({ before: (yield* Clock.currentTimeMillis) - days * dayMs }));
    yield* Effect.forEach(ids, (r) => trajectories.forget(r.id), { discard: true });
  });

  const restore = Effect.gen(function* () {
    yield* expireLogs(config.session.trajectoryDays);
    // The runs still going when the server stopped stopped with it.
    yield* Effect.forEach(
      yield* db.run(qr.openRuns()),
      (r) =>
        Effect.gen(function* () {
          yield* runs.finish(r.id, "interrupted", t("server.session.log.restarted"));
          const linked = yield* runs.issues(r.id);
          PubSub.publishUnsafe(finishedHub, { id: r.id, issues: linked, outcome: "interrupted" } satisfies RunFinished);
        }).pipe(bestEffort(`vibevalley: run ${r.id}`)),
      { discard: true },
    );
    const kept = yield* db.run(qs.activeSessions());
    // Numbering goes on from the highest id seen, so a new session never takes an old one's steps.
    hired = Math.max(
      0,
      (yield* db.run(qs.highestSessionNumber())).n ?? 0,
      ...core
        .state()
        .sessions.map((s) => Number.parseInt(s.id.replace(/^w/u, ""), 10))
        .filter((n) => Number.isFinite(n)),
    );
    for (const row of kept) {
      if (row.role === "orchestrator") continue;
      const session = core.session(row.id) ?? restoredSession(row);
      const place = row.place ? placeOf(row.place) : undefined;
      if (!place || !(yield* Effect.orElseSucceed(fs.exists(place.cwd), () => false))) {
        yield* core.apply({ type: "sessionGone", id: session.id, closed: "lost" });
        yield* trajectories.finish(session.id);
        yield* ended(session.id, "lost");
        yield* core.notice(
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
        report: row.pending_report === null ? undefined : jsonOrNone(S.IssueReport)(row.pending_report),
      };
      hands.set(session.id, {
        id: session.id,
        place: s.place,
        issue: session.issue ?? "",
        access: Semaphore.makeUnsafe(1),
        journal: yield* logOf(session, yield* trajectories.openLog(session.id)),
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
      });
      if (isBusy(session)) {
        yield* core.apply({
          type: "sessionReport",
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
          yield* Effect.forEach(
            restoredReport.remember,
            (memory) =>
              memories.write({ agent: session.agent, text: memory.text, project: memory.scope === "all" ? "" : place.project, by: sessionActor(session.id) }),
            { discard: true },
          ).pipe(bestEffort(`vibevalley: ${session.id}'s restored memories were not kept`));
        yield* db.inTx(
          Effect.gen(function* () {
            const restored = core.session(session.id);
            if (restored) yield* db.run(qs.keepSessionState(sessionState(restored)));
            yield* db.run(qs.clearPendingReport({ id: session.id }));
          }),
        );
        yield* core.notice("info", t("server.session.life.restartedNotice", { name: session.name }));
      }
    }
    if (hands.size > 0) yield* Effect.logInfo(`vibevalley: brought back ${hands.size} helpers`);
  });

  // The sessions are let go first: a turn cut off by the shutdown is reported when the farm comes back, not on the way out.
  // The database closes after this layer: what brings the sessions back is written while it is still open.
  yield* Effect.addFinalizer(() =>
    Effect.andThen(
      Effect.suspend(() => {
        closing = true;
        return Effect.andThen(FiberMap.remove(timers, "save"), Effect.andThen(flushRuns, keepHands));
      }),
      Effect.sync(() => {
        for (const h of [...hands.values()]) {
          h.journal.close();
          release(h);
        }
      }),
    ),
  );

  const runStore: RunStore = {
    ...runs,
    start: Effect.fn("Session.startHostedRun")(function* (id, session, issue, trigger) {
      yield* runs.start(id, session, issue, trigger);
      if (issue) PubSub.publishUnsafe(startedIssuesHub, issue);
    }),
    link: Effect.fn("Session.linkHostedIssue")(function* (run, issue) {
      yield* runs.link(run, issue);
      PubSub.publishUnsafe(startedIssuesHub, issue);
    }),
    finished: (r) => PubSub.publishUnsafe(finishedHub, r),
    consumed: (c) => PubSub.publishUnsafe(consumedHub, c),
    register: (session, current) => void executions.set(session, current),
  };
  const shape = Session.of({
    noRoom: roomFor,
    makeRoom: Effect.fn("Session.makeRoom")(function* (runtime, project): Effect.fn.Return<{ readonly refused: string } | { readonly evicted?: string }> {
      const full = roomFor(runtime, project);
      if (full) return { refused: full };
      const oldest = whoMakesRoom(
        core.state().sessions.filter((s) => executor.find(s.id) !== undefined),
        maxRunning,
      );
      if (!oldest) return {};
      const freeing = oldest.issue ? shape.dismiss(oldest.id) : shape.suspend(oldest.id);
      return yield* freeing.pipe(Effect.match({ onFailure: (e) => ({ refused: reasonOf(e) }), onSuccess: () => ({ evicted: oldest.name }) }));
    }),
    send: Effect.fn("Session.send")(function* (agent, brief, where, opt) {
      const permit = yield* Scope.fork(yield* Effect.scope);
      yield* Effect.acquireRelease(Effect.interruptible(admission.take(1)), (taken) => admission.release(taken)).pipe(
        Effect.provideService(Scope.Scope, permit),
      );
      const issue = opt.context.kind === "issue" ? opt.context.issue : undefined;
      const channel = opt.context.kind === "channel" ? opt.context.channel : opt.channel;
      const project = issue ? where : "";
      const unclosed = executor
        .all()
        .find((a) => (issue ? a.owner.issue === issue.id : !a.owner.issue && a.owner.agent === agent.id && a.owner.channel === channel));
      if (unclosed)
        return {
          refused: unclosed.failure ?? t(issue ? "server.session.life.issueNotReturned" : "server.session.life.notReturned"),
          retainedWork: true as const,
        };
      const full = roomFor(agent.runtime, project);
      if (full) return { refused: full };
      hired++;
      const id = sessionId(`w${hired}`);
      const placed = yield* Effect.result(
        issue
          ? projects.workplace(project, issue.number, opt.worktree ?? agent.worktree, opt.base ?? "")
          : contextPlace(config.workRoot, id).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
      );
      if (placed._tag === "Failure") return { refused: t("server.session.life.noPlace", { name: agent.name, why: placed.failure.message }) };
      const place = placed.success;
      const releasePlace = issue ? projects.release(place) : releaseContextPlace(place).pipe(Effect.provideService(FileSystem.FileSystem, fs));
      let committed = false;
      let released = false;
      let registeredRow = false;
      const recalled = new Set<string>();
      const journal = yield* trajectories.openLog(id);
      const initial = opt.inputs ?? [];
      const h: Hand = {
        id,
        place,
        issue: issue?.id ?? "",
        access: Semaphore.makeUnsafe(1),
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
      const starting = Effect.gen(function* () {
        const recall = yield* remind(agent.id, id, place.project, brief, recalled);
        const hiredAt = yield* Clock.currentTimeMillis;
        const session: T.Session = {
          id,
          role: "worker",
          name: sessionName(capacity(), agent.id, agent.name),
          agent: agent.id,
          runtime: agent.runtime,
          brief,
          ...(place.project ? { project: place.project } : {}),
          hiredAt,
          runs: 0,
          phase: { _tag: "working", since: hiredAt, doing: { action: "none", label: "" } },
          ...(channel ? { channel } : {}),
          refining: issue ? (opt.refining ?? false) : false,
          ...(issue ? { issue: issue.id } : {}),
          ...(place.branch ? { branch: place.branch, worktree: place.cwd } : {}),
        };
        const refuseStart = (why: string, retained: boolean): Effect.Effect<Hired> =>
          Effect.gen(function* () {
            yield* trajectories.finish(id);
            if (retained) return { refused: why, retainedWork: true };
            revokeToken(h);
            const result = yield* releasePlace;
            released = true;
            if (result.kept) yield* core.notice("warn", result.reason);
            return { refused: why, ...(result.kept ? { retainedWork: true as const } : {}) };
          });
        const initialText = initial.map((input) => `${input.id}\n${input.card.summary}\n${input.card.readUri}`).join("\n\n");
        const source = issue?.mandate?.originTriggerId;
        const prompt = [brief, source ? sourceBrief(source) : "", initialText].filter(Boolean).join("\n\n");
        const opened = yield* open(agent, session, h, place, withRecall(recall, prompt), "");
        if (!opened.execution) return yield* refuseStart(t("server.session.life.cannotSend", { name: agent.name, why: opened.refused }), opened.retained);
        // The execution now reserves capacity; source registration may take the channel lock, whose delivery waits on admission.
        yield* Scope.close(permit, Exit.void);
        const launch = launchOf(id);
        return yield* Effect.gen(function* () {
          yield* db.inTx(
            Effect.gen(function* () {
              yield* logOf(session, journal);
              yield* db
                .attempt(
                  qs.keepHand({
                    id,
                    place: JSON.stringify(place),
                    oar_session: opened.execution.sessionId ?? null,
                    last_text: null,
                    recalled: recalled.size > 0 ? JSON.stringify([...recalled]) : null,
                  }),
                )
                .pipe(Effect.mapError((cause) => new NotRecorded({ message: causeMessage(cause), cause })));
            }),
          );
          registeredRow = true;
          if (opt.hiring) yield* opt.hiring(session, launch);
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              hands.set(id, h);
              yield* core.apply({ type: "session", session });
              attach(h, opened.execution, agent.runtime, launch);
              committed = true;
            }),
          );
          return { session };
        }).pipe(
          Effect.catchTag("NotRecorded", (error) =>
            Effect.gen(function* () {
              const failed = yield* failedOpening(id, t("server.session.life.notRecorded", { name: agent.name, why: reasonText(error) }));
              if (!failed.retained) {
                yield* forget(id);
                registeredRow = false;
              }
              return yield* refuseStart(failed.refused, failed.retained);
            }),
          ),
        );
      });
      return yield* starting.pipe(
        Effect.onExit((exit) => {
          if (exit._tag === "Success" || committed || released) return Effect.void;
          return Effect.gen(function* () {
            yield* trajectories.finish(id);
            const allocation = executor.find(id);
            if (allocation?.attached === true) return;
            if (allocation) {
              const stopped = yield* Effect.result(executor.close(id));
              if (stopped._tag === "Failure") {
                yield* core.notice("error", allocation.failure ?? reasonOf(stopped.failure));
                return;
              }
            }
            if (registeredRow) yield* forget(id);
            revokeToken(h);
            const result = yield* releasePlace;
            if (result.kept) yield* core.notice("warn", result.reason);
          });
        }),
      );
    }, Effect.scoped),
    deliver,
    stop: Effect.fn("Session.stop")(function* (id) {
      const execution = executor.find(id);
      const hand = hands.get(id);
      if (!hand || execution?.attached !== true || execution.closing || core.session(id)?.phase._tag !== "working") return false;
      if (hand.settling)
        return yield* hand.access
          .withPermits(1)(
            Effect.gen(function* () {
              const pending = hand.settling;
              if (!pending) return false;
              executor.detach(id);
              yield* executor.close(id);
              delete hand.settling;
              finishReport(hand, { ...pending.report, outcome: { kind: "aborted" } }, pending.completedBefore);
              closedLaunch(hand);
              return true;
            }),
          )
          .pipe(Effect.catch((error) => Effect.as(Effect.logWarning(`vibevalley: background work did not close: ${reasonOf(error)}`), false)));
      const outcome = yield* executor.interrupt(id);
      if (outcome.kind !== "accepted") {
        yield* Effect.logWarning(`vibevalley: the stop was not taken: ${"reason" in outcome ? outcome.reason : ""}`).pipe(Effect.annotateLogs({ session: id }));
        return false;
      }
      return true;
    }),
    suspend: Effect.fn("Session.suspend")(function* (id) {
      const h = hands.get(id);
      if (!h) return false;
      return yield* h.access.withPermits(1)(
        Effect.gen(function* () {
          const session = core.session(id);
          if (hands.get(id) !== h || !session || isBusy(session) || h.triggers.length > 0) return false;
          yield* rest(h);
          yield* keepHands;
          return true;
        }),
      );
    }),
    dismiss: Effect.fn("Session.dismiss")(function* (id, work = "keep", closed = "dismissed") {
      const h = hands.get(id);
      if (!h) return false;
      return yield* h.access.withPermits(1)(
        Effect.gen(function* () {
          if (hands.get(id) !== h) return false;
          const current = core.session(id);
          const name = current?.name ?? id;
          if (work === "discard" && !current?.issue) return yield* Effect.fail(refused(t("server.session.life.noIssue")));
          yield* closeExecution(h);
          if (work === "discard" && h.place.branch) {
            const reset = yield* Effect.result(projects.reset(h.place));
            if (reset._tag === "Failure") yield* core.notice("warn", t("server.session.life.notReset", { name, why: reset.failure.message }));
          }
          yield* leave(h, closed, 0);
          const kept = current?.issue ? yield* projects.release(h.place) : { kept: false as const };
          if (kept.kept) yield* core.notice("info", t("server.session.life.left", { name, why: kept.reason }));
          return true;
        }),
      );
    }),
    discardWork: Effect.fn("Session.discardWork")(function* (id) {
      const h = hands.get(id);
      if (!core.session(id)?.issue) return yield* Effect.fail(refused(t("server.session.life.noIssue")));
      if (!h?.place.branch) return;
      yield* h.access.withPermits(1)(
        Effect.gen(function* () {
          const s = core.session(id);
          if (hands.get(id) !== h || !s || isBusy(s)) return;
          const reset = yield* Effect.result(projects.reset(h.place));
          if (reset._tag === "Failure") yield* core.notice("warn", t("server.session.life.notReset", { name: s.name, why: reset.failure.message }));
        }),
      );
    }),
    clearWorkplace: Effect.fn("Session.clearWorkplace")(function* (issue, project, number, work) {
      const unclosed = executor.all().find((a) => a.owner.issue === issue);
      if (unclosed) return yield* Effect.fail(refused(unclosed.failure ?? t("server.session.life.issueNotReturned")));
      if (core.state().sessions.some((s) => s.issue === issue)) return yield* Effect.fail(refused(t("server.session.life.stillHasHelper")));
      return yield* projects.clear(project, number, work);
    }, admission.withPermits(1)),
    handOver,
    withIdleWorkplace: Effect.fn("Session.withIdleWorkplace")(function* <A, E>(id: string, use: (place: Workplace) => Effect.Effect<A, E>) {
      return yield* accessWorkplace(id, use, true);
    }),
    withWorkplace: Effect.fn("Session.withWorkplace")(function* <A, E>(id: string, use: (place: Workplace) => Effect.Effect<A, E>) {
      return yield* accessWorkplace(id, use, false);
    }),
    list: Effect.fn("Session.list")(function* (agent) {
      const out = core.state().sessions.filter((s) => !agent || s.agent === agent);
      const rows = yield* db.run(qs.endedSessions({ agent, n: endedListed }));
      const runs = yield* db.run(qr.runsOfSessions({ sessions: rows.map((r) => r.id) }));
      const bySession = Map.groupBy(runs, (r) => r.session);
      for (const r of rows) if (!out.some((s) => s.id === r.id)) out.push(endedSession(r, bySession.get(r.id) ?? []));
      return out.toSorted((a, b) => b.hiredAt - a.hiredAt);
    }),
    get: Effect.fn("Session.get")(function* (id) {
      const live = core.session(id);
      if (live) return live;
      const r = yield* db.run(Effect.catchNoSuchElement(qs.sessionByID({ id })));
      if (Option.isNone(r) || r.value.ended_at === null) return undefined;
      return endedSession(r.value, yield* db.run(qr.runsOfSession({ session: id })));
    }),
    issueRuns: Effect.fn("Session.issueRuns")(function* (issue) {
      const rows = yield* db.run(qr.runsOfIssue({ issue_id: issue }));
      return rows.map(runOf);
    }),
    events: (id, r) => trajectories.events(id, r),
    sessionOf: (id) => core.session(id),
    presentSessions: () => core.state().sessions.filter((s) => s.role === "worker"),
    present: (id) => hands.has(id),
    lastTextOf: (id) => hands.get(id)?.lastText ?? "",
    cwdOf: (id) => hands.get(id)?.place.cwd,
    runOf: (id) => {
      const run = hands.get(id)?.run ?? executions.get(id)?.() ?? "";
      return run === "" ? undefined : run;
    },
    reportOf: (id) => summaryOf(hands.get(id)?.lastText ?? ""),
    report: Effect.fn("Session.report")(function* (id, report) {
      const h = hands.get(id);
      const session = core.session(id);
      if (!h || !session?.issue || !h.run) return yield* Effect.fail(refused(t("server.session.life.noHelper", { id })));
      yield* h.access.withPermits(1)(
        Effect.gen(function* () {
          yield* flushRuns;
          yield* db.attempt(qs.setPendingReport({ id, report: JSON.stringify(report) })).pipe(Effect.mapError((error) => refused(causeMessage(error))));
          h.report = report;
          if (h.settling && handsToOwner(report)) {
            const pending = h.settling;
            delete h.settling;
            finishReport(h, pending.report, pending.completedBefore);
          }
        }),
      );
    }),
    onIssue: (issue) => sessionOnIssue(core.state(), issue)?.id,
    launches: Effect.map(PubSub.subscribe(launchesHub), Stream.fromSubscription),
    news: Effect.map(PubSub.subscribe(newsHub), Stream.fromSubscription),
    startedIssues: Effect.map(PubSub.subscribe(startedIssuesHub), Stream.fromSubscription),
    finishedRuns: Effect.map(PubSub.subscribe(finishedHub), Stream.fromSubscription),
    inputsConsumed: Effect.map(PubSub.subscribe(consumedHub), Stream.fromSubscription),
    inputsReturned: Effect.map(PubSub.subscribe(returnedHub), Stream.fromSubscription),
    register,
    who,
    setAddress: (address) => void (mcpUrl = `http://${address}/mcp`),
    host: Effect.fn("Session.host")(function* <R>(o: HostOptions<R>) {
      yield* register(o.session);
      const hostedRuns: RunStore = {
        ...runStore,
        finish: Effect.fn("Session.finishHostedRun")(function* (run, outcome, summary, spent) {
          yield* runStore.finish(run, outcome, summary, spent);
          const session = core.session(o.session.id);
          if (session)
            yield* core.apply({
              type: "sessionReport",
              id: session.id,
              run,
              outcome,
              summary,
              runs: session.runs + 1,
              questions: [],
              checks: [],
              ...(spent ? { spent } : {}),
            });
        }),
      };
      return yield* makeHost(
        { ...o, memory: memories.forAgent(o.session.agent, o.session.id) },
        yield* trajectories.openLog(o.session.id, o.keepEvents),
        hostedRuns,
      ).pipe(Effect.provideService(Core, core), Effect.provideService(FileSystem.FileSystem, fs));
    }),
    restore,
  });
  return shape;
});

/** Brings the sessions back once every service is built. */
export const ready = Layer.effectDiscard(Effect.flatMap(Session, (s) => s.restore));
