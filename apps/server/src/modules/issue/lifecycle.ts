import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { assignedAgentOf, executionsOf, latestSessionIdOf } from "@vibevalley/protocol/rules";
import { issueId } from "@vibevalley/protocol/schema";

import { BizCode, lookIn, missing, refuseIn } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import { jsonText } from "#/base/json.ts";
import type { Core } from "#/core/core.ts";
import { causeMessage, type Db, SqlError } from "#/infra/db.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Agent } from "#/modules/agent/agent.ts";
import type { Mailbox } from "#/modules/mailbox/mailbox.ts";
import type { Trigger } from "#/modules/mailbox/shapes.ts";
import { issueBranch, type Repo } from "#/modules/repo/repo.ts";
import { RepoError } from "#/modules/repo/workplace.ts";
import { NotRecorded, type Session } from "#/modules/session/session.ts";
import * as q from "#db/issue.sql.ts";

import { issueBrief, splitBrief } from "./brief.ts";
import { issueRow } from "./creation.ts";
import { dependencyProblems } from "./dependencies.ts";
import { kept, openQuestions } from "./refinement.ts";
import { jsonOrNull, nullText } from "./rows.ts";
import { isClosed } from "./status.ts";
import { makeIssueStore } from "./store.ts";

const refused = refuseIn(BizCode.IssueRefused);

/** Only while the issue is still open: a completion the user chose (kept, none) is written before its session leaves, and a child issue merges into its parent, so it does not merge into main here. */
const closingOf = (closed: T.SessionClose | undefined): { delivered: T.Landing } | { canceled: T.IssueCanceled } =>
  closed === "merged" ? { delivered: "merged" } : closed === "completed" ? { delivered: "none" } : { canceled: closed === "lost" ? "lost" : "dismissed" };

/** What every part of the issue module reads and writes the issues with. */
export interface IssueParts {
  readonly core: Core;
  readonly agent: Agent;
  readonly repo: Repo;
  readonly session: Session;
  readonly mailbox: Mailbox;
  readonly db: Db;
  readonly clock: Time;
  readonly log: Logger;
}

export type IssueLifecycle = Awaited<ReturnType<typeof issueLifecycle>>;

export async function issueLifecycle(deps: IssueParts) {
  const { core, agent: agents, repo: repos, session: sessions, mailbox, db, clock, log } = deps;
  const store = await makeIssueStore({ core, db });

  const loadKept = async () => {
    for (const issue of await store.kept()) core.apply({ type: "issueChanged", issue });
  };

  const everyIssue = store.all;

  const idOf = async (ref: string): Promise<string> => {
    const r = ref.trim();
    const number = /^#?(\d+)$/u.exec(r)?.[1];
    if (number !== undefined) {
      const found = await store.byNumber(Number(number));
      if (!found) throw missing(t("server.issue.issueNumbered", { n: number }), [lookIn.issue]);
      return found;
    }
    const bySession = store.issueOfSession(r);
    if (bySession) return bySession;
    const hired = sessions.hired();
    const byName = hired.find((s) => s.name === r) ?? hired.find((s) => s.name !== "" && r.includes(s.name));
    return byName?.issue ?? r;
  };

  const get = async (ref: string): Promise<T.Issue> => {
    const issue = await idOf(ref);
    const found = await store.byId(issue);
    if (!found) throw missing(t("server.issue.issueRef", { ref }), [lookIn.issue]);
    return found;
  };

  const ofCron = (id: string) => store.latestOfCron(id);

  const publish = (id: string) =>
    bestEffort(log, `vibevalley: issue ${id} changed but could not be read back for the board`, async () => {
      core.apply({ type: "issueChanged", issue: await get(id) });
    });

  /** The newest session, the one a merge, changes, comments and cancel act on; a reopen makes another. */
  const latest = async (id: string) => {
    const last = latestSessionIdOf(await get(id));
    if (last === undefined) throw refused(t("server.issue.notStarted"));
    return last;
  };

  const unsent = async (id: string) => {
    const issue = await get(id);
    if (executionsOf(issue).length !== 0) throw refused(t("server.issue.started"));
    return issue;
  };

  const liveSession = async (id: string) => {
    const session = await latest(id);
    if (!sessions.isReachable(session)) throw missing(t("server.issue.helperRef", { id: session }), [lookIn.session]);
    return session;
  };

  const issueWords = (req: Pick<T.IssueRequest, "title" | "description">): readonly [string, string] => {
    const [title, rest] = splitBrief(req.title);
    if (!title) throw refused(t("server.issue.noTitle"));
    let description = (req.description ?? "").trim();
    if (rest) description = (rest + "\n\n" + description).trim();
    return [title, description];
  };

  const insert = async (req: T.IssueRequest, mandate: T.IssueMandate, cron?: string) => {
    const [title, description] = issueWords(req);
    if (req.constraints?.acceptance === true && !req.constraints.check?.trim()) throw refused(t("server.issue.verification.acceptanceNeedsCheck"));
    const id = newId();
    const parent = req.parent ? await get(req.parent) : undefined;
    if (parent && isClosed(parent.status)) throw refused(t("server.issue.dependencies.closedParent"));
    const repo = req.repo ?? parent?.repo;
    if (parent && repo !== parent.repo) throw refused(t("server.issue.dependencies.repo"));
    const blockedBy = [...new Set(req.blockedBy ?? [])];
    if (parent || blockedBy.length > 0) {
      const all = await everyIssue();
      if (dependencyProblems([...all, { id: issueId(id), blockedBy, ...(parent ? { parent: parent.id } : {}) }]).length > 0)
        throw refused(t("server.issue.dependencies.invalid"));
    }
    const at = clock.now();
    await db.tx(async () => {
      await q.addIssue(
        db.sql,
        issueRow(
          id,
          {
            ...req,
            title,
            description,
            blockedBy,
            ...(req.criteria ? { criteria: kept(req.criteria) } : {}),
            ...(repo ? { repo } : {}),
            ...(parent ? { parent: parent.id } : {}),
            deliver: req.deliver ?? (agents.isOrchestrator(req.agent ?? "") ? "answer" : "change"),
          },
          mandate,
          at,
          cron,
        ),
      );
      await store.assignInTx(id, req.agent ?? (parent ? assignedAgentOf(parent) : undefined), at, () => publish(id));
    });
    return get(id);
  };

  /** add, with the database refusing the row told as a refusal: hire tells it to the user. */
  const attemptAdd = async (req: T.IssueRequest, mandate: T.IssueMandate, cron?: string) => {
    try {
      return await insert(req, mandate, cron);
    } catch (e) {
      if (e instanceof SqlError) throw refused(causeMessage(e));
      throw e;
    }
  };

  /** The database failing here is not the caller's to tell: it goes up as it is. */
  const add = (req: T.IssueRequest, mandate: T.IssueMandate, cron?: string) => insert(req, mandate, cron);

  const remove = async (id: string) => {
    await store.remove(id);
    core.apply({ type: "issueRemoved", id: issueId(id) });
  };

  const rankStep = 1024;
  const rankBound = 2_000_000_000;

  const place = async (id: string, before: string) => {
    const unsentIssues = (await everyIssue()).filter((item) => executionsOf(item).length === 0);
    const from = unsentIssues.findIndex((item) => item.id === id);
    const moving = from >= 0 ? unsentIssues[from] : undefined;
    if (!moving) return;
    const rest = unsentIssues.filter((item) => item.id !== id);
    const rawAt = rest.findIndex((item) => item.id === before);
    const at = rawAt < 0 ? rest.length : rawAt;
    if (at === from) return;
    const prev = at > 0 ? rest[at - 1] : undefined;
    const next = at < rest.length ? rest[at] : undefined;
    const prevRank = prev === undefined ? undefined : (prev.rank ?? 0);
    const nextRank = next === undefined ? undefined : (next.rank ?? 0);
    let singleRank: number | undefined;
    if (prevRank === undefined && nextRank !== undefined) {
      const r = nextRank - rankStep;
      if (r >= -rankBound) singleRank = r;
    } else if (prevRank !== undefined && nextRank === undefined) {
      const r = prevRank + rankStep;
      if (r <= rankBound) singleRank = r;
    } else if (prevRank !== undefined && nextRank !== undefined && nextRank - prevRank >= 2) {
      singleRank = Math.trunc((prevRank + nextRank) / 2);
    }
    if (singleRank !== undefined) {
      const rank = singleRank;
      await db.tx(async () => {
        await q.placeIssue(db.sql, { rank, id });
        await db.afterCommit(() => publish(id));
      });
      return;
    }
    const ordered = [...rest];
    ordered.splice(at, 0, moving);
    const changed = ordered.flatMap((item, index) => {
      const target = (index + 1) * rankStep;
      return (item.rank ?? 0) === target ? [] : [{ id: item.id, rank: target }];
    });
    if (changed.length === 0) return;
    await db.tx(async () => {
      for (const each of changed) await q.placeIssue(db.sql, each);
      await db.afterCommit(async () => {
        for (const each of changed) await publish(each.id);
      });
    });
  };

  const saveEdit = async (
    id: string,
    fields: {
      readonly title: string;
      readonly description: string;
      readonly repo: string | undefined;
      readonly priority: T.Priority;
      readonly criteria: readonly string[];
      readonly deliver: T.Deliverable;
      readonly agent: string | undefined;
      readonly clearQuestions?: boolean;
      readonly before?: string;
    },
  ) => {
    const at = clock.now();
    await db.tx(async () => {
      await q.editIssue(db.sql, {
        title: fields.title,
        description: fields.description,
        repo: nullText(fields.repo),
        priority: fields.priority,
        criteria: jsonOrNull(fields.criteria, fields.criteria.length > 0),
        deliver: fields.deliver,
        id,
      });
      if (fields.clearQuestions === true) await q.setIssueQuestions(db.sql, { id, questions: null });
      await store.assignInTx(id, fields.agent, at, fields.before === undefined ? () => publish(id) : undefined);
    });
    if (fields.before !== undefined) await place(id, fields.before);
  };

  const saveRefinement = async (id: string, title: string, description: string, criteria: readonly string[], questions: readonly T.Question[] | undefined) => {
    const open = openQuestions(questions);
    await q.refineIssue(db.sql, {
      id,
      title,
      description,
      criteria: jsonOrNull(criteria, criteria.length > 0),
      questions: jsonOrNull(open, open.length > 0),
    });
    await publish(id);
  };

  const complete = async (id: string, delivered: T.Landing) => {
    await q.completeIssue(db.sql, { closed_at: clock.now(), delivered, id });
    await publish(id);
  };

  const cancelAs = async (id: string, canceled: T.IssueCanceled) => {
    await q.cancelIssue(db.sql, { closed_at: clock.now(), canceled, id });
    await publish(id);
  };

  const closeIfOpen = async (sessionId: string, closed: T.SessionClose | undefined) => {
    const issue = store.issueOfSession(sessionId);
    if (!issue) return;
    const current = await store.byId(issue);
    if (!current) return;
    const runs = store.sessionIdsOf(issue);
    // Closed already (completed by the user before its session went home): the verdict stands.
    if (runs.at(-1) !== sessionId || current.closedAt !== undefined) return;
    const closing = closingOf(closed);
    const closed_at = clock.now();
    if ("delivered" in closing) await q.completeOpenIssue(db.sql, { closed_at, delivered: closing.delivered, id: issue });
    else await q.cancelOpenIssue(db.sql, { closed_at, canceled: closing.canceled, id: issue });
    await publish(issue);
  };

  const endRun = async (id: string) => {
    const item = await get(id);
    if (isClosed(item.status)) return;
    await publish(id);
  };

  /** A repo's failure to read the changes is told as a refusal. */
  const repoRefusal = (e: unknown) => (e instanceof RepoError ? refused(e.message) : e);

  const changesOf = async (item: T.Issue): Promise<T.Changes | undefined> => {
    const session = latestSessionIdOf(item);
    try {
      if (session && sessions.isReachable(session)) return await sessions.withWorkplace(session, (place) => repos.changes(place));
      return item.repo ? await repos.branchChanges(item.repo, issueBranch(item.number)) : undefined;
    } catch (e) {
      throw repoRefusal(e);
    }
  };

  const setConflict = async (id: string, conflict: T.Conflict | undefined) => {
    const current = await store.byId(id);
    if (!current) return;
    const stored = conflict ? jsonOrNull(conflict, true) : null;
    const prev = current.conflict ? jsonOrNull(current.conflict, true) : null;
    if (prev === stored) return;
    await q.setIssueConflict(db.sql, { id, conflict: stored });
    await publish(id);
  };

  const revive = async (id: string) => {
    await q.reopenIssue(db.sql, { id });
    await publish(id);
  };

  const unqueue = async (id: string) => {
    await q.unqueueIssue(db.sql, { id });
    await publish(id);
  };

  /** What the session waits on the user for, from its report; a report with none, or a comment, clears them. */
  const asked = async (id: string, questions: readonly T.Question[] | undefined) => {
    const open = openQuestions(questions);
    await q.setIssueQuestions(db.sql, { id, questions: jsonOrNull(open, open.length > 0) });
    await publish(id);
  };

  const recordReport = async (
    sessionId: string,
    outcome: T.Outcome,
    questions: readonly T.Question[] | undefined,
    checks: readonly T.CriterionCheck[],
    answer: T.IssueAnswer | undefined,
  ) => {
    const issue = store.issueOfSession(sessionId);
    if (!issue) return undefined;
    const open = openQuestions(questions);
    const item = await get(issue);
    const isLatestAnswer = item.deliver === "answer" && latestSessionIdOf(item) === sessionId;
    await db.tx(async () => {
      await q.setIssueReport(db.sql, {
        id: issue,
        questions: jsonOrNull(open, open.length > 0),
        checks: jsonOrNull(checks, checks.length > 0),
      });
      if (isLatestAnswer && outcome === "completed") {
        await q.setIssueAnswer(db.sql, { id: issue, answer: jsonOrNull(answer, answer !== undefined) });
      }
      await db.afterCommit(() => publish(issue));
    });
    if (isLatestAnswer) await sessions.discardWork(sessionId);
    return issue;
  };

  /** at 0 is not accepted (a fail, or another round started); the findings are written as they stand. */
  const judged = async (id: string, at: number, findings: readonly T.Finding[]) => {
    await q.reviewIssue(db.sql, { id, reviewed_at: at > 0 ? at : null, findings: jsonOrNull(findings, findings.length > 0) });
    await publish(id);
  };

  /** A new user reply invalidates the previous acceptance. */
  const userSaid = async (id: string) => {
    const item = await get(id);
    await db.tx(async () => {
      await q.setIssueQuestions(db.sql, { id, questions: null });
      if (item.reviewedAt !== undefined) {
        await q.reviewIssue(db.sql, { id, reviewed_at: null, findings: jsonOrNull(item.findings, item.findings.length > 0) });
      }
      await db.afterCommit(() => publish(id));
    });
  };

  const withdrawDispatches = (id: string, at: number) => mailbox.withdraw({ _tag: "Issue", issue: id, at });

  const route = (dispatch: Trigger) => bestEffort(log, `issue: route ${dispatch.id}`, () => mailbox.receive({ _tag: "Trigger", trigger: dispatch }));

  /** The issue already owns its number and workplace before its session starts. Throws NotRecorded when the database does not keep it. */
  const recordHiredStart = async (id: string, session: T.Session) => {
    try {
      await db.tx(async () => {
        await q.reopenIssue(db.sql, { id });
        await store.executeInTx(id, session.agent, session.id, session.hiredAt, () => publish(id));
        await withdrawDispatches(id, session.hiredAt);
      });
    } catch (e) {
      if (e instanceof SqlError) throw new NotRecorded(causeMessage(e), { cause: e });
      throw e;
    }
  };

  const recordOnDutyStart = async (issue: T.Issue, agent: string, channel: string, input?: { readonly text: string; readonly by: T.RunTrigger }) => {
    const assignedAt = clock.now();
    let dispatch: Trigger | undefined;
    await db.tx(async () => {
      if (isClosed(issue.status)) await q.reopenIssue(db.sql, { id: issue.id });
      await q.queueIssue(db.sql, { id: issue.id, at: assignedAt });
      await store.executeInTx(issue.id, agent, agent, assignedAt, () => publish(issue.id));
      if (input)
        dispatch = await mailbox.recordTrigger({
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
    });
    if (dispatch) await route(dispatch);
  };

  const setQueued = async (id: string, queued: boolean, channel: string, by?: T.RunTrigger, source?: Trigger) => {
    const item = await unsent(id);
    const at = clock.now();
    let dispatch: Trigger | undefined;
    await db.tx(async () => {
      if (!queued) {
        await withdrawDispatches(id, at);
        await q.unqueueIssue(db.sql, { id });
        await db.afterCommit(() => publish(id));
        return;
      }
      const changed = await q.queueIssue(db.sql, { at, id });
      if (changed.length > 0 && !source)
        dispatch = await mailbox.recordTrigger({
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
      await db.afterCommit(() => publish(id));
    });
    if (dispatch) await route(dispatch);
    return get(id);
  };

  const drop = async (id: string) => {
    await unsent(id);
    const now = clock.now();
    await db.tx(async () => {
      await withdrawDispatches(id, now);
      await q.unqueueIssue(db.sql, { id });
      await q.cancelIssue(db.sql, { closed_at: clock.now(), canceled: "dismissed", id });
      await db.afterCommit(() => publish(id));
    });
  };

  const savePullRequest = async (id: string, pr: T.PullRequest) => {
    await q.setIssuePullRequest(db.sql, { id, pull_request: jsonText(pr) });
    await publish(id);
  };

  const finishPullRequest = async (issue: T.Issue, state: T.PullRequestState) => {
    await db.tx(async () => {
      if (state === "closed") await q.cancelIssue(db.sql, { id: issue.id, canceled: "dismissed", closed_at: clock.now() });
      else await q.completeIssue(db.sql, { id: issue.id, delivered: "pull_request", closed_at: clock.now() });
      await q.setIssuePullRequest(db.sql, { id: issue.id, pull_request: jsonText({ ...issue.pullRequest, state }) });
      await db.afterCommit(() => publish(issue.id));
    });
  };

  const saveSplit = async (
    id: string,
    title: string,
    channel: string,
    parentMandate: T.IssueMandate,
    rows: readonly { readonly id: T.IssueId; readonly req: T.IssueRequest }[],
  ) => {
    const at = clock.now();
    const dispatches: Trigger[] = [];
    try {
      await db.tx(async () => {
        const current = await q.getIssue(db.sql, { id });
        if (current === undefined) throw missing(t("server.issue.issueRef", { ref: id }), [lookIn.issue]);
        const family = await q.family(db.sql, { id });
        if (current.closed_at !== null || family.some((item) => item.parent === id)) throw refused(t("server.issue.split.already"));
        if (title.trim())
          await q.editIssue(db.sql, {
            id,
            title: title.trim(),
            description: current.description,
            repo: current.repo,
            priority: current.priority,
            criteria: current.criteria,
            deliver: current.deliver,
          });
        for (const row of rows) {
          await q.addIssue(db.sql, issueRow(row.id, row.req, parentMandate, at));
          const triggerRecorded = await mailbox.recordTrigger({
            source: "workbench",
            key: newId(),
            actor: { kind: "system", id: "system" },
            text: [row.req.title, row.req.description].filter(Boolean).join("\n\n"),
            threads: [`issue:${row.id}`],
            addressed: "thread_owner",
            replyChannel: channel,
            meta: { ingressRecipient: row.req.agent ?? "", issue: row.id, trigger: { kind: "issue" }, dispatch: true },
            at,
          });
          dispatches.push(triggerRecorded);
          await q.queueIssue(db.sql, { id: row.id, at });
          await store.assignInTx(row.id, row.req.agent, at);
        }
        await db.afterCommit(() => publish(id));
      });
    } catch (e) {
      if (e instanceof SqlError) throw refused(causeMessage(e));
      throw e;
    }
    for (const dispatch of dispatches) await route(dispatch);
    // Children reach the board only once their dispatches are held: the queue reacts to their issueChanged, and an
    // earlier one would find no queued input and, the issue then unchanged, never be told again.
    for (const row of rows) await publish(row.id);
  };

  const completeChild = async (childId: string, constraints: T.IssueConstraints | undefined) => {
    await db.tx(async () => {
      if (constraints) await q.setIssueConstraints(db.sql, { id: childId, constraints: jsonText(constraints) });
      await q.completeIssue(db.sql, { closed_at: clock.now(), delivered: "merged_into_parent", id: childId });
      await db.afterCommit(() => publish(childId));
    });
  };

  return {
    issueOfSession: store.issueOfSession,
    lastAssigneeIn: store.lastAssigneeIn,
    loadKept,
    everyIssue,
    idOf,
    get,
    ofCron,
    publish,
    unsent,
    liveSession,
    issueWords,
    attemptAdd,
    add,
    remove,
    saveEdit,
    saveRefinement,
    complete,
    cancelAs,
    closeIfOpen,
    endRun,
    changesOf,
    setConflict,
    revive,
    unqueue,
    asked,
    recordReport,
    judged,
    userSaid,
    recordHiredStart,
    recordOnDutyStart,
    setQueued,
    drop,
    savePullRequest,
    finishPullRequest,
    saveSplit,
    completeChild,
  };
}
