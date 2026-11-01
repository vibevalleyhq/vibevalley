// Admission serializes room and opening turns; each hand owns its input, handover and departure, so one worktree's
// checks do not hold the other sessions.

import { randomBytes } from "node:crypto";

import type { Event, SessionOptions } from "@botiverse/oar";
import type { SubagentReport } from "@botiverse/oar/agents";
import { Clock, Context, Effect, Exit, FiberMap, FiberSet, FileSystem, Layer, Option, Predicate, PubSub, Schema, Scope, Semaphore, Stream } from "effect";
import type { SqlClient } from "effect/sql";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { dayMs, maxRunning } from "@vibevalley/protocol";
import { ApiError as ApiErrorSchema } from "@vibevalley/protocol/api";
import { isBusy, omitUndefined } from "@vibevalley/protocol/rules";
import { issueId, sessionId } from "@vibevalley/protocol/schema";

import { Agent } from "@/agent/agent.ts";
import { newId } from "@/base/ids.ts";
import { scopedPubSub } from "@/base/pubsub.ts";
import { Core, type FactIn } from "@/core/core.ts";
import { type ApiError, missing, lookIn, reasonOf, refused } from "@/errors.ts";
import { Executor, type Execution, type Started, type StartFailure } from "@/executor/executor.ts";
import { serverAddress, ServerConfig } from "@/infra/config.ts";
import { causeMessage, Db } from "@/infra/db.ts";
import { bestEffort } from "@/infra/log.ts";
import { Memory } from "@/memory/memory.ts";
import { Project } from "@/project/project.ts";
import { type Merged, MergeFailure, type ProjectError, type Workplace, type WorkplaceCleanup, type WorkplaceRelease } from "@/project/shapes.ts";
import { Runtime } from "@/runtime/runtime.ts";

import { instructions, briefBreak, recallBlock, toOarMcp, withRecall } from "./briefing.ts";
import { eventFacts, type Op, since, type Tracking } from "./facts.ts";
import { noRoom, type SessionLimits, sessionName, whoMakesRoom } from "./hiring.ts";
import { type AgentHost, type HostOptions, makeHost } from "./host.ts";
import { type Journal, makeTrajectories } from "./journal.ts";
import { channelRules, restartedContextNote, restartedNote, workplaceRules } from "./prompts.ts";
import { readReport, summaryOf } from "./report.ts";
import { sessionOnIssue } from "./roster.ts";
import type { Delivered, InputConsumed, LaunchActivity, SessionNews } from "./shapes.ts";
import { conflictOf, notTakenIn, sameConflict, type Settle } from "./takeIn.ts";
import { contextPlace, releaseContextPlace } from "./workspace.ts";

export type { SessionNews };
import * as qs from "../../db/generated/session.sql.ts";
import * as qr from "../../db/generated/session_run.sql.ts";
import * as qi from "../../db/generated/session_run_issue.sql.ts";

/** A burst of changes is one write. */
const saveAfterMs = 300;
/** The ended sessions a list shows, newest first: their trajectories expire after days anyway. */
const endedListed = 200;

export interface Roster {
  readonly session: T.Session;
  readonly place: Workplace;
  readonly lastText: string;
}

export interface Hired {
  readonly session?: T.Session;
  readonly refused?: string;
  /** Who was sent home to make room. */
  readonly evicted?: string;
  /** A refused dispatch left work behind: its issue identity must be kept. */
  readonly retainedWork?: true;
}

export interface HireOptions {
  /** The branch its own branch starts from; empty: the project's main branch. */
  readonly base?: string;
  readonly worktree?: boolean;
  readonly taskGraph?: T.SessionGraph;
  readonly channel?: string;
  /** Empty: the Issue service writes one from the issue before opening its session. */
  readonly issue?: string;
  /** What its first run is for; the issue sent out when none. */
  readonly trigger?: T.RunTrigger;
  /** It drafts the issue rather than works it. */
  readonly refining?: boolean;
}

export interface SendOptions extends Omit<HireOptions, "issue"> {
  readonly context: { readonly kind: "issue"; readonly issue: Pick<T.Issue, "id" | "number"> } | { readonly kind: "channel"; readonly channel: string };
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
  readonly access: Semaphore.Semaphore;
  readonly journal: Journal;
  /** The oar session it is attached to; undefined between launches. */
  sess: Execution | undefined;
  oarSessionId: string;
  lastText: string;
  tracking: Tracking;
  /** As the chat names it: <id>#<n>; "" when it has none. */
  launch: string;
  spoke: boolean;
  recalled: Set<string>;
  /** The triggers of the turns asked for and not opened yet, oldest first. */
  triggers: T.RunTrigger[];
  /** The open turn's run and what it heard. */
  run: string;
  heard: string[];
}

export class Session extends Context.Service<
  Session,
  {
    readonly noRoom: (runtime: string, project: string) => string;
    /** Room for one more on runtime in project: refused when either is at its limit; a full farm sends home whoever has
     * been idle longest, and says who. */
    readonly makeRoom: (runtime: string, project: string) => Effect.Effect<{ readonly refused: string } | { readonly evicted?: string }>;
    readonly send: (agent: T.Agent, brief: string, where: string, opt: SendOptions) => Effect.Effect<Hired>;
    readonly deliver: (id: string, text: string, by: T.RunTrigger) => Effect.Effect<Delivered>;
    readonly stop: (id: string) => Effect.Effect<boolean>;
    /** Closes an idle execution, keeping the context and native session identity for its next input. */
    readonly suspend: (id: string) => Effect.Effect<boolean, ApiError>;
    /** Discard resets its branch only after the runtime has stopped writing. */
    /** closed: how it leaves, "dismissed" unless its issue was completed without a merge ("completed"). */
    readonly dismiss: (id: string, work?: "keep" | "discard", closed?: "dismissed" | "completed") => Effect.Effect<boolean, ApiError>;
    /** A read-only round's leftovers go: its worktree back to the main branch, what it changed or committed gone; the
     * session stays. Not while a round goes on (the next report resets it). */
    readonly discardWork: (id: string) => Effect.Effect<void, ApiError>;
    /** Removes an issue's unused workplace; an active or unclosed startup still owns it. */
    readonly clearWorkplace: (issue: string, project: string, number: number, work?: WorkplaceCleanup) => Effect.Effect<WorkplaceRelease, ApiError>;
    readonly roster: () => Roster[];
    readonly find: (id: string) => Roster | undefined;
    /** A session on the farm now, as the core state has it: what another module reads a session by. */
    readonly sessionOf: (id: string) => T.Session | undefined;
    readonly presentSessions: () => readonly T.Session[];
    /** On the farm now: it can be handed a message. */
    readonly present: (id: string) => boolean;
    /** The run it is in now; undefined between runs. */
    readonly runOf: (id: string) => string | undefined;
    /** Its report, from what it last said in full. */
    readonly reportOf: (id: string) => string;
    /** The helper working the issue now, if one is. */
    readonly onIssue: (issue: string) => string | undefined;
    /** The session hands its workplace over and leaves as closed says: use takes the work in (Source Control's merge, pull
     * request, merge into a task graph's branch), given the workplace and the session's last words in full. Refused while
     * it works. Work that does not go in keeps the session and its branch, marks a conflict, and says in NotTakenIn what
     * the helper is sent back with and what the owner is told; settle says who settles a conflict. A pull request left
     * open keeps the session too. */
    readonly handOver: (
      id: string,
      closed: T.SessionClose,
      use: (place: Workplace, lastText: string) => Effect.Effect<Merged, MergeFailure | ProjectError>,
      settle?: Settle,
    ) => Effect.Effect<Merged, ApiError | NotTakenIn>;
    /** What the session's branch would bring now; the conflict it shows is kept on the session. */
    readonly changes: (id: string) => Effect.Effect<T.Changes | undefined, ApiError>;
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
    readonly finishedRuns: Effect.Effect<Stream.Stream<RunFinished>, never, Scope.Scope>;
    readonly inputsConsumed: Effect.Effect<Stream.Stream<InputConsumed>, never, Scope.Scope>;
    /** Whose token it is; "" when nobody's. */
    readonly who: (token: string) => string;
    /** For a farm listening on a free port: sessions opened from now on reach /mcp there. */
    readonly setAddress: (address: string) => void;
    /** An agent run in this process (the orchestrator), in the caller's scope: its log and its runs are kept as a session's are. */
    readonly host: <R>(options: HostOptions<R>) => Effect.Effect<AgentHost<R>, never, Scope.Scope>;
    /** Brings back the sessions the farm had when it stopped, once every service is ready. */
    readonly restore: Effect.Effect<void>;
  }
>()("vibevalley/Session") {
  static readonly layer = (options?: SessionOptionsIn) => Layer.effect(Session, make(options));
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
    case "hired": {
      const session = after.sessions.find((h) => h.id === fact.session.id);
      return session ? { _tag: "hired", session } : undefined;
    }
    case "report":
      return { _tag: "reported", report: fact, session: after.sessions.find((h) => h.id === fact.id) };
    case "left":
      return { _tag: "left", left: fact };
    default:
      return undefined;
  }
}

/** A write of a session's own records (a run, the issue it works) that did not go through. */
export class NotRecorded extends Schema.TaggedError<NotRecorded, { readonly brand: unique symbol }>()("NotRecorded", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

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

import { runOf, endedSession, placeOf, heardOf } from "./history.ts";
export { runOf } from "./history.ts";
/** A turn submitted and not opened yet, counted from since: its slot is taken, as one thinking. */
const reserved = (since: number): T.Session["phase"] => ({ _tag: "working", since, doing: { action: "thinking", label: "" } });
export interface SessionOptionsIn {
  /** The time a session may be quiet before it is said to be; tests make it short. */
  readonly stallMs?: number;
}

export const make = (options: SessionOptionsIn = {}) =>
  Effect.gen(function* () {
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
    const run = yield* FiberSet.makeRuntimePromise();
    const forkHere = yield* FiberSet.makeRuntime();
    /** A write whose failure the caller handles. */
    const tried = <A, E>(e: Effect.Effect<A, E, SqlClient.SqlClient>) =>
      db.attempt(e).pipe(Effect.mapError((cause) => new NotRecorded({ message: causeMessage(cause), cause })));
    const fire = <A, E>(e: Effect.Effect<A, E>) => void forkHere(e);
    // Waits started from callbacks (the save, each session's stall): one fiber per key, a new one replacing the last,
    // all ended with the service.
    const timers = yield* FiberMap.make<string>();
    const later = yield* FiberMap.runtime(timers)();
    // For oar's callbacks (a session's events, its report, a stall), which run outside any fiber and must land in the
    // order oar gives them: core.apply and core.notice are synchronous and need no services. Effect code yields them.
    const apply = (...facts: FactIn[]) => runSync(core.apply(...facts));
    const notice = (level: "info" | "warn" | "error", text: string) => runSync(core.notice(level, text));

    const stallMs = options.stallMs ?? config.session.stallSeconds * 1000;
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
        return news ? PubSub.publish(newsHub, news) : Effect.void;
      }),
    );
    const finishedHub = yield* scopedPubSub<RunFinished>();
    const consumedHub = yield* scopedPubSub<InputConsumed>();
    const signal = (a: LaunchActivity) => PubSub.publishUnsafe(launchesHub, a);

    const hands = new Map<string, Hand>();
    const executions = new Map<string, () => string>();
    const tokens = new Map<string, string>();
    let hired = 0;
    let launches = 0;
    const launchOf = (id: string) => `${id}#${++launches}`;
    let closing = false;

    // Tokens tell sessions apart and guard nothing (sessions already run unsandboxed here), so they are kept in memory only.
    const issueToken = (session: string) => {
      const token = "hb_" + session + "_" + randomBytes(18).toString("base64url");
      tokens.set(session, token);
      return token;
    };
    const revokeToken = (session: string) => void tokens.delete(session);
    const who = (token: string) => [...tokens.entries()].find(([, item]) => item === token)?.[0] ?? "";

    // A session's own row keeps what taking it up again needs, so it goes with the database: one made again from a new
    // schema brings back no session (and none on an issue the database no longer has).
    const handRow = (h: Hand) => {
      const oar = h.sess?.sessionId || h.oarSessionId;
      return {
        id: h.id,
        place: JSON.stringify(h.place),
        oar_session: oar || null,
        last_text: h.lastText || null,
        recalled: h.recalled.size > 0 ? JSON.stringify([...h.recalled].toSorted()) : null,
      };
    };
    const keepHands = Effect.suspend(() =>
      Effect.forEach(
        [...hands.values()],
        (h) => db.attempt(qs.keepHand(handRow(h))).pipe(bestEffort(`vibevalley: session ${h.id}: what brings it back not kept`)),
        { discard: true },
      ),
    );

    const save = () => {
      if (closing) return;
      later("save", Effect.delay(keepHands, saveAfterMs));
    };

    const keep = (s: T.Session) =>
      db
        .attempt(
          qs.keepSession({
            id: s.id,
            agent: s.agent,
            name: s.name,
            runtime: s.runtime,
            brief: s.brief,
            project: s.project ?? null,
            issue: s.issue ?? null,
            channel: s.channel ?? null,
            graph: s.graph ? JSON.stringify(s.graph) : null,
            hired_at: s.hiredAt,
          }),
        )
        .pipe(bestEffort(`vibevalley: session ${s.id} not kept`));

    const ended = (id: string, closed: T.SessionClose) =>
      db.attempt(qs.endSession({ ended_at: clock.currentTimeMillisUnsafe(), closed, id })).pipe(bestEffort(`vibevalley: session ${id}'s end not kept`));

    /** The session kept, with its log. */
    const logOf = (s: T.Session, journal: Journal) => Effect.as(keep(s), journal);

    // A run's record, the helpers' and the in-process agent's alike (inProcessRun.ts): one way to open, hear, link and end it.
    const runs = {
      start: (id: string, session: string, issue: string, trigger: T.RunTrigger) =>
        tried(qr.startRun({ id, session, issue: issue || null, triggered_by: JSON.stringify(trigger), started_at: clock.currentTimeMillisUnsafe() })),
      /** A run that takes several issues (the in-process agent's) is linked to each; session_run.issue is its first. */
      link: (r: string, issue: string) => tried(qi.linkRunIssue({ run: r, issue })),
      heard: (r: string, heard: readonly string[]) => tried(qr.heardInRun({ heard: JSON.stringify(heard), id: r })),
      issues: (r: string) => Effect.map(tried(qi.runIssues({ run: r })), (rows) => rows.map((x) => issueId(x.issue))),
      finish: (id: string, outcome: T.Outcome, summary: string, spent?: T.Spent) =>
        tried(qr.endRun({ ended_at: clock.currentTimeMillisUnsafe(), outcome, summary: summary || null, spent: spent ? JSON.stringify(spent) : null, id })),
    };

    /** Called before the input goes out, so the turn it opens finds it. */
    const expect = (h: Hand, by: T.RunTrigger) => void h.triggers.push(by);
    /** Undoes expect when the input did not open a turn. */
    const unexpect = (h: Hand) => void h.triggers.pop();

    const startRun = (h: Hand) => {
      const by = h.triggers.shift() ?? { kind: "runtime" };
      const issue = core.session(h.id)?.issue ?? "";
      const id = newId();
      // Known at once, so a report that follows closely finds the run; its row follows.
      h.run = id;
      h.heard = [];
      h.journal.runStarted(id);
      fire(runs.start(id, h.id, issue, by).pipe(bestEffort("vibevalley: a run not kept"), Effect.annotateLogs({ session: h.id })));
    };

    const heardInRun = (h: Hand, message: string) => {
      if (!h.run) return;
      h.heard.push(message);
      fire(runs.heard(h.run, h.heard).pipe(bestEffort(`vibevalley: run ${h.run}`)));
    };

    const endRun = (h: Hand, outcome: T.Outcome, summary: string, spent?: T.Spent) => {
      const id = h.run;
      h.run = "";
      h.heard = [];
      if (!id) return;
      h.journal.runEnded(id, outcome);
      fire(runs.finish(id, outcome, summary, spent).pipe(bestEffort(`vibevalley: run ${id}`)));
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

    const watch = (h: Hand, s: Execution, runtime: string) => (event: Event) => {
      let opened = false;
      const signals: LaunchActivity[] = [];
      if (h.launch && h.sess === s && event.agentPath.length === 0) {
        if (event.kind === "turn_started") {
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
      if (opened) {
        for (const fact of reaction.facts) if (fact.type === "run") apply(fact);
        startRun(h);
      }
      for (const a of signals) signal(a);
      for (const op of reaction.journal) record(h.journal, op);
      for (const fact of reaction.facts) {
        if (opened && fact.type === "run") continue;
        if (fact.type === "report") {
          const report = h.run ? { ...fact, run: h.run } : fact;
          apply(report);
          endRun(h, report.outcome, report.summary, report.spent);
        } else apply(fact);
      }
      if (reaction.spentCny !== 0) runtimes.spend(runtime, reaction.spentCny);
      if (reaction.warn) notice("warn", reaction.warn);
      if (event.kind === "exited") closedLaunch(h);
    };

    const applyReport = (h: Hand, report: SubagentReport, completedBefore: number) => {
      const session = core.session(h.id);
      if (!session) return;
      const read = readReport(report.outcome, report.text);
      const spent = session.spent ? since(session.spent, h.tracking.runFrom) : undefined;
      h.lastText = read.text;
      h.tracking = omitUndefined({ ...h.tracking, runFrom: undefined });
      const { launch, spoke } = h;
      apply({
        type: "report",
        id: h.id,
        outcome: read.outcome,
        summary: read.summary,
        runs: completedBefore + report.turn,
        ...(spent ? { spent } : {}),
        ...(h.run ? { run: h.run } : {}),
        questions: read.questions,
        checks: read.checks,
        ...(read.answer ? { answer: read.answer } : {}),
      });
      endRun(h, read.outcome, read.summary, spent);
      fire(
        memories.keep({
          agent: session.agent,
          session: h.id,
          ...(session.issue ? { issue: session.issue } : {}),
          project: h.place.project,
          brief: session.brief,
          outcome: read.outcome,
          said: read.text,
          summary: read.summary,
        }),
      );
      if (read.needsYou) notice("error", t("server.session.life.stoppedNeedsYou", { name: session.name, why: read.failure }));
      if (launch) signal({ kind: "ended", id: h.id, launch, outcome: read.outcome, spoke });
      runtimes.usageSoon(session.runtime);
      save();
    };

    const stalled = (h: Hand, silentForMs: number, at: number) => {
      const session = core.session(h.id);
      if (session?.phase._tag !== "working") return;
      h.tracking = { ...h.tracking, quiet: true };
      apply({ type: "quiet", id: h.id, since: at - silentForMs });
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
      h.sess = s;
      h.launch = launch;
      h.spoke = false;
      if (s.sessionId) h.oarSessionId = s.sessionId;
      h.tracking = omitUndefined({ ...h.tracking, oarTokens: undefined });
      const completedBefore = core.session(h.id)?.runs ?? 0;
      executor.observe(h.id, {
        event: watch(h, s, runtime),
        report: (report) => applyReport(h, report, completedBefore),
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

    const open = Effect.fnUntraced(function* (agent: T.Agent, owner: T.Session, place: Workplace, input: string, resume: string): Effect.fn.Return<Started> {
      const text = [
        instructions(agent, store.skills()),
        owner.issue
          ? workplaceRules(place, yield* projects.houseRules(), owner.id, projects.usesPullRequests(place.project))
          : channelRules(place.cwd, owner.channel ?? "", owner.id),
      ]
        .filter((s) => s !== "")
        .join("\n\n");
      const mcp = [
        { name: "vibevalley", type: "http" as const, url: mcpUrl, headers: { authorization: "Bearer " + issueToken(owner.id) } },
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
      release(h);
      yield* trajectories.finish(h.id);
      yield* ended(h.id, closed);
      closedLaunch(h);
      revokeToken(h.id);
      hands.delete(h.id);
      const session = core.session(h.id);
      if (session) yield* memories.endSession({ agent: session.agent, session: h.id, project: h.place.project });
      yield* core.apply({ type: "left", id: h.id, closed, ...(merged > 0 ? { merged } : {}) });
      save();
    });

    const closeExecution = (h: Hand) => executor.close(h.id);

    /** Lets the oar session go, keeping its id to resume. */
    const rest = Effect.fn("Session.rest")(function* (h: Hand) {
      const s = h.sess;
      yield* closeExecution(h);
      if (!s) return;
      if (s.sessionId) h.oarSessionId = s.sessionId;
      release(h);
      h.sess = undefined;
      closedLaunch(h);
      save();
    });

    const capacity = (): T.Session[] => {
      const visible = core.state().sessions;
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
          .map((a) => a.owner),
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
      let opened = yield* open(agent, session, h.place, withRecall(recall, input), resume);
      if (!opened.execution && !opened.retained && resume) {
        h.recalled.clear();
        const again = yield* remind(session.agent, h.id, h.place.project, input, h.recalled);
        opened = yield* open(agent, session, h.place, withRecall(again, (session.issue ? restartedNote : restartedContextNote) + input), "");
      }
      if (!opened.execution) return { kind: "refused", reason: t("server.session.life.cannotWake", { name: session.name, why: opened.refused }) };
      attach(h, opened.execution, session.runtime);
      return { kind: "run", launch: h.launch || h.id, woke: true };
    });

    const deliver = Effect.fn("Session.deliver")(function* (id: string, text: string, by: T.RunTrigger): Effect.fn.Return<Delivered> {
      const h = hands.get(id);
      if (!h) return { kind: "refused", reason: t("server.session.life.noHelper", { id }) };
      return yield* h.access.withPermits(1)(
        admission.withPermits(1)(
          Effect.gen(function* (): Effect.fn.Return<Delivered> {
            const session = core.session(id);
            if (hands.get(id) !== h || !session) return { kind: "refused", reason: t("server.session.life.noHelper", { id }) };
            if (h.sess?.closing === true) return { kind: "refused", reason: t("server.session.life.stillClosing", { name: session.name }) };
            const starts = !isBusy(session);
            let recall = "";
            if (starts) {
              const full = noRoom(capacity(), session.runtime, h.place.project, limits(session.runtime), id);
              if (full) return { kind: "refused", reason: t("server.session.life.noRoom", { name: session.name, full }) };
              recall = yield* remind(session.agent, id, h.place.project, text, h.recalled);
            }
            const s = h.sess;
            if (!s || !h.launch) {
              expect(h, by);
              const d = yield* wake(h, session, text, recall);
              if (d.kind === "refused") unexpect(h);
              return d;
            }
            const launch = h.launch;
            if (starts) expect(h, by);
            const sent = yield* executor.deliver(id, withRecall(recall, text));
            if (sent.kind === "accepted" && sent.landed === "prompted") return { kind: "run", launch };
            if (starts) unexpect(h);
            if (sent.kind !== "accepted") return { kind: "refused", reason: t("server.session.life.notReceived", { name: session.name, why: sent.reason }) };
            if (sent.landed === "queued") {
              expect(h, by);
              return { kind: "queued", launch };
            }
            if (by.message) heardInRun(h, by.message);
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
          if (closed === "merged" && current.graph)
            return yield* Effect.fail<ApiError | NotTakenIn>(refused(t("server.session.life.inGraph", { name: current.name, graph: current.graph.id })));
          if (isBusy(current) || h.triggers.length > 0)
            return yield* Effect.fail<ApiError | NotTakenIn>(refused(t("server.session.life.stillWorking", { name: current.name })));
          yield* rest(h);
          const merged = yield* use(h.place, h.lastText).pipe(
            Effect.mapError((e) => {
              const f = Predicate.isTagged(e, "MergeFailure") ? e : MergeFailure.error(reasonText(e));
              if (f.kind === "conflict") apply({ type: "conflict", id: current.id, conflict: { base: f.base, files: [...f.files] } });
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

    /** The freshest word on conflicts is a preview of the branch; the session's state follows it. */
    const changesOf = Effect.fn("Session.changes")(function* (id: string) {
      if (!core.session(id)?.issue) return undefined;
      const place = hands.get(id)?.place;
      if (!place) return undefined;
      const changes = yield* projects.changes(place).pipe(Effect.mapError((e) => refused(e.message)));
      const conflict = conflictOf(changes);
      const session = core.session(id);
      if (session && !sameConflict(session.conflict, conflict)) yield* core.apply({ type: "conflict", id: session.id, ...(conflict ? { conflict } : {}) });
      return changes;
    });

    const recheck = Effect.fn("Session.recheck")(function* (id: string) {
      const place = hands.get(id)?.place;
      const session = core.session(id);
      if (!place || !session?.issue) return;
      const conflict = yield* projects.conflict(place, session.conflict?.base ?? "");
      if (!sameConflict(session.conflict, conflict)) yield* core.apply({ type: "conflict", id: session.id, ...(conflict ? { conflict } : {}) });
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
        (r) => runs.finish(r.id, "interrupted", t("server.session.log.restarted")).pipe(bestEffort(`vibevalley: run ${r.id}`)),
        { discard: true },
      );
      const kept = new Map((yield* db.run(qs.hands())).map((r) => [r.id, r]));
      // Numbering goes on from the highest id seen, so a new session never takes an old one's steps.
      hired = Math.max(
        0,
        (yield* db.run(qs.highestSessionNumber())).n ?? 0,
        ...core
          .state()
          .sessions.map((s) => Number.parseInt(s.id.replace(/^w/u, ""), 10))
          .filter((n) => Number.isFinite(n)),
      );
      for (const session of core.state().sessions) {
        const row = kept.get(session.id);
        const place = row?.place ? placeOf(row.place) : undefined;
        if (!row || !place || !(yield* Effect.orElseSucceed(fs.exists(place.cwd), () => false))) {
          yield* core.apply({ type: "left", id: session.id, closed: "lost" });
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
        const s = { place, oarSessionId: row.oar_session ?? "", lastText: row.last_text ?? "", recalled: heardOf(row.recalled) ?? [] };
        hands.set(session.id, {
          id: session.id,
          place: s.place,
          access: Semaphore.makeUnsafe(1),
          journal: yield* logOf(session, yield* trajectories.openLog(session.id)),
          sess: undefined,
          oarSessionId: s.oarSessionId,
          lastText: s.lastText,
          tracking: {},
          launch: "",
          spoke: false,
          recalled: new Set(s.recalled),
          triggers: [],
          run: "",
          heard: [],
        });
        if (isBusy(session)) {
          yield* core.apply({
            type: "report",
            id: session.id,
            outcome: "interrupted",
            summary: t("server.session.log.restarted"),
            runs: session.runs,
            questions: [],
            checks: [],
          });
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
          return Effect.andThen(FiberMap.remove(timers, "save"), keepHands);
        }),
        Effect.sync(() => {
          for (const h of [...hands.values()]) {
            h.journal.close();
            release(h);
          }
        }),
      ),
    );

    const view = (h: Hand): Roster | undefined => {
      const session = core.session(h.id);
      return session ? { session, place: h.place, lastText: h.lastText } : undefined;
    };

    const currentRun = (id: string) => hands.get(id)?.run ?? executions.get(id)?.() ?? "";
    const runStore: RunStore = {
      ...runs,
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
        const starting = Effect.gen(function* () {
          const recalled = new Set<string>();
          const recall = yield* remind(agent.id, id, place.project, brief, recalled);
          const session: T.Session = {
            id,
            name: sessionName(capacity(), agent.id, agent.name),
            agent: agent.id,
            runtime: agent.runtime,
            brief,
            ...(place.project ? { project: place.project } : {}),
            hiredAt: yield* Clock.currentTimeMillis,
            runs: 0,
            phase: { _tag: "arriving" },
            ...(issue && opt.taskGraph ? { graph: opt.taskGraph } : {}),
            ...(channel ? { channel } : {}),
            refining: issue ? (opt.refining ?? false) : false,
            ...(issue ? { issue: issue.id } : {}),
            ...(place.branch ? { branch: place.branch, worktree: place.cwd } : {}),
          };
          const refuseStart = (why: string, retained: boolean): Effect.Effect<Hired> =>
            Effect.gen(function* () {
              yield* trajectories.finish(id);
              if (retained) return { refused: why, retainedWork: true };
              revokeToken(id);
              const result = yield* releasePlace;
              released = true;
              if (result.kept) yield* core.notice("warn", result.reason);
              return { refused: why, ...(result.kept ? { retainedWork: true as const } : {}) };
            });
          const journal = yield* trajectories.openLog(id);
          const opened = yield* open(agent, session, place, withRecall(recall, brief), "");
          if (!opened.execution) return yield* refuseStart(t("server.session.life.cannotSend", { name: agent.name, why: opened.refused }), opened.retained);
          // The execution now reserves capacity; source registration may take the channel lock, whose delivery waits on admission.
          yield* Scope.close(permit, Exit.void);
          const launch = launchOf(id);
          const registered = yield* Effect.result(
            Effect.gen(function* () {
              if (opt.hiring) yield* opt.hiring(session, launch);
              return yield* logOf(session, journal);
            }),
          ).pipe(Effect.onError((cause) => failedOpening(id, t("server.session.life.notRecorded", { name: agent.name, why: reasonText(cause) }))));
          if (registered._tag === "Failure") {
            const failed = yield* failedOpening(id, t("server.session.life.notRecorded", { name: agent.name, why: reasonText(registered.failure) }));
            return yield* refuseStart(failed.refused, failed.retained);
          }
          const h: Hand = {
            id,
            place,
            access: Semaphore.makeUnsafe(1),
            journal: registered.success,
            sess: undefined,
            oarSessionId: "",
            lastText: "",
            tracking: {},
            launch: "",
            spoke: false,
            recalled,
            triggers: [opt.trigger ?? (issue ? { kind: "issue" } : { kind: "comment", ...(channel ? { channel } : {}) })],
            run: "",
            heard: [],
          };
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              hands.set(id, h);
              yield* core.apply({ type: "hired", session });
              attach(h, opened.execution, agent.runtime, launch);
              committed = true;
            }),
          );
          return { session };
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
              revokeToken(id);
              const result = yield* releasePlace;
              if (result.kept) yield* core.notice("warn", result.reason);
            });
          }),
        );
      }, Effect.scoped),
      deliver,
      stop: Effect.fn("Session.stop")(function* (id) {
        const s = hands.get(id)?.sess;
        if (!s || core.session(id)?.phase._tag !== "working") return false;
        const outcome = yield* executor.interrupt(id);
        if (outcome.kind !== "accepted") {
          yield* Effect.logWarning(`vibevalley: the stop was not taken: ${"reason" in outcome ? outcome.reason : ""}`).pipe(
            Effect.annotateLogs({ session: id }),
          );
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
      roster: () =>
        [...hands.values()]
          .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .flatMap((h) => {
            const r = view(h);
            return r ? [r] : [];
          }),
      find: (id) => {
        const h = hands.get(id);
        return h ? view(h) : undefined;
      },
      handOver,
      changes: changesOf,
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
      presentSessions: () => core.state().sessions,
      present: (id) => hands.has(id),
      runOf: (id) => {
        const run = hands.get(id)?.run ?? executions.get(id)?.() ?? "";
        return run === "" ? undefined : run;
      },
      reportOf: (id) => summaryOf(hands.get(id)?.lastText ?? ""),
      onIssue: (issue) => sessionOnIssue(core.state(), issue)?.id,
      launches: Effect.map(PubSub.subscribe(launchesHub), Stream.fromSubscription),
      news: Effect.map(PubSub.subscribe(newsHub), Stream.fromSubscription),
      finishedRuns: Effect.map(PubSub.subscribe(finishedHub), Stream.fromSubscription),
      inputsConsumed: Effect.map(PubSub.subscribe(consumedHub), Stream.fromSubscription),
      who,
      setAddress: (address) => void (mcpUrl = `http://${address}/mcp`),
      host: Effect.fn("Session.host")(function* <R>(o: HostOptions<R>) {
        return yield* makeHost(o, yield* trajectories.openLog(o.name, o.keepEvents), runStore).pipe(
          Effect.provideService(Core, core),
          Effect.provideService(FileSystem.FileSystem, fs),
        );
      }),
      restore,
    });
    // A round reported on a session marked conflicting may have settled it: the mark is looked at again.
    yield* Effect.forkScoped(Stream.runForEach(yield* shape.news, (n) => (n._tag === "reported" && n.session?.conflict ? recheck(n.report.id) : Effect.void)));
    // A handle for tests: what the shape does not say.
    return Object.assign(shape, {
      hands,
      expect,
      unexpect,
      hired: () => hired,
      run,
      trajectories,
      runStore,
      currentRun,
      issueToken,
      place: (id: string) => hands.get(id)?.place,
      mcpUrl: () => mcpUrl,
    });
  });

/** The sessions as a test sees them: the shape, and what is inside it. */
export type SessionsInside = Effect.Success<ReturnType<typeof make>>;

/** Brings the sessions back once every service is built. */
export const ready = Layer.effectDiscard(Effect.flatMap(Session, (s) => s.restore));
