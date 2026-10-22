// The sessions: each helper on the farm is an oar session in its project's worktree, run by
// oar's subagents, and its events are read into facts (facts.ts) and its log (journal.ts). Every session is a row from the
// moment it is sent; ended, its row says when and how its issue took it, and its runs are session_run.
//
// oar runs sessions without permission prompts or a sandbox: the only fence is where a session starts, inside the work
// root in its own worktree. Each farm session owns its subagents; what only it takes (the farm's MCP server, its prompt,
// its refused tools) goes in through a copy of its runtime, so the shared registry is never changed. A run starts when
// the runtime opens a turn and ends with that turn's report; what started it is known only to whoever sent the input, so
// the sender leaves its trigger on the hand first and the turn takes the oldest. Admission (room, opening a turn,
// harvesting) is one at a time, so two callers cannot claim the same room.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { Event, Runtime, Session as RuntimeSession, SessionOptions } from "@botiverse/oar";
import { createSubagents, type Subagent, type SubagentReport, type Subagents } from "@botiverse/oar/agents";
import { initialStatus, reduceStatus, stallOf } from "@botiverse/oar/observe";
import {
  type Agent,
  type Changes,
  dayMs,
  type Fact,
  type IssueClose,
  maxRunning,
  type Outcome,
  type Run,
  type RunTrigger,
  type Session,
  type SessionEvent,
  type SessionGraph,
  type Spent,
  type WorkspaceState,
} from "@vibevalley/protocol";
import { isBusy } from "@vibevalley/protocol/rules";
import { Context, Effect, FiberSet, Layer, Option, PubSub, type Scope, Semaphore, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { Agents } from "../agent/agent.ts";
import { Channels, type Delivered, type InputConsumed, type LaunchActivity, type SessionNews } from "../channel/chat.ts";

export type { SessionNews };
import { serverAddress, Settings } from "../base/config.ts";
import { newId } from "../base/ids.ts";
import { Core, type FactIn } from "../core/core.ts";
import { type ApiError, missing, reasonOf, refused } from "../errors.ts";
import { Memories } from "../memory/memory.ts";
import { type Merged, MergeFailure, Projects, type Workplace } from "../project/project.ts";
import { probeInstallation, Runtimes } from "../runtime/runtime.ts";
import { eventFacts, type From, type Op, since, type Tracking } from "./facts.ts";
import { type Journal, Trajectories } from "./journal.ts";
import {
  conflictOf,
  instructions,
  jobBreak,
  noRoom,
  notTakenIn,
  readReport,
  recallBlock,
  sameConflict,
  type SessionLimits,
  sessionName,
  type Settle,
  summaryOf,
  toOarMcp,
  whoMakesRoom,
  withRecall,
  workplaceRules,
} from "./rules.ts";
import { sessionOnIssue } from "./state.ts";
import * as qr from "../../db/generated/session_run.sql.ts";
import * as qi from "../../db/generated/session_run_issue.sql.ts";
import * as qs from "../../db/generated/session.sql.ts";

/** A burst of changes is one write. */
const saveAfterMs = 300;
const closeWaitMs = 15_000;

export interface Roster {
  readonly session: Session;
  readonly place: Workplace;
  readonly lastText: string;
}

export interface Hired {
  readonly session?: Session;
  readonly refused?: string;
  /** Who was sent home to make room. */
  readonly evicted?: string;
}

export interface HireOptions {
  /** The branch its own branch starts from; empty: the project's main branch. */
  readonly base?: string;
  readonly worktree?: boolean;
  readonly taskGraph?: SessionGraph;
  readonly channel?: string;
  /** Empty: the caller makes one from the job. */
  readonly issue?: string;
  readonly issueNumber?: number;
  /** What its first run is for; the issue sent out when none. */
  readonly trigger?: RunTrigger;
  /** It drafts the issue rather than works it. */
  readonly refining?: boolean;
  /** Called with the session just before it goes on the farm, so what must know of it first (its issue's link) is written before anyone can see it. */
  readonly hiring?: (s: Session) => Effect.Effect<void, unknown>;
}

export interface RunFinished {
  readonly id: string;
  readonly issues: string[];
  readonly outcome: Outcome;
}

interface OarSession {
  readonly subagents: Subagents;
  agent: Subagent;
  detached: boolean;
  stop?: () => void;
}

interface Hand {
  readonly id: string;
  readonly place: Workplace;
  readonly journal: Journal;
  sess?: OarSession;
  oarSessionId: string;
  lastText: string;
  tracking: Tracking;
  /** As the chat names it: <id>#<n>; "" when it has none. */
  launch: string;
  spoke: boolean;
  recalled: Set<string>;
  /** The triggers of the turns asked for and not opened yet, oldest first. */
  triggers: RunTrigger[];
  /** The open turn's run and what it heard. */
  run: string;
  heard: string[];
}

export interface SessionShape {
  readonly noRoom: (runtime: string, project: string) => string;
  /** Room for one more on runtime in project: refused when either is at its limit; a full farm sends home whoever has
   * been idle longest, and says who. */
  readonly makeRoom: (runtime: string, project: string) => Effect.Effect<{ readonly refused: string } | { readonly evicted?: string }>;
  readonly send: (agent: Agent, task: string, where: string, opt?: HireOptions) => Effect.Effect<Hired>;
  readonly deliver: (id: string, text: string, by: RunTrigger) => Effect.Effect<Delivered>;
  /** deliver, in words for whoever sent it. */
  readonly tell: (id: string, text: string, by: RunTrigger) => Effect.Effect<string>;
  readonly stop: (id: string) => Effect.Effect<boolean>;
  readonly dismiss: (id: string) => Effect.Effect<boolean>;
  readonly place: (id: string) => Workplace | undefined;
  readonly roster: () => Roster[];
  readonly find: (id: string) => Roster | undefined;
  /** A session on the farm now, as the core state has it: what another module reads a session by. */
  readonly sessionOf: (id: string) => Session | undefined;
  readonly presentSessions: () => readonly Session[];
  /** The session hands its workplace over and leaves as closed says: use takes the work in (Source Control's merge, pull
   * request, merge into a task graph's branch), given the workplace and the session's last words in full. Refused while
   * it works. Work that does not go in keeps the session and its branch, marks a conflict, and says in NotTakenIn what
   * the helper is sent back with and what the owner is told; settle says who settles a conflict. A pull request left
   * open keeps the session too. */
  readonly handOver: (
    id: string,
    closed: IssueClose,
    use: (place: Workplace, lastText: string) => Effect.Effect<Merged, unknown>,
    settle?: Settle,
  ) => Effect.Effect<Merged, ApiError | NotTakenIn>;
  /** What the session's branch would bring now; the conflict it shows is kept on the session. */
  readonly changes: (id: string) => Effect.Effect<Changes | undefined, ApiError>;
  /** A conflict marked on the session is looked at again (after a round, which may have settled it). */
  readonly recheck: (id: string) => Effect.Effect<void>;
  /** Every session of the agent, or of every agent when it is empty: on the farm and ended, newest first. */
  readonly list: (agent: string) => Effect.Effect<Session[]>;
  /** A session on the farm, or one that has ended. */
  readonly get: (id: string) => Effect.Effect<Session | undefined>;
  readonly runs: (issue: string) => Effect.Effect<Run[]>;
  readonly currentRun: (id: string) => string;
  /** A session's log, oldest first; a run's only when run is given. */
  readonly events: (id: string, run?: string) => SessionEvent[] | undefined;
  readonly trajectories: Trajectories;
  /** These four are subscribed before they return: nothing published after is missed. */
  readonly launches: Effect.Effect<Stream.Stream<LaunchActivity>, never, Scope.Scope>;
  /** A session hired, reported or gone, with the session as it stood after: what the issues and task graphs follow. */
  readonly news: Effect.Effect<Stream.Stream<SessionNews>, never, Scope.Scope>;
  readonly finishedRuns: Effect.Effect<Stream.Stream<RunFinished>, never, Scope.Scope>;
  readonly inputsConsumed: Effect.Effect<Stream.Stream<InputConsumed>, never, Scope.Scope>;
  /** A session's token for the farm's MCP server; a new one stops the old working. */
  readonly issueToken: (session: string) => string;
  readonly revokeToken: (session: string) => void;
  /** Whose token it is; "" when nobody's. */
  readonly who: (token: string) => string;
  /** For a farm listening on a free port: sessions opened from now on reach /mcp there. */
  readonly setAddress: (address: string) => void;
  readonly mcpUrl: () => string;
  /** Records a run of an in-process agent (the orchestrator's) as its own; execution.ts. */
  readonly runStore: RunStore;
  /** Brings back the sessions the farm had when it stopped, once every service is ready. */
  readonly restore: Effect.Effect<void>;
}

/** What execution.ts keeps runs with; a write that fails is an error the run retries. */
export interface RunStore {
  readonly start: (id: string, session: string, issue: string, trigger: RunTrigger) => Effect.Effect<void, Error>;
  readonly link: (run: string, issue: string) => Effect.Effect<void, Error>;
  readonly heard: (run: string, heard: readonly string[]) => Effect.Effect<void, Error>;
  readonly issues: (run: string) => Effect.Effect<string[], Error>;
  readonly finish: (id: string, outcome: Outcome, summary: string, spent?: Spent) => Effect.Effect<void, Error>;
  readonly finished: (r: RunFinished) => void;
  readonly consumed: (c: InputConsumed) => void;
  readonly register: (session: string, currentRun: () => string) => void;
}

/** A session's own fact as news; the rest are not the sessions'. */
export function newsOf(fact: Fact, after: WorkspaceState): SessionNews | undefined {
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

/** Work that did not go in (see handOver); the session stays. */
export class NotTakenIn extends Error {
  readonly _tag = "NotTakenIn";
  constructor(
    readonly failure: MergeFailure,
    /** What the helper is sent back with; "" when the owner settles it. */
    readonly fix: string,
    /** What the owner is told. */
    readonly owner: string,
    readonly notice: string,
    readonly short: string,
  ) {
    super(owner);
  }
}

/** A failure's words, whatever it is. */
const reasonText = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === "object" && e !== null && "_tag" in e ? reasonOf(e as ApiError) : String(e);

export class Sessions extends Context.Service<Sessions, SessionShape>()("vibevalley/Session") {}

const json = <T>(text: string | null | undefined): T | undefined => {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
};

function runOf(r: qr.RunsOfSessionResult): Run {
  const run: Run = {
    id: r.id,
    session: r.session,
    triggeredBy: json<RunTrigger>(r.triggered_by) ?? { kind: "runtime" },
    heard: json<string[]>(r.heard) ?? [],
    startedAt: r.started_at,
  };
  if (r.issue !== null) run.issue = r.issue;
  if (r.ended_at !== null) run.endedAt = r.ended_at;
  if (r.outcome !== null) run.outcome = r.outcome as Outcome;
  if (r.summary !== null) run.summary = r.summary;
  const spent = json<Spent>(r.spent);
  if (spent) run.spent = spent;
  return run;
}

/** An ended session as the core state would have had it: its runs counted, its last one's word, what it spent in all. */
function endedSession(r: qs.SessionByIDResult, runs: readonly qr.RunsOfSessionResult[]): Session {
  const s: Session = {
    id: r.id,
    name: r.name,
    agent: r.agent,
    runtime: r.runtime,
    brief: r.brief,
    hiredAt: r.hired_at,
    runs: runs.length,
    phase: { _tag: "closed", at: r.ended_at ?? 0, closed: (r.closed ?? "dismissed") as IssueClose },
    ...(r.project !== null ? { project: r.project } : {}),
    ...(r.issue !== null ? { issue: r.issue } : {}),
  };
  const graph = json<SessionGraph>(r.graph);
  if (graph) s.graph = graph;
  let tokens = 0;
  let cny = 0;
  let priced = false;
  for (const run of runs) {
    const one = json<Spent>(run.spent);
    if (!one) continue;
    tokens += one.tokens;
    if (one.cny !== undefined) {
      cny += one.cny;
      priced = true;
    }
  }
  if (tokens > 0 || priced) s.spent = { tokens, ...(priced ? { cny } : {}) };
  const last = runs.at(-1);
  if (last?.outcome) s.lastRun = { outcome: last.outcome as Outcome, summary: last.summary ?? "", at: last.ended_at ?? 0 };
  return s;
}

export interface SessionOptionsIn {
  /** The time a session may be quiet before it is said to be; tests make it short. */
  readonly stallMs?: number;
}

/** Calls onStall once a turn has had no record for stallMs, folded from the session's first record as its events are:
 * oar's observeStalls hears only records from when it subscribes, and misses a turn that went quiet before that. */
function watchStalls(session: RuntimeSession, stallMs: number, onStall: (silentForMs: number) => void) {
  let status = initialStatus;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const disarm = () => clearTimeout(timer);
  const stop = session.rawEvents(
    (record) => {
      status = reduceStatus(status, record, session.id);
      disarm();
      if (status.kind !== "running") return;
      timer = setTimeout(() => {
        const stall = stallOf(status, Date.now(), stallMs);
        if (stall !== null) onStall(stall.silentForMs);
      }, stallMs);
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
    const config = yield* Settings;
    const core = yield* Core;
    const store = yield* Agents;
    const memories = yield* Memories;
    const chat = yield* Channels;
    const projects = yield* Projects;
    const runtimes = yield* Runtimes;
    const sql = yield* SqlClient.SqlClient;
    const db = <A, E>(e: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.provideService(e, SqlClient.SqlClient, sql).pipe(Effect.orDie);
    /** A write that must not stop a run: logged, and the run goes on. */
    const logged = <A, E>(what: string, e: Effect.Effect<A, E, SqlClient.SqlClient>) =>
      Effect.provideService(e, SqlClient.SqlClient, sql).pipe(
        Effect.asVoid,
        Effect.catch((err) => Effect.logWarning(`vibevalley: ${what}: ${String(err)}`)),
      );
    // Fibers started from callbacks belong to this service: they end with it and keep its services (the logger).
    const run = yield* FiberSet.makeRuntimePromise<never>();
    const forkHere = yield* FiberSet.makeRuntime<never>();
    /** A write whose failure the caller handles. */
    const tried = <A, E>(e: Effect.Effect<A, E, SqlClient.SqlClient>) =>
      Effect.provideService(e, SqlClient.SqlClient, sql).pipe(Effect.mapError((err) => (err instanceof Error ? err : new Error(String(err)))));
    const fire = (e: Effect.Effect<unknown, unknown>) => void forkHere(e);
    const apply = (...facts: FactIn[]) => Effect.runSync(core.apply(...facts));
    const notice = (level: "info" | "warn" | "error", text: string) => Effect.runSync(core.notice(level, text));

    const root = resolve(projects.root);
    const logDir = join(config.home, "logs");
    const stallMs = options.stallMs ?? config.session.stallSeconds * 1000;
    let mcpUrl = `http://${serverAddress(config)}/mcp`;
    const trajectories = new Trajectories(config.home, (id, e) => Effect.runSync(core.sessionEvent(id, e)));
    const admission = Semaphore.makeUnsafe(1);

    const launchesHub = yield* PubSub.unbounded<LaunchActivity>();
    // The sessions' own facts, told as news in the order they were applied.
    const newsHub = yield* PubSub.unbounded<SessionNews>();
    const [, moves] = yield* core.transitions;
    yield* Effect.forkScoped(
      Stream.runForEach(moves, ({ fact, after }) => {
        const news = newsOf(fact, after);
        return news ? PubSub.publish(newsHub, news) : Effect.void;
      }),
    );
    const finishedHub = yield* PubSub.unbounded<RunFinished>();
    const consumedHub = yield* PubSub.unbounded<InputConsumed>();
    const signal = (a: LaunchActivity) => PubSub.publishUnsafe(launchesHub, a);

    const hands = new Map<string, Hand>();
    const executions = new Map<string, () => string>();
    const tokens = new Map<string, string>();
    let hired = 0;
    let launches = 0;
    let closing = false;
    let pending: NodeJS.Timeout | undefined;

    // ── tokens: they tell sessions apart and guard nothing (sessions already run unsandboxed here), so memory only ──

    const issueToken = (session: string) => {
      const token = "hb_" + session + "_" + randomBytes(18).toString("base64url");
      tokens.set(session, token);
      return token;
    };
    const revokeToken = (session: string) => void tokens.delete(session);
    const who = (token: string) => [...tokens.entries()].find(([, t]) => t === token)?.[0] ?? "";

    // ── what is kept ──

    // A session's own row keeps what taking it up again needs, so it goes with the database: one made again from a new
    // schema brings back no session (and none on an issue the database no longer has).
    const handRow = (h: Hand) => {
      const oar = h.sess?.agent.session.id || h.oarSessionId;
      return {
        id: h.id,
        place: JSON.stringify(h.place),
        oar_session: oar || null,
        last_text: h.lastText || null,
        recalled: h.recalled.size > 0 ? JSON.stringify([...h.recalled].sort()) : null,
      };
    };
    const keepHands = Effect.suspend(() =>
      Effect.forEach([...hands.values()], (h) => logged(`session ${h.id}: what brings it back not kept`, qs.keepHand(handRow(h))), { discard: true }),
    );

    const save = () => {
      if (closing) return;
      clearTimeout(pending);
      pending = setTimeout(() => fire(keepHands), saveAfterMs);
    };

    const keep = (s: Session) =>
      logged(
        `session ${s.id} not kept`,
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
      );

    const ended = (id: string, closed: IssueClose) => logged(`session ${id}'s end not kept`, qs.endSession({ ended_at: Date.now(), closed, id }));

    const logOf = (s: Session) => Effect.as(keep(s), trajectories.openLog(s.id));

    // ── runs ──

    // A run's record, the helpers' and the in-process agent's alike (execution.ts): one way to open, hear, link and end it.
    const runs = {
      start: (id: string, session: string, issue: string, trigger: RunTrigger) =>
        tried(qr.startRun({ id, session, issue: issue || null, triggered_by: JSON.stringify(trigger), started_at: Date.now() })),
      /** A run that takes several issues (the in-process agent's) is linked to each; session_run.issue is its first. */
      link: (r: string, issue: string) => tried(qi.linkRunIssue({ run: r, issue })),
      heard: (r: string, heard: readonly string[]) => tried(qr.heardInRun({ heard: JSON.stringify(heard), id: r })),
      issues: (r: string) => Effect.map(tried(qi.runIssues({ run: r })), (rows) => rows.map((x) => x.issue)),
      finish: (id: string, outcome: Outcome, summary: string, spent?: Spent) =>
        tried(qr.endRun({ ended_at: Date.now(), outcome, summary: summary || null, spent: spent ? JSON.stringify(spent) : null, id })),
    };
    /** A helper's run is recorded beside its work: a write that fails is logged, and the run goes on. */
    const keptRun = (what: string, e: Effect.Effect<unknown, Error>) =>
      Effect.catch(Effect.asVoid(e), (err) => Effect.logWarning(`vibevalley: ${what}: ${err.message}`));

    /** Called before the input goes out, so the turn it opens finds it. */
    const expect = (h: Hand, by: RunTrigger) => void h.triggers.push(by);
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
      fire(keptRun(`${h.id}'s run not kept`, runs.start(id, h.id, issue, by)));
    };

    const heardInRun = (h: Hand, message: string) => {
      if (!h.run) return;
      h.heard.push(message);
      fire(keptRun(`run ${h.run}`, runs.heard(h.run, h.heard)));
    };

    const endRun = (h: Hand, outcome: Outcome, summary: string, spent?: Spent) => {
      const id = h.run;
      h.run = "";
      h.heard = [];
      if (!id) return;
      h.journal.runEnded(id, outcome);
      fire(keptRun(`run ${id}`, runs.finish(id, outcome, summary, spent)));
    };

    // ── following a session ──

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
      if (reaction.model) h.tracking = { ...h.tracking, rate: runtimes.quote(runtime, reaction.model) };
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
      if (reaction.spentCny) runtimes.spend(runtime, reaction.spentCny);
      if (reaction.warn) notice("warn", reaction.warn);
      if (event.kind === "exited") closedLaunch(h);
    };

    const applyReport = (h: Hand, report: SubagentReport) => {
      const session = core.session(h.id);
      if (!session) return;
      const read = readReport(report.outcome, report.text);
      const spent = session.spent ? since(session.spent, h.tracking.runFrom) : undefined;
      h.lastText = read.text;
      h.tracking = { ...h.tracking, runFrom: undefined };
      const { launch, spoke } = h;
      apply({
        type: "report",
        id: h.id,
        outcome: read.outcome,
        summary: read.summary,
        runs: report.turn,
        ...(spent ? { spent } : {}),
        ...(h.run ? { run: h.run } : {}),
        ...(read.questions.length > 0 ? { questions: read.questions } : {}),
        ...(read.checks.length > 0 ? { checks: read.checks } : {}),
      });
      endRun(h, read.outcome, read.summary, spent);
      fire(
        memories.keep({
          agent: session.agent,
          session: h.id,
          project: h.place.project,
          job: session.brief,
          outcome: read.outcome,
          said: read.text,
          summary: read.summary,
        }),
      );
      if (read.needsYou) notice("error", `${session.name} 停下了：${read.failure}`);
      if (launch) signal({ kind: "ended", id: h.id, launch, outcome: read.outcome, spoke });
      runtimes.usageSoon(session.runtime);
      save();
    };

    const stalled = (h: Hand, silentForMs: number) => {
      const session = core.session(h.id);
      if (session?.phase._tag !== "working") return;
      h.tracking = { ...h.tracking, quiet: true };
      apply({ type: "quiet", id: h.id, since: Date.now() - silentForMs });
      const quiet = silentForMs < 60_000 ? `${Math.round(silentForMs / 1000)} 秒` : `${Math.round(silentForMs / 60_000)} 分钟`;
      const last = session.phase.doing.label ? "（最后在：" + session.phase.doing.label + "）" : "";
      h.journal.note("run/error", `已经 ${quiet}没动静了${last}。可能在跑很久的命令，也可能卡住了`);
      notice("warn", `${session.name} 已经 ${quiet}没动静了${last}：点它的地看看过程，不对就叫停`);
    };

    const release = (h: Hand) => {
      const s = h.sess;
      if (!s) return;
      s.detached = true;
      s.stop?.();
    };

    const attach = (h: Hand, s: OarSession, runtime: string) => {
      launches++;
      const old = h.sess;
      if (old) release(h);
      h.sess = s;
      h.launch = `${h.id}#${launches}`;
      h.spoke = false;
      if (s.agent.session.id) h.oarSessionId = s.agent.session.id;
      h.tracking = { ...h.tracking, oarTokens: undefined };
      if (old) void old.subagents.close().catch(() => {});
      const session = s.agent.session;
      // From the session's first record: its turn may have started (or ended) before this line runs.
      const stopEvents = session.events(watch(h, s, runtime), { cursor: { sessionId: session.id, afterSeq: -1 } });
      // The report comes from oar's subagent, which hears the turn's end first: it is taken once the end's other readers have.
      const stopReports = s.subagents.onReport((report) => {
        if (report.sessionId === session.id) queueMicrotask(() => !s.detached && applyReport(h, report));
      });
      const stopStalls = watchStalls(session, stallMs, (silentForMs) => !s.detached && stalled(h, silentForMs));
      s.stop = () => {
        stopEvents();
        stopReports();
        stopStalls();
      };
      save();
    };

    /** Opens an oar session for the profile in place: its prompt, the farm's MCP server and its own, as a subagent. */
    const open = (agent: Agent, id: string, place: Workplace, input: string, resume: string) =>
      Effect.gen(function* () {
        const resolved = yield* Effect.result(runtimes.resolve(agent));
        if (resolved._tag === "Failure") return { refused: reasonOf(resolved.failure) };
        const r = resolved.success;
        const text = [instructions(agent, store.skills()), workplaceRules(place, projects.houseRules(), id)].filter((s) => s !== "").join("\n\n");
        const mcp = [
          { name: "vibevalley", type: "http" as const, url: mcpUrl, headers: { authorization: "Bearer " + issueToken(id) } },
          ...(agent.mcpServers ?? []).map(toOarMcp),
        ];
        const own: Partial<SessionOptions> = {
          mcpServers: mcp,
          ...(text && agent.personaMode === "append" ? { appendSystemPrompt: text } : {}),
          ...(text && agent.personaMode === "replace" ? { systemPrompt: text } : {}),
          ...((agent.disallowedTools ?? []).length > 0 ? { disallowedTools: agent.disallowedTools } : {}),
        };
        const base = r.runtime;
        // The session's own copy: the installation it was resolved to, and what only it takes added to what oar opens.
        const mine: Runtime = {
          ...base,
          installation: () => (r.installation ? Promise.resolve(r.installation) : probeInstallation(base, r.binPath)),
          session: (installation, opts) => base.session(installation, { ...opts, ...own }),
        };
        const subagents = createSubagents({ runtimes: { get: (rid) => (rid === base.id ? mine : undefined) }, maxRunning, maxDepth: 1, cwd: root, logDir });
        const task = text && agent.personaMode === "prompt" ? text + jobBreak + input : input;
        const spawned = yield* Effect.promise(() =>
          subagents
            .spawn({
              runtime: base.id,
              name: id,
              task,
              cwd: place.cwd,
              ...(r.model ? { model: r.model } : {}),
              ...(r.effort ? { effort: r.effort } : {}),
              ...(resume ? { resume } : {}),
              env: r.env,
            })
            .catch((e: unknown) => ({ kind: "refused" as const, code: "open_failed" as const, reason: e instanceof Error ? e.message : String(e) })),
        );
        if (spawned.kind !== "spawned") {
          yield* Effect.promise(() => subagents.close().catch(() => {}));
          return { refused: `${spawned.reason}（${spawned.code}）` };
        }
        const verb = resume ? "叫醒" : "派";
        const how = r.model ? "，模型 " + r.model : "，runtime 默认模型";
        const where = place.project + (place.branch ? " 的 " + place.branch : "");
        yield* Effect.logInfo(`vibevalley: ${verb} ${id}（${agent.name}）：${agent.runtime}${how}，在 ${where}`);
        return { session: { subagents, agent: spawned.agent, detached: false } as OarSession };
      });

    const leave = (h: Hand, closed: IssueClose, merged: number) =>
      Effect.gen(function* () {
        release(h);
        trajectories.finish(h.id);
        yield* ended(h.id, closed);
        closedLaunch(h);
        revokeToken(h.id);
        hands.delete(h.id);
        const session = core.session(h.id);
        if (session) yield* memories.endSession({ agent: session.agent, session: h.id, project: h.place.project });
        apply({ type: "left", id: h.id, closed, ...(merged > 0 ? { merged } : {}) });
        save();
      });

    const closeOar = (h: Hand) => (h.sess ? Effect.promise(() => h.sess!.subagents.close().catch(() => {})) : Effect.void);

    /** Lets the oar session go, keeping its id to resume. */
    const rest = (h: Hand) =>
      Effect.gen(function* () {
        const s = h.sess;
        if (!s) return;
        if (s.agent.session.id) h.oarSessionId = s.agent.session.id;
        release(h);
        h.sess = undefined;
        closedLaunch(h);
        yield* Effect.promise(() => s.subagents.close().catch(() => {}));
        save();
      });

    const capacity = (): Session[] =>
      core.state().sessions.map((s) => {
        const h = hands.get(s.id);
        // A submitted turn owns its slot before oar opens it: its trigger is the reservation.
        return h && h.triggers.length > 0 && !isBusy(s) ? ({ ...s, phase: { _tag: "working", doing: { action: "thinking", label: "" } } } as Session) : s;
      });

    const limits = (runtime: string): SessionLimits => ({
      workspace: maxRunning,
      perProject: projects.limit,
      perRuntime: store.settings(runtime).maxWorking ?? 0,
    });

    const roomFor = (runtime: string, project: string) => noRoom(capacity(), runtime, project.trim(), limits(runtime));

    const remind = (agent: string, session: string, project: string, input: string, recalled: Set<string>) =>
      Effect.gen(function* () {
        const found = yield* memories.recall({ agent, session, project, text: input, skip: new Set(recalled) });
        for (const id of found.ids) recalled.add(id);
        if (found.ids.length > 0) save();
        return recallBlock(found.lines);
      });

    const wake = (h: Hand, session: Session, input: string, recall: string) =>
      Effect.gen(function* () {
        const agent = store.agent(session.agent);
        if (!agent) return { kind: "refused", reason: session.name + " 的 agent 已经删掉了，叫不醒" } as Delivered;
        const resume = h.oarSessionId;
        let opened = yield* open(agent, h.id, h.place, withRecall(recall, input), resume);
        if (!opened.session && resume) {
          h.recalled.clear();
          const again = yield* remind(session.agent, h.id, h.place.project, input, h.recalled);
          opened = yield* open(
            agent,
            h.id,
            h.place,
            withRecall(again, "（VibeValley 重启过，之前的会话接不上了。你在这个分支上做过的事看 git log。）\n\n" + input),
            "",
          );
        }
        if (!opened.session) return { kind: "refused", reason: `${session.name} 叫不醒：${opened.refused}` } as Delivered;
        attach(h, opened.session, session.runtime);
        return { kind: "run", launch: h.launch || h.id, woke: true } as Delivered;
      });

    const deliver = (id: string, text: string, by: RunTrigger) =>
      admission.withPermits(1)(
        Effect.gen(function* () {
          const h = hands.get(id);
          const session = core.session(id);
          if (!h || !session) return { kind: "refused", reason: `没有 ${id} 这个帮工` } as Delivered;
          const starts = !isBusy(session);
          let recall = "";
          if (starts) {
            const full = noRoom(capacity(), session.runtime, h.place.project, limits(session.runtime), id);
            if (full) return { kind: "refused", reason: `${session.name} 先不接着干：${full}` } as Delivered;
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
            s.agent
              .send(withRecall(recall, text), "followup")
              .catch((e: unknown) => ({ kind: "error" as const, reason: e instanceof Error ? e.message : String(e) })),
          );
          if (sent.kind === "accepted" && sent.landed === "prompted") return { kind: "run", launch } as Delivered;
          if (starts) unexpect(h);
          if (sent.kind !== "accepted") return { kind: "refused", reason: `${session.name} 没收到：${sent.reason}` } as Delivered;
          if (sent.landed === "queued") {
            expect(h, by);
            return { kind: "queued", launch } as Delivered;
          }
          if (by.message) heardInRun(h, by.message);
          return { kind: "steered", launch } as Delivered;
        }),
      );

    const harvest = (id: string, closed: IssueClose, use: (place: Workplace, lastText: string) => Effect.Effect<Merged, unknown>, settle: Settle = "owner") =>
      admission.withPermits(1)(
        Effect.gen(function* () {
          const h = hands.get(id);
          const current = core.session(id);
          if (!h || !current) return yield* Effect.fail<ApiError | NotTakenIn>(missing("帮工 " + id));
          if (closed === "merged" && current.graph)
            return yield* Effect.fail<ApiError | NotTakenIn>(
              refused(`${current.name} 在做种植计划 ${current.graph.id} 里的活：做完会自动合进计划分支，收获整个计划时再进主分支`),
            );
          if (isBusy(current) || h.triggers.length > 0)
            return yield* Effect.fail<ApiError | NotTakenIn>(refused(current.name + " 还在干活：等这一轮做完，或者先叫停，再收"));
          yield* rest(h);
          const merged = yield* use(h.place, h.lastText).pipe(
            Effect.mapError((e) => {
              const f = e instanceof MergeFailure ? e : new MergeFailure("error", reasonText(e));
              if (f.kind === "conflict") apply({ type: "conflict", id, conflict: { base: f.base, files: [...f.files] } });
              const words = notTakenIn(f, current.name, settle);
              return new NotTakenIn(f, words.fix, words.owner, words.notice, words.short);
            }),
          );
          if (merged.pullRequest) return merged;
          yield* leave(h, closed, closed === "merged" ? merged.commits : 0);
          if (merged.warning) notice("warn", merged.warning);
          return merged;
        }),
      );

    /** The freshest word on conflicts is a preview of the branch; the session's state follows it. */
    const changesOf = (id: string) =>
      Effect.gen(function* () {
        const place = hands.get(id)?.place;
        if (!place) return undefined;
        const changes = yield* projects.changes(place).pipe(Effect.mapError((e) => refused(e.message)));
        const conflict = conflictOf(changes);
        const session = core.session(id);
        if (session && !sameConflict(session.conflict, conflict)) apply({ type: "conflict", id, ...(conflict ? { conflict } : {}) });
        return changes;
      });

    const recheck = (id: string) =>
      Effect.gen(function* () {
        const place = hands.get(id)?.place;
        const session = core.session(id);
        if (!place || !session) return;
        const conflict = yield* projects.conflict(place, session.conflict?.base ?? "");
        if (!sameConflict(session.conflict, conflict)) apply({ type: "conflict", id, ...(conflict ? { conflict } : {}) });
      });

    // ── bringing the farm back ──

    const expireLogs = (days: number) =>
      Effect.gen(function* () {
        if (days <= 0) return;
        const ids = yield* db(qs.sessionsEndedBefore({ before: Date.now() - days * dayMs }));
        for (const r of ids) trajectories.forget(r.id);
      });

    const restore = Effect.gen(function* () {
      yield* expireLogs(config.session.trajectoryDays);
      // The runs still going when the server stopped stopped with it.
      for (const r of yield* db(qr.openRuns())) yield* keptRun(`run ${r.id}`, runs.finish(r.id, "interrupted", "VibeValley 重启了，这一轮停在了半路"));
      const kept = new Map((yield* db(qs.hands())).map((r) => [r.id, r]));
      // Numbering goes on from the highest id seen, so a new session never takes an old one's steps.
      hired = Math.max(
        0,
        ...[...(yield* db(qs.sessionIDs())).map((r) => r.id), ...core.state().sessions.map((s) => s.id)]
          .map((id) => Number.parseInt(id.replace(/^w/, ""), 10))
          .filter((n) => Number.isFinite(n)),
      );
      for (const session of core.state().sessions) {
        const row = kept.get(session.id);
        const place = row?.place ? json<Workplace>(row.place) : undefined;
        if (!row || !place || !existsSync(place.cwd)) {
          apply({ type: "left", id: session.id, closed: "lost" });
          trajectories.finish(session.id);
          yield* ended(session.id, "lost");
          notice("warn", `${session.name} 没接回来：${place ? "干活的目录不见了（" + place.cwd + "）" : "库里没有它的记录"}`);
          continue;
        }
        const s = { place, oarSessionId: row.oar_session ?? "", lastText: row.last_text ?? "", recalled: json<string[]>(row.recalled) ?? [] };
        hands.set(session.id, {
          id: session.id,
          place: s.place,
          journal: yield* logOf(session),
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
          apply({ type: "report", id: session.id, outcome: "interrupted", summary: "VibeValley 重启了，这一轮停在了半路", runs: session.runs });
          notice("info", `VibeValley 重启过，${session.name} 那一轮停下了；给它带句话就能接着干`);
        }
      }
      if (hands.size > 0) yield* Effect.logInfo(`vibevalley: 接回 ${hands.size} 个帮工`);
      yield* chat.helpersBack;
    });

    // The sessions are let go first: a turn cut off by the shutdown is reported when the farm comes back, not on the way out.
    // The database closes after this layer: what brings the sessions back is written while it is still open.
    yield* Effect.addFinalizer(() =>
      Effect.andThen(
        Effect.suspend(() => {
          closing = true;
          clearTimeout(pending);
          return keepHands;
        }),
        Effect.promise(async () => {
          const all = [...hands.values()];
          for (const h of all) h.journal.close();
          await Promise.race([
            Promise.all(
              all.map((h) => {
                const s = h.sess;
                release(h);
                return s ? s.subagents.close().catch(() => {}) : Promise.resolve();
              }),
            ),
            new Promise((r) => setTimeout(r, closeWaitMs).unref()),
          ]);
          trajectories.close();
        }),
      ),
    );

    const view = (h: Hand): Roster | undefined => {
      const session = core.session(h.id);
      return session ? { session, place: h.place, lastText: h.lastText } : undefined;
    };

    const shape: SessionShape = {
      noRoom: roomFor,
      makeRoom: (runtime, project) =>
        Effect.gen(function* () {
          const full = roomFor(runtime, project);
          if (full) return { refused: full };
          const oldest = whoMakesRoom(core.state().sessions, maxRunning);
          if (!oldest) return {};
          yield* shape.dismiss(oldest.id);
          return { evicted: oldest.name };
        }),
      send: (agent, task, where, opt = {}) =>
        admission.withPermits(1)(
          Effect.gen(function* () {
            const full = roomFor(agent.runtime, where);
            if (full) return { refused: full };
            hired++;
            const id = `w${hired}`;
            const placed = yield* Effect.result(projects.workplace(where, id, opt.worktree ?? agent.worktree ?? false, opt.base ?? "", opt.issueNumber ?? 0));
            if (placed._tag === "Failure") return { refused: `${agent.name} 没地方干活：${placed.failure.message}` };
            const place = placed.success;
            const recalled = new Set<string>();
            const recall = yield* remind(agent.id, id, place.project, task, recalled);
            const opened = yield* open(agent, id, place, withRecall(recall, task), "");
            const giveBack = Effect.gen(function* () {
              revokeToken(id);
              const kept = yield* projects.release(place);
              if (kept) notice("warn", kept);
            });
            if (!opened.session) {
              yield* giveBack;
              return { refused: `${agent.name} 派不出去：${opened.refused}` };
            }
            const session: Session = {
              id,
              name: sessionName(core.state().sessions, agent.id, agent.name),
              agent: agent.id,
              runtime: agent.runtime,
              brief: task,
              project: place.project,
              hiredAt: Date.now(),
              runs: 0,
              phase: { _tag: "arriving" },
              ...(opt.taskGraph ? { graph: opt.taskGraph } : {}),
              ...(opt.channel ? { channel: opt.channel } : {}),
              ...(opt.refining ? { refining: true } : {}),
              ...(opt.issue ? { issue: opt.issue } : {}),
              ...(place.branch ? { branch: place.branch, worktree: place.cwd } : {}),
            };
            if (opt.hiring) {
              const written = yield* Effect.result(opt.hiring(session));
              if (written._tag === "Failure") {
                yield* Effect.promise(() => opened.session.subagents.close().catch(() => {}));
                yield* giveBack;
                return { refused: `${agent.name} 的工单没记下来：${String(written.failure instanceof Error ? written.failure.message : written.failure)}` };
              }
            }
            const h: Hand = {
              id,
              place,
              journal: yield* logOf(session),
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
            hands.set(id, h);
            apply({ type: "hired", session });
            attach(h, opened.session, agent.runtime);
            return { session };
          }),
        ),
      deliver,
      tell: (id, text, by) =>
        Effect.map(deliver(id, text, by), (d) => {
          const name = core.session(id)?.name ?? id;
          switch (d.kind) {
            case "steered":
              return name + " 正在干，话已经插进去了";
            case "queued":
              return name + " 这一轮做完再看这句话";
            case "run":
              return d.woke ? name + " 醒了，开始新的一轮" : name + " 开始新的一轮";
          }
          return d.reason ?? "";
        }),
      stop: (id) =>
        Effect.gen(function* () {
          const s = hands.get(id)?.sess;
          if (!s || core.session(id)?.phase._tag !== "working") return false;
          const outcome = yield* Effect.promise(() => s.agent.interrupt().catch((e: unknown) => ({ kind: "failed" as const, reason: String(e) })));
          if (outcome.kind !== "accepted") {
            yield* Effect.logWarning(`vibevalley: ${id} did not take the stop: ${"reason" in outcome ? outcome.reason : ""}`);
            return false;
          }
          return true;
        }),
      dismiss: (id) =>
        admission.withPermits(1)(
          Effect.gen(function* () {
            const h = hands.get(id);
            if (!h) return false;
            const name = core.session(id)?.name ?? id;
            yield* closeOar(h);
            yield* leave(h, "dismissed", 0);
            const kept = yield* projects.release(h.place);
            if (kept) notice("info", `${name} 收工了：${kept}`);
            return true;
          }),
        ),
      place: (id) => hands.get(id)?.place,
      roster: () =>
        [...hands.values()]
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .flatMap((h) => {
            const r = view(h);
            return r ? [r] : [];
          }),
      find: (id) => {
        const h = hands.get(id);
        return h ? view(h) : undefined;
      },
      handOver: harvest,
      changes: changesOf,
      recheck,
      list: (agent) =>
        Effect.gen(function* () {
          const out = core.state().sessions.filter((s) => !agent || s.agent === agent);
          const rows = yield* db(qs.endedSessions({ agent }));
          const runs = yield* db(qr.runsOfEndedSessions());
          const bySession = Map.groupBy(runs, (r) => r.session);
          for (const r of rows) if (!out.some((s) => s.id === r.id)) out.push(endedSession(r, bySession.get(r.id) ?? []));
          return out.sort((a, b) => b.hiredAt - a.hiredAt);
        }),
      get: (id) =>
        Effect.gen(function* () {
          const live = core.session(id);
          if (live) return live;
          const r = yield* db(Effect.option(qs.sessionByID({ id })));
          if (Option.isNone(r) || r.value.ended_at === null) return undefined;
          return endedSession(r.value, yield* db(qr.runsOfSession({ session: id })));
        }),
      runs: (issue) => Effect.map(db(qr.runsOfIssue({ issue_id: issue })), (rows) => rows.map(runOf)),
      currentRun: (id) => hands.get(id)?.run ?? executions.get(id)?.() ?? "",
      events: (id, r) => trajectories.events(id, r),
      trajectories,
      sessionOf: (id) => core.session(id),
      presentSessions: () => core.state().sessions,
      launches: Effect.map(PubSub.subscribe(launchesHub), Stream.fromSubscription),
      news: Effect.map(PubSub.subscribe(newsHub), Stream.fromSubscription),
      finishedRuns: Effect.map(PubSub.subscribe(finishedHub), Stream.fromSubscription),
      inputsConsumed: Effect.map(PubSub.subscribe(consumedHub), Stream.fromSubscription),
      issueToken,
      revokeToken,
      who,
      setAddress: (address) => void (mcpUrl = `http://${address}/mcp`),
      mcpUrl: () => mcpUrl,
      runStore: {
        ...runs,
        finished: (r) => PubSub.publishUnsafe(finishedHub, r),
        consumed: (c) => PubSub.publishUnsafe(consumedHub, c),
        register: (session, current) => void executions.set(session, current),
      },
      restore,
    };
    // The channels' helpers are these sessions: the channels hand them what is said to them and hear what they did.
    chat.useHelpers({
      present: (id) => hands.has(id),
      deliver,
      currentRun: shape.currentRun,
      report: (id) => summaryOf(hands.get(id)?.lastText ?? ""),
      onIssue: (issue) => sessionOnIssue(core.state(), issue)?.id,
      sessionOf: shape.sessionOf,
      presentSessions: shape.presentSessions,
    });
    yield* Effect.forkScoped(Stream.runForEach(yield* shape.launches, chat.activity));
    yield* Effect.forkScoped(Stream.runForEach(yield* shape.inputsConsumed, chat.consumed));
    yield* Effect.forkScoped(Stream.runForEach(yield* shape.news, chat.sessionNews));
    // A handle for tests: what the shape does not say.
    return Object.assign(shape, { hands, expect, unexpect, hired: () => hired, run });
  });

export const layer = (options?: SessionOptionsIn) => Layer.effect(Sessions, make(options));

/** Brings the sessions back once every service is built. */
export const ready = Layer.effectDiscard(Effect.flatMap(Sessions, (s) => s.restore));

export type { From };
