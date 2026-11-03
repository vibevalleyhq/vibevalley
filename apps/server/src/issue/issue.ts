import { Clock, Context, Effect, Layer, Option, Schedule, Semaphore, Stream } from "effect";

import { dagIDValid, dagProblems } from "@vibevalley/agent/dag";
import { list, t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { IssueStatusValues } from "@vibevalley/protocol";
import { commandOf } from "@vibevalley/protocol/api";
import {
  assignmentOf,
  assignedAgentOf,
  closedText,
  cut,
  executionsOf,
  isBusy,
  isOneOf,
  latestSessionIdOf,
  sessionIdsOf,
  shortTitle,
} from "@vibevalley/protocol/rules";
import { issueId } from "@vibevalley/protocol/schema";

import { Agent } from "@/agent/agent.ts";
import { templateCatalog } from "@/agent/seed.ts";
import { actsForOwner, type Actor } from "@/base/actor.ts";
import { newId } from "@/base/ids.ts";
import { Channel } from "@/channel/channel.ts";
import { Core } from "@/core/core.ts";
import type { Due } from "@/cron/cron.ts";
import { type ApiError, Inconsistent, missing, lookIn, reasonOf, refused } from "@/errors.ts";
import { ServerConfig } from "@/infra/config.ts";
import { causeMessage, Db } from "@/infra/db.ts";
import { bestEffort } from "@/infra/log.ts";
import { Mailbox } from "@/mailbox/mailbox.ts";
import { issueBranch, Project } from "@/project/project.ts";
import { MergeFailure, type Workplace } from "@/project/workplace.ts";
import { Runtime } from "@/runtime/runtime.ts";
import { conflictBrief } from "@/session/briefing.ts";
import { askedMax } from "@/session/journal.ts";
import { type Hired, type HireOptions, NotRecorded, type SessionNews, Session } from "@/session/session.ts";

import * as q from "../../db/generated/issue.sql.ts";
import * as qs from "../../db/generated/issue_assignment.sql.ts";
import * as qe from "../../db/generated/issue_assignment_execution.sql.ts";
import { assignTo, Assignments } from "./assignment.ts";
import { answerCureWords, cureWords, findingsOf, issueBrief, milestonesOf, resumeWords, splitBrief } from "./brief.ts";
import { explicitMandate, filledKinds, inferredMandate, issueRow, maxChildren, sentTitles } from "./creation.ts";
import { acceptanceAncestors, blockedIssues, dependencyProblems } from "./dependencies.ts";
import { merging, verifyChild } from "./merge.ts";
import { nextSteps, statusMove } from "./moves.ts";
import { workConstraints, needsOwner } from "./prompts.ts";
import { kept, openQuestions, refinement } from "./refinement.ts";
import { issueRows, jsonOrNull, nullText } from "./rows.ts";
import { conflictOf, isClosed, isForOrchestrator, issueOrder, keepClosedIssues, pickIssues } from "./status.ts";

export class Issue extends Context.Service<
  Issue,
  {
    readonly list: () => Effect.Effect<T.Issue[]>;
    /** The board's issues a filter picks (issue.list). */
    readonly query: (f: T.IssueFilter) => Effect.Effect<T.Issue[]>;
    /** The issues the board holds now (open, and the latest closed). */
    readonly onBoard: () => readonly T.Issue[];
    readonly get: (id: string) => Effect.Effect<T.Issue, ApiError>;
    readonly add: (req: T.IssueRequest, mandate: T.IssueMandate) => Effect.Effect<T.Issue, ApiError>;
    /** On the owner's word only (actsForOwner). */
    readonly edit: (id: string, upd: T.IssueUpdate, by: Actor) => Effect.Effect<T.Issue, ApiError>;
    readonly remove: (id: string) => Effect.Effect<void, ApiError>;
    readonly start: (id: string, channel: string) => Effect.Effect<Dispatched, ApiError>;
    readonly scheduled: (due: Due, input: T.Trigger) => Effect.Effect<T.Issue, ApiError>;
    readonly split: (id: string, title: string, drafts: readonly T.IssueChildDraft[], by: Actor) => Effect.Effect<string, ApiError>;
    /** agent: moving to todo, the profile (id or name) that takes it on; another than its own hands it over. On the owner's
     * word only (actsForOwner). */
    readonly setStatus: (id: string, to: T.IssueStatus, text: string, channel: string, by: Actor, opt?: StatusOptions) => Effect.Effect<T.Issue, ApiError>;
    /** Stops the turn of the session working it; the session stays, and a word starts the next. */
    readonly stop: (id: string) => Effect.Effect<void, ApiError>;
    /** What setStatus would do with the same request, refused as it would be; nothing changes. edit: the owner's unsaved
     * fields, as the move would see them once saved. */
    readonly previewStatus: (id: string, to: T.IssueStatus, text: string, opt?: StatusOptions, edit?: T.IssueUpdate) => Effect.Effect<T.Preview, ApiError>;
    /** What remove would do, refused as it would be; nothing changes. */
    readonly previewRemove: (id: string) => Effect.Effect<T.Preview, ApiError>;
    /** An issue's id from what the owner and the orchestrator call it: #41 or 41, its id, or the id of a session that worked it. */
    readonly idOf: (ref: string) => Effect.Effect<string, ApiError>;
    readonly comment: (id: string, text: string, sendKey?: string) => Effect.Effect<void, ApiError>;
    /** The owner's look counts for the game; anyone else's does not. */
    readonly changes: (id: string, by: Actor) => Effect.Effect<T.Changes, ApiError>;
    readonly review: (id: string, req: IssueReviewRequest) => Effect.Effect<T.Issue, ApiError>;
    readonly refine: (id: string, word: string, channel: string) => Effect.Effect<T.Issue, ApiError>;
    readonly history: () => Effect.Effect<T.IssueHistory[]>;
    readonly timeline: (id: string) => Effect.Effect<T.IssueTimeline, ApiError>;
    readonly templates: (project: string) => Effect.Effect<T.ProjectTemplates, ApiError>;
    /** Sends a session for work that is not written down first (the orchestrator sending someone at once, a task's step): its issue is made from the brief. */
    readonly hire: (agent: T.Agent, brief: string, project: string, opt?: HireOptions) => Effect.Effect<Hired>;
    readonly refreshPullRequests: Effect.Effect<void>;
    readonly refreshQueue: Effect.Effect<void>;
    readonly submitPullRequest: (session: string, summary?: string) => Effect.Effect<string, ApiError>;
  }
>()("vibevalley/Issue") {
  static readonly layer = Layer.effect(
    Issue,
    Effect.suspend(() => make),
  );
}

interface StatusOptions {
  /** Moving to todo: the profile that takes it on (a name or an id). */
  readonly agent?: string;
}

/** What starting an issue came to: the session sent, or why it waits in the queue. */
interface Dispatched {
  readonly session?: T.SessionId;
  readonly queued?: string;
}

/** A verdict on what was handed back: passed, or not, with the findings (or words) it is mended by. */
export interface IssueReviewRequest {
  readonly pass: boolean;
  readonly findings?: readonly string[];
  readonly text?: string;
}

/** Only while the issue is still open: a completion the owner chose (kept, none) is written before its session leaves,
 * and a child issue merges into its parent, so it does not merge into main here. */
const closingOf = (closed: T.SessionClose | undefined): { delivered: T.Delivery } | { canceled: T.IssueCanceled } =>
  closed === "merged" ? { delivered: "merged" } : closed === "completed" ? { delivered: "none" } : { canceled: closed === "lost" ? "lost" : "dismissed" };

function reopenBrief(issue: T.Issue, last: T.Session, text: string, previous: boolean, handedOver = false): string {
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

function failedText(findings: readonly T.Finding[], text: string): string {
  let out = t("server.issue.brief.failedHead");
  let n = 0;
  for (const f of findings) if (!f.resolved) out += `\n${++n}. ${f.text}`;
  if (text) out += "\n\n" + text;
  return out + t("server.issue.brief.failedEnd");
}

const make = Effect.gen(function* () {
  const clock = yield* Clock.Clock;
  const core = yield* Core;
  const store = yield* Agent;
  const projects = yield* Project;
  const runtimes = yield* Runtime;
  const sessions = yield* Session;
  const chat = yield* Channel;
  const mailbox = yield* Mailbox;
  const db = yield* Db;
  const worked = new Assignments();
  /** After an issue is removed: its sessions' rows went with it, and its children's. */
  const reloadAssignments = db.inTx(
    Effect.gen(function* () {
      const rows = yield* db.run(qs.allAssignments());
      const executions = yield* db.run(qe.allExecutions());
      worked.load(rows, executions);
    }),
  );
  yield* reloadAssignments;
  /** One round of the queue at a time. */
  const trying = yield* Semaphore.make(1);

  const issueOf = issueRows(core);

  const everyIssue = Effect.gen(function* () {
    const rows = yield* db.run(q.listIssues());
    return rows.map((r) => issueOf(r, worked.of(r.id))).toSorted(issueOrder);
  });

  const idOf = Effect.fn("Issue.idOf")(function* (ref: string): Effect.fn.Return<string, ApiError> {
    const r = ref.trim();
    const number = /^#?(\d+)$/u.exec(r)?.[1];
    if (number !== undefined) {
      const row = yield* db.one(q.issueByNumber({ number: Number(number) }));
      if (!row) return yield* Effect.fail(missing(t("server.issue.issueNumbered", { n: number }), [lookIn.issue]));
      return row.id;
    }
    return worked.issueOf(r) ?? r;
  });

  const get = Effect.fn("Issue.get")(function* (ref: string): Effect.fn.Return<T.Issue, ApiError> {
    const issue = yield* idOf(ref);
    const row = yield* db.one(q.getIssue({ id: issue }));
    if (!row) return yield* Effect.fail(missing(t("server.issue.issueRef", { ref }), [lookIn.issue]));
    return issueOf(row, worked.of(issue));
  });

  const publish = (id: string) =>
    get(id).pipe(
      Effect.flatMap((issue) => core.apply({ type: "issue", issue })),
      bestEffort(`vibevalley: issue ${id} changed but could not be read back for the board`),
    );

  /** The newest session, the one a merge, changes, comments and cancel act on; a reopen makes another. */
  const latest = (id: string) =>
    Effect.flatMap(get(id), (issue) => {
      const last = latestSessionIdOf(issue);
      return last === undefined ? Effect.fail(refused(t("server.issue.notStarted"))) : Effect.succeed(last);
    });

  const unsent = (id: string) =>
    Effect.filterOrFail(
      get(id),
      (issue) => executionsOf(issue).length === 0,
      () => refused(t("server.issue.started")),
    );

  const liveSession = (id: string) =>
    Effect.filterOrFail(
      latest(id),
      (session) => sessions.present(session),
      (session) => missing(t("server.issue.helperRef", { id: session }), [lookIn.session]),
    );

  const issueWords = (req: Pick<T.IssueRequest, "title" | "description">) => {
    const [title, rest] = splitBrief(req.title);
    if (!title) return Effect.fail(refused(t("server.issue.noTitle")));
    let description = (req.description ?? "").trim();
    if (rest) description = (rest + "\n\n" + description).trim();
    return Effect.succeed([title, description] as const);
  };

  /** add, with the database refusing the row kept as a failure: hire tells it to the owner. */
  const attemptAdd = Effect.fn("Issue.attemptAdd")(function* (req: T.IssueRequest, mandate: T.IssueMandate, cron?: string) {
    const [title, description] = yield* issueWords(req);
    if (req.constraints?.acceptance === true && !req.constraints.check?.trim())
      return yield* Effect.fail(refused(t("server.issue.verification.acceptanceNeedsCheck")));
    const id = newId();
    const parent = req.parent ? yield* get(req.parent) : undefined;
    if (parent && isClosed(parent.status)) return yield* Effect.fail(refused(t("server.issue.dependencies.closedParent")));
    const project = req.project ?? parent?.project;
    if (parent && project !== parent.project) return yield* Effect.fail(refused(t("server.issue.dependencies.project")));
    const blockedBy = [...new Set(req.blockedBy ?? [])];
    if (parent || blockedBy.length > 0) {
      const all = yield* everyIssue;
      if (dependencyProblems([...all, { id: issueId(id), blockedBy, ...(parent ? { parent: parent.id } : {}) }]).length > 0)
        return yield* Effect.fail(refused(t("server.issue.dependencies.invalid")));
    }
    const at = yield* Clock.currentTimeMillis;
    const assignment = yield* db.attemptTx(
      Effect.gen(function* () {
        yield* q.addIssue(
          issueRow(
            id,
            {
              ...req,
              title,
              description,
              blockedBy,
              ...(project ? { project } : {}),
              ...(parent ? { parent: parent.id } : {}),
              deliver: req.deliver ?? (store.isOrchestrator(req.agent ?? "") ? "answer" : "change"),
            },
            mandate,
            at,
            cron,
          ),
        );
        return yield* assignTo(id, req.agent ?? (parent ? assignedAgentOf(parent) : undefined), at);
      }),
    );
    worked.changed(assignment.changed);
    yield* publish(id);
    return yield* get(id);
  });

  const add = (req: T.IssueRequest, mandate: T.IssueMandate, cron?: string) =>
    attemptAdd(req, mandate, cron).pipe(Effect.catchTags({ SqlError: Effect.die, SchemaError: Effect.die }));

  const complete = (id: string, delivered: T.Delivery) =>
    Effect.andThen(db.run(q.completeIssue({ closed_at: clock.currentTimeMillisUnsafe(), delivered, id })), publish(id));
  const cancelAs = (id: string, canceled: T.IssueCanceled) =>
    Effect.andThen(db.run(q.cancelIssue({ closed_at: clock.currentTimeMillisUnsafe(), canceled, id })), publish(id));

  const endRun = Effect.fn("Issue.endRun")(function* (id: string) {
    const item = yield* get(id);
    if (isClosed(item.status)) return;
    yield* publish(id);
  });

  const changesOf = Effect.fn("Issue.changesOf")(function* (item: T.Issue) {
    const session = latestSessionIdOf(item);
    if (session && sessions.present(session))
      return yield* sessions.withWorkplace(session, (place) => projects.changes(place).pipe(Effect.mapError((error) => refused(error.message))));
    return item.project
      ? yield* projects.branchChanges(item.project, issueBranch(item.number)).pipe(Effect.mapError((error) => refused(error.message)))
      : undefined;
  });

  const setConflict = Effect.fn("Issue.setConflict")(function* (id: string, conflict: T.Conflict | undefined) {
    const row = yield* db.one(q.getIssue({ id }));
    if (!row) return;
    const stored = conflict ? JSON.stringify(conflict) : null;
    if (row.conflict === stored) return;
    yield* db.run(q.setIssueConflict({ id, conflict: stored }));
    yield* publish(id);
  });

  const reopenRow = (id: string) => Effect.andThen(db.run(q.reopenIssue({ id })), publish(id));

  /** What the session waits on the owner for, from its report; a report with none, or a comment, clears them. */
  const asked = (id: string, questions: readonly T.Question[] | undefined) =>
    Effect.andThen(db.run(q.setIssueQuestions({ id, questions: jsonOrNull(openQuestions(questions), openQuestions(questions).length > 0) })), publish(id));

  /** An answer issue's round: one that got through gives its conclusion (none readable leaves the issue stuck on it); whatever it changed goes, so the issue never delivers a change. */
  const answered = Effect.fn("Issue.answered")(function* (id: string, session: string, outcome: T.Outcome, answer: T.IssueAnswer | undefined) {
    const item = yield* get(id);
    if (item.deliver !== "answer" || latestSessionIdOf(item) !== session) return;
    if (outcome === "completed") yield* db.run(q.setIssueAnswer({ id, answer: jsonOrNull(answer, answer !== undefined) }));
    yield* sessions.discardWork(session);
    yield* publish(id);
  });

  /** at 0 is not accepted (a fail, or another round started); the findings are written as they stand. */
  const judged = (id: string, at: number, findings: readonly T.Finding[]) =>
    Effect.andThen(db.run(q.reviewIssue({ id, reviewed_at: at > 0 ? at : null, findings: jsonOrNull(findings, findings.length > 0) })), publish(id));

  /** The owner's word answers what it asked, and starts a round that the last acceptance did not see. */
  const ownerSaid = Effect.fn("Issue.ownerSaid")(function* (id: string) {
    yield* asked(id, []);
    const item = yield* get(id);
    if (item.reviewedAt !== undefined) yield* judged(id, 0, item.findings);
  });

  const retireDispatches = (id: string, at: number) => mailbox.retireDispatches(id, at);

  /** The issue already owns its number and workplace before its session starts. */
  const ran = Effect.fn("Issue.ran")(function* (id: string, session: T.Session) {
    const linked = yield* db
      .attemptTx(
        Effect.gen(function* () {
          yield* q.reopenIssue({ id });
          const assignment = yield* assignTo(id, session.agent, session.hiredAt);
          if (!assignment.assigned) return yield* Effect.die(new Inconsistent({ message: "a session's profile must own its assignment" }));
          const execution = yield* qe.addExecution({
            assignment: assignment.assigned.id,
            executor: session.id,
            started_at: session.hiredAt,
          });
          yield* retireDispatches(id, session.hiredAt);
          return { assignment, execution };
        }),
      )
      .pipe(Effect.mapError((cause) => new NotRecorded({ message: causeMessage(cause), cause })));
    worked.changed(linked.assignment.changed);
    worked.executed(id, linked.execution);
    yield* publish(id);
  });

  const queueRow = Effect.fn("Issue.queueRow")(function* (id: string, queued: boolean, channel: string, by?: T.RunTrigger, source?: T.Trigger) {
    const item = yield* unsent(id);
    const at = yield* Clock.currentTimeMillis;
    let dispatch: T.Trigger | undefined;
    yield* db.inTx(
      Effect.gen(function* () {
        if (!queued) {
          yield* retireDispatches(id, at);
          yield* db.run(q.unqueueIssue({ id }));
          return;
        }
        const changed = yield* db.run(q.queueIssue({ at, id }));
        if (changed.length > 0 && !source)
          dispatch = yield* mailbox.recordTrigger({
            source: "workbench",
            key: newId(),
            actor: { kind: "system", id: "system" },
            text: issueBrief(item),
            threads: [`issue:${id}`],
            addressed: "thread_owner",
            replyChannel: channel,
            meta: { ingressRecipient: assignedAgentOf(item) ?? "", issue: id, trigger: by ?? { kind: "issue" }, dispatch: true },
            at,
          });
      }),
    );
    if (dispatch) yield* mailbox.receive(dispatch).pipe(bestEffort(`issue: route ${dispatch.id}`));
    yield* publish(id);
    return yield* get(id);
  });

  const drop = Effect.fn("Issue.drop")(function* (id: string) {
    yield* unsent(id);
    yield* db.inTx(
      Effect.all(
        [
          retireDispatches(id, yield* Clock.currentTimeMillis),
          db.run(q.unqueueIssue({ id })),
          db.run(q.cancelIssue({ closed_at: yield* Clock.currentTimeMillis, canceled: "dismissed", id })),
        ],
        {
          discard: true,
        },
      ),
    );
    yield* publish(id);
  });

  const hire = Effect.fn("Issue.hire")(function* (agent: T.Agent, brief: string, project: string, opt: HireOptions = {}) {
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
      opt.issue
        ? get(opt.issue)
        : attemptAdd({ title: brief, project: where, agent: agent.id }, explicitMandate()).pipe(
            // The database failing (a full disk) is told as a refusal; a request it cannot encode is a bug.
            Effect.catchTags({ SqlError: (e) => Effect.fail(refused(causeMessage(e))), SchemaError: Effect.die }),
          ),
    );
    if (prepared._tag === "Failure") return { refused: t("server.issue.notRecorded", { name: agent.name, why: reasonOf(prepared.failure) }) };
    const issue = prepared.success;
    const all = yield* everyIssue;
    const blocked = blockedIssues(issue, all);
    if (blocked.length > 0) return { refused: t("server.issue.dependencies.waiting", { issues: list(blocked) }) };
    const parent = issue.parent ? yield* Effect.option(get(issue.parent)) : Option.none();
    const base = opt.base ?? (Option.isSome(parent) ? issueBranch(parent.value.number) : undefined);
    if (Option.isSome(parent)) {
      const place = yield* Effect.result(projects.workplace(where, parent.value.number, true, ""));
      if (place._tag === "Failure") return { refused: place.failure.message };
    }
    // A draft's session is not one of the issue's sessions: the issue stays unsent.
    const constraints = workConstraints(
      issue.constraints,
      acceptanceAncestors(issue, all).flatMap((item) => item.constraints?.frozen ?? []),
    );
    const hired = yield* sessions.send(agent, [brief, constraints].filter(Boolean).join("\n\n"), where, {
      ...opt,
      ...(base ? { base, worktree: true } : {}),
      context: { kind: "issue", issue },
      hiring: (w: T.Session, launch: string) =>
        Effect.gen(function* () {
          if (opt.refining !== true) yield* ran(issue.id, w);
          if (opt.hiring) yield* opt.hiring(w, launch);
        }),
    });
    if (!hired.session && !opt.issue && !hired.retainedWork) {
      yield* db.run(q.removeIssue({ id: issue.id }));
      yield* reloadAssignments;
      yield* core.apply({ type: "issueGone", id: issue.id });
    }
    if (hired.retainedWork) return { ...hired, refused: t("server.issue.workKept", { refused: hired.refused ?? "", n: issue.number }) };
    return hired.session && evicted ? { ...hired, evicted } : hired;
  });

  /** Starting it and its dry run ask the same, so neither refuses what the other allows. */
  const readyOf = Effect.fn("Issue.readyOf")(function* (issue: T.Issue, assignedAgent: string | undefined = assignedAgentOf(issue)) {
    if (issue.refining) return yield* Effect.fail(refused(t("server.issue.drafting", { name: issue.refining.name })));
    const pick = [lookIn.agent, { say: t("server.issue.pickHint", { command: commandOf("issue.status.update", [String(issue.number)]).join(" ") }) }];
    if (!assignedAgent) return yield* Effect.fail(refused(t("server.issue.noAssignee"), pick));
    const agent = store.agent(assignedAgent);
    if (!agent) return yield* Effect.fail(refused(t("server.issue.profileGone", { id: assignedAgent }), pick));
    return [issue, agent, issue.project ?? agent.workdir] as const;
  });

  const ready = (id: string) => Effect.flatMap(unsent(id), readyOf);

  const send = (
    issue: T.Issue,
    agent: T.Agent,
    project: string,
    channel: string,
    by?: T.RunTrigger,
    inputs: readonly T.Trigger[] = [],
    hiring: ((s: T.Session, launch: string) => Effect.Effect<void, NotRecorded>) | undefined = inputs.length > 0
      ? (s, launch) => mailbox.registerInitialInputs(s, launch, inputs)
      : undefined,
  ) =>
    Effect.flatMap(
      hire(agent, issueBrief(issue), project, { channel, issue: issue.id, inputs, ...(by ? { trigger: by } : {}), ...(hiring ? { hiring } : {}) }),
      (hired) => (hired.session ? Effect.succeed(hired.session.id) : Effect.fail(refused(hired.refused ?? t("server.issue.sendFailed")))),
    );

  /** Its run starts as it is handed over: the issue is in progress until the run ends on it (endRun). */
  const beginOrchestrator = Effect.fn("Issue.beginOrchestrator")(function* (
    issue: T.Issue,
    channel: string,
    input?: { readonly text: string; readonly by: T.RunTrigger },
  ) {
    const agent = assignedAgentOf(issue) || chat.orchestratorOf((yield* chat.topOf(channel)).id);
    if (!sessions.sessionOf(agent)) {
      const profile = store.agent(agent);
      if (!profile) return yield* Effect.fail(refused(t("server.issue.profileGone", { id: agent })));
      yield* sessions
        .register({ id: profile.id, agent: profile.id, name: profile.name, role: profile.role, runtime: profile.runtime, brief: profile.duty })
        .pipe(Effect.mapError((error) => refused(error.message)));
    }
    const assignedAt = yield* Clock.currentTimeMillis;
    let dispatch: T.Trigger | undefined;
    const linked = yield* db.run(
      db.attemptTx(
        Effect.gen(function* () {
          if (isClosed(issue.status)) yield* q.reopenIssue({ id: issue.id });
          yield* q.queueIssue({ id: issue.id, at: assignedAt });
          const assignment = yield* assignTo(issue.id, agent, assignedAt);
          if (!assignment.assigned) return yield* Effect.die(new Inconsistent({ message: "an orchestrator's profile must own its assignment" }));
          const execution = yield* qe.addExecution({
            assignment: assignment.assigned.id,
            executor: agent,
            started_at: assignedAt,
          });
          if (input)
            dispatch = yield* mailbox.recordTrigger({
              source: "workbench",
              key: newId(),
              actor: { kind: "system", id: "system" },
              text: input.text,
              threads: [`issue:${issue.id}`],
              addressed: "thread_owner",
              replyChannel: channel,
              meta: { ingressRecipient: agent, issue: issue.id, trigger: input.by, dispatch: true },
              at: assignedAt,
            });
          return { assignment, execution };
        }),
      ),
    );
    if (dispatch) yield* mailbox.receive(dispatch).pipe(bestEffort(`issue: route ${dispatch.id}`));
    worked.changed(linked.assignment.changed);
    worked.executed(issue.id, linked.execution);
    yield* publish(issue.id);
  });
  const toOrchestrator = Effect.fn("Issue.toOrchestrator")(function* (issue: T.Issue, channel: string, by: T.RunTrigger, said?: string) {
    yield* beginOrchestrator(issue, channel, { text: [issue.title, issue.description, said ?? ""].filter(Boolean).join("\n\n"), by });
  });

  const start = Effect.fn("Issue.start")(function* (
    id: string,
    channel: string,
    by?: T.RunTrigger,
    said?: string,
    inputs: readonly T.Trigger[] = [],
  ): Effect.fn.Return<Dispatched, ApiError> {
    const mine = yield* Effect.option(get(id));
    const initial = inputs.length > 0 || mine._tag === "None" ? inputs : yield* mailbox.issueInputs(id);
    if (Option.isSome(mine)) {
      const children = (yield* everyIssue).filter((child) => child.parent === mine.value.id);
      if (children.length > 0) {
        if (by?.kind === "comment" && children.every((child) => isClosed(child.status))) {
          const [, agent, project] = yield* readyOf(mine.value);
          const instruction = said || (mine.value.conflict ? conflictBrief(mine.value.conflict.base, mine.value.conflict.files) : "");
          const hired = yield* hire(agent, [issueBrief(mine.value), instruction].filter(Boolean).join("\n\n"), project, {
            channel,
            issue: id,
            trigger: by,
            inputs: initial,
            worktree: true,
            ...(initial.length > 0 ? { hiring: (s: T.Session, launch: string) => mailbox.registerInitialInputs(s, launch, initial) } : {}),
          });
          if (!hired.session) return yield* Effect.fail(refused(hired.refused ?? t("server.issue.sendFailed")));
          return { session: hired.session.id };
        }
        yield* Effect.forEach(
          children.filter((child) => child.status === "backlog"),
          (child) => start(child.id, channel, by),
          { discard: true },
        );
        return {};
      }
    }
    if (Option.isSome(mine) && isForOrchestrator(mine.value, store.isOrchestrator)) {
      yield* toOrchestrator(mine.value, channel, by ?? { kind: "issue" }, said);
      return {};
    }
    const [issue, agent, project] = yield* ready(id);
    if (issue.queuedAt !== undefined) return { queued: t("server.issue.waitingDispatch") };
    const where = channel;
    const trigger = by;
    const full = sessions.noRoom(agent.runtime, project);
    const blocked = issue.blockedBy.length > 0 ? blockedIssues(issue, yield* everyIssue) : [];
    if (blocked.length > 0) {
      yield* queueRow(issue.id, true, (yield* chat.topOf(where)).id, trigger, initial[0]);
      return { queued: t("server.issue.dependencies.waiting", { issues: list(blocked) }) };
    }
    if (full) {
      yield* queueRow(issue.id, true, (yield* chat.topOf(where)).id, trigger, initial[0]);
      return { queued: t("server.issue.queued", { full }) };
    }
    const sent = yield* send(issue, agent, project, where, trigger, initial);
    return { session: sent };
  });

  const splitting = yield* Semaphore.make(1);
  const split = Effect.fn("Issue.split")(function* (id: string, title: string, drafts: readonly T.IssueChildDraft[], by: Actor) {
    const parent = yield* get(id);
    if (by.kind === "session") {
      const caller = sessions.sessionOf(by.id);
      if (!caller || caller.refining || latestSessionIdOf(parent) !== by.id || caller.issue !== parent.id)
        return yield* Effect.fail(refused(t("server.issue.split.notCurrent")));
    } else if (!actsForOwner(by)) return yield* Effect.fail(refused(needsOwner));
    if (isClosed(parent.status)) return yield* Effect.fail(refused(t("server.issue.dependencies.closedParent")));
    if (!parent.project) return yield* Effect.fail(refused(t("server.issue.noProject")));
    if ((yield* everyIssue).some((item) => item.parent === parent.id)) return yield* Effect.fail(refused(t("server.issue.split.already")));
    if (
      drafts.length === 0 ||
      drafts.length > maxChildren ||
      drafts.some((draft) => !dagIDValid(draft.id)) ||
      dagProblems(drafts.map((draft) => ({ id: draft.id, after: draft.needs ?? [] }))).length > 0
    )
      return yield* Effect.fail(refused(t("server.issue.split.invalid", { max: maxChildren })));
    const ids = new Map(drafts.map((draft) => [draft.id, issueId(newId())]));
    const rows = yield* Effect.forEach(drafts, (draft) =>
      Effect.gen(function* () {
        const named = draft.agent?.trim() || assignedAgentOf(parent);
        const agent = store.agents().find((candidate) => candidate.id === named || candidate.name === named);
        if (!agent || agent.role !== "worker" || !agent.enabled) return yield* Effect.fail(refused(t("server.issue.split.agent", { agent: named ?? "" })));
        const [childTitle, description] = yield* issueWords({
          title: draft.title?.trim() || draft.brief,
          description: draft.title?.trim() ? draft.brief : "",
        });
        const check = draft.check?.trim();
        if (draft.acceptance === true && !check) return yield* Effect.fail(refused(t("server.issue.verification.acceptanceNeedsCheck")));
        const req: T.IssueRequest = {
          title: childTitle,
          description,
          parent: parent.id,
          project: parent.project!,
          agent: agent.id,
          priority: parent.priority,
          blockedBy: (draft.needs ?? []).map((need) => ids.get(need)!),
          constraints: { acceptance: draft.acceptance === true, scope: draft.scope ?? [], frozen: [], ...(check ? { check } : {}) },
        };
        return { id: ids.get(draft.id)!, req };
      }),
    );
    const session = latestSessionIdOf(parent);
    if (session && sessions.present(session)) {
      if (!sessions.sessionOf(session)?.branch) return yield* Effect.fail(refused(t("server.issue.split.needsBranch")));
      const changes = yield* changesOf(parent);
      if (changes && changes.uncommitted.length > 0) return yield* Effect.fail(refused(t("server.issue.split.commitFirst")));
    }
    const channel = (yield* chat.topOf(session ? (sessions.sessionOf(session)?.channel ?? "") : "")).id;
    const at = yield* Clock.currentTimeMillis;
    const dispatches: T.Trigger[] = [];
    const assignments = yield* db
      .attemptTx(
        Effect.gen(function* () {
          const current = yield* q.getIssue({ id });
          const family = yield* q.family({ id });
          if (current.closed_at !== null || family.some((item) => item.parent === id)) return yield* Effect.fail(refused(t("server.issue.split.already")));
          if (title.trim())
            yield* q.editIssue({
              id,
              title: title.trim(),
              description: current.description,
              project: current.project,
              priority: current.priority,
              criteria: current.criteria,
              deliver: current.deliver,
            });
          return yield* Effect.forEach(rows, (row) =>
            Effect.gen(function* () {
              yield* q.addIssue(issueRow(row.id, row.req, parent.mandate, at));
              dispatches.push(
                yield* mailbox.recordTrigger({
                  source: "workbench",
                  key: newId(),
                  actor: { kind: "system", id: "system" },
                  text: [row.req.title, row.req.description].filter(Boolean).join("\n\n"),
                  threads: [`issue:${row.id}`],
                  addressed: "thread_owner",
                  replyChannel: channel,
                  meta: { ingressRecipient: row.req.agent ?? "", issue: row.id, trigger: { kind: "issue" }, dispatch: true },
                  at,
                }),
              );
              yield* q.queueIssue({ id: row.id, at });
              return yield* assignTo(row.id, row.req.agent, at);
            }),
          );
        }),
      )
      .pipe(
        Effect.catchTags({
          SqlError: (error) => Effect.fail(refused(causeMessage(error))),
          SchemaError: Effect.die,
          NoSuchElementError: () => Effect.fail(missing(t("server.issue.issueRef", { ref: id }), [lookIn.issue])),
        }),
      );
    for (const assignment of assignments) worked.changed(assignment.changed);
    yield* Effect.forEach(dispatches, (dispatch) => mailbox.receive(dispatch).pipe(bestEffort(`issue: route ${dispatch.id}`)), { discard: true });
    yield* Effect.forEach(rows, (row) => publish(row.id), { discard: true });
    yield* publish(id);
    return (
      t("server.issue.split.created", { n: parent.number, count: rows.length }) + "\n" + rows.map((row) => `${row.req.title}: vv://issue/${row.id}`).join("\n")
    );
  }, splitting.withPermits(1));

  const joining = yield* Semaphore.make(1);
  const joinChildren = joining.withPermits(1)(
    Effect.gen(function* () {
      const all = yield* everyIssue;
      yield* Effect.forEach(
        all.filter((item) => item.parent !== undefined && item.stage.state === "reviewing"),
        (child) =>
          Effect.gen(function* () {
            const parent = yield* get(child.parent!);
            if (!parent.project || isClosed(parent.status)) return;
            const session = latestSessionIdOf(child);
            if (!session || !sessions.present(session)) return;
            const parentSession = latestSessionIdOf(parent);
            const parentWorker = parentSession ? sessions.sessionOf(parentSession) : undefined;
            if (parentWorker && isBusy(parentWorker)) return;
            const result = yield* Effect.result(
              sessions.handOver(
                session,
                "completed",
                (place) =>
                  Effect.gen(function* () {
                    const constraints = yield* verifyChild(projects, child, parent, all, place);
                    if (constraints) yield* db.run(q.setIssueConstraints({ id: child.id, constraints: JSON.stringify(constraints) }));
                    const mergeIntoParent = (target: Workplace) => projects.mergeInto(place, issueBranch(parent.number), target.cwd);
                    const merged =
                      parentSession && sessions.present(parentSession)
                        ? yield* sessions
                            .withIdleWorkplace(parentSession, mergeIntoParent)
                            .pipe(Effect.mapError((error) => (error._tag === "MergeFailure" ? error : MergeFailure.error(reasonOf(error)))))
                        : yield* Effect.flatMap(projects.workplace(parent.project!, parent.number, true, ""), mergeIntoParent);
                    yield* complete(child.id, "merged_into_parent");
                    return merged;
                  }),
                "helper",
              ),
            );
            if (result._tag === "Failure") {
              const failure = result.failure;
              if (failure._tag === "NotTakenIn" && failure.failure.kind === "conflict")
                yield* setConflict(child.id, { base: failure.failure.base, files: [...failure.failure.files] });
              yield* asked(child.id, [{ question: failure._tag === "NotTakenIn" ? failure.message : reasonOf(failure), options: [] }]);
            } else yield* setConflict(child.id, undefined);
            yield* publish(parent.id);
          }),
        { discard: true },
      );
    }),
  );

  /** In the board's order: one that cannot go any more leaves the queue. */
  const refreshQueue = Effect.fn("Issue.refreshQueue")(function* () {
    const inputs = yield* mailbox.queuedInputs;
    yield* joinChildren.pipe(bestEffort("vibevalley: child issues could not be merged"));
    const all = yield* everyIssue;
    for (const issue of all) {
      if (issue.status !== "todo" || isForOrchestrator(issue, store.isOrchestrator)) continue;
      if (blockedIssues(issue, all).length > 0) continue;
      const title = cut(issue.title, 40);
      const sent = yield* Effect.result(
        Effect.gen(function* () {
          const [, agent, project] = yield* ready(issue.id);
          if (sessions.noRoom(agent.runtime, project)) return "";
          const issueInputs = inputs.filter((item) => item.issue === issue.id).map((item) => item.trigger);
          const input = issueInputs[0];
          if (!input) return "";
          const by: T.RunTrigger = {
            ...(input.meta.trigger ?? { kind: "issue" }),
            message: input.id,
          };
          return yield* send(issue, agent, project, input.replyChannel ?? chat.defaultChannel(), by, issueInputs).pipe(
            Effect.catch((error) => Effect.as(core.notice("warn", t("server.issue.queuedStuck", { title, why: reasonOf(error) })), "")),
          );
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
  }, trying.withPermits(1));

  /** to: another profile takes it on; else the one the last session worked as. */
  const reopen = Effect.fn("Issue.reopen")(function* (
    id: string,
    text: string,
    channel: string,
    by: T.RunTrigger = { kind: "comment" },
    to?: T.Agent,
    inputs: readonly T.Trigger[] = [],
  ) {
    const issue = yield* get(id);
    if (issue.delivered === "merged_into_parent") return yield* Effect.fail(refused(t("server.issue.mergedChildRetry")));
    const newest = latestSessionIdOf(issue);
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
    const brief = reopenBrief(issue, last, text, previous, agent.id !== last.agent);
    const hired = yield* hire(agent, brief, where, { channel, issue: issue.id, trigger: by, inputs });
    if (!hired.session) return yield* Effect.fail(refused(hired.refused ?? t("server.issue.sendFailed")));
    return hired.session.id;
  });

  const scheduled = Effect.fn("Issue.scheduled")(function* (due: Due, input: T.Trigger) {
    const s = due.cron;
    const channel = yield* chat.topOf(s.channel);
    const by: T.RunTrigger = { kind: "cron", cron: s.id, message: input.id, ...(due.missed ? { missed: true } : {}) };
    const found = yield* ofCron(s.id);
    const project = s.project ?? (channel.project || undefined);
    const issue =
      found ??
      (yield* add(
        { title: s.name, description: s.text, ...(project ? { project } : {}), agent: s.agent ?? chat.orchestratorOf(channel.id) },
        inferredMandate(input.id),
        s.id,
      ));
    if (isForOrchestrator(issue, store.isOrchestrator)) {
      if (!found || isClosed(issue.status) || issue.lastRun === undefined) yield* beginOrchestrator(issue, channel.id);
    } else {
      const newest = latestSessionIdOf(issue);
      if (!found || issue.status === "backlog" || issue.status === "todo" || (!isClosed(issue.status) && newest === undefined))
        yield* start(issue.id, channel.id, by, undefined, [input]);
      else if (isClosed(issue.status) || newest === undefined) yield* reopen(issue.id, input.card.summary, channel.id, by, undefined, [input]);
    }
    return yield* get(issue.id);
  });

  const ofCron = Effect.fn("Issue.ofCron")(function* (id: string) {
    const row = yield* db.one(q.latestOfCron({ cron: id }));
    if (!row) return undefined;
    return Option.getOrUndefined(yield* Effect.option(get(row.id)));
  });

  const { merge, refreshPullRequests, submit } = merging({
    core,
    sessions,
    projects,
    chat,
    db,
    get,
    list: everyIssue,
    liveSession,
    publish,
    setConflict,
  });

  const submitPullRequest = Effect.fn("Issue.submitPullRequest")(function* (session: string, summary?: string) {
    const issue = worked.issueOf(session);
    if (!issue) return yield* Effect.fail(refused(t("server.issue.prSubmitNotCurrent")));
    const item = yield* get(issue);
    if (latestSessionIdOf(item) !== session) return yield* Effect.fail(refused(t("server.issue.prSubmitNotCurrent")));
    if (item.mandate.strength !== "explicit" || !item.mandate.autoSubmitPr) return yield* Effect.fail(refused(t("server.issue.prSubmitNotAllowed")));
    if (!item.project || !projects.usesPullRequests(item.project)) return yield* Effect.fail(refused(t("server.issue.prSubmitUnavailable")));
    return yield* submit(item.id, session, summary);
  });

  const comment = Effect.fn("Issue.comment")(function* (id: string, text: string, sendKey: string = "") {
    const issue = yield* get(id);
    if (isClosed(issue.status)) return yield* Effect.fail(refused(t("server.issue.closedReopen")));
    const latest = latestSessionIdOf(issue);
    const session = latest === undefined ? undefined : sessions.sessionOf(latest);
    const thread = yield* chat.issueThread(issue.id, issue.title, session?.channel);
    yield* chat.say(text, thread, sendKey);
  });

  /** The commits on the issue's branch that the main branch does not have; none for one without a project or branch. */
  const commitsOf = (issue: T.Issue) =>
    issue.project
      ? Effect.mapBoth(projects.branchChanges(issue.project, issueBranch(issue.number)), {
          onFailure: (e) => refused(e.message),
          onSuccess: (c) => c?.commits.length ?? 0,
        })
      : Effect.succeed(0);

  /** The profile that takes an issue on as it moves to todo; undefined when it is the one it has. Refused before anything
   * moves, so a handover never leaves its session gone and no one sent. */
  const takerOf = Effect.fn("Issue.takerOf")(function* (issue: T.Issue, to: T.IssueStatus, key: string) {
    const a = store.named(key.trim());
    if (!a) return yield* Effect.fail(refused(t("server.issue.noProfileNamed", { key }), [lookIn.agent]));
    if (a.id === assignedAgentOf(issue)) return undefined;
    if (to !== "todo") return yield* Effect.fail(refused(t("server.issue.handOverOnTodo")));
    if (issue.status === "in_progress") return yield* Effect.fail(refused(t("server.issue.stopFirst", { n: issue.number })));
    if (!a.enabled) return yield* Effect.fail(refused(t("server.issue.disabled", { name: a.name })));
    for (const i of yield* runtimes.problemsOf(a))
      if (i.level === "error") return yield* Effect.fail(refused(t("server.issue.cannotSend", { name: a.name, why: i.text })));
    return a;
  });

  /** Its session, if one is on the farm, goes home; an issue no session works on has nobody to send. */
  const cancel = Effect.fn("Issue.cancel")(function* (id: string): Effect.fn.Return<void, ApiError> {
    const item = yield* get(id);
    yield* Effect.forEach(
      (yield* everyIssue).filter((child) => child.parent === item.id && !isClosed(child.status)),
      (child) =>
        Effect.gen(function* () {
          yield* cancel(child.id);
          yield* cancelAs(child.id, "dismissed");
        }),
      { discard: true },
    );
    const last = latestSessionIdOf(item);
    if (last === undefined || !sessions.present(last)) return;
    if (!(yield* sessions.dismiss(last))) return yield* Effect.fail(missing(t("server.issue.helperRef", { id: last }), [lookIn.session]));
  });

  /** The issue as a move would see it once the owner's unsaved fields are saved (issue.status saves them first);
   * refused as saving them would be: only how it is accepted and what it delivers change once it is sent. */
  const withEdit = Effect.fn("Issue.withEdit")(function* (issue: T.Issue, edit: T.IssueUpdate | undefined) {
    if (!edit) return issue;
    const reworded = Object.keys(edit).some((k) => k !== "deliver");
    if (reworded) yield* unsent(issue.id);
    const { agent, ...fields } = edit;
    if (agent === undefined) return { ...issue, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) };
    const nextAgent = nullText(agent);
    const current = assignmentOf(issue);
    const at = yield* Clock.currentTimeMillis;
    const assignments = [
      ...issue.assignments.map((assignment) => (assignment.id === current?.id && assignment.agent !== nextAgent ? { ...assignment, endedAt: at } : assignment)),
      ...(nextAgent && current?.agent !== nextAgent
        ? [{ id: "preview", issue: issue.id, agent: nextAgent, assignedAt: at, executions: [] } satisfies T.Assignment]
        : []),
    ];
    return { ...issue, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)), assignments };
  });

  /** The move and what it settles before anything changes; refused as the move itself would be. setStatus carries it out,
   * previewStatus says it in words: one judgment, so a dry run never promises what the move would refuse. */
  const settledMove = Effect.fn("Issue.settledMove")(function* (issue: T.Issue, to: T.IssueStatus, text: string, opt: StatusOptions) {
    if (!isOneOf(IssueStatusValues, to)) return yield* Effect.fail(refused(t("server.issue.noStatus", { to })));
    const taker = opt.agent ? yield* takerOf(issue, to, opt.agent) : undefined;
    const [move, why] = statusMove(issue, to);
    const said = text.trim();
    if (move === "none") return yield* Effect.fail(refused(why, nextSteps(issue)));
    // Stuck, it goes back with the server's own words for why; otherwise the owner says what this round is for.
    if (move === "round" && !taker && !said && issue.stage.state !== "stuck") return yield* Effect.fail(refused(t("server.issue.roundNeedsWords")));
    let delivery: "kept" | "none" | "merge" | undefined;
    let commits = 0;
    if (move === "complete") {
      commits = yield* commitsOf(issue);
      delivery = commits === 0 ? "none" : issue.deliver === "branch" ? "kept" : "merge";
    }
    return { issue, to, move, said, taker, delivery, commits };
  });

  const helperName = (issue: T.Issue) => {
    const last = latestSessionIdOf(issue);
    return (last !== undefined ? sessions.sessionOf(last)?.name : undefined) ?? t("server.issue.helper");
  };

  const stuckWords = Effect.fn("Issue.stuckWords")(function* (issue: T.Issue) {
    const last = latestSessionIdOf(issue);
    switch (issue.stage.stuck) {
      case "conflict": {
        const conflict = issue.conflict;
        if (!conflict) return yield* Effect.fail(refused(t("server.issue.noConflict", { name: helperName(issue) })));
        return conflictBrief(conflict.base, conflict.files);
      }
      case "failed": {
        const lastRun = last !== undefined ? sessions.sessionOf(last)?.lastRun : undefined;
        const unread = issue.deliver === "answer" && lastRun?.outcome === "completed" && !lastRun.answer;
        return unread
          ? answerCureWords(t("server.session.answer.noBlock"))
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
  const movesWords = Effect.fn("Issue.movesWords")(function* (p: Effect.Success<ReturnType<typeof settledMove>>) {
    const item = p.issue;
    const n = `#${item.number}`;
    switch (p.move) {
      case "start": {
        if (isForOrchestrator(item, store.isOrchestrator)) return [t("server.issue.does.toOrchestrator", { n })];
        const [, agent, project] = yield* readyOf(item, p.taker?.id);
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
        if (sessionIdsOf(item).length === 0) return [t("server.issue.does.orchestratorRound", { n, said: p.said })];
        if (!p.said) {
          yield* stuckWords(item);
          return [
            item.stage.stuck === "conflict"
              ? t("server.issue.does.resolve", { helper })
              : item.stage.stuck === "interrupted"
                ? t("server.issue.does.resume", { helper, words: resumeWords() })
                : t("server.issue.does.cure", { helper }),
          ];
        }
        if (item.stage.state === "reviewing") return [t("server.issue.does.reject", { n: item.number, findings: findingsOf(p.said).length, helper })];
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
        const changes = yield* changesOf(item);
        const pr = item.project !== undefined && (item.pullRequest?.state === "open" || projects.usesPullRequests(item.project));
        const out: string[] = [];
        if (changes && changes.uncommitted.length > 0)
          out.push(t("server.issue.does.commitFirst", { helper: helperName(item), files: changes.uncommitted.length }));
        if (changes && changes.conflicts.length > 0) return [...out, t("server.issue.does.conflicts", { base: changes.base, files: list(changes.conflicts) })];
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
    get,
    unsent,
    hire,
    publish,
    assignments: worked,
  });

  const onSessionNews = Effect.fn("Issue.onSessionNews")(function* (n: SessionNews) {
    switch (n._tag) {
      case "left": {
        const e = n.left;
        const issue = worked.issueOf(e.id);
        if (!issue) return;
        const row = yield* db.one(q.getIssue({ id: issue }));
        if (!row) return;
        const runs = worked.sessionIds(issue);
        // Closed already (completed by the owner before its session went home): the verdict stands.
        if (runs.at(-1) !== e.id || row.closed_at !== null) return;
        const closing = closingOf(e.closed);
        yield* db.run(
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
        if (issue)
          yield* Effect.andThen(
            db.run(
              q.setIssueReport({
                id: issue,
                questions: jsonOrNull(openQuestions(e.questions), openQuestions(e.questions).length > 0),
                checks: jsonOrNull(e.checks, e.checks.length > 0),
              }),
            ),
            publish(issue),
          );
        if (issue) yield* answered(issue, e.id, e.outcome, e.answer);
        yield* handedBack(e);
        if (issue) {
          const conflict = (yield* get(issue)).conflict;
          if (conflict) yield* setConflict(issue, yield* sessions.withWorkplace(e.id, (place) => projects.conflict(place, conflict.base)));
        }
        yield* joinChildren;
        return;
      }
      case "hired":
        return;
    }
  });

  const onOwnerInThread = Effect.fn("Issue.onOwnerInThread")(function* (thread: string) {
    const issue = yield* Effect.option(get(thread));
    if (Option.isNone(issue)) return;
    const item = issue.value;
    if (isClosed(item.status)) return;
    yield* ownerSaid(item.id);
  });

  const rows = yield* db.run(q.keptIssues({ closed: keepClosedIssues }));
  yield* Effect.forEach(rows, (row) => core.apply({ type: "issue", issue: issueOf(row, worked.of(row.id)) }), { discard: true });
  const news = yield* sessions.news;
  const ownerWords = yield* chat.ownerInThread;
  const finished = yield* sessions.finishedRuns;
  yield* Effect.forkScoped(
    Stream.runForEach(yield* sessions.startedIssues, (id) =>
      Effect.andThen(db.run(q.unqueueIssue({ id })), publish(id)).pipe(bestEffort(`issue: run started on ${id}`)),
    ),
  );
  // One at a time: a report and the owner's word on it do not cross.
  yield* Effect.forkScoped(
    Stream.runForEach(
      Stream.merge(
        news,
        Stream.map(ownerWords, (w) => ({ _tag: "owner" as const, thread: w.thread, message: w.message })),
      ),
      (n) =>
        n._tag === "owner"
          ? onOwnerInThread(n.thread).pipe(bestEffort(`vibevalley: issues after the owner's words in ${n.thread}`))
          : onSessionNews(n).pipe(bestEffort(`vibevalley: issues after ${n._tag}`)),
    ),
  );
  yield* Effect.forkScoped(
    // However the orchestrator's turn ended, the issue waits on the owner: a turn that did not fail is not an answer yet.
    Stream.runForEach(finished, (run) =>
      Effect.forEach(run.issues, (id) => endRun(id).pipe(bestEffort(`vibevalley: run ${run.id} finished on issue ${id}`)), {
        discard: true,
      }),
    ),
  );
  /** On the board before another unsent issue, or last; only unsent issues have a place. */
  const place = Effect.fn("Issue.place")(function* (id: string, before: string) {
    const order: string[] = (yield* everyIssue).filter((item) => executionsOf(item).length === 0 && item.id !== id).map((item) => item.id);
    const at = order.indexOf(before);
    order.splice(at < 0 ? order.length : at, 0, id);
    yield* db.inTx(Effect.forEach(order, (each, rank) => db.run(q.placeIssue({ rank, id: each })), { discard: true }));
    yield* Effect.forEach(order, (each) => publish(each), { discard: true });
  });

  const timeline = Effect.fn("Issue.timeline")(function* (id: string) {
    const issue = yield* get(id);
    const runs = yield* sessions.issueRuns(issue.id);
    const names = new Map<string, string>();
    yield* Effect.forEach(
      new Set(runs.map((r) => r.session)),
      (s) =>
        Effect.gen(function* () {
          const found = yield* sessions.get(s);
          if (found) names.set(s, found.name);
        }),
      { discard: true },
    );
    return milestonesOf(issue, runs, names);
  });

  yield* Effect.forkScoped(
    Stream.runForEach(yield* core.subscribe, (fact) =>
      Effect.gen(function* () {
        if (fact.type !== "issue" && fact.type !== "sessionGone" && !(fact.type === "session" && fact.session.issue !== undefined)) return;
        yield* refreshQueue();
      }).pipe(bestEffort("issue: advance queued work")),
    ),
  );

  const shape = Issue.of({
    scheduled,
    submitPullRequest,
    split,
    onBoard: () => core.state().issues,
    list: Effect.fn("Issue.list")(function* () {
      return yield* everyIssue;
    }),
    query: Effect.fn("Issue.query")(function* (f) {
      const all = yield* everyIssue;
      return pickIssues(all, f, yield* Clock.currentTimeMillis);
    }),
    get,
    timeline,
    add: Effect.fn("Issue.add")(function* (req, mandate) {
      return yield* add(req, mandate);
    }),
    /** The words and who does it only before it is sent; how it is accepted and what it delivers while it is open: the
     * next round goes by them. */
    edit: Effect.fn("Issue.edit")(function* (id, upd, by) {
      if (!actsForOwner(by)) return yield* Effect.fail(refused(needsOwner));
      const whileOpen =
        upd.title === undefined &&
        upd.description === undefined &&
        upd.project === undefined &&
        upd.agent === undefined &&
        upd.priority === undefined &&
        upd.criteria === undefined &&
        upd.before === undefined;
      let was: T.Issue;
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
      const agent = upd.agent ?? assignedAgentOf(was);
      const at = yield* Clock.currentTimeMillis;
      const assignment = yield* db.run(
        db.attemptTx(
          Effect.gen(function* () {
            yield* q.editIssue({
              title,
              description,
              project: nullText(upd.project ?? was.project),
              priority: upd.priority ?? was.priority,
              criteria: jsonOrNull(criteria, criteria.length > 0),
              deliver: upd.deliver ?? was.deliver,
              id,
            });
            return yield* assignTo(id, agent, at);
          }),
        ),
      );
      worked.changed(assignment.changed);
      if (upd.before !== undefined) yield* place(id, upd.before);
      else yield* publish(id);
      return yield* get(id);
    }),
    remove: Effect.fn("Issue.remove")(function* (id) {
      const item = yield* unsent(id);
      const cleared = yield* clearRefinement(item);
      if (cleared.kept) return yield* Effect.fail(refused(t("server.issue.cannotDelete", { n: item.number, why: cleared.reason })));
      yield* db.run(q.removeIssue({ id }));
      yield* reloadAssignments;
      yield* core.apply({ type: "issueGone", id: issueId(id) });
    }),
    // Untraced: it only drops the arguments the service does not take, and the call it makes is named Issue.start.
    start: Effect.fnUntraced(function* (id, channel) {
      return yield* start(id, channel);
    }),
    idOf,
    stop: Effect.fn("Issue.stop")(function* (id) {
      yield* sessions.stop(yield* liveSession(id));
    }),
    setStatus: Effect.fn("Issue.setStatus")(function* (ref, to, text, channel, by, opt = {}) {
      if (!actsForOwner(by)) return yield* Effect.fail(refused(needsOwner));
      const item = yield* get(ref);
      // Read by its number too: every write below goes by its id.
      const id = item.id;
      const { move, said, taker, delivery } = yield* settledMove(item, to, text, opt);
      switch (move) {
        case "start":
          if (taker) yield* shape.edit(id, { agent: taker.id }, by);
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
          if (sessionIdsOf(item).length === 0) yield* start(id, channel, { kind: "comment" }, said);
          else if (said && item.stage.state === "reviewing") yield* shape.review(id, { pass: false, findings: findingsOf(said) });
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
          const unresolved = item.findings.some((f) => !f.resolved);
          const settleFindings = () =>
            judged(
              id,
              item.reviewedAt ?? 0,
              item.findings.map((f) => ({ ...f, resolved: true })),
            );
          if (delivery === "kept" || delivery === "none") {
            if (unresolved) yield* settleFindings();
            // Written down before its session goes home, so that leaving does not take it for canceled.
            yield* complete(id, delivery);
            const last = latestSessionIdOf(item);
            if (last !== undefined && sessions.present(last)) yield* sessions.dismiss(last, "keep", "completed");
            break;
          }
          // The session's leaving closes the issue too, but later: closed here, the answer already says so.
          // Merge before settling the findings: settling them republishes the issue, and merge checks the table again.
          yield* merge(id, true);
          const updated = yield* get(id);
          if (updated.pullRequest?.state !== "open") {
            yield* complete(id, updated.pullRequest ? "pull_request" : "merged");
          }
          if (unresolved) yield* settleFindings();
          break;
        }
        case "cancel":
          yield* cancel(id);
          yield* cancelAs(id, "dismissed");
          break;
        case "drop":
          yield* cancel(id);
          yield* clearRefinement(item);
          yield* drop(id);
          break;
      }
      return yield* get(id);
    }),
    previewStatus: Effect.fn("Issue.previewStatus")(function* (id, to, text, opt = {}, edit) {
      const item = yield* withEdit(yield* get(id), edit);
      return { does: yield* movesWords(yield* settledMove(item, to, text, opt)) };
    }),
    previewRemove: Effect.fn("Issue.previewRemove")(function* (id) {
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
    changes: Effect.fn("Issue.changes")(function* (id, by) {
      const item = yield* get(id);
      const changes = yield* changesOf(item);
      if (!changes) return yield* Effect.fail(refused(t("server.issue.notStarted")));
      yield* setConflict(id, conflictOf(changes));
      const session = latestSessionIdOf(item);
      if (by.kind === "owner" && session && sessions.present(session)) yield* core.did({ kind: "reviewed", session });
      return changes;
    }),
    review: Effect.fn("Issue.review")(function* (id, req) {
      const item = yield* get(id);
      const why = isForOrchestrator(item, store.isOrchestrator)
        ? t("server.issue.orchestratorAnswers")
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
    /** A session with no record is named as missing, not given a phase. */
    history: Effect.fn("Issue.history")(function* () {
      const all = yield* everyIssue;
      const byId = new Map((yield* sessions.list("")).map((s) => [s.id, s]));
      return all.map((issue) => ({
        issue,
        sessions: sessionIdsOf(issue).flatMap((id) => {
          const s = byId.get(id);
          return s ? [s] : [];
        }),
        missingSessions: sessionIdsOf(issue).filter((id) => !byId.has(id)),
      }));
    }),
    templates: Effect.fn("Issue.templates")(function* (name) {
      const stack = yield* projects.stack(name);
      if (!stack) return yield* Effect.fail(missing(t("server.issue.projectRef", { name }), [lookIn.project]));
      return { project: name, stack, recent: sentTitles(yield* everyIssue, name, store.isOrchestrator), kinds: filledKinds(templateCatalog(), stack) };
    }),
    hire,
    refreshPullRequests,
    refreshQueue: refreshQueue(),
  });
  return shape;
});

/** The queue and the pull requests are looked at again on their periods once every service is built. */
export const start = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const issue = yield* Issue;
    yield* issue.refreshQueue;
    yield* Effect.forkScoped(issue.refreshQueue.pipe(Effect.repeat(Schedule.spaced(config.chat.retryWakeMs)), Effect.delay(config.chat.retryWakeMs)));
    // Each waits a period before its first run, then runs every period.
    const pollEvery = config.github.prPollSeconds > 0 ? config.github.prPollSeconds * 1000 : 180_000;
    yield* Effect.forkScoped(
      issue.refreshPullRequests.pipe(bestEffort("vibevalley: refresh pull requests"), Effect.repeat(Schedule.spaced(pollEvery)), Effect.delay(pollEvery)),
    );
  }),
);
