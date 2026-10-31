// oar runs sessions without permission prompts or a sandbox: the only fence is where a session starts, inside the work root in
// its own worktree. Each farm session owns its subagents; what only it takes (the farm's MCP server, its prompt, its refused
// tools) goes in through a copy of its runtime, so the shared registry is never changed. A run starts when the runtime opens a
// turn and ends with that turn's report; what started it is known only to whoever sent the input, so the sender leaves its
// trigger on the hand first and the turn takes the oldest. Admission serializes room and opening turns; each hand owns its
// input, handover and departure, so one worktree's checks do not hold the other sessions.

import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";

import type { Event, Runtime as OarRuntime, Session as RuntimeSession, SessionOptions } from "@botiverse/oar";
import { createSubagents, type Subagent, type SubagentReport, type Subagents } from "@botiverse/oar/agents";
import { initialStatus, reduceStatus, stallOf } from "@botiverse/oar/observe";
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
  Metric,
  Option,
  Predicate,
  PubSub,
  Schema,
  type Scope,
  Semaphore,
  Stream,
} from "effect";
import type { SqlClient } from "effect/sql";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { dayMs, maxRunning } from "@vibevalley/protocol";
import { ApiError as ApiErrorSchema } from "@vibevalley/protocol/api";
import { isBusy, omitUndefined } from "@vibevalley/protocol/rules";
import { issueId, sessionId } from "@vibevalley/protocol/schema";
import * as S from "@vibevalley/protocol/schema";

import { Agent } from "@/agent/agent.ts";
import { newId } from "@/base/ids.ts";
import { jsonOrNone } from "@/base/json.ts";
import { scopedPubSub } from "@/base/pubsub.ts";
import { Channel, type Delivered, type InputConsumed, type LaunchActivity, type SessionNews } from "@/channel/chat.ts";
import { Core, type FactIn } from "@/core/core.ts";
import { messageOf, type ApiError, missing, lookIn, reasonOf, refused } from "@/errors.ts";
import { serverAddress, ServerConfig } from "@/infra/config.ts";
import { causeMessage, Db } from "@/infra/db.ts";
import { bestEffort } from "@/infra/log.ts";
import { Memory } from "@/memory/memory.ts";
import { Project } from "@/project/project.ts";
import { type Merged, MergeFailure, type ProjectError, type Workplace, type WorkplaceCleanup, type WorkplaceRelease } from "@/project/shapes.ts";
import { probeInstallation, Runtime } from "@/runtime/runtime.ts";

import { instructions, briefBreak, recallBlock, toOarMcp, withRecall } from "./briefing.ts";
import { eventFacts, type Op, since, type Tracking } from "./facts.ts";
import { noRoom, type SessionLimits, sessionName, whoMakesRoom } from "./hiring.ts";
import { type AgentHost, type HostOptions, makeHost } from "./host.ts";
import { type Journal, makeTrajectories } from "./journal.ts";
import { restartedNote, workplaceRules } from "./prompts.ts";
import { readReport, summaryOf } from "./report.ts";
import { sessionOnIssue } from "./roster.ts";
import { conflictOf, notTakenIn, sameConflict, type Settle } from "./takeIn.ts";

export type { SessionNews };
import * as qs from "../../db/generated/session.sql.ts";
import * as qr from "../../db/generated/session_run.sql.ts";
import * as qi from "../../db/generated/session_run_issue.sql.ts";

/** A burst of changes is one write. */
const saveAfterMs = 300;
const closeWaitMs = 15_000;
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
  readonly issue: Pick<T.Issue, "id" | "number">;
  /** Links the session to its existing issue before the hired fact or any report can be seen. */
  readonly hiring?: (s: T.Session) => Effect.Effect<void, NotRecorded>;
}

export interface RunFinished {
  readonly id: string;
  readonly issues: T.IssueId[];
  readonly outcome: T.Outcome;
}

interface Allocation {
  readonly owner: T.Session;
  readonly subagents: Subagents;
  readonly resources: Set<RuntimeSession>;
  attached: boolean;
  failure?: string;
  /** Keep the failure too: oar's next close may be a no-op after a failed dispose. */
  closing?: Deferred.Deferred<void, NotClosed>;
}

interface OarSession extends Allocation {
  agent: Subagent;
  detached: boolean;
  stop?: () => void;
}

type OpenFailure = { readonly session?: never; readonly refused: string; readonly retained: boolean };
type Opened = { readonly session: OarSession; readonly refused?: never; readonly retained?: never } | OpenFailure;

interface Hand {
  readonly id: T.SessionId;
  readonly place: Workplace;
  readonly access: Semaphore.Semaphore;
  readonly journal: Journal;
  /** The oar session it is attached to; undefined between launches. */
  sess: OarSession | undefined;
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
    /** deliver, in words for whoever sent it. */
    readonly tell: (id: string, text: string, by: T.RunTrigger) => Effect.Effect<string>;
    readonly stop: (id: string) => Effect.Effect<boolean>;
    /** Discard resets its branch only after the runtime has stopped writing. */
    /** closed: how it leaves, "dismissed" unless its issue was completed without a merge ("completed"). */
    readonly dismiss: (id: string, work?: "keep" | "discard", closed?: "dismissed" | "completed") => Effect.Effect<boolean, ApiError>;
    /** A read-only round's leftovers go: its worktree back to the main branch, what it changed or committed gone; the
     * session stays. Not while a round goes on (the next report resets it). */
    readonly discardWork: (id: string) => Effect.Effect<void>;
    /** Removes an issue's unused workplace; an active or unclosed startup still owns it. */
    readonly clearWorkplace: (issue: string, project: string, number: number, work?: WorkplaceCleanup) => Effect.Effect<WorkplaceRelease, ApiError>;
    readonly roster: () => Roster[];
    readonly find: (id: string) => Roster | undefined;
    /** A session on the farm now, as the core state has it: what another module reads a session by. */
    readonly sessionOf: (id: string) => T.Session | undefined;
    readonly presentSessions: () => readonly T.Session[];
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
    readonly runs: (issue: string) => Effect.Effect<T.Run[]>;
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

/** The runtime sessions open now (a helper's, the orchestrator's), as a gauge. */
const running = Metric.gauge("vibevalley.sessions.running", { description: "Runtime sessions open now (the helpers' and the orchestrators')" });

/** A write of a session's own records (a run, the issue it works) that did not go through. */
export class NotRecorded extends Schema.TaggedError<NotRecorded, { readonly brand: unique symbol }>()("NotRecorded", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** oar's runtime session or its subagents did not close. */
class NotClosed extends Schema.TaggedError<NotClosed, { readonly brand: unique symbol }>()("NotClosed", { message: Schema.String, cause: Schema.Defect() }) {}

const notClosed = (cause: unknown) => new NotClosed({ message: messageOf(cause), cause });

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

const triggerOf = jsonOrNone(S.RunTrigger);
const heardOf = jsonOrNone(Schema.mutable(Schema.Array(Schema.String)));
const spentOf = jsonOrNone(S.Spent);
const graphOf = jsonOrNone(S.SessionGraph);
const placeOf = jsonOrNone(
  Schema.Struct({ project: Schema.String, cwd: Schema.String, branch: Schema.optionalKey(Schema.String) }) satisfies Schema.Codec<Workplace>,
);

export function runOf(r: qr.RunsOfSessionResult): T.Run {
  const run: T.Run = {
    id: r.id,
    session: sessionId(r.session),
    triggeredBy: triggerOf(r.triggered_by) ?? { kind: "runtime" },
    heard: heardOf(r.heard) ?? [],
    startedAt: r.started_at,
    summary: r.summary ?? "",
  };
  if (r.issue !== null) run.issue = issueId(r.issue);
  if (r.ended_at !== null) run.endedAt = r.ended_at;
  if (r.outcome !== null) run.outcome = r.outcome;
  const spent = spentOf(r.spent);
  if (spent) run.spent = spent;
  return run;
}

/** An ended session as the core state would have had it: its runs counted, its last one's word, what it spent in all. */

/** A turn submitted and not opened yet, counted from since: its slot is taken, as one thinking. */
const reserved = (since: number): T.Session["phase"] => ({ _tag: "working", since, doing: { action: "thinking", label: "" } });
function endedSession(r: qs.SessionByIDResult, runs: readonly qr.RunsOfSessionResult[]): T.Session {
  const s: T.Session = {
    id: sessionId(r.id),
    name: r.name,
    agent: r.agent,
    runtime: r.runtime,
    brief: r.brief,
    hiredAt: r.hired_at,
    runs: runs.length,
    phase: { _tag: "closed", at: r.ended_at ?? 0, closed: r.closed ?? "dismissed" },
    refining: false,
    ...(r.project !== null ? { project: r.project } : {}),
    ...(r.issue !== null ? { issue: issueId(r.issue) } : {}),
  };
  const graph = graphOf(r.graph);
  if (graph) s.graph = graph;
  let tokens = 0;
  let cny = 0;
  let priced = false;
  for (const run of runs) {
    const one = spentOf(run.spent);
    if (!one) continue;
    tokens += one.tokens;
    if (one.cny !== undefined) {
      cny += one.cny;
      priced = true;
    }
  }
  if (tokens > 0 || priced) s.spent = { tokens, ...(priced ? { cny } : {}) };
  const last = runs.at(-1);
  if (last?.outcome) s.lastRun = { outcome: last.outcome, summary: last.summary ?? "", at: last.ended_at ?? 0 };
  return s;
}

export interface SessionOptionsIn {
  /** The time a session may be quiet before it is said to be; tests make it short. */
  readonly stallMs?: number;
}

/** Calls onStall once a turn has had no record for stallMs, folded from the session's first record as its events are:
 * oar's observeStalls hears only records from when it subscribes, and misses a turn that went quiet before that. */
export function watchStalls(
  session: RuntimeSession,
  stallMs: number,
  onStall: (silentForMs: number, at: number) => void,
  timer: (wait: Effect.Effect<void>) => void,
  now: () => number,
) {
  let status = initialStatus;
  // The timer is one keyed fiber of the service's: arming again replaces it, Effect.void disarms it.
  const disarm = () => timer(Effect.void);
  const stop = session.rawEvents(
    (record) => {
      status = reduceStatus(status, record, session.id);
      if (status.kind !== "running") return disarm();
      timer(
        Effect.sleep(stallMs).pipe(
          Effect.andThen(
            Effect.sync(() => {
              const at = now();
              const stall = stallOf(status, at, stallMs);
              if (stall !== null) onStall(stall.silentForMs, at);
            }),
          ),
        ),
      );
    },
    { sessionId: session.id, afterSeq: -1 },
  );
  return () => {
    disarm();
    stop();
  };
}

export const make = (options: SessionOptionsIn = {}) =>
  Effect.gen(function* () {
    const runSync = Effect.runSyncWith(yield* Effect.context());
    const config = yield* ServerConfig;
    const core = yield* Core;
    const fs = yield* FileSystem.FileSystem;
    const store = yield* Agent;
    const memories = yield* Memory;
    const chat = yield* Channel;
    const projects = yield* Project;
    const runtimes = yield* Runtime;
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

    const root = resolve(projects.root);
    const logDir = join(config.home, "logs");
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
    // Every runtime allocation is owned here from acquisition until every acquired Session confirms disposal.
    const allocations = new Map<string, Allocation>();
    const executions = new Map<string, () => string>();
    const tokens = new Map<string, string>();
    let hired = 0;
    let launches = 0;
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
      const oar = h.sess?.agent.session.id || h.oarSessionId;
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

    const watch = (h: Hand, s: OarSession, runtime: string) => (event: Event) => {
      if (s.detached) return;
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

    const applyReport = (h: Hand, report: SubagentReport) => {
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
        runs: report.turn,
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

    const release = (h: Hand) => {
      const s = h.sess;
      if (!s) return;
      s.detached = true;
      s.stop?.();
    };

    const attach = (h: Hand, s: OarSession, runtime: string) => {
      launches++;
      h.sess = s;
      s.attached = true;
      h.launch = `${h.id}#${launches}`;
      h.spoke = false;
      if (s.agent.session.id) h.oarSessionId = s.agent.session.id;
      h.tracking = omitUndefined({ ...h.tracking, oarTokens: undefined });
      const session = s.agent.session;
      // From the session's first record: its turn may have started (or ended) before this line runs.
      const stopEvents = session.events(watch(h, s, runtime), { cursor: { sessionId: session.id, afterSeq: -1 } });
      // The report comes from oar's subagent, which hears the turn's end first: it is taken once the end's other readers have.
      const stopReports = s.subagents.onReport((report) => {
        if (report.sessionId === session.id) queueMicrotask(() => !s.detached && applyReport(h, report));
      });
      // A turn that ended before this line (the hand is made once its log is open, after the session started) left its
      // report unread, with no one to hand it to: taken now, in order. The crew is this session's alone.
      void s.subagents.wait({ timeoutMs: 0 }).then((early) => {
        for (const report of early) if (report.sessionId === session.id && !s.detached) applyReport(h, report);
      });
      const stopStalls = watchStalls(
        session,
        stallMs,
        (silentForMs, at) => !s.detached && stalled(h, silentForMs, at),
        (wait) => void later(`stall:${h.id}`, wait),
        () => clock.currentTimeMillisUnsafe(),
      );
      s.stop = () => {
        stopEvents();
        stopReports();
        stopStalls();
      };
      save();
    };

    /** Closes once, on the service's fibers: a caller that stops waiting does not stop the close, and every later call
     * waits for it and gets its outcome. */
    const closeAllocation = (allocation: Allocation): Effect.Effect<void, NotClosed> =>
      Effect.suspend(() => {
        if (allocation.closing) return Deferred.await(allocation.closing);
        const closing = Deferred.makeUnsafe<void, NotClosed>();
        allocation.closing = closing;
        const close = Effect.gen(function* () {
          const crew = yield* Effect.exit(Effect.tryPromise({ try: () => allocation.subagents.close(), catch: notClosed }));
          // A failed prompt may have made oar close its Subagent already. Its no-op close is not proof that dispose succeeded.
          const resources = yield* Effect.forEach(
            [...allocation.resources],
            (session) => Effect.exit(Effect.tryPromise({ try: () => session.dispose(), catch: notClosed })),
            { concurrency: "unbounded" },
          );
          const failed = [crew, ...resources].find(Exit.isFailure);
          if (failed) return yield* failed;
        });
        forkHere(
          close.pipe(
            Effect.onExit((exit) => Deferred.done(closing, exit)),
            Effect.ignore,
          ),
        );
        return Deferred.await(closing);
      });

    const stopOar = (allocation: Allocation) =>
      closeAllocation(allocation).pipe(
        Effect.mapError((e) => {
          allocation.failure = t("server.session.life.notStopped", { why: reasonText(e) });
          return refused(allocation.failure);
        }),
        Effect.tap(() =>
          Effect.sync(() => {
            if (allocations.get(allocation.owner.id) === allocation) allocations.delete(allocation.owner.id);
          }).pipe(Effect.andThen(Metric.update(running, allocations.size))),
        ),
      );

    const failedOpening = Effect.fnUntraced(function* (allocation: Allocation, why: string): Effect.fn.Return<OpenFailure> {
      return yield* stopOar(allocation).pipe(
        Effect.matchEffect({
          onSuccess: () => Effect.succeed({ refused: why, retained: false }),
          onFailure: (e) => {
            const failure = t("shared.join.clauses", { a: why, b: reasonOf(e) });
            allocation.failure = failure;
            return Effect.as(core.notice("error", failure), { refused: failure, retained: true });
          },
        }),
      );
    });

    /** Opens an oar session for the profile in place: its prompt, the farm's MCP server and its own, as a subagent. */
    const open = Effect.fnUntraced(function* (agent: T.Agent, owner: T.Session, place: Workplace, input: string, resume: string): Effect.fn.Return<Opened> {
      const id = owner.id;
      const prior = allocations.get(id);
      if (prior) return { refused: prior.failure ?? t("server.session.life.notReturned"), retained: true };
      const resolved = yield* Effect.result(runtimes.resolve(agent));
      if (resolved._tag === "Failure") return { refused: reasonOf(resolved.failure), retained: false };
      const r = resolved.success;
      const text = [instructions(agent, store.skills()), workplaceRules(place, yield* projects.houseRules(), id, projects.usesPullRequests(place.project))]
        .filter((s) => s !== "")
        .join("\n\n");
      const mcp = [
        { name: "vibevalley", type: "http" as const, url: mcpUrl, headers: { authorization: "Bearer " + issueToken(id) } },
        ...agent.mcpServers.map(toOarMcp),
      ];
      const own: Partial<SessionOptions> = {
        mcpServers: mcp,
        ...(text && agent.personaMode === "append" ? { appendSystemPrompt: text } : {}),
        ...(text && agent.personaMode === "replace" ? { systemPrompt: text } : {}),
        ...(agent.disallowedTools.length > 0 ? { disallowedTools: agent.disallowedTools } : {}),
      };
      const base = r.runtime;
      const resources = new Set<RuntimeSession>();
      // The session's own copy: the installation it was resolved to, and what only it takes added to what oar opens.
      const mine: OarRuntime = {
        ...base,
        installation: () => (r.installation ? Promise.resolve(r.installation) : probeInstallation(base, r.binPath)),
        // oar's interface: the base runtime's one call, with what it opens kept to be closed.
        session: (installation, opts) =>
          base.session(installation, { ...opts, ...own }).then((session) => {
            let disposing: Promise<void> | undefined;
            const tracked: RuntimeSession = { ...session, dispose: () => (disposing ??= Promise.resolve().then(() => session.dispose())) };
            resources.add(tracked);
            return tracked;
          }),
      };
      const subagents = createSubagents({ runtimes: { get: (rid) => (rid === base.id ? mine : undefined) }, maxRunning, maxDepth: 1, cwd: root, logDir });
      const allocation: Allocation = { owner, subagents, resources, attached: false };
      allocations.set(id, allocation);
      yield* Metric.update(running, allocations.size);
      const opening = Effect.gen(function* () {
        const brief = text && agent.personaMode === "prompt" ? text + briefBreak + input : input;
        const spawned = yield* Effect.promise(() =>
          subagents
            .spawn({
              runtime: base.id,
              name: id,
              task: brief,
              cwd: place.cwd,
              ...(r.model ? { model: r.model } : {}),
              ...(r.effort ? { effort: r.effort } : {}),
              ...(resume ? { resume } : {}),
              env: r.env,
            })
            .catch((e: unknown) => ({ kind: "refused" as const, code: "open_failed" as const, reason: messageOf(e) })),
        );
        if (spawned.kind !== "spawned") return yield* failedOpening(allocation, t("shared.join.aside", { text: spawned.reason, aside: spawned.code }));
        const verb = resume ? "woke" : "sent";
        const how = r.model ? ", model " + r.model : ", the runtime's default model";
        const where = place.project + (place.branch ? " on " + place.branch : "");
        yield* Effect.logInfo(`vibevalley: ${verb} ${id} (${agent.name}): ${agent.runtime}${how}, in ${where}`);
        return { session: Object.assign(allocation, { agent: spawned.agent, detached: false }) };
      });
      return yield* opening.pipe(Effect.onExit((exit) => (exit._tag === "Failure" ? Effect.ignore(stopOar(allocation)) : Effect.void)));
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

    const closeOar = (h: Hand) => {
      const allocation = allocations.get(h.id);
      return allocation ? stopOar(allocation) : Effect.void;
    };

    /** Lets the oar session go, keeping its id to resume. */
    const rest = Effect.fn("Session.rest")(function* (h: Hand) {
      const s = h.sess;
      yield* closeOar(h);
      if (!s) return;
      if (s.agent.session.id) h.oarSessionId = s.agent.session.id;
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
          const allocation = allocations.get(s.id);
          const opening = allocation !== undefined && (!allocation.attached || allocation.closing !== undefined);
          // A submitted turn owns its slot before oar opens it: its trigger is the reservation.
          return (opening || (h !== undefined && h.triggers.length > 0)) && !isBusy(s) ? { ...s, phase: reserved(clock.currentTimeMillisUnsafe()) } : s;
        }),
        ...[...allocations.values()].filter((a) => !visible.some((s) => s.id === a.owner.id)).map((a) => a.owner),
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
      if (!opened.session && !opened.retained && resume) {
        h.recalled.clear();
        const again = yield* remind(session.agent, h.id, h.place.project, input, h.recalled);
        opened = yield* open(agent, session, h.place, withRecall(again, restartedNote + input), "");
      }
      if (!opened.session) return { kind: "refused", reason: t("server.session.life.cannotWake", { name: session.name, why: opened.refused }) };
      attach(h, opened.session, session.runtime);
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
            if (h.sess?.closing) return { kind: "refused", reason: t("server.session.life.stillClosing", { name: session.name }) };
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
            const sent = yield* Effect.promise(() =>
              s.agent.send(withRecall(recall, text), "followup").catch((e: unknown) => ({ kind: "error" as const, reason: messageOf(e) })),
            );
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
      if (!place || !session) return;
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
      yield* chat.helpersBack;
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
        }).pipe(
          Effect.andThen(
            Effect.forEach(
              [...allocations],
              ([id, allocation]) =>
                closeAllocation(allocation).pipe(
                  Effect.catch((e) => Effect.logWarning("an execution did not close", e).pipe(Effect.annotateLogs({ session: id }))),
                ),
              { concurrency: "unbounded", discard: true },
            ).pipe(Effect.timeoutOption(closeWaitMs)),
          ),
        ),
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
        const oldest = whoMakesRoom(core.state().sessions, maxRunning);
        if (!oldest) return {};
        return yield* shape
          .dismiss(oldest.id)
          .pipe(Effect.match({ onFailure: (e) => ({ refused: reasonOf(e) }), onSuccess: () => ({ evicted: oldest.name }) }));
      }),
      send: Effect.fn("Session.send")(function* (agent, brief, where, opt) {
        const unclosed = [...allocations.values()].find((a) => a.owner.issue === opt.issue.id);
        if (unclosed) return { refused: unclosed.failure ?? t("server.session.life.issueNotReturned"), retainedWork: true as const };
        const full = roomFor(agent.runtime, where);
        if (full) return { refused: full };
        hired++;
        const id = sessionId(`w${hired}`);
        const placed = yield* Effect.result(projects.workplace(where, opt.issue.number, opt.worktree ?? agent.worktree, opt.base ?? ""));
        if (placed._tag === "Failure") return { refused: t("server.session.life.noPlace", { name: agent.name, why: placed.failure.message }) };
        const place = placed.success;
        let committed = false;
        let released = false;
        const starting = Effect.gen(function* () {
          const recalled = new Set<string>();
          const recall = yield* remind(agent.id, id, place.project, brief, recalled);
          const session: T.Session = {
            id,
            name: sessionName(core.state().sessions, agent.id, agent.name),
            agent: agent.id,
            runtime: agent.runtime,
            brief,
            project: place.project,
            hiredAt: yield* Clock.currentTimeMillis,
            runs: 0,
            phase: { _tag: "arriving" },
            ...(opt.taskGraph ? { graph: opt.taskGraph } : {}),
            ...(opt.channel ? { channel: opt.channel } : {}),
            refining: opt.refining ?? false,
            issue: opt.issue.id,
            ...(place.branch ? { branch: place.branch, worktree: place.cwd } : {}),
          };
          const refuseStart = (why: string, retained: boolean): Effect.Effect<Hired> =>
            Effect.gen(function* () {
              yield* trajectories.finish(id);
              if (retained) return { refused: why, retainedWork: true };
              revokeToken(id);
              const result = yield* projects.release(place);
              released = true;
              if (result.kept) yield* core.notice("warn", result.reason);
              return { refused: why, ...(result.kept ? { retainedWork: true as const } : {}) };
            });
          // The log is open before the session starts: from the start to attach there is no wait, so nothing the session
          // says or reports falls in between.
          const journal = yield* trajectories.openLog(id);
          const opened = yield* open(agent, session, place, withRecall(recall, brief), "");
          if (!opened.session) return yield* refuseStart(t("server.session.life.cannotSend", { name: agent.name, why: opened.refused }), opened.retained);
          const registered = yield* Effect.result(
            Effect.gen(function* () {
              if (opt.hiring) yield* opt.hiring(session);
              return yield* logOf(session, journal);
            }),
          ).pipe(Effect.onError((cause) => failedOpening(opened.session, t("server.session.life.notRecorded", { name: agent.name, why: reasonText(cause) }))));
          if (registered._tag === "Failure") {
            const failed = yield* failedOpening(
              opened.session,
              t("server.session.life.notRecorded", { name: agent.name, why: reasonText(registered.failure) }),
            );
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
            triggers: [opt.trigger ?? { kind: "issue" }],
            run: "",
            heard: [],
          };
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              hands.set(id, h);
              yield* core.apply({ type: "hired", session });
              attach(h, opened.session, agent.runtime);
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
              const allocation = allocations.get(id);
              if (allocation?.attached === true) return;
              if (allocation) {
                const stopped = yield* Effect.result(stopOar(allocation));
                if (stopped._tag === "Failure") {
                  yield* core.notice("error", allocation.failure ?? reasonOf(stopped.failure));
                  return;
                }
              }
              revokeToken(id);
              const result = yield* projects.release(place);
              if (result.kept) yield* core.notice("warn", result.reason);
            });
          }),
        );
      }, admission.withPermits(1)),
      deliver,
      tell: Effect.fn("Session.tell")(function* (id, text, by) {
        const d = yield* deliver(id, text, by);
        const name = core.session(id)?.name ?? id;
        switch (d.kind) {
          case "steered":
            return t("server.session.life.steered", { name });
          case "queued":
            return t("server.session.life.queued", { name });
          case "run":
            return t("server.session.life.started", { name, woke: d.woke === true });
          case "refused":
            break;
        }
        return d.reason ?? "";
      }),
      stop: Effect.fn("Session.stop")(function* (id) {
        const s = hands.get(id)?.sess;
        if (!s || core.session(id)?.phase._tag !== "working") return false;
        const outcome = yield* Effect.promise(() => s.agent.interrupt().catch((e: unknown) => ({ kind: "failed" as const, reason: String(e) })));
        if (outcome.kind !== "accepted") {
          yield* Effect.logWarning(`vibevalley: the stop was not taken: ${"reason" in outcome ? outcome.reason : ""}`).pipe(
            Effect.annotateLogs({ session: id }),
          );
          return false;
        }
        return true;
      }),
      dismiss: Effect.fn("Session.dismiss")(function* (id, work = "keep", closed = "dismissed") {
        const h = hands.get(id);
        if (!h) return false;
        return yield* h.access.withPermits(1)(
          Effect.gen(function* () {
            if (hands.get(id) !== h) return false;
            const name = core.session(id)?.name ?? id;
            yield* closeOar(h);
            if (work === "discard" && h.place.branch) {
              const reset = yield* Effect.result(projects.reset(h.place));
              if (reset._tag === "Failure") yield* core.notice("warn", t("server.session.life.notReset", { name, why: reset.failure.message }));
            }
            yield* leave(h, closed, 0);
            const kept = yield* projects.release(h.place);
            if (kept.kept) yield* core.notice("info", t("server.session.life.left", { name, why: kept.reason }));
            return true;
          }),
        );
      }),
      discardWork: Effect.fn("Session.discardWork")(function* (id) {
        const h = hands.get(id);
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
        const unclosed = [...allocations.values()].find((a) => a.owner.issue === issue);
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
      runs: Effect.fn("Session.runs")(function* (issue) {
        const rows = yield* db.run(qr.runsOfIssue({ issue_id: issue }));
        return rows.map(runOf);
      }),
      events: (id, r) => trajectories.events(id, r),
      sessionOf: (id) => core.session(id),
      presentSessions: () => core.state().sessions,
      launches: Effect.map(PubSub.subscribe(launchesHub), Stream.fromSubscription),
      news: Effect.map(PubSub.subscribe(newsHub), Stream.fromSubscription),
      finishedRuns: Effect.map(PubSub.subscribe(finishedHub), Stream.fromSubscription),
      inputsConsumed: Effect.map(PubSub.subscribe(consumedHub), Stream.fromSubscription),
      who,
      setAddress: (address) => void (mcpUrl = `http://${address}/mcp`),
      host: Effect.fn("Session.host")(function* <R>(o: HostOptions<R>) {
        return yield* makeHost(o, yield* trajectories.openLog(o.name, o.keepEvents), runStore);
      }),
      restore,
    });
    // The channels' helpers are these sessions: the channels hand them what is said to them and hear what they did.
    chat.useHelpers({
      present: (id) => hands.has(id),
      deliver,
      currentRun,
      report: (id) => summaryOf(hands.get(id)?.lastText ?? ""),
      onIssue: (issue) => sessionOnIssue(core.state(), issue)?.id,
      sessionOf: shape.sessionOf,
      presentSessions: shape.presentSessions,
    });
    // A round reported on a session marked conflicting may have settled it: the mark is looked at again.
    yield* Effect.forkScoped(Stream.runForEach(yield* shape.news, (n) => (n._tag === "reported" && n.session?.conflict ? recheck(n.report.id) : Effect.void)));
    yield* Effect.forkScoped(Stream.runForEach(yield* shape.launches, chat.activity));
    yield* Effect.forkScoped(Stream.runForEach(yield* shape.inputsConsumed, chat.consumed));
    yield* Effect.forkScoped(Stream.runForEach(yield* shape.news, chat.sessionNews));
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
