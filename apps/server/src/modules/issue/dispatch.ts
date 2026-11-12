import { Semaphore } from "@vibevalley/async";
import { list, t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { assignedAgentOf, closedText, cut, latestSessionIdOf } from "@vibevalley/protocol/rules";

import { ApiError, BizCode, lookIn, missing, refuseIn } from "#/base/errors.ts";
import type { Core } from "#/core/core.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import type { Agent } from "#/modules/agent/agent.ts";
import type { Channel } from "#/modules/channel/channel.ts";
import { issueBranch, type Repo } from "#/modules/repo/repo.ts";
import { RepoError } from "#/modules/repo/workplace.ts";
import { conflictBrief } from "#/modules/session/briefing.ts";
import { askedMax } from "#/modules/session/journal.ts";
import { type Hired, type HireOptions, HireRefused, type QueuedInput, type Session } from "#/modules/session/session.ts";
import type { Trigger } from "#/modules/session/shapes.ts";

import { issueBrief } from "./brief.ts";
import { explicitMandate, inferredMandate } from "./creation.ts";
import type { Due } from "./cron.ts";
import { acceptanceAncestors, blockedIssues } from "./dependencies.ts";
import type { IssueLifecycle } from "./lifecycle.ts";
import { workConstraints } from "./prompts.ts";
import type { IssueSplitting } from "./split.ts";
import { isClosed, assignedOnDuty } from "./status.ts";

const refused = refuseIn(BizCode.IssueRefused);

/** What starting an issue came to: the session sent, or why it waits in the queue. */
export interface Dispatched {
  readonly session?: T.SessionId;
  readonly queued?: string;
}

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

export interface DispatchDeps {
  readonly core: Core;
  readonly agent: Agent;
  readonly repo: Repo;
  readonly session: Session;
  readonly channel: Channel;
  readonly log: Logger;
}

/** An ApiError's refusal goes on as `to` says; anything else goes up as it is. */
const asRefusal = (e: unknown, to: (e: ApiError) => Error): unknown => (e instanceof ApiError ? to(e) : e);

/** A lookup that was refused (not there) reads as none; anything else goes up. */
const noneIfRefused = (e: unknown): undefined => {
  if (e instanceof ApiError) return undefined;
  throw e;
};

export type IssueDispatch = ReturnType<typeof issueDispatch>;

export function issueDispatch(r: IssueLifecycle, joinChildren: IssueSplitting["joinChildren"], deps: DispatchDeps) {
  const { core, agent: store, repo: repos, session: sessions, channel: chat, log } = deps;
  const { everyIssue, get, ofCron, unsent, attemptAdd, add, remove, recordHiredStart, recordOnDutyStart, setQueued } = r;
  /** One round of the queue at a time. */
  const trying = new Semaphore(1);

  /** Throws HireRefused. */
  const hire = async (agent: T.Agent, brief: string, repo: string, opt: HireOptions = {}): Promise<Hired> => {
    if (store.isOrchestrator(agent.id)) throw new HireRefused(t("server.issue.orchestratorNotHelper"));
    if (!agent.enabled) throw new HireRefused(t("server.issue.disabled", { name: agent.name }));
    for (const i of await store.problemsOf(agent))
      if (i.level === "error") throw new HireRefused(t("server.issue.cannotSend", { name: agent.name, why: i.text }));
    const where = repo.trim() || agent.workdir.trim();
    if (!where && opt.refining !== true) throw new HireRefused(t("server.issue.noRepo"));
    let issue: T.Issue;
    try {
      // The database failing (a full disk) is told as a refusal (attemptAdd).
      issue = opt.issue ? await get(opt.issue) : await attemptAdd({ title: brief, repo: where, agent: agent.id }, explicitMandate());
    } catch (e) {
      throw asRefusal(e, (e) => new HireRefused(t("server.issue.notRecorded", { name: agent.name, why: e.message })));
    }
    const all = await everyIssue();
    const blocked = blockedIssues(issue, all);
    if (blocked.length > 0) throw new HireRefused(t("server.issue.dependencies.waiting", { issues: list(blocked) }));
    const parent = issue.parent ? await get(issue.parent).catch(noneIfRefused) : undefined;
    const base = opt.base ?? (parent ? issueBranch(parent.number) : undefined);
    // A draft's session is not one of the issue's sessions: the issue stays unsent.
    const constraints = workConstraints(
      issue.constraints,
      acceptanceAncestors(issue, all).flatMap((item) => item.constraints?.frozen ?? []),
    );
    const { issue: _issue, hiring: _hiring, ...sending } = opt;
    const hiredIssue = issue;
    try {
      const received = await sessions.hireWith({
        agent,
        brief: [brief, constraints].filter(Boolean).join("\n\n"),
        where,
        // The child's branch forks from the parent's.
        ...(parent ? { parent: parent.number } : {}),
        options: { ...sending, ...(base ? { base, worktree: true } : {}), context: { kind: "issue", issue: hiredIssue } },
        envelopes: { _tag: "Queued", triggers: opt.inputs ?? [] },
        hiring: async (w) => {
          if (opt.refining !== true) await recordHiredStart(hiredIssue.id, w);
        },
      });
      return { session: received.hired, ...(received.evicted ? { evicted: received.evicted } : {}) };
    } catch (refusedHire) {
      if (!(refusedHire instanceof HireRefused)) throw refusedHire;
      const kept = refusedHire.retainedWork === true;
      if (!opt.issue && !kept) await remove(hiredIssue.id);
      throw kept
        ? new HireRefused(t("server.issue.workKept", { refused: refusedHire.reason, n: hiredIssue.number }), true)
        : new HireRefused(refusedHire.reason);
    }
  };

  /** hire, its refusal told as the issue's. */
  const hired = async (agent: T.Agent, brief: string, repo: string, opt: HireOptions) => {
    try {
      return await hire(agent, brief, repo, opt);
    } catch (e) {
      if (e instanceof HireRefused) throw refused(e.reason);
      throw e;
    }
  };

  /** Starting it and its dry run ask the same, so neither refuses what the other allows. */
  const readyOf = async (issue: T.Issue, assignedAgent: string | undefined = assignedAgentOf(issue)): Promise<readonly [T.Issue, T.Agent, string]> => {
    if (issue.refining) throw refused(t("server.issue.drafting", { name: issue.refining.name }));
    const pick = [lookIn.agent, { say: t("server.issue.pickHint", { n: issue.number }) }];
    if (!assignedAgent) throw refused(t("server.issue.noAssignee"), pick);
    const agent = store.agent(assignedAgent);
    if (!agent) throw refused(t("server.issue.profileGone", { id: assignedAgent }), pick);
    return [issue, agent, issue.repo ?? agent.workdir] as const;
  };

  const ready = async (id: string) => readyOf(await unsent(id));

  const send = async (issue: T.Issue, agent: T.Agent, repo: string, channel: string, by?: T.RunTrigger, inputs: readonly Trigger[] = []) =>
    (await hired(agent, issueBrief(issue), repo, { channel, issue: issue.id, inputs, ...(by ? { trigger: by } : {}) })).session.id;

  /** Its run starts as it is handed over: the issue is in progress until the run ends on it (endRun). */
  const beginOnDuty = async (issue: T.Issue, channel: string, input?: { readonly text: string; readonly by: T.RunTrigger }) => {
    const agent = assignedAgentOf(issue) || chat.orchestratorIn((await chat.topOf(channel)).id);
    if (!sessions.live(agent).session) throw refused(t("server.issue.profileGone", { id: agent }));
    await recordOnDutyStart(issue, agent, channel, input);
  };
  const handOnDuty = (issue: T.Issue, channel: string, by: T.RunTrigger, said?: string) =>
    beginOnDuty(issue, channel, { text: [issue.title, issue.description, said ?? ""].filter(Boolean).join("\n\n"), by });

  const start = async (id: string, channel: string, by?: T.RunTrigger, said?: string, inputs: readonly Trigger[] = []): Promise<Dispatched> => {
    const mine = await get(id).catch(noneIfRefused);
    const queued = inputs.length > 0 || mine === undefined ? undefined : await sessions.triggersOf(id);
    const initial = queued ?? inputs;
    if (mine) {
      const children = (await everyIssue()).filter((child) => child.parent === mine.id);
      if (children.length > 0) {
        if (by?.kind === "comment" && children.every((child) => isClosed(child.status))) {
          const [, agent, repo] = await readyOf(mine);
          const instruction = said || (mine.conflict ? conflictBrief(mine.conflict.base, mine.conflict.files) : "");
          const sent = await hired(agent, [issueBrief(mine), instruction].filter(Boolean).join("\n\n"), repo, {
            channel,
            issue: id,
            trigger: by,
            inputs: initial,
            worktree: true,
          });
          return { session: sent.session.id };
        }
        for (const child of children.filter((child) => child.status === "backlog")) await start(child.id, channel, by);
        return {};
      }
    }
    if (mine && assignedOnDuty(mine, store.isOrchestrator)) {
      await handOnDuty(mine, channel, by ?? { kind: "issue" }, said);
      return {};
    }
    const [issue, agent, repo] = await ready(id);
    if (issue.queuedAt !== undefined) return { queued: t("server.issue.waitingDispatch") };
    const where = channel;
    const trigger = by;
    const full = sessions.room(agent.runtime, repo);
    const blocked = issue.blockedBy.length > 0 ? blockedIssues(issue, await everyIssue()) : [];
    if (blocked.length > 0) {
      await setQueued(issue.id, true, (await chat.topOf(where)).id, trigger, initial[0]);
      return { queued: t("server.issue.dependencies.waiting", { issues: list(blocked) }) };
    }
    if (full) {
      await setQueued(issue.id, true, (await chat.topOf(where)).id, trigger, initial[0]);
      return { queued: t("server.issue.queued", { full }) };
    }
    const sent = await send(issue, agent, repo, where, trigger, initial);
    return { session: sent };
  };

  /** One queued issue's turn: "" when it stays queued, else the session sent. Throws ApiError when it cannot go any more. */
  const tryQueued = async (issue: T.Issue, inputs: readonly QueuedInput[], title: string): Promise<string> => {
    const [, agent, repo] = await ready(issue.id);
    if (sessions.room(agent.runtime, repo)) return "";
    const triggers = inputs.filter((item) => item.issue === issue.id).map((item) => item.trigger);
    const input = triggers[0];
    if (!input) return "";
    const by: T.RunTrigger = {
      ...(input.meta.trigger ?? { kind: "issue" }),
      message: input.id,
    };
    try {
      return await send(issue, agent, repo, input.replyChannel ?? chat.defaultChannel(), by, triggers);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      core.notice("warn", t("server.issue.queuedStuck", { title, why: error.message }));
      return "";
    }
  };

  /** In the board's order: one that cannot go any more leaves the queue. */
  const refreshQueue = (): Promise<void> =>
    trying.with(async () => {
      const inputs = await sessions.queuedTriggers();
      await bestEffort(log, "vibevalley: child issues could not be merged", () => joinChildren());
      const all = await everyIssue();
      for (const issue of all) {
        if (issue.status !== "todo" || assignedOnDuty(issue, store.isOrchestrator)) continue;
        if (blockedIssues(issue, all).length > 0) continue;
        const title = cut(issue.title, 40);
        let session: string;
        try {
          session = await tryQueued(issue, inputs, title);
        } catch (failure) {
          if (!(failure instanceof ApiError)) throw failure;
          const why = failure.message;
          try {
            await setQueued(issue.id, false, chat.defaultChannel());
          } catch (e) {
            if (!(e instanceof ApiError)) throw e;
            core.notice("warn", t("server.issue.queuedStuck", { title, why }));
            continue;
          }
          core.notice("warn", t("server.issue.queuedBack", { title, why }));
          continue;
        }
        if (session !== "") core.notice("info", t("server.issue.queuedStarted", { title, session }));
      }
    });

  /** to: another profile takes it on; else the one the last session worked as. */
  const reopen = async (id: string, text: string, channel: string, by: T.RunTrigger = { kind: "comment" }, to?: T.Agent, inputs: readonly Trigger[] = []) => {
    const issue = await get(id);
    if (issue.delivered === "merged_into_parent") throw refused(t("server.issue.mergedChildRetry"));
    const newest = latestSessionIdOf(issue);
    if (newest === undefined) {
      // Run before by no session (the orchestrator): its doer takes it up again, with the user's words.
      if (!issue.lastRun) throw refused(t("server.issue.neverStarted"));
      if (!isClosed(issue.status)) throw refused(t("server.issue.stillOpen"));
      await start(id, channel, by, text);
      return "";
    }
    const last = await sessions.get(newest);
    if (!last) throw missing(t("server.issue.issueRef", { ref: id }), [lookIn.issue]);
    if (!isClosed(issue.status)) throw refused(t("server.issue.stillWorking", { name: last.name }));
    const agent = to ?? store.agent(last.agent);
    if (!agent) throw refused(t("server.issue.senderGone", { id: last.agent }));
    const where = issue.repo ?? "";
    let changes: T.Changes | undefined;
    try {
      changes = await repos.branchChanges(where, issueBranch(issue.number));
    } catch (e) {
      if (e instanceof RepoError) throw refused(e.message);
      throw e;
    }
    const previous = (changes?.commits.length ?? 0) > 0;
    const brief = reopenBrief(issue, last, text, previous, agent.id !== last.agent);
    const sent = await hired(agent, brief, where, { channel, issue: issue.id, trigger: by, inputs });
    return sent.session.id;
  };

  const scheduled = async (due: Due, input: Trigger) => {
    const s = due.cron;
    const channel = await chat.topOf(s.channel);
    const by: T.RunTrigger = { kind: "cron", cron: s.id, message: input.id, ...(due.missed ? { missed: true } : {}) };
    const found = await ofCron(s.id);
    const repo = s.repo ?? (channel.repo || undefined);
    const issue =
      found ??
      (await add(
        { title: s.name, description: s.text, ...(repo ? { repo } : {}), agent: s.agent ?? chat.orchestratorIn(channel.id) },
        inferredMandate(input.id),
        s.id,
      ));
    if (assignedOnDuty(issue, store.isOrchestrator)) {
      if (!found || isClosed(issue.status) || issue.lastRun === undefined) await beginOnDuty(issue, channel.id);
    } else {
      const newest = latestSessionIdOf(issue);
      if (!found || issue.status === "backlog" || issue.status === "todo" || (!isClosed(issue.status) && newest === undefined))
        await start(issue.id, channel.id, by, undefined, [input]);
      else if (isClosed(issue.status) || newest === undefined) await reopen(issue.id, input.card.summary, channel.id, by, undefined, [input]);
    }
    return get(issue.id);
  };

  return { hire, readyOf, ready, send, beginOnDuty, handOnDuty, start, refreshQueue, reopen, scheduled, ofCron };
}
