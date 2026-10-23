// Issues: what the owner wants done, each worked by sessions one after another. An issue closes
// when its last session leaves, as the fact that the session left says how, and opens again with another session; a
// task's issues open and close as the task says. An issue may be refined first: a session reads the code and writes it in
// the issue's format, then leaves, the issue still unsent. One for the orchestrator is handed to the orchestrator, not to a session,
// and waits on the owner once the orchestrator's turn ends, however it ended: only the owner closes it. A branch that would conflict is not merged: the session stays
// with its branch and worktree, and the state says which files.

import {
  type Agent,
  type Question,
  type Changes,
  type CriterionCheck,
  type Dispatched,
  type Finding,
  type IssueRun,
  type IssueAnswer,
  type Deliverable,
  type Outcome,
  type Issue,
  type IssueReviewRequest,
  type IssueActRequest,
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
  type Priority,
  type ProjectTemplates,
  type RunTrigger,
  type Recurrence,
  type Session,
  type TaskGraph,
} from "@vibevalley/protocol";
import { actLabel, attentionLabel, closedText, outcomeLabel, shortTitle } from "@vibevalley/protocol/rules";
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
import { Context, Effect, Layer, Option, PubSub, Schedule, Schema, type Scope, Semaphore, Stream } from "effect";
import { jsonOf, jsonOrNone } from "../base/json.ts";
import * as S from "@vibevalley/protocol/schema";
import { SqlClient } from "effect/sql";
import { Agents } from "../agent/agent.ts";
import { Settings } from "../base/config.ts";
import { causeMessage } from "../base/db.ts";
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
import { conflictBrief, conflictOf, parseAnswer } from "../session/rules.ts";

/** An issue for the orchestrator, handed to it. */
export interface OrchestratorWork {
  readonly issue: Issue;
  readonly channel: string;
  readonly by: RunTrigger;
  /** The recurrence that came due, when one did. */
  readonly recurrence?: Recurrence;
  /** What the owner said with it, asking again (another round, a reopen). */
  readonly said?: string;
}

/** Who looked at changes: the owner's look counts for the game, the orchestrator's does not. */
export type Caller = "owner" | "orchestrator";

export interface IssueShape {
  readonly list: () => Effect.Effect<Issue[]>;
  /** The issues the board holds now (open, and the latest closed). */
  readonly onBoard: () => readonly Issue[];
  readonly get: (id: string) => Effect.Effect<Issue, ApiError>;
  readonly add: (req: IssueRequest) => Effect.Effect<Issue, ApiError>;
  readonly edit: (id: string, upd: IssueUpdate) => Effect.Effect<Issue, ApiError>;
  readonly remove: (id: string) => Effect.Effect<void, ApiError>;
  readonly move: (id: string, before: string) => Effect.Effect<Issue[], ApiError>;
  readonly queue: (id: string, queued: boolean) => Effect.Effect<Issue, ApiError>;
  readonly start: (id: string, channel: string) => Effect.Effect<Dispatched, ApiError>;
  readonly dispatchQueued: (id: string) => Effect.Effect<Dispatched, ApiError>;
  readonly reopen: (id: string, text: string, channel: string) => Effect.Effect<string, ApiError>;
  /** agent: moving to todo, the profile (id or name) that takes it on; another than its own hands it over. keepBranch: moving
   * to done, completed with its branch kept, not merged. */
  readonly setStatus: (id: string, to: IssueStatus, text: string, channel: string, opt?: StatusOptions) => Effect.Effect<Issue, ApiError>;
  /** One of what the issue's attention offers the owner (Issue.attention.acts), done as its page's button does it: the
   * page, the command line and the orchestrator's tools all go by it. Any act the attention does not offer is refused. */
  readonly act: (id: string, req: IssueActRequest, channel: string) => Effect.Effect<Issue, ApiError>;
  /** What setStatus would do with the same request, refused as it would be; nothing changes. edit: the owner's unsaved
   * fields, as the move would see them once saved. */
  readonly previewStatus: (id: string, to: IssueStatus, text: string, opt?: StatusOptions, edit?: IssueUpdate) => Effect.Effect<Preview, ApiError>;
  /** What act would do with the same request, refused as it would be; nothing changes. */
  readonly previewAct: (id: string, req: IssueActRequest) => Effect.Effect<Preview, ApiError>;
  /** What remove would do, refused as it would be; nothing changes. */
  readonly previewRemove: (id: string) => Effect.Effect<Preview, ApiError>;
  /** An issue's id from what the owner and the orchestrator call it: #41 or 41, its id, or the id of a session that worked it. */
  readonly idOf: (ref: string) => Effect.Effect<string, ApiError>;
  readonly comment: (id: string, text: string, sendKey?: string) => Effect.Effect<void, ApiError>;
  readonly changes: (id: string, by: Caller) => Effect.Effect<Changes, ApiError>;
  readonly merge: (id: string) => Effect.Effect<string, ApiError>;
  readonly resolve: (id: string) => Effect.Effect<void, ApiError>;
  readonly cancel: (id: string) => Effect.Effect<void, ApiError>;
  readonly review: (id: string, req: IssueReviewRequest) => Effect.Effect<Issue, ApiError>;
  readonly refine: (id: string, word: string, channel: string) => Effect.Effect<Issue, ApiError>;
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
  readonly keepBranch?: boolean;
}

export class Issues extends Context.Service<Issues, IssueShape>()("vibevalley/Issue") {}

type Row = q.GetIssueResult;

// The issue's JSON columns, read by their Schemas; one that does not read is none, as it was when it would not parse.
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

/** Empty is none. */

/** What a session's leaving says of its issue, when the issue is still open then: its work merged is done, the rest is
 * canceled. A completion the owner chose (kept, none) is written before its session leaves, and a task graph's step
 * closes with its graph, so neither is this. */
const closingOf = (closed: SessionClose | undefined): { delivered: Delivery } | { canceled: IssueCanceled } =>
  closed === "merged" ? { delivered: "merged" } : closed === "completed" ? { delivered: "none" } : { canceled: closed === "lost" ? "lost" : "dismissed" };

/** An issue not found: the list says which there are. */

const reopenDefault = "接着把这张工单做完";

/** handedOver: another profile takes it on from last. */
export function reopenTask(issue: Issue, last: Session, text: string, previous: boolean, handedOver = false): string {
  const how = handedOver ? `这张工单换你接手了，之前是 ${last.name}（${last.id}）在做` : `这张工单重开了，上一次是 ${last.name}（${last.id}）做的`;
  let out = (text.trim() || reopenDefault) + `\n\n（${how}。）`;
  out += "\n这张工单原来是：" + cut(issueJob(issue), askedMax);
  if (issue.answer) out += "\n上一次的结论：" + cut(issue.answer.conclusion, askedMax);
  if (issue.closedAt !== undefined) out += "\n它是怎么关的：" + closedText(issue);
  if (last.lastRun) out += `\n最后一轮${outcomeLabel[last.lastRun.outcome]}：${cut(last.lastRun.summary.trim(), askedMax)}`;
  if (previous) out += "\n这条分支上已经有上次的提交，接着做。";
  return out + "\n先看看项目现在的样子，再接着做。";
}

/** The findings still attention, numbered, then the owner's own words. */
function failedText(findings: readonly Finding[], text: string): string {
  let out = "验收没过，这几处要修：";
  let n = 0;
  for (const f of findings) if (!f.resolved) out += `\n${++n}. ${f.text}`;
  if (text) out += "\n\n" + text;
  return out + "\n\n修好以后在结论里逐条说怎么修的。";
}

/** Tests make it shorter. */
export interface IssueOptions {
  readonly tryEveryMs?: number;
  readonly background?: boolean;
}

export const make = Effect.fnUntraced(function* (options: IssueOptions = {}) {
  const config = yield* Settings;
  const core = yield* Core;
  const store = yield* Agents;
  const projects = yield* Projects;
  const runtimes = yield* Runtimes;
  const sessions = yield* Sessions;
  const chat = yield* Channels;
  const recurrences = yield* Recurrences;
  const sql = yield* SqlClient.SqlClient;
  const db = <A, E>(e: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.provideService(e, SqlClient.SqlClient, sql).pipe(Effect.orDie);
  const one = <A, E>(e: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.map(db(Effect.option(e)), Option.getOrUndefined);
  const inTx = <A, E>(e: Effect.Effect<A, E>) =>
    sql.withTransaction(e).pipe(Effect.catchTag("SqlError", Effect.die)) as Effect.Effect<A, Exclude<E, { _tag: "SqlError" }>>;
  const orchestratorHub = yield* PubSub.unbounded<OrchestratorWork>();
  /** One round of the queue at a time. */
  const trying = yield* Semaphore.make(1);

  // ── reading ──

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
      id: row.id,
      number: row.number,
      title: row.title,
      ...(row.description ? { description: row.description } : {}),
      ...(row.project !== null ? { project: row.project } : {}),
      ...(row.assignee !== null ? { assignee: row.assignee } : {}),
      priority: row.priority as Priority,
      createdAt: row.created_at,
      ...(row.queued_at !== null ? { queuedAt: row.queued_at } : {}),
      sessions: [...(runs ?? [])],
      ...(row.closed_at !== null ? { closedAt: row.closed_at } : {}),
      ...(row.delivered !== null ? { delivered: row.delivered as Delivery } : {}),
      ...(row.canceled !== null ? { canceled: row.canceled as IssueCanceled } : {}),
      ...(row.parent !== null ? { parent: row.parent } : {}),
      ...(blockedBy ? { blockedBy } : {}),
      ...(graph ? { graph } : {}),
      ...(task ? { task } : {}),
      ...(row.recurrence !== null ? { recurrence: row.recurrence } : {}),
      status: "backlog",
      moves: [],
      ...(pullRequest ? { pullRequest } : {}),
      review: row.review as Issue["review"],
      deliver: row.deliver as Deliverable,
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

  const runsBy = (rows: readonly { issue: string; session: string }[]) => {
    const out = new Map<string, string[]>();
    for (const r of rows) out.set(r.issue, [...(out.get(r.issue) ?? []), r.session]);
    return out;
  };

  const list = Effect.gen(function* () {
    const rows = yield* db(q.listIssues());
    const runs = runsBy(yield* db(qs.allSessions()));
    return rows.map((r) => issueOf(r, runs.get(r.id))).sort(issueOrder);
  });

  const idOf = Effect.fnUntraced(function* (ref: string): Effect.fn.Return<string, ApiError> {
    const r = ref.trim();
    const number = /^#?(\d+)$/.exec(r)?.[1];
    if (number !== undefined) {
      const row = yield* one(q.issueByNumber({ number: Number(number) }));
      if (!row) return yield* Effect.fail(missing("工单 #" + number, [lookIn.issue]));
      return row.id;
    }
    return (yield* one(qs.issueOfSession({ session: r })))?.issue ?? r;
  });

  /** By any of what idOf reads. */
  const get = Effect.fnUntraced(function* (ref: string): Effect.fn.Return<Issue, ApiError> {
    const issue = yield* idOf(ref);
    const row = yield* one(q.getIssue({ id: issue }));
    if (!row) return yield* Effect.fail(missing("工单 " + ref, [lookIn.issue]));
    return issueOf(
      row,
      (yield* db(qs.sessionsOf({ issue }))).map((r) => r.session),
    );
  });

  const publish = (id: string) =>
    get(id).pipe(
      Effect.flatMap((issue) => core.apply({ type: "issue", issue })),
      Effect.catch((e) => Effect.logWarning(`vibevalley: issue ${id} changed but could not be read back for the board: ${reasonOf(e)}`)),
    );

  /** The newest session, the one a merge, changes, comments and cancel act on; a reopen makes another. */
  const latest = (id: string) =>
    Effect.flatMap(get(id), (issue) => (issue.sessions.length === 0 ? Effect.fail(refused("这张工单还没开工")) : Effect.succeed(issue.sessions.at(-1)!)));

  const unsent = (id: string) =>
    Effect.flatMap(get(id), (issue) =>
      issue.graph || issue.task
        ? Effect.fail(refused("这是计划里的工单：在计划里改"))
        : issue.sessions.length > 0
          ? Effect.fail(refused("这张工单已经开工了"))
          : Effect.succeed(issue),
    );

  const liveSession = (id: string) =>
    Effect.flatMap(latest(id), (session) => (sessions.find(session) ? Effect.succeed(session) : Effect.fail(missing("帮工 " + session, [lookIn.session]))));

  // ── writing ──

  const issueWords = (req: Pick<IssueRequest, "title" | "description">) => {
    const [title, rest] = splitJob(req.title);
    if (!title) return Effect.fail(refused("工单没有标题"));
    let description = (req.description ?? "").trim();
    if (rest) description = (rest + "\n\n" + description).trim();
    return Effect.succeed([title, description] as const);
  };

  const add = Effect.fnUntraced(function* (req: IssueRequest, recurrence?: string) {
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
        created_at: Date.now(),
        recurrence: recurrence ?? null,
        review: req.review || "glance",
        // The orchestrator never changes code: what it is given is answered.
        deliver: req.deliver ?? (req.assignee === orchestratorAgent ? "answer" : "change"),
      }),
    );
    yield* publish(id);
    return yield* get(id);
  });

  /** Done, with what it delivered. */
  const complete = (id: string, delivered: Delivery) => Effect.andThen(db(q.completeIssue({ closed_at: Date.now(), delivered, id })), publish(id));
  /** Not done, and why. */
  const cancelAs = (id: string, canceled: IssueCanceled) => Effect.andThen(db(q.cancelIssue({ closed_at: Date.now(), canceled, id })), publish(id));

  /** A run no session carries (an in-process agent's, the orchestrator's) ended on the issue: the issue keeps how. */
  const endRun = Effect.fnUntraced(function* (id: string, outcome: Outcome) {
    const t = yield* get(id);
    // A run cut off by a restart closed its issue as lost; the run it goes on in ends on it all the same.
    if (isClosed(t.status)) {
      if (t.canceled !== "lost") return;
      yield* db(q.reopenIssue({ id }));
    }
    const now = Date.now();
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

  /** An answer issue's round reported: a round that got through gives its conclusion (none when none can be read, and
   * the issue is stuck on it); whatever the round changed goes, so the issue never delivers a change. */
  const answered = Effect.fnUntraced(function* (id: string, session: string, outcome: Outcome, answer: IssueAnswer | undefined) {
    const t = yield* get(id);
    if (t.deliver !== "answer" || t.sessions.at(-1) !== session) return;
    if (outcome === "completed") yield* db(q.setIssueAnswer({ id, answer: jsonOrNull(answer, answer !== undefined) }));
    yield* sessions.discardWork(session);
    yield* publish(id);
  });

  /** at 0 is not accepted (a fail, or another round started); the findings are written as they stand. */
  const judged = (id: string, at: number, findings: readonly Finding[]) =>
    Effect.andThen(db(q.reviewIssue({ id, reviewed_at: at > 0 ? at : null, findings: jsonOrNull(findings, findings.length > 0) })), publish(id));

  /** The owner's word answers what it asked, and starts a round that the last acceptance did not see. */
  const ownerSaid = Effect.fnUntraced(function* (id: string) {
    yield* asked(id, []);
    const t = yield* get(id);
    if (t.reviewedAt !== undefined) yield* judged(id, 0, t.findings);
  });

  /** The issue already owns its number and workplace before its session starts. */
  const ran = Effect.fnUntraced(function* (id: string, session: Session) {
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
    yield* publish(id);
  });

  /** Queueing keeps the first dispatch context until the issue starts or leaves the queue. */
  const queueRow = Effect.fnUntraced(function* (id: string, queued: boolean, channel: string, by?: RunTrigger) {
    yield* unsent(id);
    yield* inTx(
      queued
        ? Effect.andThen(
            db(qq.enqueueIssue({ issue: id, channel, triggered_by: JSON.stringify(by ?? { kind: "issue" }) })),
            db(q.queueIssue({ at: Date.now(), id })),
          )
        : Effect.andThen(db(qq.dequeueIssue({ issue: id })), db(q.unqueueIssue({ id }))),
    );
    yield* publish(id);
    return yield* get(id);
  });

  const queuedDispatch = (id: string) =>
    Effect.flatMap(one(qq.queuedIssue({ issue: id })), (row) =>
      row ? Effect.succeed([row.channel, triggerOf(row.triggered_by)] as const) : Effect.fail(refused(`工单 ${id} 不在队里`)),
    );

  /** Canceled before it was ever sent: out of the queue and closed as dismissed, in one write. */
  const drop = Effect.fnUntraced(function* (id: string) {
    yield* unsent(id);
    yield* inTx(
      Effect.all([db(qq.dequeueIssue({ issue: id })), db(q.unqueueIssue({ id })), db(q.cancelIssue({ closed_at: Date.now(), canceled: "dismissed", id }))], {
        discard: true,
      }),
    );
    yield* publish(id);
  });

  // ── sending ──

  const hire = Effect.fnUntraced(function* (agent: Agent, task: string, project: string, opt: HireOptions = {}) {
    if (agent.id === orchestratorAgent) return { refused: "管家不当帮工：派给一个帮工档案" } as Hired;
    if (!agent.enabled) return { refused: agent.name + " 被停用了" } as Hired;
    for (const i of yield* runtimes.check(agent)) if (i.level === "error") return { refused: `${agent.name} 派不出去：${i.text}` } as Hired;
    const where = project.trim() || (agent.workdir ?? "").trim();
    if (!where) return { refused: "没说在哪个项目里做：项目是工作目录下的一个文件夹" } as Hired;
    const room = yield* sessions.makeRoom(agent.runtime, where);
    if ("refused" in room) return { refused: room.refused } as Hired;
    const evicted = room.evicted ?? "";
    const prepared = yield* Effect.result(
      (opt.issue ? get(opt.issue) : add({ title: task, project: where, assignee: agent.id })).pipe(
        Effect.catchDefect((d) => Effect.fail(refused(causeMessage(d)))),
      ),
    );
    if (prepared._tag === "Failure") return { refused: `${agent.name} 的工单没记下来：${reasonOf(prepared.failure)}` } as Hired;
    const issue = prepared.success;
    // A draft's session is not one of the issue's sessions: the issue stays unsent.
    const hired = yield* sessions.send(agent, task, where, { ...opt, issue, ...(!opt.refining ? { hiring: (w: Session) => ran(issue.id, w) } : {}) });
    if (!hired.session && !opt.issue && !hired.retainedWork) {
      yield* db(q.removeIssue({ id: issue.id }));
      yield* core.apply({ type: "issueGone", id: issue.id });
    }
    if (hired.retainedWork) return { ...hired, refused: `${hired.refused}；工单 #${issue.number} 和它的改动留着，可以接着派这张工单` };
    return hired.session && evicted ? { ...hired, evicted } : hired;
  });

  /** Who an unsent issue goes to and where, or why it cannot go: starting it and its dry run ask the same. */
  const readyOf = Effect.fnUntraced(function* (issue: Issue) {
    if (issue.refining) return yield* Effect.fail(refused(issue.refining.name + " 正在起草：等它交回来再开工"));
    const pick = [lookIn.agent, { say: `挑好以后挪到待办时带上它：issue status ${issue.number}，--json 带 status「todo」和 agent（档案的 id）` }];
    if (!issue.assignee) return yield* Effect.fail(refused("还没选派哪个帮工档案", pick));
    const agent = store.agent(issue.assignee);
    if (!agent) return yield* Effect.fail(refused("帮工档案 " + issue.assignee + " 不在了", pick));
    return [issue, agent, issue.project ?? agent.workdir ?? ""] as const;
  });

  const ready = (id: string) => Effect.flatMap(unsent(id), readyOf);

  const send = (issue: Issue, agent: Agent, project: string, channel: string, by?: RunTrigger) =>
    Effect.flatMap(hire(agent, issueJob(issue), project, { channel, issue: issue.id, ...(by ? { trigger: by } : {}) }), (hired) =>
      hired.session ? Effect.succeed(hired.session.id) : Effect.fail(refused(hired.refused ?? "派不出去")),
    );

  /** Its run starts as it is handed over: the issue is in progress until the run ends on it (endRun). */
  const toOrchestrator = Effect.fnUntraced(function* (issue: Issue, channel: string, by: RunTrigger, due?: Recurrence, said?: string) {
    if (isClosed(issue.status)) yield* db(q.reopenIssue({ id: issue.id }));
    const run: IssueRun = { startedAt: Date.now() };
    yield* db(q.setLastRun({ id: issue.id, last_run: JSON.stringify(run) }));
    yield* publish(issue.id);
    PubSub.publishUnsafe(orchestratorHub, { issue, channel, by, ...(due ? { recurrence: due } : {}), ...(said ? { said } : {}) });
  });

  /** by undefined: the issue sent out. said: the owner's words with it, when it is asked again. */
  const start = Effect.fnUntraced(function* (id: string, channel: string, by?: RunTrigger, said?: string): Effect.fn.Return<Dispatched, ApiError> {
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
      yield* queueRow(issue.id, true, (yield* chat.channelOf(where)).id, trigger);
      return { queued: full + "：排上队了，有空位就自动开工" };
    }
    return { session: yield* send(issue, agent, project, where, trigger) };
  });

  /** In the board's order; one that cannot go any more leaves the queue, said in a notice. */
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
          if (sent.success) yield* core.notice("info", `排队的「${title}」开工了：${sent.success}`);
          continue;
        }
        const why = reasonOf(sent.failure);
        const left = yield* Effect.result(queueRow(issue.id, false, chat.general()));
        if (left._tag === "Failure") {
          yield* core.notice("warn", `排队的「${title}」开不了工：${why}；也没能退回待办，还在队里`);
          continue;
        }
        yield* core.notice("warn", `排队的「${title}」开不了工，留在待办里：${why}`);
      }
    }),
  );

  /** to: another profile takes it on; else the one the last session worked as. */
  const reopen = Effect.fnUntraced(function* (id: string, text: string, channel: string, by: RunTrigger = { kind: "comment" }, to?: Agent) {
    const issue = yield* get(id);
    if (issue.graph || issue.task || issue.delivered === "merged_into_parent")
      return yield* Effect.fail(refused("这是计划里的工单，跟着计划走：在计划里重试这一步，或者重开整个计划"));
    if (issue.sessions.length === 0) {
      // Run before by no session (the orchestrator): its doer takes it up again, with the owner's words.
      if (!issue.lastRun) return yield* Effect.fail(refused("这张工单还没开过工：直接开工"));
      if (!isClosed(issue.status)) return yield* Effect.fail(refused("这张工单还开着：挪回待办就是再来一轮"));
      yield* start(id, channel, by, text);
      return "";
    }
    const last = yield* sessions.get(issue.sessions.at(-1)!);
    if (!last) return yield* Effect.fail(missing("工单 " + id, [lookIn.issue]));
    if (!isClosed(issue.status)) return yield* Effect.fail(refused(last.name + " 还在做这张工单：直接给它带话"));
    const agent = to ?? store.agent(last.agent);
    if (!agent) return yield* Effect.fail(refused("派它的帮工档案 " + last.agent + " 不在了"));
    const where = issue.project ?? "";
    const changes = yield* Effect.option(projects.branchChanges(where, issueBranch(issue.number)));
    const previous = Option.isSome(changes) && changes.value.commits.length > 0;
    const task = reopenTask(issue, last, text, previous, agent.id !== last.agent);
    const hired = yield* hire(agent, task, where, { channel, issue: issue.id, trigger: by });
    if (!hired.session) return yield* Effect.fail(refused(hired.refused ?? "派不出去"));
    return hired.session.id;
  });

  /** A recurrence has one issue, for the session it names or for the orchestrator; each time it comes due is a run of that issue. */
  const scheduled = Effect.fnUntraced(function* (due: Due) {
    const s = due.recurrence;
    const channel = yield* chat.channelOf(s.channel);
    const by: RunTrigger = { kind: "recurrence", recurrence: s.id, ...(due.missed ? { missed: true } : {}) };
    const found = yield* ofRecurrence(s.id);
    let issue = found;
    if (!issue) {
      const project = s.project ?? (channel.project || undefined);
      const made = yield* Effect.result(
        add({ title: s.name, description: s.text, ...(project ? { project } : {}), assignee: s.agent ?? orchestratorAgent }, s.id),
      );
      if (made._tag === "Failure") return yield* chat.notice(channel.id, "定时「" + s.name + "」写不了工单：" + reasonOf(made.failure), "recurrence_refused");
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
    if (result._tag === "Failure") yield* chat.notice(channel.id, "定时「" + s.name + "」开不了工：" + reasonOf(result.failure), "recurrence_refused");
  });

  const ofRecurrence = Effect.fnUntraced(function* (id: string) {
    const row = yield* one(q.latestOfRecurrence({ recurrence: id }));
    if (!row) return undefined;
    return Option.getOrUndefined(yield* Effect.option(get(row.id)));
  });

  // ── merging ──

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

  const comment = Effect.fnUntraced(function* (id: string, text: string, sendKey = "") {
    const issue = yield* get(id);
    if (isClosed(issue.status)) return yield* Effect.fail(refused("这张工单关上了：带一句话重开它"));
    const session = yield* liveSession(id);
    const said = yield* chat.tellSession("user", session, text, sendKey);
    // Said in its thread, the issue hears it from the message's fact (heard below); with no thread there is no fact.
    if (!said) yield* ownerSaid(id);
  });

  /** The commits on the issue's branch that the main branch does not have; none for one without a project or branch. */
  const commitsOf = (t: Issue) =>
    t.project
      ? Effect.map(Effect.option(projects.branchChanges(t.project, issueBranch(t.number))), (c) => (Option.isSome(c) ? c.value.commits.length : 0))
      : Effect.succeed(0);

  /** The profile that takes an issue on as it moves to todo; undefined when it is the one it has. Refused before anything
   * moves, so a handover never leaves its session gone and no one sent. */
  const takerOf = Effect.fnUntraced(function* (t: Issue, to: IssueStatus, key: string) {
    const a = store.named(key.trim());
    if (!a) return yield* Effect.fail(refused("没有叫 " + key + " 的帮工档案", [lookIn.agent]));
    if (a.id === t.assignee) return undefined;
    if (to !== "todo") return yield* Effect.fail(refused("换人是挪到待办时的事：挪到待办，填上谁来接手"));
    if (t.status === "in_progress") return yield* Effect.fail(refused(`#${t.number} 还在干这一轮：先叫停，等它停下再换人`));
    if (!a.enabled) return yield* Effect.fail(refused(a.name + " 被停用了"));
    for (const i of yield* runtimes.check(a)) if (i.level === "error") return yield* Effect.fail(refused(`${a.name} 派不出去：${i.text}`));
    return a;
  });

  /** Its session, if one is on the farm, goes home; an issue no session works on has nobody to send. */
  const cancel = Effect.fnUntraced(function* (id: string) {
    const t = yield* get(id);
    const last = t.sessions.at(-1);
    if (last === undefined || !sessions.find(last)) return;
    if (!(yield* sessions.dismiss(last))) return yield* Effect.fail(missing("帮工 " + last, [lookIn.session]));
  });

  // ── a move worked out before it is made ──

  /** The issue as a move would see it once the owner's unsaved fields are saved (issue.status saves them first);
   * refused as saving them would be: only how it is accepted and what it delivers change once it is sent. */
  const withEdit = Effect.fnUntraced(function* (t: Issue, edit: IssueUpdate | undefined) {
    if (!edit) return t;
    const words = Object.keys(edit).some((k) => k !== "review" && k !== "deliver");
    if (words) yield* unsent(t.id);
    return { ...t, ...Object.fromEntries(Object.entries(edit).filter(([, v]) => v !== undefined)) } as Issue;
  });

  /** The move and what it settles before anything changes; refused as the move itself would be. setStatus carries it out,
   * previewStatus says it in words: one judgment, so a dry run never promises what the move would refuse. */
  const settledMove = Effect.fnUntraced(function* (t: Issue, to: IssueStatus, text: string, opt: StatusOptions) {
    if (!(IssueStatusValues as readonly string[]).includes(to)) return yield* Effect.fail(refused("没有这个状态：" + to));
    const taker = opt.agent ? yield* takerOf(t, to, opt.agent) : undefined;
    const [move, why] = statusMove(t, to);
    const said = text.trim();
    if (move === "none") return yield* Effect.fail(refused(why, nextSteps(t)));
    if (move === "round" && !taker && !said) return yield* Effect.fail(refused("再干一轮要说一句：这一轮要它做什么"));
    // What a completion delivers follows the issue: nothing to take in, its branch kept, or merged (locally or by a PR).
    let delivery: "kept" | "none" | "merge" | undefined;
    let commits = 0;
    if (move === "complete") {
      commits = yield* commitsOf(t);
      delivery = opt.keepBranch || commits === 0 ? (opt.keepBranch && commits > 0 ? "kept" : "none") : "merge";
    }
    return { t, to, move, said, taker, delivery, commits };
  });

  const helperName = (t: Issue) => {
    const last = t.sessions.at(-1);
    return (last !== undefined ? sessions.sessionOf(last)?.name : undefined) ?? "帮工";
  };

  /** A settled move in words, one step a line; what it reads to say so (who would go, the room, a merge's conflicts) is read, not changed. */
  const movesWords = Effect.fnUntraced(function* (p: Effect.Success<ReturnType<typeof settledMove>>) {
    const t = p.t;
    const n = `#${t.number}`;
    switch (p.move) {
      case "start": {
        if (isForOrchestrator(t)) return [`${n} 交给管家答`];
        const [, agent, project] = yield* readyOf(p.taker ? { ...t, assignee: p.taker.id } : t);
        const full = sessions.noRoom(agent.runtime, project);
        return full
          ? [`${n} 派给 ${agent.name}`, `现在没空位（${full}）：排进待办，有空位就自动开工`]
          : [project ? `${n} 派 ${agent.name} 去 ${project} 开工` : `${n} 派 ${agent.name} 开工`];
      }
      case "unqueue":
        return [`${n} 不排了，挪回备选`];
      case "round":
        if (p.taker) return [`${helperName(t)} 收工，分支留着`, `${p.taker.name} 接手，在同一条分支上接着做`];
        return t.sessions.length === 0 ? [`${n} 再交给管家答一轮：${p.said}`] : [`把这句话带给 ${helperName(t)}，再干一轮：${p.said}`];
      case "reopen":
        return [`${n} 重开：派${p.taker ? " " + p.taker.name : "同一个档案的新帮工"}接着做`, ...(p.said ? [`这一次要做的：${p.said}`] : [])];
      case "revive":
        return [`${n} 挪回备选`];
      case "complete": {
        if (p.delivery === "none") return [`${n} 关成已完成：没有改动要合`, `${helperName(t)} 收工`];
        if (p.delivery === "kept") return [`${n} 关成已完成：分支留着没合（${p.commits} 个提交）`, `${helperName(t)} 收工`];
        const changes = yield* sessions.changes(yield* liveSession(t.id));
        const pr = t.project !== undefined && (t.pullRequest?.state === "open" || projects.usesPullRequests(t.project));
        const out: string[] = [];
        if (changes && changes.uncommitted.length > 0) out.push(`先替 ${helperName(t)} 提交 ${changes.uncommitted.length} 个没提交的文件`);
        if (changes && changes.conflicts.length > 0)
          return [...out, `合进 ${changes.base} 会冲突（${changes.conflicts.join("、")}）：不会合，标上冲突，工单留在等你看`];
        out.push("合之前跑项目的检查（.vibevalley/check，有的话）：没过就不合，工单留在等你看");
        out.push(
          pr
            ? `推分支、开 PR（${p.commits} 个提交）：PR 合了才关成已完成`
            : `合进 ${changes?.base ?? "主分支"}（${p.commits} 个提交），关成已完成，${helperName(t)} 收工`,
        );
        return out;
      }
      case "cancel":
        return [`${n} 关成已取消`, `${helperName(t)} 收工，分支上有提交就留着`];
      case "drop":
        return [`${n} 关成已取消：还没派过`, ...(t.refining ? [`在起草的 ${t.refining.name} 收工`] : [])];
    }
  });

  // ── drafts ──

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

  // ── what happens to its sessions ──

  const onSessionNews = Effect.fnUntraced(function* (n: SessionNews) {
    switch (n._tag) {
      case "left": {
        const e = n.left;
        const issue = (yield* one(qs.issueOfSession({ session: e.id })))?.issue;
        if (!issue) return;
        const row = yield* one(q.getIssue({ id: issue }));
        if (!row || row.graph !== null || row.task !== null) return;
        const runs = (yield* db(qs.sessionsOf({ issue }))).map((r) => r.session);
        // Closed already (completed by the owner before its session went home): the verdict stands.
        if (runs.at(-1) !== e.id || row.closed_at !== null) return;
        const closing = closingOf(e.closed);
        yield* db(
          "delivered" in closing
            ? q.completeOpenIssue({ closed_at: Date.now(), delivered: closing.delivered, id: issue })
            : q.cancelOpenIssue({ closed_at: Date.now(), canceled: closing.canceled, id: issue }),
        );
        yield* publish(issue);
        return;
      }
      case "reported": {
        const e = n.report;
        const issue = (yield* one(qs.issueOfSession({ session: e.id })))?.issue;
        // A report's 要问主人： lines are what its issue waits on the owner for; a report without them clears them.
        const checks = e.checks ?? [];
        if (issue && checks.length > 0) yield* checked(issue, checks);
        if (issue) yield* asked(issue, e.questions);
        if (issue) yield* answered(issue, e.id, e.outcome, e.answer);
        yield* handedBack(e);
        return;
      }
      case "hired":
        return;
    }
  });

  // Whatever path an owner's word took into an issue's thread, this is where the issue hears it.
  const onOwnerInThread = Effect.fnUntraced(function* (thread: string) {
    const issue = yield* Effect.option(get(thread));
    if (Option.isNone(issue) || isClosed(issue.value.status)) return;
    yield* ownerSaid(issue.value.id);
  });

  // ── coming back ──

  const rows = yield* db(q.keptIssues({ closed: keepClosedIssues }));
  const kept0 = runsBy(yield* db(qs.sessionsOfKept({ closed: keepClosedIssues })));
  for (const row of rows) yield* core.apply({ type: "issue", issue: issueOf(row, kept0.get(row.id)) });
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
  // One at a time, as when they were one stream of facts: a report and the owner's word on it do not cross.
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
    const tryEvery = options.tryEveryMs ?? 5000;
    yield* Effect.forkScoped(tryQueued.pipe(logged("the queue"), Effect.repeat(Schedule.spaced(tryEvery)), Effect.delay(tryEvery)));
    const pollPullRequests = config.github.prPollSeconds > 0 ? config.github.prPollSeconds * 1000 : 180_000;
    yield* Effect.forkScoped(
      refreshPullRequests.pipe(logged("refresh pull requests"), Effect.repeat(Schedule.spaced(pollPullRequests)), Effect.delay(pollPullRequests)),
    );
  }

  const timeline = Effect.fnUntraced(function* (id: string) {
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
    onBoard: () => core.state().issues ?? [],
    list: () => list,
    get,
    timeline,
    add: (req) => add(req),
    /** The words and who does it only before it is sent; how it is accepted and what it delivers while it is open: the
     * next round goes by them. */
    edit: Effect.fn("Issues.edit")(function* (id, upd) {
      const whileOpen =
        upd.title === undefined &&
        upd.description === undefined &&
        upd.project === undefined &&
        upd.assignee === undefined &&
        upd.priority === undefined &&
        upd.criteria === undefined;
      let was: Issue;
      if (whileOpen) {
        was = yield* get(id);
        if (isClosed(was.status)) return yield* Effect.fail(refused("这张工单关上了"));
      } else was = yield* unsent(id);
      const [title, description] = yield* issueWords({ title: upd.title ?? was.title, description: upd.description ?? was.description ?? "" });
      if (upd.project !== undefined && upd.project !== was.project && was.project) {
        const released = yield* sessions.clearWorkplace(was.id, was.project, was.number, "preserve");
        if (released.kept) return yield* Effect.fail(refused(`工单 #${was.number} 还不能换项目：${released.reason}`));
      }
      const criteria = upd.criteria !== undefined ? kept(upd.criteria) : (was.criteria ?? []);
      yield* db(
        q.editIssue({
          title,
          description,
          project: nullText(upd.project ?? was.project),
          assignee: nullText(upd.assignee ?? was.assignee),
          priority: upd.priority ?? was.priority,
          review: upd.review || was.review || "glance",
          criteria: jsonOrNull(criteria, criteria.length > 0),
          deliver: upd.deliver ?? was.deliver,
          id,
        }),
      );
      yield* publish(id);
      return yield* get(id);
    }),
    remove: Effect.fn("Issues.remove")(function* (id) {
      const t = yield* unsent(id);
      const cleared = yield* clearRefinement(t);
      if (cleared.kept) return yield* Effect.fail(refused(`工单 #${t.number} 还不能删：${cleared.reason}`));
      yield* db(q.removeIssue({ id }));
      yield* core.apply({ type: "issueGone", id } as never);
    }),
    move: Effect.fn("Issues.move")(function* (id, before) {
      yield* unsent(id);
      const order = (yield* list).filter((t) => t.sessions.length === 0 && !t.graph && !t.task && t.id !== id).map((t) => t.id);
      const at = order.indexOf(before);
      order.splice(at < 0 ? order.length : at, 0, id);
      yield* inTx(Effect.forEach(order, (each, rank) => db(q.placeIssue({ rank, id: each })), { discard: true }));
      for (const each of order) yield* publish(each);
      return yield* list;
    }),
    queue: (id, queued) => queueRow(id, queued, chat.general()),
    start: (id, channel) => start(id, channel),
    /** Only a queued todo starts here, under the queue's lock; without room it keeps its place. */
    dispatchQueued: Effect.fn("Issues.dispatchQueued")(function* (id) {
      const issue = yield* get(id);
      if (issue.status !== "todo" || issue.queuedAt === undefined || issue.graph || issue.task || isForOrchestrator(issue))
        return yield* Effect.fail(refused("只有排着队的待办能从这里开工"));
      const [, agent, project] = yield* ready(id);
      const full = sessions.noRoom(agent.runtime, project);
      if (full) return { queued: full + "：还在排队，有空位就自动开工" };
      return yield* start(id, "");
    }, trying.withPermits(1)),
    reopen: (id, text, channel) => reopen(id, text, channel),
    idOf,
    act: Effect.fn("Issues.act")(function* (ref, req, channel) {
      const t = yield* get(ref);
      const id = t.id;
      const name = actLabel[req.act];
      if (!t.attention.acts.includes(req.act))
        return yield* Effect.fail(refused(`#${t.number} 是「${attentionLabel[t.attention.state]}」，现在不能「${name}」`, nextSteps(t)));
      const said = (req.text ?? "").trim();
      const words = said ? Effect.succeed(said) : Effect.fail(refused(`「${name}」要说一句`));
      switch (req.act) {
        case "start":
          yield* shape.setStatus(id, "todo", said, channel);
          break;
        case "answer":
        case "tell":
          yield* comment(id, yield* words, req.sendKey ?? "");
          break;
        case "accept":
          yield* shape.review(id, { pass: true });
          break;
        case "reject": {
          const findings = req.findings ?? findingsOf(said);
          if (findings.length === 0) return yield* Effect.fail(refused("打回要写哪里要修，一行一条"));
          yield* shape.review(id, { pass: false, findings });
          break;
        }
        case "complete":
        case "acknowledge":
          yield* shape.setStatus(id, "done", said, channel);
          break;
        case "keep":
          yield* shape.setStatus(id, "done", said, channel, { keepBranch: true });
          break;
        case "close":
          yield* shape.setStatus(id, "canceled", said, channel);
          break;
        // Sent before: another session, told what to do; never sent: back to the backlog, nothing to tell.
        case "reopen":
          yield* t.sessions.length > 0 ? shape.setStatus(id, "todo", yield* words, channel) : shape.setStatus(id, "backlog", "", channel);
          break;
        case "resolve":
          yield* shape.resolve(id);
          break;
        case "resume":
          yield* comment(id, resumeWords);
          break;
        case "cure": {
          const last = t.sessions.at(-1);
          // An answer that could not be read goes back with what was wrong with it; a failed round with the job again.
          const lastRun = last !== undefined ? sessions.sessionOf(last)?.lastRun : undefined;
          const unread = t.deliver === "answer" && lastRun?.outcome === "completed" && !lastRun.answer;
          yield* comment(
            id,
            unread
              ? answerCureWords(parseAnswer(sessions.find(last ?? "")?.lastText ?? "").problem)
              : cureWords((last !== undefined ? sessions.sessionOf(last)?.brief : undefined) ?? t.title),
          );
          break;
        }
        case "stop":
          yield* sessions.stop(yield* liveSession(id));
          break;
      }
      return yield* get(id);
    }),
    setStatus: Effect.fn("Issues.setStatus")(function* (id, to, text, channel, opt = {}) {
      const t = yield* get(id);
      const { move, said, taker, delivery } = yield* settledMove(t, to, text, opt);
      switch (move) {
        case "start":
          if (taker) yield* shape.edit(id, { assignee: taker.id });
          yield* start(id, channel);
          break;
        case "unqueue":
          yield* queueRow(id, false, chat.general());
          break;
        // Handed over: its session leaves first, so that one session at a time works the issue's branch.
        case "round":
          if (taker) {
            yield* cancel(id);
            yield* cancelAs(id, "dismissed");
            yield* reopen(id, said, channel, { kind: "comment" }, taker);
            break;
          }
          // A session on the farm hears it in its thread; with none (the orchestrator's), its doer is asked again.
          if (t.sessions.length === 0) yield* start(id, channel, { kind: "comment" }, said);
          else yield* comment(id, said);
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
    previewAct: Effect.fn("Issues.previewAct")(function* (ref, req) {
      const t = yield* get(ref);
      const name = actLabel[req.act];
      if (!t.attention.acts.includes(req.act))
        return yield* Effect.fail(refused(`#${t.number} 是「${attentionLabel[t.attention.state]}」，现在不能「${name}」`, nextSteps(t)));
      const said = (req.text ?? "").trim();
      const words = said ? Effect.succeed(said) : Effect.fail(refused(`「${name}」要说一句`));
      const asStatus = (to: IssueStatus, text: string, opt: StatusOptions = {}) => Effect.flatMap(settledMove(t, to, text, opt), movesWords);
      const helper = helperName(t);
      const does: readonly string[] = yield* (() => {
        switch (req.act) {
          case "start":
            return asStatus("todo", said);
          case "answer":
            return Effect.map(words, (w) => [`回答 ${helper} 问的：${w}`, "它的问题清掉，接着做"]);
          case "tell":
            return Effect.map(words, (w) => [`把这句话带给 ${helper}：${w}`]);
          case "accept":
            return Effect.succeed([`#${t.number} 验收通过`]);
          case "reject": {
            const findings = req.findings ?? findingsOf(said);
            return findings.length === 0
              ? Effect.fail(refused("打回要写哪里要修，一行一条"))
              : Effect.succeed([`#${t.number} 打回：${findings.length} 条意见交给 ${helper} 再修一轮`]);
          }
          case "complete":
          case "acknowledge":
            return asStatus("done", said);
          case "keep":
            return asStatus("done", said, { keepBranch: true });
          case "close":
            return asStatus("canceled", said);
          case "reopen":
            return t.sessions.length > 0 ? Effect.flatMap(words, (w) => asStatus("todo", w)) : asStatus("backlog", "");
          case "resolve":
            return Effect.succeed([`让 ${helper} 把主分支合进它的分支、解决冲突，做完再交回来`]);
          case "resume":
            return Effect.succeed([`让 ${helper} 接着做：${resumeWords}`]);
          case "cure":
            return Effect.succeed([`让 ${helper} 接着修，再交回来`]);
          case "stop":
            return Effect.succeed([`叫停 ${helper} 这一轮：它停下，工单等你看`]);
        }
      })();
      return { does: [...does] };
    }),
    previewRemove: Effect.fn("Issues.previewRemove")(function* (id) {
      const t = yield* unsent(id);
      return {
        does: [
          `删掉工单 #${t.number}「${shortTitle(t.title)}」`,
          ...(t.refining ? [`在起草的 ${t.refining.name} 收工`] : []),
          ...(t.project ? ["清掉它的 worktree 和没有提交的分支；还有改动就不删"] : []),
        ],
      };
    }),
    comment,
    changes: Effect.fn("Issues.changes")(function* (id, by) {
      const session = yield* liveSession(id);
      const changes = yield* sessions.changes(session);
      if (!changes) return yield* Effect.fail(missing("帮工 " + session, [lookIn.session]));
      if (by === "owner") yield* core.did({ kind: "reviewed", session });
      return changes;
    }),
    merge,
    /** The owner asks the session to settle its conflicts: the ones the farm marked on it, else the ones merging would meet now. */
    resolve: Effect.fn("Issues.resolve")(function* (id) {
      const session = yield* liveSession(id);
      const h = sessions.sessionOf(session);
      if (!h) return yield* Effect.fail(missing("帮工 " + session, [lookIn.session]));
      // A preview that fails (git broken) is said as it is, not taken for no conflict.
      const changes = h.conflict ? undefined : yield* sessions.changes(session);
      const conflict = h.conflict ?? (changes ? conflictOf(changes) : undefined);
      if (!conflict) return yield* Effect.fail(refused(h.name + " 和主分支没有冲突"));
      yield* chat.tellSession("user", session, conflictBrief(conflict.base, conflict.files), "");
    }),
    cancel,
    /** Only an issue in review has something to judge. */
    review: Effect.fn("Issues.review")(function* (id, req) {
      const t = yield* get(id);
      const why = isForOrchestrator(t)
        ? "这是派给管家的工单：管家答完就关"
        : t.graph || t.task
          ? "这是计划里的工单，跟着计划走：在计划里验收"
          : t.status !== "in_review"
            ? "还没交回来，没有东西可验收"
            : "";
      if (why) return yield* Effect.fail(refused(why, nextSteps(t)));
      if (req.pass) {
        yield* judged(
          id,
          Date.now(),
          t.findings.map((f) => ({ ...f, resolved: true })),
        );
        return yield* get(id);
      }
      const fresh = kept(req.findings);
      const text = (req.text ?? "").trim();
      if (fresh.length === 0 && !text) return yield* Effect.fail(refused("没过验收要说哪里不行：至少写一条意见"));
      const at = Date.now();
      const findings = [...t.findings, ...fresh.map((text) => ({ id: newId(), text, at }))];
      yield* judged(id, 0, findings);
      // The findings go to whoever works it as the next round's words, like any comment.
      yield* comment(id, failedText(findings, text));
      return yield* get(id);
    }),
    refine: draft,
    /** Every issue with its sessions, live and ended, once; a session with no record is named as missing, not given a phase. */
    history: Effect.fn("Issues.history")(function* () {
      const all = yield* list;
      const byId = new Map((yield* sessions.list("")).map((s) => [s.id, s]));
      return all.map((issue) => ({
        issue,
        sessions: issue.sessions.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])),
        missingSessions: issue.sessions.filter((id) => !byId.has(id)),
      }));
    }),
    templates: Effect.fn("Issues.templates")(function* (name) {
      const stack = yield* projects.stack(name);
      if (!stack) return yield* Effect.fail(missing("项目 " + name, [lookIn.project]));
      return { project: name, stack, recent: sentTitles(yield* list, name), kinds: filledKinds(templateCatalog(), stack) };
    }),
    hire,
    ran,
    putTask: Effect.fn("Issues.putTask")(function* (graph) {
      const family = Effect.fnUntraced(function* (id: string) {
        const rows = yield* db(q.family({ id }));
        const runs = runsBy(yield* db(qs.sessionsOfFamily({ id })));
        return rows.map((r) => issueOf(r, runs.get(r.id)));
      });
      const before = yield* family(graph.id);
      const issues = graphIssues(graph, before, Date.now());
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
      // Published as one commit once the transaction has succeeded.
      const updated = yield* Effect.forEach([...issues.slice(1), issues[0]!], (t) => get(t.id).pipe(Effect.orDie));
      yield* core.apply(...gone.map((id) => ({ type: "issueGone", id }) as never), ...updated.map((issue) => ({ type: "issue" as const, issue })));
    }),
    nextTaskId: () => Effect.map(db(q.graphIDs()), (rows) => nextTaskId(rows.map((r) => r.id))),
    forOrchestrator: Effect.map(PubSub.subscribe(orchestratorHub), Stream.fromSubscription),
    ofRecurrence,
    refreshPullRequests,
    tryQueued,
  });
  return shape;
});

export const layer = (options?: IssueOptions) => Layer.effect(Issues, make(options));
