// Issues: what the owner wants done, each worked by sessions one after another. An issue closes
// when its last session leaves, as the fact that the session left says how, and opens again with another session; a
// task's issues open and close as the task says. An issue may be drafted first: a session reads the code and writes it in
// the issue's format, then leaves, the issue still unsent. One for the manager is handed to the manager, not to a session,
// and waits on the owner once the manager's turn ends, however it ended: only the owner closes it. A branch that would conflict is not merged: the session stays
// with its branch and worktree, and the state says which files.

import {
  type Agent,
  type Ask,
  type Changes,
  type CriterionCheck,
  type Conflict,
  type Dispatched,
  type Finding,
  type HandedBack,
  type Issue,
  type IssueAcceptRequest,
  type IssueClose,
  type IssueGraph,
  type IssueHistory,
  type IssueRequest,
  type IssueStatus,
  IssueStatusValues,
  type IssueTask,
  type IssueTimeline,
  type IssueUpdate,
  managerAgent,
  maxRunning,
  type Priority,
  type ProjectTemplates,
  type PullRequest,
  type PullRequestState,
  type RunTrigger,
  type Schedule,
  type Session,
  type TaskGraph,
} from "@vibevalley/protocol";
import {
  conflictBrief,
  cut,
  dueText,
  graphIssues,
  isBusy,
  isForManager,
  issueDraftingOf,
  issueOrder,
  issueStatusOf,
  keepClosedIssues,
  standingIn,
  templateCatalog,
} from "@vibevalley/protocol/rules";
import { Context, Effect, Layer, Option, PubSub, type Scope, Semaphore, Stream } from "effect";
import { SqlClient } from "effect/sql";
import * as q from "../../db/generated/issue.sql.ts";
import * as qq from "../../db/generated/issue_queue.sql.ts";
import * as qs from "../../db/generated/issue_session.sql.ts";
import { Agents } from "../agent/agent.ts";
import { Settings } from "../base/config.ts";
import { causeMessage } from "../base/db.ts";
import { newId } from "../base/ids.ts";
import { Channels } from "../channel/chat.ts";
import { Core } from "../core/core.ts";
import { type ApiError, missing, reasonOf, refused } from "../errors.ts";
import { issueBranch, MergeFailure, Projects, type Workplace } from "../project/project.ts";
import { Runtimes, usable } from "../runtime/runtime.ts";
import { askedMax } from "../session/journal.ts";
import { chooseAgent } from "../session/rules.ts";
import { type Hired, type HireOptions, Sessions } from "../session/session.ts";
import { type Due, Schedules } from "../schedule/schedule.ts";
import {
  draftBrief,
  draftDescription,
  filledKinds,
  isClosed,
  issueJob,
  type IssueDraft,
  kept,
  milestonesOf,
  openAsks,
  nextTaskId,
  parseDraft,
  sentTitles,
  splitJob,
  statusMove,
  statusMoves,
} from "./rules.ts";

/** An issue for the manager, handed to it. */
export interface ManagerWork {
  readonly issue: Issue;
  readonly channel: string;
  readonly by: RunTrigger;
  /** The schedule that came due, when one did. */
  readonly schedule?: Schedule;
}

/** Who looked at changes: the owner's look counts for the game, the manager's does not. */
export type Caller = "owner" | "manager";

export interface IssueShape {
  readonly list: () => Effect.Effect<Issue[]>;
  readonly get: (id: string) => Effect.Effect<Issue, ApiError>;
  readonly add: (req: IssueRequest) => Effect.Effect<Issue, ApiError>;
  readonly edit: (id: string, upd: IssueUpdate) => Effect.Effect<Issue, ApiError>;
  readonly remove: (id: string) => Effect.Effect<void, ApiError>;
  readonly move: (id: string, before: string) => Effect.Effect<Issue[], ApiError>;
  readonly queue: (id: string, queued: boolean) => Effect.Effect<Issue, ApiError>;
  readonly start: (id: string, channel: string) => Effect.Effect<Dispatched, ApiError>;
  readonly dispatchQueued: (id: string) => Effect.Effect<Dispatched, ApiError>;
  readonly reopen: (id: string, text: string, channel: string) => Effect.Effect<string, ApiError>;
  readonly setStatus: (id: string, to: IssueStatus, text: string, channel: string) => Effect.Effect<Issue, ApiError>;
  readonly comment: (id: string, text: string, sendKey?: string) => Effect.Effect<void, ApiError>;
  readonly changes: (id: string, by: Caller) => Effect.Effect<Changes, ApiError>;
  readonly merge: (id: string) => Effect.Effect<string, ApiError>;
  readonly resolve: (id: string) => Effect.Effect<void, ApiError>;
  readonly cancel: (id: string) => Effect.Effect<void, ApiError>;
  readonly accept: (id: string, req: IssueAcceptRequest) => Effect.Effect<Issue, ApiError>;
  readonly draft: (id: string, word: string, channel: string) => Effect.Effect<Issue, ApiError>;
  readonly history: () => Effect.Effect<IssueHistory[]>;
  readonly timeline: (id: string) => Effect.Effect<IssueTimeline, ApiError>;
  readonly templates: (project: string) => Effect.Effect<ProjectTemplates, ApiError>;
  /** Sends a session for a job that is not written down first (the manager sending someone at once, a task's step): its issue is made from the job. */
  readonly hire: (agent: Agent, task: string, project: string, opt?: HireOptions) => Effect.Effect<Hired>;
  /** A session started on an issue not written down first: the issue is made from its job, in one write with the session. */
  readonly ran: (id: string, session: Session) => Effect.Effect<void, Error>;
  /** The issues of a task graph as the graph has them now, published as one commit once written. */
  readonly putTask: (graph: TaskGraph) => Effect.Effect<void>;
  readonly nextTaskId: () => Effect.Effect<string>;
  /** Issues for the manager, subscribed before it returns. */
  readonly forManager: Effect.Effect<Stream.Stream<ManagerWork>, never, Scope.Scope>;
  readonly ofSchedule: (id: string) => Effect.Effect<Issue | undefined>;
  readonly refreshPullRequests: Effect.Effect<void>;
  readonly tryQueued: Effect.Effect<void>;
}

export class Issues extends Context.Service<Issues, IssueShape>()("vibevalley/Issue") {}

type Row = q.GetIssueResult;

const json = <T>(text: string | null): T | undefined => {
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
};

/** Empty is none. */
const nullText = (s: string | undefined) => {
  const t = (s ?? "").trim();
  return t === "" ? null : t;
};

const jsonOrNull = (v: unknown, there: boolean) => (there ? JSON.stringify(v) : null);

const closedText: Readonly<Partial<Record<IssueClose, string>>> = {
  merged: "收获了，改动已经合进项目的主分支",
  merged_into_graph: "做完了，改动合进了种植计划的分支",
  dismissed: "没收获就收工了，改动没有合进主分支",
  lost: "干活的目录丢了，改动可能不在了",
};

const outcomeText = { completed: "做完了", failed: "没做成", interrupted: "被叫停了" } as const;

const reopenDefault = "接着把这张工单做完";

export function reopenTask(issue: Issue, last: Session, text: string, previous: boolean): string {
  let out = (text.trim() || reopenDefault) + `\n\n（这张工单重开了，上一次是 ${last.name}（${last.id}）做的。）`;
  out += "\n这张工单原来是：" + cut(issueJob(issue), askedMax);
  if (last.phase._tag === "closed") out += "\n它是怎么关的：" + (closedText[last.phase.closed] ?? "");
  if (last.lastRun) out += `\n最后一轮${outcomeText[last.lastRun.outcome]}：${cut(last.lastRun.summary.trim(), askedMax)}`;
  if (previous) out += "\n这条分支上已经有上次的提交，接着做。";
  return out + "\n先看看项目现在的样子，再接着做。";
}

/** The findings still standing, numbered, then the owner's own words. */
function failedText(findings: readonly Finding[], text: string): string {
  let out = "验收没过，这几处要修：";
  let n = 0;
  for (const f of findings) if (!f.pulled) out += `\n${++n}. ${f.text}`;
  if (text) out += "\n\n" + text;
  return out + "\n\n修好以后在结论里逐条说怎么修的。";
}

/** Tests make it shorter. */
export interface IssueOptions {
  readonly tryEveryMs?: number;
  readonly background?: boolean;
}

export const make = (options: IssueOptions = {}) =>
  Effect.gen(function* () {
    const config = yield* Settings;
    const core = yield* Core;
    const store = yield* Agents;
    const projects = yield* Projects;
    const runtimes = yield* Runtimes;
    const sessions = yield* Sessions;
    const chat = yield* Channels;
    const schedules = yield* Schedules;
    const sql = yield* SqlClient.SqlClient;
    const db = <A, E>(e: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.provideService(e, SqlClient.SqlClient, sql).pipe(Effect.orDie);
    const one = <A, E>(e: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.map(db(Effect.option(e)), Option.getOrUndefined);
    const inTx = <A, E>(e: Effect.Effect<A, E>) =>
      sql.withTransaction(e).pipe(Effect.catchTag("SqlError", Effect.die)) as Effect.Effect<A, Exclude<E, { _tag: "SqlError" }>>;
    const managerHub = yield* PubSub.unbounded<ManagerWork>();
    /** One round of the queue at a time. */
    const trying = Semaphore.makeUnsafe(1);
    /** One draft starts at a time: two clicks do not send two sessions. */
    const drafting = Semaphore.makeUnsafe(1);
    /** Harvests by pull request and the poll of their states, one at a time. */
    const prLock = Semaphore.makeUnsafe(1);

    // ── reading ──

    function issueOf(row: Row, runs: readonly string[] | undefined): Issue {
      const state = core.state();
      const graph = json<IssueGraph>(row.graph);
      const task = json<IssueTask>(row.task);
      const blockedBy = json<string[]>(row.blocked_by);
      const criteria = json<string[]>(row.criteria);
      const checks = json<CriterionCheck[]>(row.checks);
      const pullRequest = json<PullRequest>(row.pull_request);
      const handedBack = json<HandedBack>(row.handed_back);
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
        ...(row.closed !== null ? { closed: row.closed as IssueClose } : {}),
        ...(row.parent !== null ? { parent: row.parent } : {}),
        ...(blockedBy ? { blockedBy } : {}),
        ...(graph ? { graph } : {}),
        ...(task ? { task } : {}),
        ...(row.schedule !== null ? { schedule: row.schedule } : {}),
        status: "backlog",
        moves: [],
        ...(pullRequest ? { pullRequest } : {}),
        acceptance: row.acceptance as Issue["acceptance"],
        ...(row.accepted_at !== null ? { acceptedAt: row.accepted_at } : {}),
        findings: json<Finding[]>(row.findings) ?? [],
        asks: json<Ask[]>(row.asks) ?? [],
        ...(criteria ? { criteria } : {}),
        ...(checks ? { checks } : {}),
        ...(handedBack ? { handedBack } : {}),
        standing: { state: "draft", acts: [] },
      };
      if ((out.sessions.length === 0 || out.task) && row.rank) out.rank = row.rank;
      out.status = issueStatusOf(out, state);
      const drafter = issueDraftingOf(out, state);
      if (drafter) out.drafting = drafter;
      // The moves read the standing: a round that failed is not harvested.
      out.standing = standingIn(out, state);
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

    /** By its id, or by the id of a session that worked it. */
    const get = (id: string): Effect.Effect<Issue, ApiError> =>
      Effect.gen(function* () {
        const issue = (yield* one(qs.issueOfSession({ session: id })))?.issue ?? id;
        const row = yield* one(q.getIssue({ id: issue }));
        if (!row) return yield* Effect.fail(missing("工单 " + id));
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
          ? Effect.fail(refused("这是种植计划的工单：在计划里改"))
          : issue.sessions.length > 0
            ? Effect.fail(refused("这张工单已经开工了"))
            : Effect.succeed(issue),
      );

    const liveSession = (id: string) =>
      Effect.flatMap(latest(id), (session) => (sessions.find(session) ? Effect.succeed(session) : Effect.fail(missing("帮工 " + session))));

    // ── writing ──

    const issueWords = (req: Pick<IssueRequest, "title" | "description">) => {
      const [title, rest] = splitJob(req.title);
      if (!title) return Effect.fail(refused("工单没有标题"));
      let description = (req.description ?? "").trim();
      if (rest) description = (rest + "\n\n" + description).trim();
      return Effect.succeed([title, description] as const);
    };

    const add = (req: IssueRequest, schedule?: string) =>
      Effect.gen(function* () {
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
            schedule: schedule ?? null,
            acceptance: req.acceptance || "glance",
          }),
        );
        yield* publish(id);
        return yield* get(id);
      });

    const closeAs = (id: string, how: IssueClose) => Effect.andThen(db(q.closeIssue({ closed_at: Date.now(), closed: how, id })), publish(id));

    /** The manager's turn on its issue ended; a session's run on one is not this. */
    const handBack = (id: string, h: HandedBack) =>
      Effect.gen(function* () {
        const t = yield* get(id);
        if (!isForManager(t)) return;
        // A turn cut off by a restart closed its issue as lost; the turn it goes on in hands back all the same.
        if (isClosed(t.status)) {
          if (t.closed !== "lost") return;
          yield* db(q.reopenIssue({ id }));
        }
        yield* db(q.setHandedBack({ id, handed_back: JSON.stringify(h) }));
        yield* publish(id);
      });

    const reopenRow = (id: string) => Effect.andThen(db(q.reopenIssue({ id })), publish(id));

    /** What the session waits on the owner for, from its report; a report with none, or a comment, clears them. */
    const asked = (id: string, asks: readonly Ask[] | undefined) =>
      Effect.andThen(db(q.setIssueAsks({ id, asks: jsonOrNull(openAsks(asks), openAsks(asks).length > 0) })), publish(id));

    /** The helper's word on each criterion, from the newest report that gave one; a reopen clears it. */
    const checked = (id: string, checks: readonly CriterionCheck[]) => db(q.setIssueChecks({ id, checks: jsonOrNull(checks, checks.length > 0) }));

    /** at 0 is not accepted (a fail, or another round started); the findings are written as they stand. */
    const judged = (id: string, at: number, findings: readonly Finding[]) =>
      Effect.andThen(db(q.acceptIssue({ id, accepted_at: at > 0 ? at : null, findings: jsonOrNull(findings, findings.length > 0) })), publish(id));

    /** The owner's word answers what it asked, and starts a round that the last acceptance did not see. */
    const ownerSaid = (id: string) =>
      Effect.gen(function* () {
        yield* asked(id, []);
        const t = yield* get(id);
        if (t.acceptedAt !== undefined) yield* judged(id, 0, t.findings);
      });

    /** An issue not written down first is made from the session's job, in one write with its first session; a write that fails says what the database said. */
    const ran = (id: string, session: Session) =>
      Effect.gen(function* () {
        const [title, description] = splitJob(session.brief);
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* q.openIssue({
                id,
                title,
                description,
                project: nullText(session.project),
                assignee: nullText(session.agent),
                created_at: session.hiredAt,
              });
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
    const queueRow = (id: string, queued: boolean, channel: string, by?: RunTrigger) =>
      Effect.gen(function* () {
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
        row ? Effect.succeed([row.channel, JSON.parse(row.triggered_by) as RunTrigger] as const) : Effect.fail(refused(`工单 ${id} 不在队里`)),
      );

    /** Canceled before it was ever sent: out of the queue and closed as dismissed, in one write. */
    const drop = (id: string) =>
      Effect.gen(function* () {
        yield* unsent(id);
        yield* inTx(
          Effect.all([db(qq.dequeueIssue({ issue: id })), db(q.unqueueIssue({ id })), db(q.closeIssue({ closed_at: Date.now(), closed: "dismissed", id }))], {
            discard: true,
          }),
        );
        yield* publish(id);
      });

    // ── sending ──

    const hire = (agent: Agent, task: string, project: string, opt: HireOptions = {}) =>
      Effect.gen(function* () {
        if (agent.id === managerAgent) return { refused: "管家不下地：派给一个帮工档案" } as Hired;
        if (!agent.enabled) return { refused: agent.name + " 被停用了" } as Hired;
        for (const i of yield* runtimes.check(agent)) if (i.level === "error") return { refused: `${agent.name} 派不出去：${i.text}` } as Hired;
        const where = project.trim() || (agent.workdir ?? "").trim();
        if (!where) return { refused: "没说在哪个项目里做：项目是工作目录下的一个文件夹" } as Hired;
        const full = sessions.noRoom(agent.runtime, where);
        if (full) return { refused: full } as Hired;
        // A full farm sends home whoever has been idle longest.
        let evicted = "";
        const all = core.state().sessions;
        if (all.length >= maxRunning) {
          const oldest = all.filter((s) => !isBusy(s)).sort((a, b) => a.hiredAt - b.hiredAt)[0];
          if (oldest) {
            evicted = oldest.name;
            yield* sessions.dismiss(oldest.id);
          }
        }
        let options = opt;
        if (!options.issue) options = { ...options, issue: newId() };
        else {
          const known = yield* Effect.option(get(options.issue));
          if (Option.isSome(known)) options = { ...options, issueNumber: known.value.number };
        }
        // A draft's session is not one of the issue's sessions: the issue stays unsent.
        if (!options.draft) options = { ...options, hiring: (w) => ran(options.issue!, w) };
        const hired = yield* sessions.send(agent, task, where, options);
        return hired.session && evicted ? { ...hired, evicted } : hired;
      });

    const ready = (id: string) =>
      Effect.gen(function* () {
        const issue = yield* unsent(id);
        if (issue.drafting) return yield* Effect.fail(refused(issue.drafting.name + " 正在起草：等它交回来再开工"));
        if (!issue.assignee) return yield* Effect.fail(refused("还没选派哪个帮工档案"));
        const agent = store.agent(issue.assignee);
        if (!agent) return yield* Effect.fail(refused("帮工档案 " + issue.assignee + " 不在了"));
        return [issue, agent, issue.project ?? agent.workdir ?? ""] as const;
      });

    const send = (issue: Issue, agent: Agent, project: string, channel: string, by?: RunTrigger) =>
      Effect.flatMap(hire(agent, issueJob(issue), project, { channel, issue: issue.id, ...(by ? { trigger: by } : {}) }), (hired) =>
        hired.session ? Effect.succeed(hired.session.id) : Effect.fail(refused(hired.refused ?? "派不出去")),
      );

    const toManager = (issue: Issue, channel: string, by: RunTrigger, due?: Schedule) =>
      Effect.gen(function* () {
        if (isClosed(issue.status)) yield* reopenRow(issue.id);
        else if (issue.handedBack) yield* Effect.andThen(db(q.setHandedBack({ id: issue.id, handed_back: null })), publish(issue.id));
        PubSub.publishUnsafe(managerHub, { issue, channel, by, ...(due ? { schedule: due } : {}) });
      });

    /** by undefined: the issue sent out. */
    const start = (id: string, channel: string, by?: RunTrigger): Effect.Effect<Dispatched, ApiError> =>
      Effect.gen(function* () {
        const mine = yield* Effect.option(get(id));
        if (Option.isSome(mine) && isForManager(mine.value)) {
          yield* toManager(mine.value, channel, by ?? { kind: "issue" });
          return {};
        }
        const [issue, agent, project] = yield* ready(id);
        let where = channel;
        let trigger = by;
        if (issue.queuedAt !== undefined) [where, trigger] = yield* queuedDispatch(id);
        const full = sessions.noRoom(agent.runtime, project);
        if (full) {
          yield* queueRow(issue.id, true, (yield* chat.channelOf(where)).id, trigger);
          return { queued: full + "：排上队了，有空地就自动开工" };
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

    const reopen = (id: string, text: string, channel: string, by: RunTrigger = { kind: "comment" }) =>
      Effect.gen(function* () {
        const issue = yield* get(id);
        if (issue.graph || issue.task || issue.closed === "merged_into_graph")
          return yield* Effect.fail(refused("这是种植计划的工单，跟着计划走：在计划里重试这一步，或者重开整个计划"));
        if (issue.sessions.length === 0) return yield* Effect.fail(refused("这张工单还没开过工：直接开工"));
        const last = yield* sessions.get(issue.sessions.at(-1)!);
        if (!last) return yield* Effect.fail(missing("工单 " + id));
        if (!isClosed(issue.status)) return yield* Effect.fail(refused(last.name + " 还在做这张工单：直接给它带话"));
        const agent = store.agent(last.agent);
        if (!agent) return yield* Effect.fail(refused("派它的帮工档案 " + last.agent + " 不在了"));
        const where = issue.project ?? "";
        const changes = yield* Effect.option(projects.branchChanges(where, issueBranch(issue.number)));
        const previous = Option.isSome(changes) && changes.value.commits.length > 0;
        const hired = yield* hire(agent, reopenTask(issue, last, text, previous), where, { channel, issue: issue.id, trigger: by });
        if (!hired.session) return yield* Effect.fail(refused(hired.refused ?? "派不出去"));
        return hired.session.id;
      });

    /** A schedule has one issue, for the session it names or for the manager; each time it comes due is a run of that issue. */
    const scheduled = (due: Due) =>
      Effect.gen(function* () {
        const s = due.schedule;
        const channel = yield* chat.channelOf(s.channel);
        const by: RunTrigger = { kind: "schedule", schedule: s.id, ...(due.missed ? { missed: true } : {}) };
        const found = yield* ofSchedule(s.id);
        let issue = found;
        if (!issue) {
          const project = s.project ?? (channel.project || undefined);
          const made = yield* Effect.result(
            add({ title: s.name, description: s.text, ...(project ? { project } : {}), assignee: s.agent ?? managerAgent }, s.id),
          );
          if (made._tag === "Failure") return yield* chat.notice(channel.id, "定时「" + s.name + "」写不了工单：" + reasonOf(made.failure), "schedule_refused");
          issue = made.success;
        }
        const text = dueText(s, due.missed);
        const t = issue;
        const result = yield* Effect.result(
          Effect.gen(function* () {
            if (isForManager(t)) return yield* toManager(t, channel.id, by, s);
            if (!found || t.status === "backlog" || t.status === "todo") return yield* Effect.asVoid(start(t.id, channel.id, by));
            if (isClosed(t.status)) return yield* Effect.asVoid(reopen(t.id, text, channel.id, by));
            const d = yield* sessions.deliver(t.sessions.at(-1)!, text, by);
            if (d.kind === "refused") return yield* Effect.fail(refused(d.reason ?? ""));
          }),
        );
        if (result._tag === "Failure") yield* chat.notice(channel.id, "定时「" + s.name + "」开不了工：" + reasonOf(result.failure), "schedule_refused");
      });

    const ofSchedule = (id: string) =>
      Effect.gen(function* () {
        const row = yield* one(q.latestOfSchedule({ schedule: id }));
        if (!row) return undefined;
        return Option.getOrUndefined(yield* Effect.option(get(row.id)));
      });

    // ── merging ──

    const conflictOf = (changes: Changes): Conflict | undefined =>
      changes.conflicts && changes.conflicts.length > 0 ? { base: changes.base, files: changes.conflicts } : undefined;
    const sameConflict = (a: Conflict | undefined, b: Conflict | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

    /** What the session's branch would bring; the preview is the freshest word on conflicts, and the state follows it. */
    const sessionChanges = (id: string) =>
      Effect.gen(function* () {
        const place = sessions.place(id);
        if (!place) return undefined;
        const changes = yield* projects.changes(place).pipe(Effect.mapError((e) => refused(e.message)));
        const conflict = conflictOf(changes);
        const session = core.session(id);
        if (session && !sameConflict(session.conflict, conflict)) yield* core.apply({ type: "conflict", id, ...(conflict ? { conflict } : {}) });
        return changes;
      });

    const recheck = (id: string) =>
      Effect.gen(function* () {
        const place = sessions.place(id);
        const session = core.session(id);
        if (!place || !session) return;
        const conflict = yield* projects.conflict(place, session.conflict?.base ?? "");
        if (!sameConflict(session.conflict, conflict)) yield* core.apply({ type: "conflict", id, ...(conflict ? { conflict } : {}) });
      });

    const mergeError = (id: string, err: unknown) =>
      Effect.gen(function* () {
        const session = core.session(id);
        const failure =
          err instanceof MergeFailure
            ? err
            : new MergeFailure("error", typeof err === "object" && err !== null && "_tag" in err ? reasonOf(err as ApiError) : String(err));
        if (!session) return refused(failure.reasonText || failure.message);
        if (failure.kind === "conflict") {
          const files = failure.files.join("、");
          yield* core.notice("warn", `${session.name} 的分支合进 ${failure.base} 会冲突（${files}），先没收。可以让它自己把冲突解决掉`);
          return refused(
            `没收：合进 ${failure.base} 会冲突（${files}）。${session.name} 还在地里，分支和 worktree 都在。要它解决就用 tell 告诉它：${conflictBrief(failure.base, failure.files)}`,
          );
        }
        let why = failure.reasonText;
        if (failure.kind === "check") {
          const told = yield* Effect.result(chat.tellSession("user", id, failure.reasonText + "\n请修好检查，再交回来。", ""));
          if (told._tag === "Failure") why += "\n给帮工带话失败：" + reasonOf(told.failure);
        }
        yield* core.notice("warn", `${session.name} 的活没收进去：${why}`);
        return refused(`没收进去：${why}。${session.name} 还在地里`);
      });

    const mergeSession = (id: string) =>
      Effect.gen(function* () {
        const session = core.session(id);
        if (!session) return yield* Effect.fail(missing("帮工 " + id));
        const merged = yield* Effect.result(sessions.merge(id));
        if (merged._tag === "Failure") return yield* Effect.fail(yield* mergeError(id, merged.failure));
        yield* core.notice("info", `收了 ${session.name} 的活：${merged.success.text}`);
        return merged.success.text;
      });

    const savePullRequest = (id: string, pr: PullRequest) => Effect.andThen(db(q.setIssuePullRequest({ id, pull_request: JSON.stringify(pr) })), publish(id));

    const comment = (id: string, text: string, sendKey = "") =>
      Effect.gen(function* () {
        const issue = yield* get(id);
        if (isClosed(issue.status)) return yield* Effect.fail(refused("这张工单关上了：带一句话重开它"));
        const session = yield* liveSession(id);
        const said = yield* chat.tellSession("user", session, text, sendKey);
        // Said in its thread, the issue hears it from the message's fact (heard below); with no thread there is no fact.
        if (!said) yield* ownerSaid(id);
      });

    const merge = (id: string) =>
      prLock.withPermits(1)(
        Effect.gen(function* () {
          const issue = yield* get(id);
          // Whoever asks (the board, the command line, the manager's tool) is held to the same table: a round that
          // failed, or a required acceptance not passed, is not harvested.
          if (!issue.graph && !issue.task) {
            const [m, why] = statusMove(issue, "done");
            if (m === "none") return yield* Effect.fail(refused(why));
          }
          const session = yield* liveSession(id);
          if (issue.project && !issue.graph && !issue.task && (issue.pullRequest?.state === "open" || projects.usesPullRequests(issue.project))) {
            const merged = yield* Effect.result(sessions.submitPullRequest(session, issue, (pr) => savePullRequest(issue.id, pr)));
            if (merged._tag === "Failure") return yield* Effect.fail(yield* mergeError(session, merged.failure));
            return merged.success.text;
          }
          return yield* mergeSession(session);
        }),
      );

    const cancel = (id: string) =>
      Effect.gen(function* () {
        const session = yield* liveSession(id);
        if (!(yield* sessions.dismiss(session))) return yield* Effect.fail(missing("帮工 " + session));
      });

    // ── drafts ──

    /** Who drafts: its assignee; else whoever was last sent to work in its project, if they can work now; else chooseAgent. */
    const drafter = (t: Issue) =>
      Effect.gen(function* () {
        const candidates = yield* Effect.forEach(store.agents(), (agent) => Effect.map(runtimes.assess(agent), (a) => ({ agent, usable: usable(a) })));
        let named = "";
        if (t.assignee) {
          if (!store.agent(t.assignee)) return yield* Effect.fail(refused("帮工档案 " + t.assignee + " 不在了"));
          named = t.assignee;
        } else if (t.project) {
          const last = (yield* one(qs.lastAssigneeIn({ project: t.project })))?.assignee;
          if (last && candidates.some((c) => c.agent.id === last && c.usable)) named = last;
        }
        const chosen = chooseAgent(candidates, "起草 " + t.title, named, "");
        if (!chosen) return yield* Effect.fail(refused("没有能派的帮工来起草"));
        return chosen;
      });

    /** Before its session is sent: the owner's first word is its title, the drafter and the project are its own unless it names them, and an answer clears what it asked. */
    const beforeDraft = (t: Issue, word: string, agent: string, where: string) =>
      Effect.gen(function* () {
        let [title, description] = [t.title, t.description ?? ""];
        if (word && t.asks.length === 0 && !description && (t.criteria ?? []).length === 0) [title, description] = splitJob(word);
        yield* inTx(
          Effect.gen(function* () {
            yield* db(
              q.editIssue({
                title,
                description,
                project: nullText(t.project ?? where),
                assignee: nullText(t.assignee ?? agent),
                priority: t.priority,
                acceptance: t.acceptance,
                criteria: jsonOrNull(t.criteria, (t.criteria ?? []).length > 0),
                id: t.id,
              }),
            );
            if (word && t.asks.length > 0) yield* db(q.setIssueAsks({ id: t.id, asks: null }));
          }),
        );
        yield* publish(t.id);
      });

    const drafted = (id: string, d: IssueDraft, asks: readonly Ask[] | undefined) =>
      Effect.gen(function* () {
        const criteria = kept(d.criteria);
        const open = openAsks(asks);
        yield* db(
          q.draftIssue({
            id,
            title: d.title,
            description: draftDescription(d),
            criteria: jsonOrNull(criteria, criteria.length > 0),
            asks: jsonOrNull(open, open.length > 0),
          }),
        );
        yield* publish(id);
      });

    const draft = (id: string, word: string, channel: string) =>
      drafting.withPermits(1)(
        Effect.gen(function* () {
          const t = yield* unsent(id);
          if (isForManager(t)) return yield* Effect.fail(refused("这是派给管家的工单：管家自己会看"));
          if (t.status !== "backlog") return yield* Effect.fail(refused("只有备选里的工单能起草：先挪回备选"));
          if (t.drafting) return yield* Effect.fail(refused(t.drafting.name + " 正在起草：等它交回来"));
          const chosen = yield* drafter(t);
          const where = t.project ?? (chosen.workdir ?? "").trim();
          if (!where) return yield* Effect.fail(refused("没说在哪个项目里做：先选一个项目"));
          const said = word.trim();
          const brief = draftBrief(t, said, where);
          yield* beforeDraft(t, said, chosen.id, where);
          // A draft cut short (a restart) may have left the worktree as its drafter had it: each draft starts from main.
          const kept = yield* projects.clear(where, t.number);
          if (kept) yield* Effect.logInfo(`vibevalley: issue ${t.id}: before its draft: ${kept}`);
          // Always a worktree, even for a profile that works in the project folder: the reset after it must not touch the owner's checkout.
          const hired = yield* hire(chosen, brief, where, { worktree: true, channel, issue: id, trigger: { kind: "draft" }, draft: true });
          if (!hired.session) return yield* Effect.fail(refused(hired.refused ?? "派不出去"));
          // Its moves no longer hold todo while it drafts.
          yield* publish(id);
          return yield* get(id);
        }),
      );

    /** A draft's session reported: what it hands back is written into the issue, or the thread says why not; then its worktree goes back to main and it leaves. */
    const handedBack = (f: { id: string; outcome: string; summary: string; asks?: readonly Ask[] }) =>
      Effect.gen(function* () {
        const h = core.session(f.id);
        if (!h?.draft || !h.issue) return;
        const id = h.issue;
        const r = sessions.find(f.id);
        const said = r?.lastText ?? "";
        const place: Workplace | undefined = r?.place;
        const thread = yield* chat.jobThread(f.id);
        const tell = (text: string) => (thread ? chat.notice(thread, text, "issue_draft") : core.notice("warn", text));
        if (f.outcome === "completed") {
          const { draft: d, problem } = parseDraft(said);
          if (!d) yield* tell(`${h.name} 交回来的草稿读不出来（${problem}），工单没动：再起草一次`);
          else yield* drafted(id, d, f.asks);
        } else yield* tell(`${h.name} 没起草完（${f.summary}），工单没动：再起草一次`);
        if (place?.branch) {
          const reset = yield* Effect.result(projects.reset(place));
          if (reset._tag === "Failure") yield* core.notice("warn", `起草的 worktree 没能重置：${reset.failure.message}`);
        }
        yield* sessions.dismiss(f.id);
        yield* publish(id);
      });

    /** An unsent issue going away takes its draft with it: whoever drafts it goes home, and what drafts left is removed. */
    const clearDraft = (t: Issue) =>
      Effect.gen(function* () {
        if (t.drafting) {
          const r = sessions.find(t.drafting.session);
          if (r?.place.branch) yield* Effect.ignore(projects.reset(r.place));
          yield* sessions.dismiss(t.drafting.session);
        }
        if (t.project) {
          const kept = yield* projects.clear(t.project, t.number);
          if (kept) yield* core.notice("warn", `「${cut(t.title, 40)}」取消了：${kept}`);
        }
      });

    // ── pull requests ──

    const finishPullRequest = (issue: Issue, state: PullRequestState) =>
      Effect.gen(function* () {
        const closed: IssueClose = state === "closed" ? "dismissed" : "merged";
        const id = yield* latest(issue.id);
        if (sessions.find(id))
          yield* sessions.finishPullRequest(id, issue.number, closed).pipe(Effect.mapError((e) => (e instanceof MergeFailure ? refused(e.reasonText) : e)));
        else yield* projects.finishPullRequest(issue.project!, issue.number).pipe(Effect.mapError((e) => refused(e.message)));
        yield* inTx(
          Effect.andThen(
            db(q.closeIssue({ id: issue.id, closed, closed_at: Date.now() })),
            db(q.setIssuePullRequest({ id: issue.id, pull_request: JSON.stringify({ ...issue.pullRequest, state }) })),
          ),
        );
        yield* publish(issue.id);
      });

    const refreshPullRequests = prLock.withPermits(1)(
      Effect.gen(function* () {
        for (const issue of yield* list) {
          if (issue.pullRequest?.state !== "open" || !issue.project) continue;
          const state = yield* Effect.result(projects.pullRequestState(issue.project, issue.pullRequest.number));
          const done = state._tag === "Failure" ? state : state.success === "open" ? undefined : yield* Effect.result(finishPullRequest(issue, state.success));
          if (done?._tag === "Failure")
            yield* Effect.logWarning(
              `vibevalley: refresh pull requests: 工单 #${issue.number}: ${done.failure instanceof Error ? done.failure.message : reasonOf(done.failure)}`,
            );
        }
      }),
    );

    // ── what happens to its sessions ──

    const onFact = (e: { type: string } & Record<string, unknown>) =>
      Effect.gen(function* () {
        if (e.type === "left") {
          const issue = (yield* one(qs.issueOfSession({ session: e.id as string })))?.issue;
          if (!issue) return;
          const row = yield* one(q.getIssue({ id: issue }));
          if (!row || row.graph !== null || row.task !== null) return;
          const runs = (yield* db(qs.sessionsOf({ issue }))).map((r) => r.session);
          if (runs.at(-1) !== e.id) return;
          yield* db(q.closeIssue({ closed_at: Date.now(), closed: (e.closed as string | undefined) ?? null, id: issue }));
          yield* publish(issue);
        } else if (e.type === "report") {
          const issue = (yield* one(qs.issueOfSession({ session: e.id as string })))?.issue;
          // A report's 要问主人： lines are what its issue waits on the owner for; a report without them clears them.
          const checks = (e.checks as CriterionCheck[] | undefined) ?? [];
          if (issue && checks.length > 0) yield* checked(issue, checks);
          if (issue) yield* asked(issue, e.asks as Ask[] | undefined);
          yield* handedBack(e as never);
          if (core.session(e.id as string)?.conflict) yield* recheck(e.id as string);
        } else if (e.type === "message") {
          // Whatever path an owner's word took into an issue's thread, this is where the issue hears it.
          const m = e.message as { fromKind: string; kind: string; final: boolean };
          if (!e.thread || m.fromKind !== "user" || m.kind !== "chat" || !m.final) return;
          const issue = yield* Effect.option(get(e.thread as string));
          if (Option.isNone(issue) || isClosed(issue.value.status)) return;
          yield* ownerSaid(issue.value.id);
        }
      });

    // ── coming back ──

    const rows = yield* db(q.keptIssues({ closed: keepClosedIssues }));
    const kept0 = runsBy(yield* db(qs.sessionsOfKept({ closed: keepClosedIssues })));
    for (const row of rows) yield* core.apply({ type: "issue", issue: issueOf(row, kept0.get(row.id)) });
    // The manager's turn on its issues stopped with the server; one it had answered still waits on the owner.
    for (const r of yield* db(q.openOf({ assignee: managerAgent }))) if (r.handed_back === null) yield* closeAs(r.id, "lost");

    const facts = yield* core.subscribe;
    const finished = yield* sessions.finishedRuns;
    const due = yield* schedules.due;
    const logged =
      (what: string) =>
      <A, E>(e: Effect.Effect<A, E>) =>
        Effect.asVoid(e).pipe(Effect.catchCause((c) => Effect.logWarning(`vibevalley: ${what}: ${String(c)}`)));
    yield* Effect.forkScoped(Stream.runForEach(facts, (e) => onFact(e as never).pipe(logged(`issues after a ${e.type}`))));
    yield* Effect.forkScoped(
      // However the manager's turn ended, the issue waits on the owner: a turn that did not fail is not an answer yet.
      Stream.runForEach(finished, (run) =>
        Effect.forEach(run.issues, (id) => handBack(id, { at: Date.now(), outcome: run.outcome }).pipe(logged(`run ${run.id} finished on issue ${id}`)), {
          discard: true,
        }),
      ),
    );
    yield* Effect.forkScoped(Stream.runForEach(due, (d) => scheduled(d).pipe(logged(`schedule ${d.schedule.id}`))));
    if (options.background ?? true) {
      yield* Effect.forkScoped(Effect.forever(Effect.andThen(Effect.sleep(options.tryEveryMs ?? 5000), tryQueued.pipe(logged("the queue")))));
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.andThen(
            Effect.sleep(config.github.prPollSeconds > 0 ? config.github.prPollSeconds * 1000 : 180_000),
            refreshPullRequests.pipe(logged("refresh pull requests")),
          ),
        ),
      );
    }

    const timeline = (id: string) =>
      Effect.gen(function* () {
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
      list: () => list,
      get,
      timeline,
      add: (req) => add(req),
      /** The words and who does it only before it is sent; how it is accepted while it is open. */
      edit: (id, upd) =>
        Effect.gen(function* () {
          const wordsOnly =
            upd.title === undefined &&
            upd.description === undefined &&
            upd.project === undefined &&
            upd.assignee === undefined &&
            upd.priority === undefined &&
            upd.criteria === undefined;
          let was: Issue;
          if (wordsOnly) {
            was = yield* get(id);
            if (isClosed(was.status)) return yield* Effect.fail(refused("这张工单关上了"));
          } else was = yield* unsent(id);
          const [title, description] = yield* issueWords({ title: upd.title ?? was.title, description: upd.description ?? was.description ?? "" });
          const criteria = upd.criteria !== undefined ? kept(upd.criteria) : (was.criteria ?? []);
          yield* db(
            q.editIssue({
              title,
              description,
              project: nullText(upd.project ?? was.project),
              assignee: nullText(upd.assignee ?? was.assignee),
              priority: upd.priority ?? was.priority,
              acceptance: upd.acceptance || was.acceptance || "glance",
              criteria: jsonOrNull(criteria, criteria.length > 0),
              id,
            }),
          );
          yield* publish(id);
          return yield* get(id);
        }),
      remove: (id) =>
        Effect.gen(function* () {
          const t = yield* unsent(id);
          yield* clearDraft(t);
          yield* db(q.removeIssue({ id }));
          yield* core.apply({ type: "issueGone", id } as never);
        }),
      move: (id, before) =>
        Effect.gen(function* () {
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
      dispatchQueued: (id) =>
        trying.withPermits(1)(
          Effect.gen(function* () {
            const issue = yield* get(id);
            if (issue.status !== "todo" || issue.queuedAt === undefined || issue.graph || issue.task || isForManager(issue))
              return yield* Effect.fail(refused("只有排着队的待办能从这里开工"));
            const [, agent, project] = yield* ready(id);
            const full = sessions.noRoom(agent.runtime, project);
            if (full) return { queued: full + "：还在排队，有空地就自动开工" };
            return yield* start(id, "");
          }),
        ),
      reopen: (id, text, channel) => reopen(id, text, channel),
      setStatus: (id, to, text, channel) =>
        Effect.gen(function* () {
          if (!(IssueStatusValues as readonly string[]).includes(to)) return yield* Effect.fail(refused("没有这个状态：" + to));
          const t = yield* get(id);
          const [m, why] = statusMove(t, to);
          const said = text.trim();
          switch (m) {
            case "none":
              return yield* Effect.fail(refused(why));
            case "start":
              yield* start(id, channel);
              break;
            case "unqueue":
              yield* queueRow(id, false, chat.general());
              break;
            case "round":
              if (!said) return yield* Effect.fail(refused("再干一轮要说一句：这一轮要它做什么"));
              yield* comment(id, said);
              break;
            case "reopen":
              yield* reopen(id, said, channel);
              break;
            case "revive":
              yield* reopenRow(id);
              break;
            // The session's leaving closes the issue too, but later: closed here, the answer already says so.
            case "merge": {
              yield* merge(id);
              const updated = yield* get(id);
              if (updated.pullRequest?.state !== "open") yield* closeAs(id, "merged");
              break;
            }
            case "cancel":
              yield* cancel(id);
              yield* closeAs(id, "dismissed");
              break;
            case "drop":
              yield* clearDraft(t);
              yield* drop(id);
              break;
            case "answered":
              yield* closeAs(id, "answered");
              break;
            case "putAway":
              yield* closeAs(id, "dismissed");
              break;
          }
          return yield* get(id);
        }),
      comment,
      changes: (id, by) =>
        Effect.gen(function* () {
          const session = yield* liveSession(id);
          const changes = yield* sessionChanges(session);
          if (!changes) return yield* Effect.fail(missing("帮工 " + session));
          if (by === "owner") yield* core.did({ kind: "reviewed", session });
          return changes;
        }),
      merge,
      /** The owner asks the session to settle its conflicts: the ones the farm marked on it, else the ones merging would meet now. */
      resolve: (id) =>
        Effect.gen(function* () {
          const session = yield* liveSession(id);
          const h = core.session(session);
          if (!h) return yield* Effect.fail(missing("帮工 " + session));
          // A preview that fails (git broken) is said as it is, not taken for no conflict.
          const changes = h.conflict ? undefined : yield* sessionChanges(session);
          const conflict = h.conflict ?? (changes ? conflictOf(changes) : undefined);
          if (!conflict) return yield* Effect.fail(refused(h.name + " 和主分支没有冲突"));
          yield* chat.tellSession("user", session, conflictBrief(conflict.base, conflict.files), "");
        }),
      cancel,
      /** Only an issue in review has something to judge. */
      accept: (id, req) =>
        Effect.gen(function* () {
          const t = yield* get(id);
          const why = isForManager(t)
            ? "这是派给管家的工单：管家答完就关"
            : t.graph || t.task
              ? "这是种植计划的工单，跟着计划走：在计划里验收"
              : t.status !== "in_review"
                ? "还没交回来，没有东西可验收"
                : "";
          if (why) return yield* Effect.fail(refused(why));
          if (req.pass) {
            yield* judged(
              id,
              Date.now(),
              t.findings.map((f) => ({ ...f, pulled: true })),
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
      draft,
      /** Every issue with its sessions, live and ended, once; a session with no record is named as missing, not given a phase. */
      history: () =>
        Effect.gen(function* () {
          const all = yield* list;
          const byId = new Map((yield* sessions.list("")).map((s) => [s.id, s]));
          return all.map((issue) => ({
            issue,
            sessions: issue.sessions.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])),
            missingSessions: issue.sessions.filter((id) => !byId.has(id)),
          }));
        }),
      templates: (name) =>
        Effect.gen(function* () {
          const stack = yield* projects.stack(name);
          if (!stack) return yield* Effect.fail(missing("项目 " + name));
          return { project: name, stack, recent: sentTitles(yield* list, name), kinds: filledKinds(templateCatalog(), stack) };
        }),
      hire,
      ran,
      putTask: (graph) =>
        Effect.gen(function* () {
          const family = (id: string) =>
            Effect.gen(function* () {
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
                    closed: t.closed ?? null,
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
      forManager: Effect.map(PubSub.subscribe(managerHub), Stream.fromSubscription),
      ofSchedule,
      refreshPullRequests,
      tryQueued,
    };
    return shape;
  });

export const layer = (options?: IssueOptions) => Layer.effect(Issues, make(options));
