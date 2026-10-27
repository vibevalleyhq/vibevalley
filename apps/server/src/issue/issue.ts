import { needsOwner, talkJob } from "./prompts.ts";
import { commandOf } from "@vibevalley/protocol/api";
import { issueWording } from "./words.ts";
import { wording } from "@vibevalley/protocol/words";
import {
  type Agent,
  type Question,
  type Changes,
  type CriterionCheck,
  type Finding,
  type IssueRun,
  type IssueAnswer,
  type Deliverable,
  type Outcome,
  type Issue,
  type Delivery,
  type IssueCanceled,
  type SessionClose,
  type IssueHistory,
  type IssueRequest,
  type IssueStatus,
  IssueStatusValues,
  type IssueTimeline,
  type IssueUpdate,
  type Preview,
  orchestratorAgent,
  ownerId,
  type Priority,
  type ProjectTemplates,
  type RunTrigger,
  type Recurrence,
  type Session,
  type SessionId,
  type TaskGraph,
} from "@vibevalley/protocol";
import { issueId, sessionId } from "@vibevalley/protocol/schema";
import { closedText, shortTitle } from "@vibevalley/protocol/rules";
import { isForOrchestrator, issueRefiningOf, issueOrder, issueStatusOf, keepClosedIssues } from "./state.ts";
import { cut } from "../base/text.ts";
import { templateCatalog } from "../agent/seed.ts";
import { attentionIn } from "./attention.ts";
import { nextSteps, statusMove, statusMoves } from "./moves.ts";
import { graphIssues } from "../task/rules.ts";
import { dueText } from "../recurrence/rules.ts";
import {
  answerCureWords,
  cureWords,
  filledKinds,
  findingsOf,
  isClosed,
  issueJob,
  kept,
  milestonesOf,
  nextTaskId,
  openQuestions,
  resumeWords,
  sentTitles,
  splitJob,
} from "./rules.ts";
import { Clock, Context, Effect, FiberMap, Layer, Option, PubSub, Schedule, Schema, type Scope, Semaphore, Stream } from "effect";
import { isBusy } from "@vibevalley/protocol/rules";
import { inboxLines } from "../channel/prompts.ts";
import { jsonOf, jsonOrNone } from "../base/json.ts";
import * as S from "@vibevalley/protocol/schema";
import { SqlClient, SqlError } from "effect/sql";
import { Agents } from "../agent/agent.ts";
import { Settings } from "../base/config.ts";
import { causeMessage, Db } from "../base/db.ts";
import { newId } from "../base/ids.ts";
import { Channels } from "../channel/chat.ts";
import { Core } from "../core/core.ts";
import { type ApiError, missing, lookIn, reasonOf, refused } from "../errors.ts";
import { issueBranch, Projects } from "../project/project.ts";
import { Runtimes } from "../runtime/runtime.ts";
import { merging } from "./merge.ts";
import { refinement } from "./refinement.ts";
import { jsonOrNull, nullText } from "./rules.ts";
import { askedMax } from "../session/journal.ts";
import { type Hired, type HireOptions, type SessionNews, Sessions } from "../session/session.ts";
import { type Due, Recurrences } from "../recurrence/recurrence.ts";
import * as q from "../../db/generated/issue.sql.ts";
import * as qq from "../../db/generated/issue_queue.sql.ts";
import * as qs from "../../db/generated/issue_session.sql.ts";
import { IssueSessions } from "./sessions.ts";
import { actsForOwner, type Actor } from "../base/actor.ts";
import { conflictBrief, parseAnswer } from "../session/rules.ts";

export interface OrchestratorWork {
  readonly issue: Issue;
  readonly channel: string;
  readonly by: RunTrigger;
  readonly recurrence?: Recurrence;
  /** What the owner said with it, asking again (another round, a reopen). */
  readonly said?: string;
}

export interface IssueShape {
  /** The issues on the board: a talk with a profile is not one. */
  readonly list: () => Effect.Effect<Issue[]>;
  /** The issues the board holds now (open, and the latest closed). */
  readonly onBoard: () => readonly Issue[];
  readonly get: (id: string) => Effect.Effect<Issue, ApiError>;
  readonly add: (req: IssueRequest) => Effect.Effect<Issue, ApiError>;
  /** On the owner's word only (actsForOwner). */
  readonly edit: (id: string, upd: IssueUpdate, by: Actor) => Effect.Effect<Issue, ApiError>;
  readonly remove: (id: string) => Effect.Effect<void, ApiError>;
  readonly queue: (id: string, queued: boolean) => Effect.Effect<Issue, ApiError>;
  readonly start: (id: string, channel: string) => Effect.Effect<Dispatched, ApiError>;
  readonly reopen: (id: string, text: string, channel: string) => Effect.Effect<string, ApiError>;
  /** agent: moving to todo, the profile (id or name) that takes it on; another than its own hands it over. On the owner's
   * word only (actsForOwner). */
  readonly setStatus: (id: string, to: IssueStatus, text: string, channel: string, by: Actor, opt?: StatusOptions) => Effect.Effect<Issue, ApiError>;
  /** Stops the turn of the session working it; the session stays, and a word starts the next. */
  readonly stop: (id: string) => Effect.Effect<void, ApiError>;
  /** What setStatus would do with the same request, refused as it would be; nothing changes. edit: the owner's unsaved
   * fields, as the move would see them once saved. */
  readonly previewStatus: (id: string, to: IssueStatus, text: string, opt?: StatusOptions, edit?: IssueUpdate) => Effect.Effect<Preview, ApiError>;
  /** What remove would do, refused as it would be; nothing changes. */
  readonly previewRemove: (id: string) => Effect.Effect<Preview, ApiError>;
  /** An issue's id from what the owner and the orchestrator call it: #41 or 41, its id, or the id of a session that worked it. */
  readonly idOf: (ref: string) => Effect.Effect<string, ApiError>;
  readonly comment: (id: string, text: string, sendKey?: string) => Effect.Effect<void, ApiError>;
  /** The owner's look counts for the game; anyone else's does not. */
  readonly changes: (id: string, by: Actor) => Effect.Effect<Changes, ApiError>;
  readonly merge: (id: string) => Effect.Effect<string, ApiError>;
  readonly cancel: (id: string) => Effect.Effect<void, ApiError>;
  readonly review: (id: string, req: IssueReviewRequest) => Effect.Effect<Issue, ApiError>;
  readonly refine: (id: string, word: string, channel: string) => Effect.Effect<Issue, ApiError>;
  /** The owner's direct channel with a helper profile (or the orchestrator), opened with its talk issue the first time. */
  readonly talkWith: (agent: string) => Effect.Effect<string, ApiError>;
  readonly history: () => Effect.Effect<IssueHistory[]>;
  readonly timeline: (id: string) => Effect.Effect<IssueTimeline, ApiError>;
  readonly templates: (project: string) => Effect.Effect<ProjectTemplates, ApiError>;
  /** Sends a session for a job that is not written down first (the orchestrator sending someone at once, a task's step): its issue is made from the job. */
  readonly hire: (agent: Agent, task: string, project: string, opt?: HireOptions) => Effect.Effect<Hired>;
  /** A session starts on an existing issue: open it and link the session in one write. */
  readonly ran: (id: string, session: Session) => Effect.Effect<void, Error>;
  /** The issues of a task graph as the graph has them now, published as one commit once written. */
  readonly putTask: (graph: TaskGraph) => Effect.Effect<void>;
  readonly nextTaskId: () => Effect.Effect<string>;
  /** Issues for the orchestrator, subscribed before it returns. */
  readonly forOrchestrator: Effect.Effect<Stream.Stream<OrchestratorWork>, never, Scope.Scope>;
  readonly ofRecurrence: (id: string) => Effect.Effect<Issue | undefined>;
  readonly refreshPullRequests: Effect.Effect<void>;
  readonly tryQueued: Effect.Effect<void>;
}

export interface StatusOptions {
  readonly agent?: string;
}

/** What starting an issue came to: the session sent, or why it waits in the queue. */
export interface Dispatched {
  readonly session?: SessionId;
  readonly queued?: string;
}

/** A verdict on what was handed back: passed, or not, with the findings (or words) it is mended by. */
export interface IssueReviewRequest {
  readonly pass: boolean;
  readonly findings?: readonly string[];
  readonly text?: string;
}

export class Issues extends Context.Service<Issues, IssueShape>()("vibevalley/Issue") {}

type Row = q.GetIssueResult;

// The issue's JSON columns, read by their Schemas; one that does not read is none.
const strings = Schema.mutable(Schema.Array(Schema.String));
const column = {
  graph: jsonOrNone(S.IssueGraph),
  task: jsonOrNone(S.IssueTask),
  strings: jsonOrNone(strings),
  checks: jsonOrNone(Schema.mutable(Schema.Array(S.CriterionCheck))),
  pullRequest: jsonOrNone(S.PullRequest),
  run: jsonOrNone(S.IssueRun),
  answer: jsonOrNone(S.IssueAnswer),
  findings: jsonOrNone(Schema.mutable(Schema.Array(S.Finding))),
  questions: jsonOrNone(Schema.mutable(Schema.Array(S.Question))),
};
const triggerOf = jsonOf(S.RunTrigger);

/** Only while the issue is still open: a completion the owner chose (kept, none) is written before its session leaves,
 * and a task graph's step closes with its graph, so neither comes here. */
const closingOf = (closed: SessionClose | undefined): { delivered: Delivery } | { canceled: IssueCanceled } =>
  closed === "merged" ? { delivered: "merged" } : closed === "completed" ? { delivered: "none" } : { canceled: closed === "lost" ? "lost" : "dismissed" };

export function reopenTask(issue: Issue, last: Session, text: string, previous: boolean, handedOver = false): string {
  const w = issueWording().job;
  const how = handedOver ? w.handedOver(last.name, last.id) : w.reopened(last.name, last.id);
  let out = (text.trim() || w.reopenDefault) + w.how(how);
  out += w.original(cut(issueJob(issue), askedMax));
  if (issue.answer) out += w.answer(cut(issue.answer.conclusion, askedMax));
  if (issue.closedAt !== undefined) out += w.closed(closedText(issue));
  if (last.lastRun) out += w.lastRun(wording().outcome[last.lastRun.outcome], cut(last.lastRun.summary.trim(), askedMax));
  if (previous) out += w.previous;
  return out + w.end;
}

function failedText(findings: readonly Finding[], text: string): string {
  const w = issueWording().job;
  let out = w.failedHead;
  let n = 0;
  for (const f of findings) if (!f.resolved) out += `\n${++n}. ${f.text}`;
  if (text) out += "\n\n" + text;
  return out + w.failedEnd;
}

/** A talk's session stays this long with nothing said after its round. */
const talkIdleMs = 10 * 60_000;
/** How much of a talk a session sent for it is given: the newest messages. */
const talkContext = 12;

export interface IssueOptions {
  readonly tryEveryMs?: number;
  readonly background?: boolean;
  /** How long a talk's session stays with nothing said after its round. */
  readonly talkIdleMs?: number;
}

export const make = (options: IssueOptions = {}) =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const config = yield* Settings;
    const core = yield* Core;
    const store = yield* Agents;
    const projects = yield* Projects;
    const runtimes = yield* Runtimes;
    const sessions = yield* Sessions;
    const chat = yield* Channels;
    const recurrences = yield* Recurrences;
    const sql = yield* SqlClient.SqlClient;
    const { run: db, one, inTx } = yield* Db;
    const worked = new IssueSessions();
    /** After an issue is removed: its sessions' rows went with it, and its children's. */
    const reloadSessions = Effect.suspend(() => Effect.map(db(qs.allSessions()), (rows) => worked.load(rows)));
    yield* reloadSessions;
    const orchestratorHub = yield* PubSub.unbounded<OrchestratorWork>();
    /** One round of the queue at a time. */
    const trying = yield* Semaphore.make(1);

    function issueOf(row: Row, runs: readonly string[] | undefined): Issue {
      const state = core.state();
      const graph = column.graph(row.graph);
      const task = column.task(row.task);
      const blockedBy = column.strings(row.blocked_by);
      const criteria = column.strings(row.criteria);
      const checks = column.checks(row.checks);
      const pullRequest = column.pullRequest(row.pull_request);
      const lastRun = column.run(row.last_run);
      const answer = column.answer(row.answer);
      const out: Issue = {
        id: issueId(row.id),
        number: row.number,
        title: row.title,
        ...(row.description ? { description: row.description } : {}),
        ...(row.project !== null ? { project: row.project } : {}),
        ...(row.assignee !== null ? { assignee: row.assignee } : {}),
        priority: row.priority as Priority,
        createdAt: row.created_at,
        ...(row.queued_at !== null ? { queuedAt: row.queued_at } : {}),
        sessions: (runs ?? []).map((s) => sessionId(s)),
        ...(row.closed_at !== null ? { closedAt: row.closed_at } : {}),
        ...(row.delivered !== null ? { delivered: row.delivered as Delivery } : {}),
        ...(row.canceled !== null ? { canceled: row.canceled as IssueCanceled } : {}),
        ...(row.parent !== null ? { parent: issueId(row.parent) } : {}),
        ...(blockedBy ? { blockedBy } : {}),
        ...(graph ? { graph } : {}),
        ...(task ? { task } : {}),
        ...(row.recurrence !== null ? { recurrence: row.recurrence } : {}),
        status: "backlog",
        moves: [],
        ...(pullRequest ? { pullRequest } : {}),
        deliver: row.deliver as Deliverable,
        ...(row.talk !== null ? { talk: row.talk } : {}),
        ...(row.reviewed_at !== null ? { reviewedAt: row.reviewed_at } : {}),
        findings: column.findings(row.findings) ?? [],
        questions: column.questions(row.questions) ?? [],
        ...(criteria ? { criteria } : {}),
        ...(checks ? { checks } : {}),
        ...(lastRun ? { lastRun } : {}),
        ...(answer ? { answer } : {}),
        attention: { state: "draft", acts: [] },
      };
      if ((out.sessions.length === 0 || out.task) && row.rank) out.rank = row.rank;
      out.status = issueStatusOf(out, state);
      const refiner = issueRefiningOf(out, state);
      if (refiner) out.refining = refiner;
      // The moves read the attention: a round that failed is not completed.
      out.attention = attentionIn(out, state);
      out.moves = statusMoves(out);
      return out;
    }

    const list = Effect.gen(function* () {
      const rows = yield* db(q.listIssues());
      return rows.map((r) => issueOf(r, worked.of(r.id))).sort(issueOrder);
    });

    const idOf = Effect.fn("Issues.idOf")(function* (ref: string): Effect.fn.Return<string, ApiError> {
      const r = ref.trim();
      const number = /^#?(\d+)$/.exec(r)?.[1];
      if (number !== undefined) {
        const row = yield* one(q.issueByNumber({ number: Number(number) }));
        if (!row) return yield* Effect.fail(missing(issueWording().issueNumbered(number), [lookIn.issue]));
        return row.id;
      }
      return worked.issueOf(r) ?? r;
    });

    const get = Effect.fn("Issues.get")(function* (ref: string): Effect.fn.Return<Issue, ApiError> {
      const issue = yield* idOf(ref);
      const row = yield* one(q.getIssue({ id: issue }));
      if (!row) return yield* Effect.fail(missing(issueWording().issueRef(ref), [lookIn.issue]));
      return issueOf(row, worked.of(issue));
    });

    const publish = (id: string) =>
      get(id).pipe(
        Effect.flatMap((issue) => core.apply({ type: "issue", issue })),
        Effect.catch((e) => Effect.logWarning(`vibevalley: issue ${id} changed but could not be read back for the board: ${reasonOf(e)}`)),
      );

    /** The newest session, the one a merge, changes, comments and cancel act on; a reopen makes another. */
    const latest = (id: string) =>
      Effect.flatMap(get(id), (issue) =>
        issue.sessions.length === 0 ? Effect.fail(refused(issueWording().notStarted)) : Effect.succeed(issue.sessions.at(-1)!),
      );

    const unsent = (id: string) =>
      Effect.flatMap(get(id), (issue) =>
        issue.graph || issue.task
          ? Effect.fail(refused(issueWording().inGraph))
          : issue.sessions.length > 0
            ? Effect.fail(refused(issueWording().started))
            : Effect.succeed(issue),
      );

    const liveSession = (id: string) =>
      Effect.flatMap(latest(id), (session) =>
        sessions.find(session) ? Effect.succeed(session) : Effect.fail(missing(issueWording().helperRef(session), [lookIn.session])),
      );

    const issueWords = (req: Pick<IssueRequest, "title" | "description">) => {
      const [title, rest] = splitJob(req.title);
      if (!title) return Effect.fail(refused(issueWording().noTitle));
      let description = (req.description ?? "").trim();
      if (rest) description = (rest + "\n\n" + description).trim();
      return Effect.succeed([title, description] as const);
    };

    const add = Effect.fn("Issues.add")(function* (req: IssueRequest, recurrence?: string, talk?: string) {
      const [title, description] = yield* issueWords(req);
      const id = newId();
      yield* db(
        q.addIssue({
          id,
          title,
          description,
          project: nullText(req.project),
          assignee: nullText(req.assignee),
          priority: req.priority ?? "medium",
          created_at: yield* Clock.currentTimeMillis,
          recurrence: recurrence ?? null,
          // The orchestrator never changes code: what it is given is answered.
          deliver: req.deliver ?? (req.assignee === orchestratorAgent ? "answer" : "change"),
          talk: talk ?? null,
        }),
      );
      yield* publish(id);
      return yield* get(id);
    });

    const complete = (id: string, delivered: Delivery) =>
      Effect.andThen(db(q.completeIssue({ closed_at: clock.currentTimeMillisUnsafe(), delivered, id })), publish(id));
    const cancelAs = (id: string, canceled: IssueCanceled) =>
      Effect.andThen(db(q.cancelIssue({ closed_at: clock.currentTimeMillisUnsafe(), canceled, id })), publish(id));

    /** A run no session carries: an in-process agent's, the orchestrator's. */
    const endRun = Effect.fn("Issues.endRun")(function* (id: string, outcome: Outcome) {
      const t = yield* get(id);
      // A run cut off by a restart closed its issue as lost; the run it goes on in ends on it all the same.
      if (isClosed(t.status)) {
        if (t.canceled !== "lost") return;
        yield* db(q.reopenIssue({ id }));
      }
      const now = yield* Clock.currentTimeMillis;
      const run: IssueRun = { startedAt: t.lastRun?.startedAt ?? now, endedAt: now, outcome };
      yield* db(q.setLastRun({ id, last_run: JSON.stringify(run) }));
      yield* publish(id);
    });

    const reopenRow = (id: string) => Effect.andThen(db(q.reopenIssue({ id })), publish(id));

    /** What the session waits on the owner for, from its report; a report with none, or a comment, clears them. */
    const asked = (id: string, questions: readonly Question[] | undefined) =>
      Effect.andThen(db(q.setIssueQuestions({ id, questions: jsonOrNull(openQuestions(questions), openQuestions(questions).length > 0) })), publish(id));

    /** The helper's word on each criterion, from the newest report that gave one; a reopen clears it. */
    const checked = (id: string, checks: readonly CriterionCheck[]) => db(q.setIssueChecks({ id, checks: jsonOrNull(checks, checks.length > 0) }));

    /** An answer issue's round: one that got through gives its conclusion (none readable leaves the issue stuck on it); whatever it changed goes, so the issue never delivers a change. */
    const answered = Effect.fn("Issues.answered")(function* (id: string, session: string, outcome: Outcome, answer: IssueAnswer | undefined) {
      const t = yield* get(id);
      if (t.deliver !== "answer" || t.sessions.at(-1) !== session) return;
      // A talk has no conclusion to read: its words are in its channel. What the round changed goes all the same.
      if (t.talk) return yield* sessions.discardWork(session);
      if (outcome === "completed") yield* db(q.setIssueAnswer({ id, answer: jsonOrNull(answer, answer !== undefined) }));
      yield* sessions.discardWork(session);
      yield* publish(id);
    });

    /** at 0 is not accepted (a fail, or another round started); the findings are written as they stand. */
    const judged = (id: string, at: number, findings: readonly Finding[]) =>
      Effect.andThen(db(q.reviewIssue({ id, reviewed_at: at > 0 ? at : null, findings: jsonOrNull(findings, findings.length > 0) })), publish(id));

    /** The owner's word answers what it asked, and starts a round that the last acceptance did not see. */
    const ownerSaid = Effect.fn("Issues.ownerSaid")(function* (id: string) {
      yield* asked(id, []);
      const t = yield* get(id);
      if (t.reviewedAt !== undefined) yield* judged(id, 0, t.findings);
    });

    /** The issue already owns its number and workplace before its session starts. */
    const ran = Effect.fn("Issues.ran")(function* (id: string, session: Session) {
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* q.reopenIssue({ id });
            yield* q.assignIssue({ id, assignee: session.agent });
            yield* qs.addSession({ session: session.id, issue: id, started_at: session.hiredAt });
            yield* qq.dequeueIssue({ issue: id });
          }),
        )
        .pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.mapError((e) => new Error(causeMessage(e))),
        );
      worked.added(session.id, id);
      yield* publish(id);
    });

    /** Queueing keeps the first dispatch context until the issue starts or leaves the queue. */
    const queueRow = Effect.fn("Issues.queueRow")(function* (id: string, queued: boolean, channel: string, by?: RunTrigger) {
      yield* unsent(id);
      yield* inTx(
        queued
          ? Effect.andThen(
              db(qq.enqueueIssue({ issue: id, channel, triggered_by: JSON.stringify(by ?? { kind: "issue" }) })),
              db(q.queueIssue({ at: yield* Clock.currentTimeMillis, id })),
            )
          : Effect.andThen(db(qq.dequeueIssue({ issue: id })), db(q.unqueueIssue({ id }))),
      );
      yield* publish(id);
      return yield* get(id);
    });

    const queuedDispatch = (id: string) =>
      Effect.flatMap(one(qq.queuedIssue({ issue: id })), (row) =>
        row ? Effect.succeed([row.channel, triggerOf(row.triggered_by)] as const) : Effect.fail(refused(issueWording().notQueued(id))),
      );

    const drop = Effect.fn("Issues.drop")(function* (id: string) {
      yield* unsent(id);
      yield* inTx(
        Effect.all(
          [
            db(qq.dequeueIssue({ issue: id })),
            db(q.unqueueIssue({ id })),
            db(q.cancelIssue({ closed_at: yield* Clock.currentTimeMillis, canceled: "dismissed", id })),
          ],
          {
            discard: true,
          },
        ),
      );
      yield* publish(id);
    });

    const hire = Effect.fn("Issues.hire")(function* (agent: Agent, task: string, project: string, opt: HireOptions = {}) {
      if (agent.id === orchestratorAgent) return { refused: issueWording().orchestratorNotHelper };
      if (!agent.enabled) return { refused: issueWording().disabled(agent.name) };
      for (const i of yield* runtimes.check(agent)) if (i.level === "error") return { refused: issueWording().cannotSend(agent.name, i.text) };
      const where = project.trim() || (agent.workdir ?? "").trim();
      if (!where) return { refused: issueWording().noProject };
      const room = yield* sessions.makeRoom(agent.runtime, where);
      if ("refused" in room) return { refused: room.refused };
      const evicted = room.evicted ?? "";
      const prepared = yield* Effect.result(
        (opt.issue ? get(opt.issue) : add({ title: task, project: where, assignee: agent.id })).pipe(
          // The database failing (a full disk) is told as a refusal; any other defect is a bug and stays one.
          Effect.catchDefect((d) => (SqlError.isSqlError(d) ? Effect.fail(refused(causeMessage(d))) : Effect.die(d))),
        ),
      );
      if (prepared._tag === "Failure") return { refused: issueWording().notRecorded(agent.name, reasonOf(prepared.failure)) };
      const issue = prepared.success;
      // A draft's session is not one of the issue's sessions: the issue stays unsent.
      const hired = yield* sessions.send(agent, task, where, { ...opt, issue, ...(!opt.refining ? { hiring: (w: Session) => ran(issue.id, w) } : {}) });
      if (!hired.session && !opt.issue && !hired.retainedWork) {
        yield* db(q.removeIssue({ id: issue.id }));
        yield* reloadSessions;
        yield* core.apply({ type: "issueGone", id: issue.id });
      }
      if (hired.retainedWork) return { ...hired, refused: issueWording().workKept(hired.refused, issue.number) };
      return hired.session && evicted ? { ...hired, evicted } : hired;
    });

    /** Starting it and its dry run ask the same, so neither refuses what the other allows. */
    const readyOf = Effect.fn("Issues.readyOf")(function* (issue: Issue) {
      if (issue.refining) return yield* Effect.fail(refused(issueWording().drafting(issue.refining.name)));
      const pick = [lookIn.agent, { say: issueWording().pickHint(commandOf("issue.status.update", [String(issue.number)]).join(" ")) }];
      if (!issue.assignee) return yield* Effect.fail(refused(issueWording().noAssignee, pick));
      const agent = store.agent(issue.assignee);
      if (!agent) return yield* Effect.fail(refused(issueWording().profileGone(issue.assignee), pick));
      return [issue, agent, issue.project ?? agent.workdir ?? ""] as const;
    });

    const ready = (id: string) => Effect.flatMap(unsent(id), readyOf);

    const send = (issue: Issue, agent: Agent, project: string, channel: string, by?: RunTrigger) =>
      Effect.flatMap(hire(agent, issueJob(issue), project, { channel, issue: issue.id, ...(by ? { trigger: by } : {}) }), (hired) =>
        hired.session ? Effect.succeed(hired.session.id) : Effect.fail(refused(hired.refused ?? issueWording().sendFailed)),
      );

    /** Its run starts as it is handed over: the issue is in progress until the run ends on it (endRun). */
    const toOrchestrator = Effect.fn("Issues.toOrchestrator")(function* (issue: Issue, channel: string, by: RunTrigger, due?: Recurrence, said?: string) {
      if (isClosed(issue.status)) yield* db(q.reopenIssue({ id: issue.id }));
      const run: IssueRun = { startedAt: yield* Clock.currentTimeMillis };
      yield* db(q.setLastRun({ id: issue.id, last_run: JSON.stringify(run) }));
      yield* publish(issue.id);
      PubSub.publishUnsafe(orchestratorHub, { issue, channel, by, ...(due ? { recurrence: due } : {}), ...(said ? { said } : {}) });
    });

    /** said: the owner's words with it, when it is asked again. */
    const start = Effect.fn("Issues.start")(function* (id: string, channel: string, by?: RunTrigger, said?: string): Effect.fn.Return<Dispatched, ApiError> {
      const mine = yield* Effect.option(get(id));
      if (Option.isSome(mine) && isForOrchestrator(mine.value)) {
        yield* toOrchestrator(mine.value, channel, by ?? { kind: "issue" }, undefined, said);
        return {};
      }
      const [issue, agent, project] = yield* ready(id);
      let where = channel;
      let trigger = by;
      if (issue.queuedAt !== undefined) [where, trigger] = yield* queuedDispatch(id);
      const full = sessions.noRoom(agent.runtime, project);
      if (full) {
        yield* queueRow(issue.id, true, (yield* chat.topOf(where)).id, trigger);
        return { queued: issueWording().queued(full) };
      }
      return { session: yield* send(issue, agent, project, where, trigger) };
    });

    /** In the board's order: one that cannot go any more leaves the queue. */
    const tryQueued = trying.withPermits(1)(
      Effect.gen(function* () {
        for (const issue of yield* list) {
          if (issue.status !== "todo") continue;
          const title = cut(issue.title, 40);
          const sent = yield* Effect.result(
            Effect.gen(function* () {
              const [, agent, project] = yield* ready(issue.id);
              if (sessions.noRoom(agent.runtime, project)) return "";
              const [channel, by] = yield* queuedDispatch(issue.id);
              return yield* send(issue, agent, project, channel, by);
            }),
          );
          if (sent._tag === "Success") {
            if (sent.success) yield* core.notice("info", issueWording().queuedStarted(title, sent.success));
            continue;
          }
          const why = reasonOf(sent.failure);
          const left = yield* Effect.result(queueRow(issue.id, false, chat.defaultChannel()));
          if (left._tag === "Failure") {
            yield* core.notice("warn", issueWording().queuedStuck(title, why));
            continue;
          }
          yield* core.notice("warn", issueWording().queuedBack(title, why));
        }
      }),
    );

    /** to: another profile takes it on; else the one the last session worked as. */
    const reopen = Effect.fn("Issues.reopen")(function* (id: string, text: string, channel: string, by: RunTrigger = { kind: "comment" }, to?: Agent) {
      const issue = yield* get(id);
      if (issue.graph || issue.task || issue.delivered === "merged_into_parent") return yield* Effect.fail(refused(issueWording().graphRetry));
      if (issue.sessions.length === 0) {
        // Run before by no session (the orchestrator): its doer takes it up again, with the owner's words.
        if (!issue.lastRun) return yield* Effect.fail(refused(issueWording().neverStarted));
        if (!isClosed(issue.status)) return yield* Effect.fail(refused(issueWording().stillOpen));
        yield* start(id, channel, by, text);
        return "";
      }
      const last = yield* sessions.get(issue.sessions.at(-1)!);
      if (!last) return yield* Effect.fail(missing(issueWording().issueRef(id), [lookIn.issue]));
      if (!isClosed(issue.status)) return yield* Effect.fail(refused(issueWording().stillWorking(last.name)));
      const agent = to ?? store.agent(last.agent);
      if (!agent) return yield* Effect.fail(refused(issueWording().senderGone(last.agent)));
      const where = issue.project ?? "";
      const changes = yield* projects.branchChanges(where, issueBranch(issue.number)).pipe(Effect.mapError((e) => refused(e.message)));
      const previous = (changes?.commits.length ?? 0) > 0;
      const task = reopenTask(issue, last, text, previous, agent.id !== last.agent);
      const hired = yield* hire(agent, task, where, { channel, issue: issue.id, trigger: by });
      if (!hired.session) return yield* Effect.fail(refused(hired.refused ?? issueWording().sendFailed));
      return hired.session.id;
    });

    /** A recurrence has one issue, for the session it names or for the orchestrator; each time it comes due is a run of that issue. */
    const scheduled = Effect.fn("Issues.scheduled")(function* (due: Due) {
      const s = due.recurrence;
      const channel = yield* chat.topOf(s.channel);
      const by: RunTrigger = { kind: "recurrence", recurrence: s.id, ...(due.missed ? { missed: true } : {}) };
      const found = yield* ofRecurrence(s.id);
      let issue = found;
      if (!issue) {
        const project = s.project ?? (channel.project || undefined);
        const made = yield* Effect.result(
          add({ title: s.name, description: s.text, ...(project ? { project } : {}), assignee: s.agent ?? orchestratorAgent }, s.id),
        );
        if (made._tag === "Failure")
          return yield* chat.notice(channel.id, issueWording().recurrenceNoIssue(s.name, reasonOf(made.failure)), "recurrence_refused");
        issue = made.success;
      }
      const text = dueText(s, due.missed);
      const t = issue;
      const result = yield* Effect.result(
        Effect.gen(function* () {
          if (isForOrchestrator(t)) return yield* toOrchestrator(t, channel.id, by, s);
          if (!found || t.status === "backlog" || t.status === "todo") return yield* Effect.asVoid(start(t.id, channel.id, by));
          if (isClosed(t.status)) return yield* Effect.asVoid(reopen(t.id, text, channel.id, by));
          const d = yield* sessions.deliver(t.sessions.at(-1)!, text, by);
          if (d.kind === "refused") return yield* Effect.fail(refused(d.reason ?? ""));
        }),
      );
      if (result._tag === "Failure") yield* chat.notice(channel.id, issueWording().recurrenceNoStart(s.name, reasonOf(result.failure)), "recurrence_refused");
    });

    const ofRecurrence = Effect.fn("Issues.ofRecurrence")(function* (id: string) {
      const row = yield* one(q.latestOfRecurrence({ recurrence: id }));
      if (!row) return undefined;
      return Option.getOrUndefined(yield* Effect.option(get(row.id)));
    });

    const { merge, refreshPullRequests } = merging({
      core,
      sessions,
      projects,
      chat,
      db,
      inTx,
      get,
      list,
      latest,
      liveSession,
      publish,
    });

    const comment = Effect.fn("Issues.comment")(function* (id: string, text: string, sendKey: string = "") {
      const issue = yield* get(id);
      if (isClosed(issue.status)) return yield* Effect.fail(refused(issueWording().closedReopen));
      const session = yield* liveSession(id);
      const said = yield* chat.tellSession(ownerId, session, text, sendKey);
      // Said in its thread, the issue hears it from the message's fact (heard below); with no thread there is no fact.
      if (!said) yield* ownerSaid(id);
    });

    /** The commits on the issue's branch that the main branch does not have; none for one without a project or branch. */
    const commitsOf = (t: Issue) =>
      t.project
        ? Effect.map(projects.branchChanges(t.project, issueBranch(t.number)).pipe(Effect.mapError((e) => refused(e.message))), (c) => c?.commits.length ?? 0)
        : Effect.succeed(0);

    /** The profile that takes an issue on as it moves to todo; undefined when it is the one it has. Refused before anything
     * moves, so a handover never leaves its session gone and no one sent. */
    const takerOf = Effect.fn("Issues.takerOf")(function* (t: Issue, to: IssueStatus, key: string) {
      const a = store.named(key.trim());
      if (!a) return yield* Effect.fail(refused(issueWording().noProfileNamed(key), [lookIn.agent]));
      if (a.id === t.assignee) return undefined;
      if (to !== "todo") return yield* Effect.fail(refused(issueWording().handOverOnTodo));
      if (t.status === "in_progress") return yield* Effect.fail(refused(issueWording().stopFirst(t.number)));
      if (!a.enabled) return yield* Effect.fail(refused(issueWording().disabled(a.name)));
      for (const i of yield* runtimes.check(a)) if (i.level === "error") return yield* Effect.fail(refused(issueWording().cannotSend(a.name, i.text)));
      return a;
    });

    /** Its session, if one is on the farm, goes home; an issue no session works on has nobody to send. */
    const cancel = Effect.fn("Issues.cancel")(function* (id: string) {
      const t = yield* get(id);
      const last = t.sessions.at(-1);
      if (last === undefined || !sessions.find(last)) return;
      if (!(yield* sessions.dismiss(last))) return yield* Effect.fail(missing(issueWording().helperRef(last), [lookIn.session]));
    });

    /** The issue as a move would see it once the owner's unsaved fields are saved (issue.status saves them first);
     * refused as saving them would be: only how it is accepted and what it delivers change once it is sent. */
    const withEdit = Effect.fn("Issues.withEdit")(function* (t: Issue, edit: IssueUpdate | undefined) {
      if (!edit) return t;
      const reworded = Object.keys(edit).some((k) => k !== "deliver");
      if (reworded) yield* unsent(t.id);
      return { ...t, ...Object.fromEntries(Object.entries(edit).filter(([, v]) => v !== undefined)) };
    });

    /** The move and what it settles before anything changes; refused as the move itself would be. setStatus carries it out,
     * previewStatus says it in words: one judgment, so a dry run never promises what the move would refuse. */
    const settledMove = Effect.fn("Issues.settledMove")(function* (t: Issue, to: IssueStatus, text: string, opt: StatusOptions) {
      if (!(IssueStatusValues as readonly string[]).includes(to)) return yield* Effect.fail(refused(issueWording().noStatus(to)));
      const taker = opt.agent ? yield* takerOf(t, to, opt.agent) : undefined;
      const [move, why] = statusMove(t, to);
      const said = text.trim();
      if (move === "none") return yield* Effect.fail(refused(why, nextSteps(t)));
      // Stuck, it goes back with the server's own words for why; otherwise the owner says what this round is for.
      if (move === "round" && !taker && !said && t.attention.state !== "stuck") return yield* Effect.fail(refused(issueWording().roundNeedsWords));
      let delivery: "kept" | "none" | "merge" | undefined;
      let commits = 0;
      if (move === "complete") {
        commits = yield* commitsOf(t);
        delivery = commits === 0 ? "none" : t.deliver === "branch" ? "kept" : "merge";
      }
      return { t, to, move, said, taker, delivery, commits };
    });

    const helperName = (t: Issue) => {
      const last = t.sessions.at(-1);
      return (last !== undefined ? sessions.sessionOf(last)?.name : undefined) ?? issueWording().helper;
    };

    const stuckWords = Effect.fn("Issues.stuckWords")(function* (t: Issue) {
      const last = t.sessions.at(-1);
      switch (t.attention.stuck) {
        case "conflict": {
          const conflict = sessions.sessionOf(yield* liveSession(t.id))?.conflict;
          if (!conflict) return yield* Effect.fail(refused(issueWording().noConflict(helperName(t))));
          return conflictBrief(conflict.base, conflict.files);
        }
        case "failed": {
          const lastRun = last !== undefined ? sessions.sessionOf(last)?.lastRun : undefined;
          const unread = t.deliver === "answer" && lastRun?.outcome === "completed" && !lastRun.answer;
          return unread
            ? answerCureWords(parseAnswer(sessions.find(last ?? "")?.lastText ?? "").problem)
            : cureWords((last !== undefined ? sessions.sessionOf(last)?.brief : undefined) ?? t.title);
        }
        case "interrupted":
          return resumeWords();
        case "quiet":
        case undefined:
          return yield* Effect.fail(refused(issueWording().roundNeedsWords));
      }
    });

    /** A settled move in words, one step a line; what it reads to say so (who would go, the room, a merge's conflicts) is read, not changed. */
    const movesWords = Effect.fn("Issues.movesWords")(function* (p: Effect.Success<ReturnType<typeof settledMove>>) {
      const t = p.t;
      const n = `#${t.number}`;
      switch (p.move) {
        case "start": {
          if (isForOrchestrator(t)) return [issueWording().does.toOrchestrator(n)];
          const [, agent, project] = yield* readyOf(p.taker ? { ...t, assignee: p.taker.id } : t);
          const full = sessions.noRoom(agent.runtime, project);
          return full
            ? [issueWording().does.sendTo(n, agent.name), issueWording().does.noRoom(full)]
            : [project ? issueWording().does.startIn(n, agent.name, project) : issueWording().does.start(n, agent.name)];
        }
        case "unqueue":
          return [issueWording().does.unqueue(n)];
        case "round": {
          if (p.taker) return [issueWording().does.leaves(helperName(t)), issueWording().does.takesOver(p.taker.name)];
          const helper = helperName(t);
          if (t.sessions.length === 0) return [issueWording().does.orchestratorRound(n, p.said)];
          if (!p.said) {
            yield* stuckWords(t);
            return [
              t.attention.stuck === "conflict"
                ? issueWording().does.resolve(helper)
                : t.attention.stuck === "interrupted"
                  ? issueWording().does.resume(helper, resumeWords())
                  : issueWording().does.cure(helper),
            ];
          }
          if (t.attention.state === "reviewing") return [issueWording().does.reject(t.number, findingsOf(p.said).length, helper)];
          return [issueWording().does.round(helper, p.said)];
        }
        case "reopen":
          return [issueWording().does.reopen(n, p.taker?.name), ...(p.said ? [issueWording().does.thisTime(p.said)] : [])];
        case "revive":
          return [issueWording().does.revive(n)];
        case "complete": {
          if (p.delivery === "none") return [issueWording().does.completeNone(n), issueWording().does.helperLeaves(helperName(t))];
          if (p.delivery === "kept") return [issueWording().does.completeKept(n, p.commits), issueWording().does.helperLeaves(helperName(t))];
          const changes = yield* sessions.changes(yield* liveSession(t.id));
          const pr = t.project !== undefined && (t.pullRequest?.state === "open" || projects.usesPullRequests(t.project));
          const out: string[] = [];
          if (changes && changes.uncommitted.length > 0) out.push(issueWording().does.commitFirst(helperName(t), changes.uncommitted.length));
          if (changes && changes.conflicts.length > 0) return [...out, issueWording().does.conflicts(changes.base, changes.conflicts)];
          out.push(issueWording().does.check);
          out.push(pr ? issueWording().does.pullRequest(p.commits) : issueWording().does.merge(changes?.base, p.commits, helperName(t)));
          return out;
        }
        case "cancel":
          return [issueWording().does.cancel(n), issueWording().does.cancelLeaves(helperName(t))];
        case "drop":
          return [issueWording().does.drop(n), ...(t.refining ? [issueWording().does.drafterLeaves(t.refining.name)] : [])];
      }
    });

    const { draft, handedBack, clearRefinement } = refinement({
      core,
      store,
      runtimes,
      sessions,
      chat,
      db,
      one,
      inTx,
      get,
      unsent,
      hire,
      publish,
    });

    const onSessionNews = Effect.fn("Issues.onSessionNews")(function* (n: SessionNews) {
      switch (n._tag) {
        case "left": {
          const e = n.left;
          const issue = worked.issueOf(e.id);
          if (!issue) return;
          const row = yield* one(q.getIssue({ id: issue }));
          if (!row || row.graph !== null || row.task !== null) return;
          const runs = worked.of(issue);
          // Closed already (completed by the owner before its session went home): the verdict stands.
          if (runs.at(-1) !== e.id || row.closed_at !== null) return;
          const closing = closingOf(e.closed);
          yield* db(
            "delivered" in closing
              ? q.completeOpenIssue({ closed_at: yield* Clock.currentTimeMillis, delivered: closing.delivered, id: issue })
              : q.cancelOpenIssue({ closed_at: yield* Clock.currentTimeMillis, canceled: closing.canceled, id: issue }),
          );
          yield* publish(issue);
          return;
        }
        case "reported": {
          const e = n.report;
          const issue = worked.issueOf(e.id);
          // A report's 要问主人： lines are what its issue waits on the owner for; a report without them clears them.
          const checks = e.checks ?? [];
          if (issue && checks.length > 0) yield* checked(issue, checks);
          if (issue) yield* asked(issue, e.questions);
          if (issue) yield* answered(issue, e.id, e.outcome, e.answer);
          if (issue && (yield* get(issue)).talk) yield* idleLater(issue, e.id);
          yield* handedBack(e);
          return;
        }
        case "hired":
          return;
      }
    });

    /** Where a talk with a profile that has no folder of its own looks: the project worked in last, else the first one. */
    const lastProject = Effect.gen(function* () {
      const worked = (yield* list).filter((i) => i.project && !i.talk).sort((a, b) => b.createdAt - a.createdAt)[0]?.project;
      return worked ?? (yield* projects.list())[0]?.name ?? "";
    });

    /** The owner said something to a profile no session talks for now: one is sent, with the talk so far. */
    const talkOn = Effect.fn("Issues.talkOn")(function* (t: Issue) {
      const agent = store.agent(t.assignee ?? "");
      if (!agent || !t.talk) return;
      const said = inboxLines(yield* chat.recent(t.talk, talkContext));
      const hired = yield* hire(agent, talkJob(agent.name, said), t.project ?? (agent.workdir || (yield* lastProject)), {
        channel: t.talk,
        issue: t.id,
        trigger: { kind: "comment" },
      });
      if (!hired.session) yield* chat.notice(t.talk, hired.refused ?? issueWording().sendFailed, "talk_refused");
    });

    const onOwnerInThread = Effect.fn("Issues.onOwnerInThread")(function* (thread: string) {
      const issue = yield* Effect.option(get(thread));
      if (Option.isNone(issue)) return;
      const t = issue.value;
      if (t.talk) {
        const last = t.sessions.at(-1);
        if (last === undefined || !sessions.find(last)) yield* talkOn(t);
        return;
      }
      if (isClosed(t.status)) return;
      yield* ownerSaid(t.id);
    });

    /** A talk's session goes home once nothing is said for talkIdleMs after its round; the next word sends another. */
    const idleTalks = yield* FiberMap.make<string>();
    const idleLater = (id: string, session: string) =>
      FiberMap.run(
        idleTalks,
        id,
        Effect.delay(
          Effect.gen(function* () {
            const s = sessions.sessionOf(session);
            if (!s || isBusy(s)) return;
            yield* sessions.dismiss(session, "discard", "completed");
          }).pipe(Effect.catchCause((c) => Effect.logWarning(`vibevalley: a talk's session ${session} going home: ${String(c)}`))),
          options.talkIdleMs ?? talkIdleMs,
        ),
      );

    const rows = yield* db(q.keptIssues({ closed: keepClosedIssues }));
    for (const row of rows) yield* core.apply({ type: "issue", issue: issueOf(row, worked.of(row.id)) });
    // An in-process run on its issues stopped with the server: one still going is lost; one that ended still waits on the owner.
    for (const r of yield* db(q.openOf({ assignee: orchestratorAgent }))) {
      const run = column.run(r.last_run);
      if (run && run.endedAt === undefined) yield* cancelAs(r.id, "lost");
    }

    const news = yield* sessions.news;
    const ownerWords = yield* chat.ownerInThread;
    const finished = yield* sessions.finishedRuns;
    const due = yield* recurrences.due;
    const logged =
      (what: string) =>
      <A, E>(e: Effect.Effect<A, E>) =>
        Effect.asVoid(e).pipe(Effect.catchCause((c) => Effect.logWarning(`vibevalley: ${what}: ${String(c)}`)));
    // One at a time: a report and the owner's word on it do not cross.
    yield* Effect.forkScoped(
      Stream.runForEach(
        Stream.merge(
          news,
          Stream.map(ownerWords, (w) => ({ _tag: "owner" as const, thread: w.thread })),
        ),
        (n) =>
          n._tag === "owner"
            ? onOwnerInThread(n.thread).pipe(logged(`issues after the owner's words in ${n.thread}`))
            : onSessionNews(n).pipe(logged(`issues after ${n._tag}`)),
      ),
    );
    yield* Effect.forkScoped(
      // However the orchestrator's turn ended, the issue waits on the owner: a turn that did not fail is not an answer yet.
      Stream.runForEach(finished, (run) =>
        Effect.forEach(run.issues, (id) => endRun(id, run.outcome).pipe(logged(`run ${run.id} finished on issue ${id}`)), {
          discard: true,
        }),
      ),
    );
    yield* Effect.forkScoped(Stream.runForEach(due, (d) => scheduled(d).pipe(logged(`recurrence ${d.recurrence.id}`))));
    if (options.background ?? true) {
      // Each waits a period before its first run, then runs every period.
      const tryEvery = options.tryEveryMs ?? 5000;
      yield* Effect.forkScoped(tryQueued.pipe(logged("the queue"), Effect.repeat(Schedule.spaced(tryEvery)), Effect.delay(tryEvery)));
      const pollEvery = config.github.prPollSeconds > 0 ? config.github.prPollSeconds * 1000 : 180_000;
      yield* Effect.forkScoped(refreshPullRequests.pipe(logged("refresh pull requests"), Effect.repeat(Schedule.spaced(pollEvery)), Effect.delay(pollEvery)));
    }

    /** On the board before another unsent issue, or last; only unsent issues have a place. */
    const place = Effect.fn("Issues.place")(function* (id: string, before: string) {
      const order: string[] = (yield* list).filter((t) => t.sessions.length === 0 && !t.graph && !t.task && t.id !== id).map((t) => t.id);
      const at = order.indexOf(before);
      order.splice(at < 0 ? order.length : at, 0, id);
      yield* inTx(Effect.forEach(order, (each, rank) => db(q.placeIssue({ rank, id: each })), { discard: true }));
      for (const each of order) yield* publish(each);
    });

    const timeline = Effect.fn("Issues.timeline")(function* (id: string) {
      const issue = yield* get(id);
      const runs = yield* sessions.runs(issue.id);
      const names = new Map<string, string>();
      for (const s of new Set(runs.map((r) => r.session))) {
        const found = yield* sessions.get(s);
        if (found) names.set(s, found.name);
      }
      return milestonesOf(issue, runs, names);
    });

    const shape: IssueShape = {
      onBoard: () => core.state().issues ?? [],
      list: () => Effect.map(list, (all) => all.filter((t) => !t.talk)),
      get,
      timeline,
      add: (req) => add(req),
      /** The words and who does it only before it is sent; how it is accepted and what it delivers while it is open: the
       * next round goes by them. */
      edit: Effect.fn("Issues.edit")(function* (id, upd, by) {
        if (!actsForOwner(by)) return yield* Effect.fail(refused(needsOwner));
        const whileOpen =
          upd.title === undefined &&
          upd.description === undefined &&
          upd.project === undefined &&
          upd.assignee === undefined &&
          upd.priority === undefined &&
          upd.criteria === undefined &&
          upd.before === undefined;
        let was: Issue;
        if (whileOpen) {
          was = yield* get(id);
          if (isClosed(was.status)) return yield* Effect.fail(refused(issueWording().closed));
        } else was = yield* unsent(id);
        const [title, description] = yield* issueWords({ title: upd.title ?? was.title, description: upd.description ?? was.description ?? "" });
        if (upd.project !== undefined && upd.project !== was.project && was.project) {
          const released = yield* sessions.clearWorkplace(was.id, was.project, was.number, "preserve");
          if (released.kept) return yield* Effect.fail(refused(issueWording().cannotMoveProject(was.number, released.reason)));
        }
        const criteria = upd.criteria !== undefined ? kept(upd.criteria) : (was.criteria ?? []);
        yield* db(
          q.editIssue({
            title,
            description,
            project: nullText(upd.project ?? was.project),
            assignee: nullText(upd.assignee ?? was.assignee),
            priority: upd.priority ?? was.priority,
            criteria: jsonOrNull(criteria, criteria.length > 0),
            deliver: upd.deliver ?? was.deliver,
            id,
          }),
        );
        if (upd.before !== undefined) yield* place(id, upd.before);
        else yield* publish(id);
        return yield* get(id);
      }),
      remove: Effect.fn("Issues.remove")(function* (id) {
        const t = yield* unsent(id);
        const cleared = yield* clearRefinement(t);
        if (cleared.kept) return yield* Effect.fail(refused(issueWording().cannotDelete(t.number, cleared.reason)));
        yield* db(q.removeIssue({ id }));
        yield* reloadSessions;
        yield* core.apply({ type: "issueGone", id } as never);
      }),
      queue: (id, queued) => queueRow(id, queued, chat.defaultChannel()),
      start: (id, channel) => start(id, channel),
      reopen: (id, text, channel) => reopen(id, text, channel),
      idOf,
      stop: Effect.fn("Issues.stop")(function* (id) {
        yield* sessions.stop(yield* liveSession(id));
      }),
      setStatus: Effect.fn("Issues.setStatus")(function* (ref, to, text, channel, by, opt = {}) {
        if (!actsForOwner(by)) return yield* Effect.fail(refused(needsOwner));
        const t = yield* get(ref);
        // Read by its number too: every write below goes by its id.
        const id = t.id;
        const { move, said, taker, delivery } = yield* settledMove(t, to, text, opt);
        switch (move) {
          case "start":
            if (taker) yield* shape.edit(id, { assignee: taker.id }, by);
            yield* start(id, channel);
            break;
          case "unqueue":
            yield* queueRow(id, false, chat.defaultChannel());
            break;
          // Handed over: its session leaves first, so that one session at a time works the issue's branch.
          case "round":
            if (taker) {
              yield* cancel(id);
              yield* cancelAs(id, "dismissed");
              yield* reopen(id, said, channel, { kind: "comment" }, taker);
              break;
            }
            // A session on the farm hears it in its thread; with none (the orchestrator's), its doer is asked again. While it
            // waits for acceptance the words are the findings, written down and given as the next round's job.
            if (t.sessions.length === 0) yield* start(id, channel, { kind: "comment" }, said);
            else if (said && t.attention.state === "reviewing") yield* shape.review(id, { pass: false, findings: findingsOf(said) });
            else yield* comment(id, said || (yield* stuckWords(t)));
            break;
          case "reopen":
            yield* reopen(id, said, channel, { kind: "comment" }, taker);
            break;
          case "revive":
            yield* reopenRow(id);
            break;
          // What it delivers follows the issue: nothing to take in (no commits), or its branch kept by the owner's choice,
          // touches no git and opens no pull request; the rest is merged into the main branch or by a pull request.
          case "complete": {
            // Completing is the acceptance: whatever it was sent back for is settled.
            if (t.findings.some((f) => !f.resolved))
              yield* judged(
                id,
                t.reviewedAt ?? 0,
                t.findings.map((f) => ({ ...f, resolved: true })),
              );
            if (delivery === "kept" || delivery === "none") {
              // Written down before its session goes home, so that leaving does not take it for canceled.
              yield* complete(id, delivery);
              const last = t.sessions.at(-1);
              if (last !== undefined && sessions.find(last)) yield* sessions.dismiss(last, "keep", "completed");
              break;
            }
            // The session's leaving closes the issue too, but later: closed here, the answer already says so.
            yield* merge(id);
            const updated = yield* get(id);
            if (updated.pullRequest?.state !== "open") yield* complete(id, updated.pullRequest ? "pull_request" : "merged");
            break;
          }
          case "cancel":
            yield* cancel(id);
            yield* cancelAs(id, "dismissed");
            break;
          case "drop":
            yield* clearRefinement(t);
            yield* drop(id);
            break;
        }
        return yield* get(id);
      }),
      previewStatus: Effect.fn("Issues.previewStatus")(function* (id, to, text, opt = {}, edit) {
        const t = yield* withEdit(yield* get(id), edit);
        return { does: yield* movesWords(yield* settledMove(t, to, text, opt)) };
      }),
      previewRemove: Effect.fn("Issues.previewRemove")(function* (id) {
        const t = yield* unsent(id);
        return {
          does: [
            issueWording().does.deleteIssue(t.number, shortTitle(t.title)),
            ...(t.refining ? [issueWording().does.drafterLeaves(t.refining.name)] : []),
            ...(t.project ? [issueWording().does.cleanWorktree] : []),
          ],
        };
      }),
      comment,
      changes: Effect.fn("Issues.changes")(function* (id, by) {
        const session = yield* liveSession(id);
        const changes = yield* sessions.changes(session);
        if (!changes) return yield* Effect.fail(missing(issueWording().helperRef(session), [lookIn.session]));
        if (by.kind === "owner") yield* core.did({ kind: "reviewed", session });
        return changes;
      }),
      merge,
      cancel,
      review: Effect.fn("Issues.review")(function* (id, req) {
        const t = yield* get(id);
        const why = isForOrchestrator(t)
          ? issueWording().orchestratorAnswers
          : t.graph || t.task
            ? issueWording().graphAcceptance
            : t.status !== "in_review"
              ? issueWording().nothingToAccept
              : "";
        if (why) return yield* Effect.fail(refused(why, nextSteps(t)));
        if (req.pass) {
          yield* judged(
            id,
            yield* Clock.currentTimeMillis,
            t.findings.map((f) => ({ ...f, resolved: true })),
          );
          return yield* get(id);
        }
        const fresh = kept(req.findings);
        const text = (req.text ?? "").trim();
        if (fresh.length === 0 && !text) return yield* Effect.fail(refused(issueWording().failNeedsFindings));
        const at = yield* Clock.currentTimeMillis;
        const findings = [...t.findings, ...fresh.map((text) => ({ id: newId(), text, at }))];
        yield* judged(id, 0, findings);
        // The findings go to whoever works it as the next round's words, like any comment.
        yield* comment(id, failedText(findings, text));
        return yield* get(id);
      }),
      refine: draft,
      talkWith: Effect.fn("Issues.talkWith")(function* (ref) {
        const agent = store.named(ref.trim()) ?? store.agent(ref);
        if (!agent) return yield* Effect.fail(missing(issueWording().noProfileNamed(ref), [lookIn.agent]));
        if (agent.id === orchestratorAgent) return chat.orchestratorDirect();
        const channel = yield* chat.openDirect({ id: agent.id, name: agent.name });
        if (!(yield* one(q.talkOf({ talk: channel })))) {
          const made = yield* add({ title: issueWording().talkTitle(agent.name), assignee: agent.id, deliver: "answer" }, undefined, channel);
          yield* chat.linkTalk(channel, made.id);
        }
        return channel;
      }),
      /** A session with no record is named as missing, not given a phase. */
      history: Effect.fn("Issues.history")(function* () {
        const all = (yield* list).filter((t) => !t.talk);
        const byId = new Map((yield* sessions.list("")).map((s) => [s.id, s]));
        return all.map((issue) => ({
          issue,
          sessions: issue.sessions.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])),
          missingSessions: issue.sessions.filter((id) => !byId.has(id)),
        }));
      }),
      templates: Effect.fn("Issues.templates")(function* (name) {
        const stack = yield* projects.stack(name);
        if (!stack) return yield* Effect.fail(missing(issueWording().projectRef(name), [lookIn.project]));
        return { project: name, stack, recent: sentTitles(yield* list, name), kinds: filledKinds(templateCatalog(), stack) };
      }),
      hire,
      ran,
      putTask: Effect.fn("Issues.putTask")(function* (graph) {
        const family = Effect.fn("Issues.family")(function* (id: string) {
          const rows = yield* db(q.family({ id }));
          return rows.map((r) => issueOf(r, worked.of(r.id)));
        });
        const before = yield* family(graph.id);
        const issues = graphIssues(graph, before, yield* Clock.currentTimeMillis);
        const gone = yield* inTx(
          Effect.gen(function* () {
            for (const t of issues)
              yield* db(
                q.putIssue({
                  id: t.id,
                  title: t.title,
                  description: t.description ?? "",
                  project: nullText(t.project),
                  assignee: nullText(t.assignee),
                  priority: t.priority,
                  rank: t.rank ?? 0,
                  created_at: t.createdAt,
                  closed_at: t.closedAt ?? null,
                  delivered: t.delivered ?? null,
                  canceled: t.canceled ?? null,
                  parent: nullText(t.parent),
                  blocked_by: jsonOrNull(t.blockedBy, (t.blockedBy ?? []).length > 0),
                  graph: jsonOrNull(t.graph, !!t.graph),
                  task: jsonOrNull(t.task, !!t.task),
                }),
              );
            const out: string[] = [];
            for (const old of before)
              if (!issues.some((t) => t.id === old.id)) {
                yield* db(q.removeIssue({ id: old.id }));
                out.push(old.id);
              }
            return out;
          }),
        );
        if (gone.length > 0) yield* reloadSessions;
        // Published in one core.apply, once the transaction has succeeded.
        const updated = yield* Effect.forEach([...issues.slice(1), issues[0]!], (t) => get(t.id).pipe(Effect.orDie));
        yield* core.apply(...gone.map((id) => ({ type: "issueGone", id }) as never), ...updated.map((issue) => ({ type: "issue" as const, issue })));
      }),
      nextTaskId: () => Effect.map(db(q.graphIDs()), (rows) => nextTaskId(rows.map((r) => r.id))),
      forOrchestrator: Effect.map(PubSub.subscribe(orchestratorHub), Stream.fromSubscription),
      ofRecurrence,
      refreshPullRequests,
      tryQueued,
    };
    return shape;
  });

export const layer = (options?: IssueOptions) => Layer.effect(Issues, make(options));
