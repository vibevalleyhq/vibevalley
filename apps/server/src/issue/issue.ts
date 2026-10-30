import { Clock, Context, Effect, FiberMap, Layer, Option, PubSub, Schedule, Schema, type Scope, Semaphore, Stream } from "effect";
import { SqlClient, SqlError } from "effect/sql";

import { list, t } from "@vibevalley/i18n";
import {
  type Agent,
  type Question,
  type Changes,
  type CriterionCheck,
  type Finding,
  type IssueRun,
  type IssueAnswer,
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
  type IssueFilter,
  type IssueUpdate,
  type Preview,
  ownerId,
  type ProjectTemplates,
  type RunTrigger,
  type Cron,
  type Session,
  type SessionId,
  type TaskGraph,
} from "@vibevalley/protocol";
import { commandOf } from "@vibevalley/protocol/api";
import { closedText, shortTitle, isOneOf, isBusy } from "@vibevalley/protocol/rules";
import { issueId, sessionId } from "@vibevalley/protocol/schema";
import * as S from "@vibevalley/protocol/schema";

import { Agents } from "@/agent/agent.ts";
import { templateCatalog } from "@/agent/seed.ts";
import { actsForOwner, type Actor } from "@/base/actor.ts";
import { cut } from "@/base/clip.ts";
import { ServerConfig } from "@/base/config.ts";
import { causeMessage, Db } from "@/base/db.ts";
import { newId } from "@/base/ids.ts";
import { jsonOf, jsonOrNone } from "@/base/json.ts";
import { scopedPubSub } from "@/base/pubsub.ts";
import { Channels } from "@/channel/chat.ts";
import { inboxLines } from "@/channel/prompts.ts";
import { Core } from "@/core/core.ts";
import { type Due, Crons } from "@/cron/cron.ts";
import { dueText } from "@/cron/due.ts";
import { type ApiError, missing, lookIn, reasonOf, refused } from "@/errors.ts";
import { issueBranch, Projects } from "@/project/project.ts";
import { Runtimes } from "@/runtime/runtime.ts";
import { askedMax } from "@/session/journal.ts";
import { parseAnswer } from "@/session/report.ts";
import { type Hired, type HireOptions, NotRecorded, type SessionNews, Sessions } from "@/session/session.ts";
import { conflictBrief } from "@/session/takeIn.ts";
import { graphIssues } from "@/task/issues.ts";

import * as q from "../../db/generated/issue.sql.ts";
import * as qq from "../../db/generated/issue_queue.sql.ts";
import * as qs from "../../db/generated/issue_session.sql.ts";
import { attentionIn } from "./attention.ts";
import { answerCureWords, cureWords, findingsOf, issueBrief, resumeWords, splitBrief } from "./brief.ts";
import { pickIssues } from "./filter.ts";
import { merging } from "./merge.ts";
import { nextSteps, statusMove, statusMoves } from "./moves.ts";
import { needsOwner, talkJob } from "./prompts.ts";
import { kept, openQuestions, refinement } from "./refinement.ts";
import { IssueSessions } from "./sessions.ts";
import { isForOrchestrator, issueRefiningOf, issueOrder, issueStatusOf, keepClosedIssues, isClosed } from "./status.ts";
import { nextTaskId, jsonOrNull, nullText } from "./stored.ts";
import { filledKinds, sentTitles } from "./templates.ts";
import { milestonesOf } from "./timeline.ts";

export interface OrchestratorWork {
  readonly issue: Issue;
  readonly channel: string;
  readonly by: RunTrigger;
  readonly cron?: Cron;
  /** What the owner said with it, asking again (another round, a reopen). */
  readonly said?: string;
}

export class Issues extends Context.Service<
  Issues,
  {
    /** The issues on the board: a talk with a profile is not one. */
    readonly list: () => Effect.Effect<Issue[]>;
    /** The board's issues a filter picks (issue.list). */
    readonly query: (f: IssueFilter) => Effect.Effect<Issue[]>;
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
    /** Sends a session for work that is not written down first (the orchestrator sending someone at once, a task's step): its issue is made from the brief. */
    readonly hire: (agent: Agent, task: string, project: string, opt?: HireOptions) => Effect.Effect<Hired>;
    /** A session starts on an existing issue: open it and link the session in one write. */
    readonly ran: (id: string, session: Session) => Effect.Effect<void, NotRecorded>;
    /** The issues of a task graph as the graph has them now, published as one commit once written. */
    readonly putTask: (graph: TaskGraph) => Effect.Effect<void>;
    readonly nextTaskId: () => Effect.Effect<string>;
    /** Issues for the orchestrator, subscribed before it returns. */
    readonly forOrchestrator: Effect.Effect<Stream.Stream<OrchestratorWork>, never, Scope.Scope>;
    readonly ofCron: (id: string) => Effect.Effect<Issue | undefined>;
    readonly refreshPullRequests: Effect.Effect<void>;
    readonly tryQueued: Effect.Effect<void>;
  }
>()("vibevalley/Issue") {
  static readonly layer = (options?: IssueOptions) => Layer.effect(Issues, make(options));
}

export interface StatusOptions {
  /** Moving to todo: the profile that takes it on (a name or an id). */
  readonly assignee?: string;
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

function reopenTask(issue: Issue, last: Session, text: string, previous: boolean, handedOver = false): string {
  const how = handedOver
    ? t("server.issue.brief.handedOver", { name: last.name, id: last.id })
    : t("server.issue.brief.reopened", { name: last.name, id: last.id });
  let out = (text.trim() || t("server.issue.brief.reopenDefault")) + t("server.issue.brief.how", { how });
  out += t("server.issue.brief.original", { brief: cut(issueBrief(issue), askedMax) });
  if (issue.answer) out += t("server.issue.brief.answer", { conclusion: cut(issue.answer.conclusion, askedMax) });
  if (issue.closedAt !== undefined) out += t("server.issue.brief.closed", { closed: closedText(issue) });
  if (last.lastRun)
    out += t("server.issue.brief.lastRun", { outcome: t(`shared.outcome.${last.lastRun.outcome}`), summary: cut(last.lastRun.summary.trim(), askedMax) });
  if (previous) out += t("server.issue.brief.previous");
  return out + t("server.issue.brief.end");
}

function failedText(findings: readonly Finding[], text: string): string {
  let out = t("server.issue.brief.failedHead");
  let n = 0;
  for (const f of findings) if (!f.resolved) out += `\n${++n}. ${f.text}`;
  if (text) out += "\n\n" + text;
  return out + t("server.issue.brief.failedEnd");
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

const make = (options: IssueOptions = {}) =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const config = yield* ServerConfig;
    const core = yield* Core;
    const store = yield* Agents;
    const projects = yield* Projects;
    const runtimes = yield* Runtimes;
    const sessions = yield* Sessions;
    const chat = yield* Channels;
    const crons = yield* Crons;
    const sql = yield* SqlClient.SqlClient;
    const { run: db, one, inTx } = yield* Db;
    const worked = new IssueSessions();
    /** After an issue is removed: its sessions' rows went with it, and its children's. */
    const reloadSessions = Effect.suspend(() => Effect.map(db(qs.allSessions()), (rows) => worked.load(rows)));
    yield* reloadSessions;
    const orchestratorHub = yield* scopedPubSub<OrchestratorWork>();
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
        description: row.description,
        ...(row.project !== null ? { project: row.project } : {}),
        ...(row.assignee !== null ? { assignee: row.assignee } : {}),
        priority: row.priority,
        createdAt: row.created_at,
        ...(row.queued_at !== null ? { queuedAt: row.queued_at } : {}),
        sessions: (runs ?? []).map((s) => sessionId(s)),
        ...(row.closed_at !== null ? { closedAt: row.closed_at } : {}),
        ...(row.delivered !== null ? { delivered: row.delivered } : {}),
        ...(row.canceled !== null ? { canceled: row.canceled } : {}),
        ...(row.parent !== null ? { parent: issueId(row.parent) } : {}),
        blockedBy: blockedBy ?? [],
        ...(graph ? { graph } : {}),
        ...(task ? { task } : {}),
        ...(row.cron !== null ? { cron: row.cron } : {}),
        status: "backlog",
        moves: [],
        ...(pullRequest ? { pullRequest } : {}),
        deliver: row.deliver,
        ...(row.talk !== null ? { talk: row.talk } : {}),
        ...(row.reviewed_at !== null ? { reviewedAt: row.reviewed_at } : {}),
        findings: column.findings(row.findings) ?? [],
        questions: column.questions(row.questions) ?? [],
        criteria: criteria ?? [],
        checks: checks ?? [],
        ...(lastRun ? { lastRun } : {}),
        ...(answer ? { answer } : {}),
        attention: { state: "draft", acts: [] },
      };
      if ((out.sessions.length === 0 || out.task) && row.rank !== 0) out.rank = row.rank;
      out.status = issueStatusOf(out, state);
      const refiner = issueRefiningOf(out, state);
      if (refiner) out.refining = refiner;
      // The moves read the attention: a round that failed is not completed.
      out.attention = attentionIn(out, state);
      out.moves = statusMoves(out);
      return out;
    }

    const everyIssue = Effect.gen(function* () {
      const rows = yield* db(q.listIssues());
      return rows.map((r) => issueOf(r, worked.of(r.id))).toSorted(issueOrder);
    });

    const idOf = Effect.fn("Issues.idOf")(function* (ref: string): Effect.fn.Return<string, ApiError> {
      const r = ref.trim();
      const number = /^#?(\d+)$/u.exec(r)?.[1];
      if (number !== undefined) {
        const row = yield* one(q.issueByNumber({ number: Number(number) }));
        if (!row) return yield* Effect.fail(missing(t("server.issue.issueNumbered", { n: number }), [lookIn.issue]));
        return row.id;
      }
      return worked.issueOf(r) ?? r;
    });

    const get = Effect.fn("Issues.get")(function* (ref: string): Effect.fn.Return<Issue, ApiError> {
      const issue = yield* idOf(ref);
      const row = yield* one(q.getIssue({ id: issue }));
      if (!row) return yield* Effect.fail(missing(t("server.issue.issueRef", { ref }), [lookIn.issue]));
      return issueOf(row, worked.of(issue));
    });

    const publish = (id: string) =>
      get(id).pipe(
        Effect.flatMap((issue) => core.apply({ type: "issue", issue })),
        Effect.catch((e) => Effect.logWarning(`vibevalley: issue ${id} changed but could not be read back for the board: ${reasonOf(e)}`)),
      );

    /** The newest session, the one a merge, changes, comments and cancel act on; a reopen makes another. */
    const latest = (id: string) =>
      Effect.flatMap(get(id), (issue) => {
        const last = issue.sessions.at(-1);
        return last === undefined ? Effect.fail(refused(t("server.issue.notStarted"))) : Effect.succeed(last);
      });

    const unsent = (id: string) =>
      Effect.flatMap(get(id), (issue) =>
        issue.graph || issue.task
          ? Effect.fail(refused(t("server.issue.inGraph")))
          : issue.sessions.length > 0
            ? Effect.fail(refused(t("server.issue.started")))
            : Effect.succeed(issue),
      );

    const liveSession = (id: string) =>
      Effect.filterOrFail(
        latest(id),
        (session) => sessions.find(session) !== undefined,
        (session) => missing(t("server.issue.helperRef", { id: session }), [lookIn.session]),
      );

    const issueWords = (req: Pick<IssueRequest, "title" | "description">) => {
      const [title, rest] = splitBrief(req.title);
      if (!title) return Effect.fail(refused(t("server.issue.noTitle")));
      let description = (req.description ?? "").trim();
      if (rest) description = (rest + "\n\n" + description).trim();
      return Effect.succeed([title, description] as const);
    };

    const add = Effect.fn("Issues.add")(function* (req: IssueRequest, cron?: string, talk?: string) {
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
          cron: cron ?? null,
          // The orchestrator never changes code: what it is given is answered.
          deliver: req.deliver ?? (store.isOrchestrator(req.assignee ?? "") ? "answer" : "change"),
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
      const item = yield* get(id);
      // A run cut off by a restart closed its issue as lost; the run it goes on in ends on it all the same.
      if (isClosed(item.status)) {
        if (item.canceled !== "lost") return;
        yield* db(q.reopenIssue({ id }));
      }
      const now = yield* Clock.currentTimeMillis;
      const run: IssueRun = { startedAt: item.lastRun?.startedAt ?? now, endedAt: now, outcome };
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
      const item = yield* get(id);
      if (item.deliver !== "answer" || item.sessions.at(-1) !== session) return;
      // A talk has no conclusion to read: its words are in its channel. What the round changed goes all the same.
      if (item.talk) return yield* sessions.discardWork(session);
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
      const item = yield* get(id);
      if (item.reviewedAt !== undefined) yield* judged(id, 0, item.findings);
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
          Effect.mapError((cause) => new NotRecorded({ message: causeMessage(cause), cause })),
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
        row ? Effect.succeed([row.channel, triggerOf(row.triggered_by)] as const) : Effect.fail(refused(t("server.issue.notQueued", { id }))),
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
      if (store.isOrchestrator(agent.id)) return { refused: t("server.issue.orchestratorNotHelper") };
      if (!agent.enabled) return { refused: t("server.issue.disabled", { name: agent.name }) };
      for (const i of yield* runtimes.problemsOf(agent))
        if (i.level === "error") return { refused: t("server.issue.cannotSend", { name: agent.name, why: i.text }) };
      const where = project.trim() || agent.workdir.trim();
      if (!where) return { refused: t("server.issue.noProject") };
      const room = yield* sessions.makeRoom(agent.runtime, where);
      if ("refused" in room) return { refused: room.refused };
      const evicted = room.evicted ?? "";
      const prepared = yield* Effect.result(
        (opt.issue ? get(opt.issue) : add({ title: task, project: where, assignee: agent.id })).pipe(
          // The database failing (a full disk) is told as a refusal; any other defect is a bug and stays one.
          Effect.catchDefect((d) => (SqlError.isSqlError(d) ? Effect.fail(refused(causeMessage(d))) : Effect.die(d))),
        ),
      );
      if (prepared._tag === "Failure") return { refused: t("server.issue.notRecorded", { name: agent.name, why: reasonOf(prepared.failure) }) };
      const issue = prepared.success;
      // A draft's session is not one of the issue's sessions: the issue stays unsent.
      const hired = yield* sessions.send(agent, task, where, { ...opt, issue, ...(opt.refining !== true ? { hiring: (w: Session) => ran(issue.id, w) } : {}) });
      if (!hired.session && !opt.issue && !hired.retainedWork) {
        yield* db(q.removeIssue({ id: issue.id }));
        yield* reloadSessions;
        yield* core.apply({ type: "issueGone", id: issue.id });
      }
      if (hired.retainedWork) return { ...hired, refused: t("server.issue.workKept", { refused: hired.refused ?? "", n: issue.number }) };
      return hired.session && evicted ? { ...hired, evicted } : hired;
    });

    /** Starting it and its dry run ask the same, so neither refuses what the other allows. */
    const readyOf = Effect.fn("Issues.readyOf")(function* (issue: Issue) {
      if (issue.refining) return yield* Effect.fail(refused(t("server.issue.drafting", { name: issue.refining.name })));
      const pick = [lookIn.agent, { say: t("server.issue.pickHint", { command: commandOf("issue.status.update", [String(issue.number)]).join(" ") }) }];
      if (!issue.assignee) return yield* Effect.fail(refused(t("server.issue.noAssignee"), pick));
      const agent = store.agent(issue.assignee);
      if (!agent) return yield* Effect.fail(refused(t("server.issue.profileGone", { id: issue.assignee }), pick));
      return [issue, agent, issue.project ?? agent.workdir] as const;
    });

    const ready = (id: string) => Effect.flatMap(unsent(id), readyOf);

    const send = (issue: Issue, agent: Agent, project: string, channel: string, by?: RunTrigger) =>
      Effect.flatMap(hire(agent, issueBrief(issue), project, { channel, issue: issue.id, ...(by ? { trigger: by } : {}) }), (hired) =>
        hired.session ? Effect.succeed(hired.session.id) : Effect.fail(refused(hired.refused ?? t("server.issue.sendFailed"))),
      );

    /** Its run starts as it is handed over: the issue is in progress until the run ends on it (endRun). */
    const toOrchestrator = Effect.fn("Issues.toOrchestrator")(function* (issue: Issue, channel: string, by: RunTrigger, due?: Cron, said?: string) {
      if (isClosed(issue.status)) yield* db(q.reopenIssue({ id: issue.id }));
      const run: IssueRun = { startedAt: yield* Clock.currentTimeMillis };
      yield* db(q.setLastRun({ id: issue.id, last_run: JSON.stringify(run) }));
      yield* publish(issue.id);
      PubSub.publishUnsafe(orchestratorHub, { issue, channel, by, ...(due ? { cron: due } : {}), ...(said ? { said } : {}) });
    });

    /** said: the owner's words with it, when it is asked again. */
    const start = Effect.fn("Issues.start")(function* (id: string, channel: string, by?: RunTrigger, said?: string): Effect.fn.Return<Dispatched, ApiError> {
      const mine = yield* Effect.option(get(id));
      if (Option.isSome(mine) && isForOrchestrator(mine.value, store.isOrchestrator)) {
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
        return { queued: t("server.issue.queued", { full }) };
      }
      return { session: yield* send(issue, agent, project, where, trigger) };
    });

    /** In the board's order: one that cannot go any more leaves the queue. */
    const tryQueued = trying.withPermits(1)(
      Effect.gen(function* () {
        for (const issue of yield* everyIssue) {
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
            if (sent.success !== "") yield* core.notice("info", t("server.issue.queuedStarted", { title, session: sent.success }));
            continue;
          }
          const why = reasonOf(sent.failure);
          const left = yield* Effect.result(queueRow(issue.id, false, chat.defaultChannel()));
          if (left._tag === "Failure") {
            yield* core.notice("warn", t("server.issue.queuedStuck", { title, why }));
            continue;
          }
          yield* core.notice("warn", t("server.issue.queuedBack", { title, why }));
        }
      }),
    );

    /** to: another profile takes it on; else the one the last session worked as. */
    const reopen = Effect.fn("Issues.reopen")(function* (id: string, text: string, channel: string, by: RunTrigger = { kind: "comment" }, to?: Agent) {
      const issue = yield* get(id);
      if (issue.graph || issue.task || issue.delivered === "merged_into_parent") return yield* Effect.fail(refused(t("server.issue.graphRetry")));
      const newest = issue.sessions.at(-1);
      if (newest === undefined) {
        // Run before by no session (the orchestrator): its doer takes it up again, with the owner's words.
        if (!issue.lastRun) return yield* Effect.fail(refused(t("server.issue.neverStarted")));
        if (!isClosed(issue.status)) return yield* Effect.fail(refused(t("server.issue.stillOpen")));
        yield* start(id, channel, by, text);
        return "";
      }
      const last = yield* sessions.get(newest);
      if (!last) return yield* Effect.fail(missing(t("server.issue.issueRef", { ref: id }), [lookIn.issue]));
      if (!isClosed(issue.status)) return yield* Effect.fail(refused(t("server.issue.stillWorking", { name: last.name })));
      const agent = to ?? store.agent(last.agent);
      if (!agent) return yield* Effect.fail(refused(t("server.issue.senderGone", { id: last.agent })));
      const where = issue.project ?? "";
      const changes = yield* projects.branchChanges(where, issueBranch(issue.number)).pipe(Effect.mapError((e) => refused(e.message)));
      const previous = (changes?.commits.length ?? 0) > 0;
      const task = reopenTask(issue, last, text, previous, agent.id !== last.agent);
      const hired = yield* hire(agent, task, where, { channel, issue: issue.id, trigger: by });
      if (!hired.session) return yield* Effect.fail(refused(hired.refused ?? t("server.issue.sendFailed")));
      return hired.session.id;
    });

    /** A cron has one issue, for the session it names or for the orchestrator; each time it comes due is a run of that issue. */
    const scheduled = Effect.fn("Issues.scheduled")(function* (due: Due) {
      const s = due.cron;
      const channel = yield* chat.topOf(s.channel);
      const by: RunTrigger = { kind: "cron", cron: s.id, ...(due.missed ? { missed: true } : {}) };
      const found = yield* ofCron(s.id);
      let issue = found;
      if (!issue) {
        const project = s.project ?? (channel.project || undefined);
        const made = yield* Effect.result(
          add({ title: s.name, description: s.text, ...(project ? { project } : {}), assignee: s.agent ?? chat.orchestratorOf(channel.id) }, s.id),
        );
        if (made._tag === "Failure")
          return yield* chat.notice(channel.id, t("server.issue.cronNoIssue", { name: s.name, why: reasonOf(made.failure) }), "cron_refused");
        issue = made.success;
      }
      const text = dueText(s, due.missed);
      const item = issue;
      const result = yield* Effect.result(
        Effect.gen(function* () {
          if (isForOrchestrator(item, store.isOrchestrator)) return yield* toOrchestrator(item, channel.id, by, s);
          const newest = item.sessions.at(-1);
          // Its doer changed to a helper: open, but no session has worked it, so one starts.
          if (!found || item.status === "backlog" || item.status === "todo" || (!isClosed(item.status) && newest === undefined))
            return yield* Effect.asVoid(start(item.id, channel.id, by));
          if (isClosed(item.status) || newest === undefined) return yield* Effect.asVoid(reopen(item.id, text, channel.id, by));
          const d = yield* sessions.deliver(newest, text, by);
          if (d.kind === "refused") return yield* Effect.fail(refused(d.reason ?? ""));
        }),
      );
      if (result._tag === "Failure")
        yield* chat.notice(channel.id, t("server.issue.cronNoStart", { name: s.name, why: reasonOf(result.failure) }), "cron_refused");
    });

    const ofCron = Effect.fn("Issues.ofCron")(function* (id: string) {
      const row = yield* one(q.latestOfCron({ cron: id }));
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
      list: everyIssue,
      latest,
      liveSession,
      publish,
    });

    const comment = Effect.fn("Issues.comment")(function* (id: string, text: string, sendKey: string = "") {
      const issue = yield* get(id);
      if (isClosed(issue.status)) return yield* Effect.fail(refused(t("server.issue.closedReopen")));
      const session = yield* liveSession(id);
      const said = yield* chat.tellSession(ownerId, session, text, sendKey);
      // Said in its thread, the issue hears it from the message's fact (heard below); with no thread there is no fact.
      if (!said) yield* ownerSaid(id);
    });

    /** The commits on the issue's branch that the main branch does not have; none for one without a project or branch. */
    const commitsOf = (issue: Issue) =>
      issue.project
        ? Effect.map(
            projects.branchChanges(issue.project, issueBranch(issue.number)).pipe(Effect.mapError((e) => refused(e.message))),
            (c) => c?.commits.length ?? 0,
          )
        : Effect.succeed(0);

    /** The profile that takes an issue on as it moves to todo; undefined when it is the one it has. Refused before anything
     * moves, so a handover never leaves its session gone and no one sent. */
    const takerOf = Effect.fn("Issues.takerOf")(function* (issue: Issue, to: IssueStatus, key: string) {
      const a = store.named(key.trim());
      if (!a) return yield* Effect.fail(refused(t("server.issue.noProfileNamed", { key }), [lookIn.agent]));
      if (a.id === issue.assignee) return undefined;
      if (to !== "todo") return yield* Effect.fail(refused(t("server.issue.handOverOnTodo")));
      if (issue.status === "in_progress") return yield* Effect.fail(refused(t("server.issue.stopFirst", { n: issue.number })));
      if (!a.enabled) return yield* Effect.fail(refused(t("server.issue.disabled", { name: a.name })));
      for (const i of yield* runtimes.problemsOf(a))
        if (i.level === "error") return yield* Effect.fail(refused(t("server.issue.cannotSend", { name: a.name, why: i.text })));
      return a;
    });

    /** Its session, if one is on the farm, goes home; an issue no session works on has nobody to send. */
    const cancel = Effect.fn("Issues.cancel")(function* (id: string) {
      const item = yield* get(id);
      const last = item.sessions.at(-1);
      if (last === undefined || !sessions.find(last)) return;
      if (!(yield* sessions.dismiss(last))) return yield* Effect.fail(missing(t("server.issue.helperRef", { id: last }), [lookIn.session]));
    });

    /** The issue as a move would see it once the owner's unsaved fields are saved (issue.status saves them first);
     * refused as saving them would be: only how it is accepted and what it delivers change once it is sent. */
    const withEdit = Effect.fn("Issues.withEdit")(function* (issue: Issue, edit: IssueUpdate | undefined) {
      if (!edit) return issue;
      const reworded = Object.keys(edit).some((k) => k !== "deliver");
      if (reworded) yield* unsent(issue.id);
      return { ...issue, ...Object.fromEntries(Object.entries(edit).filter(([, v]) => v !== undefined)) };
    });

    /** The move and what it settles before anything changes; refused as the move itself would be. setStatus carries it out,
     * previewStatus says it in words: one judgment, so a dry run never promises what the move would refuse. */
    const settledMove = Effect.fn("Issues.settledMove")(function* (issue: Issue, to: IssueStatus, text: string, opt: StatusOptions) {
      if (!isOneOf(IssueStatusValues, to)) return yield* Effect.fail(refused(t("server.issue.noStatus", { to })));
      const taker = opt.assignee ? yield* takerOf(issue, to, opt.assignee) : undefined;
      const [move, why] = statusMove(issue, to);
      const said = text.trim();
      if (move === "none") return yield* Effect.fail(refused(why, nextSteps(issue)));
      // Stuck, it goes back with the server's own words for why; otherwise the owner says what this round is for.
      if (move === "round" && !taker && !said && issue.attention.state !== "stuck") return yield* Effect.fail(refused(t("server.issue.roundNeedsWords")));
      let delivery: "kept" | "none" | "merge" | undefined;
      let commits = 0;
      if (move === "complete") {
        commits = yield* commitsOf(issue);
        delivery = commits === 0 ? "none" : issue.deliver === "branch" ? "kept" : "merge";
      }
      return { issue, to, move, said, taker, delivery, commits };
    });

    const helperName = (issue: Issue) => {
      const last = issue.sessions.at(-1);
      return (last !== undefined ? sessions.sessionOf(last)?.name : undefined) ?? t("server.issue.helper");
    };

    const stuckWords = Effect.fn("Issues.stuckWords")(function* (issue: Issue) {
      const last = issue.sessions.at(-1);
      switch (issue.attention.stuck) {
        case "conflict": {
          const conflict = sessions.sessionOf(yield* liveSession(issue.id))?.conflict;
          if (!conflict) return yield* Effect.fail(refused(t("server.issue.noConflict", { name: helperName(issue) })));
          return conflictBrief(conflict.base, conflict.files);
        }
        case "failed": {
          const lastRun = last !== undefined ? sessions.sessionOf(last)?.lastRun : undefined;
          const unread = issue.deliver === "answer" && lastRun?.outcome === "completed" && !lastRun.answer;
          return unread
            ? answerCureWords(parseAnswer(sessions.find(last ?? "")?.lastText ?? "").problem)
            : cureWords((last !== undefined ? sessions.sessionOf(last)?.brief : undefined) ?? issue.title);
        }
        case "interrupted":
          return resumeWords();
        // Quiet, or not stuck: the server has no words of its own for the round.
        case "quiet":
        default:
          return yield* Effect.fail(refused(t("server.issue.roundNeedsWords")));
      }
    });

    /** A settled move in words, one step a line; what it reads to say so (who would go, the room, a merge's conflicts) is read, not changed. */
    const movesWords = Effect.fn("Issues.movesWords")(function* (p: Effect.Success<ReturnType<typeof settledMove>>) {
      const item = p.issue;
      const n = `#${item.number}`;
      switch (p.move) {
        case "start": {
          if (isForOrchestrator(item, store.isOrchestrator)) return [t("server.issue.does.toOrchestrator", { n })];
          const [, agent, project] = yield* readyOf(p.taker ? { ...item, assignee: p.taker.id } : item);
          const full = sessions.noRoom(agent.runtime, project);
          return full
            ? [t("server.issue.does.sendTo", { n, agent: agent.name }), t("server.issue.does.noRoom", { full })]
            : [project ? t("server.issue.does.startIn", { n, agent: agent.name, project }) : t("server.issue.does.start", { n, agent: agent.name })];
        }
        case "unqueue":
          return [t("server.issue.does.unqueue", { n })];
        case "round": {
          if (p.taker) return [t("server.issue.does.leaves", { helper: helperName(item) }), t("server.issue.does.takesOver", { taker: p.taker.name })];
          const helper = helperName(item);
          if (item.sessions.length === 0) return [t("server.issue.does.orchestratorRound", { n, said: p.said })];
          if (!p.said) {
            yield* stuckWords(item);
            return [
              item.attention.stuck === "conflict"
                ? t("server.issue.does.resolve", { helper })
                : item.attention.stuck === "interrupted"
                  ? t("server.issue.does.resume", { helper, words: resumeWords() })
                  : t("server.issue.does.cure", { helper }),
            ];
          }
          if (item.attention.state === "reviewing") return [t("server.issue.does.reject", { n: item.number, findings: findingsOf(p.said).length, helper })];
          return [t("server.issue.does.round", { helper, said: p.said })];
        }
        case "reopen":
          return [
            p.taker ? t("server.issue.does.reopenBy", { n, taker: p.taker.name }) : t("server.issue.does.reopen", { n }),
            ...(p.said ? [t("server.issue.does.thisTime", { said: p.said })] : []),
          ];
        case "revive":
          return [t("server.issue.does.revive", { n })];
        case "complete": {
          if (p.delivery === "none") return [t("server.issue.does.completeNone", { n }), t("server.issue.does.helperLeaves", { helper: helperName(item) })];
          if (p.delivery === "kept")
            return [t("server.issue.does.completeKept", { n, commits: p.commits }), t("server.issue.does.helperLeaves", { helper: helperName(item) })];
          const changes = yield* sessions.changes(yield* liveSession(item.id));
          const pr = item.project !== undefined && (item.pullRequest?.state === "open" || projects.usesPullRequests(item.project));
          const out: string[] = [];
          if (changes && changes.uncommitted.length > 0)
            out.push(t("server.issue.does.commitFirst", { helper: helperName(item), files: changes.uncommitted.length }));
          if (changes && changes.conflicts.length > 0)
            return [...out, t("server.issue.does.conflicts", { base: changes.base, files: list(changes.conflicts) })];
          out.push(t("server.issue.does.check"));
          out.push(
            pr
              ? t("server.issue.does.pullRequest", { commits: p.commits })
              : t("server.issue.does.merge", { base: changes?.base ?? t("server.issue.does.mainBranch"), commits: p.commits, helper: helperName(item) }),
          );
          return out;
        }
        case "cancel":
          return [t("server.issue.does.cancel", { n }), t("server.issue.does.cancelLeaves", { helper: helperName(item) })];
        case "drop":
          return [t("server.issue.does.drop", { n }), ...(item.refining ? [t("server.issue.does.drafterLeaves", { name: item.refining.name })] : [])];
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
          const checks = e.checks;
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
      const worked = (yield* everyIssue).filter((i) => i.project !== undefined && !i.talk).toSorted((a, b) => b.createdAt - a.createdAt)[0]?.project;
      return worked ?? (yield* projects.list())[0]?.name ?? "";
    });

    /** The owner said something to a profile no session talks for now: one is sent, with the talk so far. */
    const talkOn = Effect.fn("Issues.talkOn")(function* (item: Issue) {
      const agent = store.agent(item.assignee ?? "");
      if (!agent || !item.talk) return;
      const said = inboxLines(yield* chat.recent(item.talk, talkContext));
      const hired = yield* hire(agent, talkJob(agent.name, said), item.project ?? (agent.workdir || (yield* lastProject)), {
        channel: item.talk,
        issue: item.id,
        trigger: { kind: "comment" },
      });
      if (!hired.session) yield* chat.notice(item.talk, hired.refused ?? t("server.issue.sendFailed"), "talk_refused");
    });

    const onOwnerInThread = Effect.fn("Issues.onOwnerInThread")(function* (thread: string) {
      const issue = yield* Effect.option(get(thread));
      if (Option.isNone(issue)) return;
      const item = issue.value;
      if (item.talk) {
        const last = item.sessions.at(-1);
        if (last === undefined || !sessions.find(last)) yield* talkOn(item);
        return;
      }
      if (isClosed(item.status)) return;
      yield* ownerSaid(item.id);
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
    for (const o of store.orchestrators())
      for (const r of yield* db(q.openOf({ assignee: o.id }))) {
        const run = column.run(r.last_run);
        if (run && run.endedAt === undefined) yield* cancelAs(r.id, "lost");
      }

    const news = yield* sessions.news;
    const ownerWords = yield* chat.ownerInThread;
    const finished = yield* sessions.finishedRuns;
    const due = yield* crons.due;
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
    yield* Effect.forkScoped(Stream.runForEach(due, (d) => scheduled(d).pipe(logged(`cron ${d.cron.id}`))));
    if (options.background ?? true) {
      // Each waits a period before its first run, then runs every period.
      const tryEvery = options.tryEveryMs ?? 5000;
      yield* Effect.forkScoped(tryQueued.pipe(logged("the queue"), Effect.repeat(Schedule.spaced(tryEvery)), Effect.delay(tryEvery)));
      const pollEvery = config.github.prPollSeconds > 0 ? config.github.prPollSeconds * 1000 : 180_000;
      yield* Effect.forkScoped(refreshPullRequests.pipe(logged("refresh pull requests"), Effect.repeat(Schedule.spaced(pollEvery)), Effect.delay(pollEvery)));
    }

    /** On the board before another unsent issue, or last; only unsent issues have a place. */
    const place = Effect.fn("Issues.place")(function* (id: string, before: string) {
      const order: string[] = (yield* everyIssue)
        .filter((item) => item.sessions.length === 0 && !item.graph && !item.task && item.id !== id)
        .map((item) => item.id);
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

    const shape = Issues.of({
      onBoard: () => core.state().issues,
      list: () => Effect.map(everyIssue, (all) => all.filter((item) => !item.talk)),
      query: (f) =>
        Effect.gen(function* () {
          const all = (yield* everyIssue).filter((item) => !item.talk);
          return pickIssues(all, f, yield* Clock.currentTimeMillis);
        }),
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
          if (isClosed(was.status)) return yield* Effect.fail(refused(t("server.issue.closed")));
        } else was = yield* unsent(id);
        const [title, description] = yield* issueWords({ title: upd.title ?? was.title, description: upd.description ?? was.description });
        if (upd.project !== undefined && upd.project !== was.project && was.project) {
          const released = yield* sessions.clearWorkplace(was.id, was.project, was.number, "preserve");
          if (released.kept) return yield* Effect.fail(refused(t("server.issue.cannotMoveProject", { n: was.number, why: released.reason })));
        }
        const criteria = upd.criteria !== undefined ? kept(upd.criteria) : was.criteria;
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
        const item = yield* unsent(id);
        const cleared = yield* clearRefinement(item);
        if (cleared.kept) return yield* Effect.fail(refused(t("server.issue.cannotDelete", { n: item.number, why: cleared.reason })));
        yield* db(q.removeIssue({ id }));
        yield* reloadSessions;
        yield* core.apply({ type: "issueGone", id: issueId(id) });
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
        const item = yield* get(ref);
        // Read by its number too: every write below goes by its id.
        const id = item.id;
        const { move, said, taker, delivery } = yield* settledMove(item, to, text, opt);
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
            // waits for acceptance the words are the findings, written down and given as the next round's brief.
            if (item.sessions.length === 0) yield* start(id, channel, { kind: "comment" }, said);
            else if (said && item.attention.state === "reviewing") yield* shape.review(id, { pass: false, findings: findingsOf(said) });
            else yield* comment(id, said || (yield* stuckWords(item)));
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
            if (item.findings.some((f) => !f.resolved))
              yield* judged(
                id,
                item.reviewedAt ?? 0,
                item.findings.map((f) => ({ ...f, resolved: true })),
              );
            if (delivery === "kept" || delivery === "none") {
              // Written down before its session goes home, so that leaving does not take it for canceled.
              yield* complete(id, delivery);
              const last = item.sessions.at(-1);
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
            yield* clearRefinement(item);
            yield* drop(id);
            break;
        }
        return yield* get(id);
      }),
      previewStatus: Effect.fn("Issues.previewStatus")(function* (id, to, text, opt = {}, edit) {
        const item = yield* withEdit(yield* get(id), edit);
        return { does: yield* movesWords(yield* settledMove(item, to, text, opt)) };
      }),
      previewRemove: Effect.fn("Issues.previewRemove")(function* (id) {
        const item = yield* unsent(id);
        return {
          does: [
            t("server.issue.does.deleteIssue", { n: item.number, title: shortTitle(item.title) }),
            ...(item.refining ? [t("server.issue.does.drafterLeaves", { name: item.refining.name })] : []),
            ...(item.project ? [t("server.issue.does.cleanWorktree")] : []),
          ],
        };
      }),
      comment,
      changes: Effect.fn("Issues.changes")(function* (id, by) {
        const session = yield* liveSession(id);
        const changes = yield* sessions.changes(session);
        if (!changes) return yield* Effect.fail(missing(t("server.issue.helperRef", { id: session }), [lookIn.session]));
        if (by.kind === "owner") yield* core.did({ kind: "reviewed", session });
        return changes;
      }),
      merge,
      cancel,
      review: Effect.fn("Issues.review")(function* (id, req) {
        const item = yield* get(id);
        const why = isForOrchestrator(item, store.isOrchestrator)
          ? t("server.issue.orchestratorAnswers")
          : item.graph || item.task
            ? t("server.issue.graphAcceptance")
            : item.status !== "in_review"
              ? t("server.issue.nothingToAccept")
              : "";
        if (why) return yield* Effect.fail(refused(why, nextSteps(item)));
        if (req.pass) {
          yield* judged(
            id,
            yield* Clock.currentTimeMillis,
            item.findings.map((f) => ({ ...f, resolved: true })),
          );
          return yield* get(id);
        }
        const fresh = kept(req.findings);
        const text = (req.text ?? "").trim();
        if (fresh.length === 0 && !text) return yield* Effect.fail(refused(t("server.issue.failNeedsFindings")));
        const at = yield* Clock.currentTimeMillis;
        const findings = [...item.findings, ...fresh.map((text) => ({ id: newId(), text, at, resolved: false }))];
        yield* judged(id, 0, findings);
        // The findings go to whoever works it as the next round's words, like any comment.
        yield* comment(id, failedText(findings, text));
        return yield* get(id);
      }),
      refine: draft,
      talkWith: Effect.fn("Issues.talkWith")(function* (ref) {
        const agent = store.named(ref.trim()) ?? store.agent(ref) ?? store.orchestrators().find((o) => o.name === ref.trim());
        if (!agent) return yield* Effect.fail(missing(t("server.issue.noProfileNamed", { key: ref }), [lookIn.agent]));
        // An orchestrator answers in its own direct channel; a helper profile's is its talk issue's thread.
        if (store.isOrchestrator(agent.id)) return yield* chat.openDirect({ id: agent.id, name: agent.name });
        const channel = yield* chat.openDirect({ id: agent.id, name: agent.name });
        if (!(yield* one(q.talkOf({ talk: channel })))) {
          const made = yield* add({ title: t("server.issue.talkTitle", { name: agent.name }), assignee: agent.id, deliver: "answer" }, undefined, channel);
          yield* chat.linkTalk(channel, made.id);
        }
        return channel;
      }),
      /** A session with no record is named as missing, not given a phase. */
      history: Effect.fn("Issues.history")(function* () {
        const all = (yield* everyIssue).filter((item) => !item.talk);
        const byId = new Map((yield* sessions.list("")).map((s) => [s.id, s]));
        return all.map((issue) => ({
          issue,
          sessions: issue.sessions.flatMap((id) => {
            const s = byId.get(id);
            return s ? [s] : [];
          }),
          missingSessions: issue.sessions.filter((id) => !byId.has(id)),
        }));
      }),
      templates: Effect.fn("Issues.templates")(function* (name) {
        const stack = yield* projects.stack(name);
        if (!stack) return yield* Effect.fail(missing(t("server.issue.projectRef", { name }), [lookIn.project]));
        return { project: name, stack, recent: sentTitles(yield* everyIssue, name, store.isOrchestrator), kinds: filledKinds(templateCatalog(), stack) };
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
            for (const issue of issues)
              yield* db(
                q.putIssue({
                  id: issue.id,
                  title: issue.title,
                  description: issue.description,
                  project: nullText(issue.project),
                  assignee: nullText(issue.assignee),
                  priority: issue.priority,
                  rank: issue.rank ?? 0,
                  created_at: issue.createdAt,
                  closed_at: issue.closedAt ?? null,
                  delivered: issue.delivered ?? null,
                  canceled: issue.canceled ?? null,
                  parent: nullText(issue.parent),
                  blocked_by: jsonOrNull(issue.blockedBy, issue.blockedBy.length > 0),
                  graph: jsonOrNull(issue.graph, !!issue.graph),
                  task: jsonOrNull(issue.task, !!issue.task),
                }),
              );
            const out: string[] = [];
            for (const old of before)
              if (!issues.some((issue) => issue.id === old.id)) {
                yield* db(q.removeIssue({ id: old.id }));
                out.push(old.id);
              }
            return out;
          }),
        );
        if (gone.length > 0) yield* reloadSessions;
        // Published in one core.apply, once the transaction has succeeded.
        const updated = yield* Effect.forEach([...issues.slice(1), issues[0]!], (item) => get(item.id).pipe(Effect.orDie));
        yield* core.apply(
          ...gone.map((id) => ({ type: "issueGone" as const, id: issueId(id) })),
          ...updated.map((issue) => ({ type: "issue" as const, issue })),
        );
      }),
      nextTaskId: () => Effect.map(db(q.graphIDs()), (rows) => nextTaskId(rows.map((r) => r.id))),
      forOrchestrator: Effect.map(PubSub.subscribe(orchestratorHub), Stream.fromSubscription),
      ofCron,
      refreshPullRequests,
      tryQueued,
    });
    return shape;
  });
