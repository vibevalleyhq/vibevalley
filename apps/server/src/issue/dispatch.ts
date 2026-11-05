import { Clock, Effect, Option, Semaphore } from "effect";

import { list, t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { assignedAgentOf, closedText, cut, latestSessionIdOf } from "@vibevalley/protocol/rules";

import { Agent } from "#/agent/agent.ts";
import { newId } from "#/base/ids.ts";
import { Channel } from "#/channel/channel.ts";
import { Core } from "#/core/core.ts";
import type { Due } from "#/cron/cron.ts";
import { type ApiError, Inconsistent, missing, lookIn, reasonOf, refused } from "#/base/errors.ts";
import { causeMessage, Db } from "#/infra/db.ts";
import { bestEffort } from "#/infra/log.ts";
import { Mailbox } from "#/mailbox/mailbox.ts";
import { recordTrigger } from "#/mailbox/payload.ts";
import { issueBranch, Project } from "#/project/project.ts";
import { Runtime } from "#/runtime/runtime.ts";
import { conflictBrief } from "#/session/briefing.ts";
import { askedMax } from "#/session/journal.ts";
import { type HireOptions, type NotRecorded, Session } from "#/session/session.ts";
import * as q from "#db/issue.sql.ts";
import * as qe from "#db/issue_assignment_execution.sql.ts";

import { assignTo } from "./assignment.ts";
import { issueBrief } from "./brief.ts";
import { explicitMandate, inferredMandate } from "./creation.ts";
import { acceptanceAncestors, blockedIssues } from "./dependencies.ts";
import { workConstraints } from "./prompts.ts";
import type { IssueRecords } from "./records.ts";
import type { IssueSplitting } from "./split.ts";
import { isClosed, isForOrchestrator } from "./status.ts";

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

export const issueDispatch = (r: IssueRecords, joinChildren: IssueSplitting["joinChildren"]) =>
  Effect.gen(function* () {
    const core = yield* Core;
    const store = yield* Agent;
    const projects = yield* Project;
    const runtimes = yield* Runtime;
    const sessions = yield* Session;
    const chat = yield* Channel;
    const mailbox = yield* Mailbox;
    const db = yield* Db;
    const { worked, reloadAssignments, everyIssue, get, publish, unsent, attemptAdd, add, ran, queueRow } = r;
    /** One round of the queue at a time. */
    const trying = yield* Semaphore.make(1);

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
      const issue = yield* (
        opt.issue
          ? get(opt.issue)
          : attemptAdd({ title: brief, project: where, agent: agent.id }, explicitMandate()).pipe(
              // The database failing (a full disk) is told as a refusal; a request it cannot encode is a bug.
              Effect.catchTags({ SqlError: (e) => Effect.fail(refused(causeMessage(e))), SchemaError: Effect.die }),
            )
      ).pipe(Effect.catch((e) => Effect.succeed(t("server.issue.notRecorded", { name: agent.name, why: reasonOf(e) }))));
      if (typeof issue === "string") return { refused: issue };
      const all = yield* everyIssue;
      const blocked = blockedIssues(issue, all);
      if (blocked.length > 0) return { refused: t("server.issue.dependencies.waiting", { issues: list(blocked) }) };
      const parent = issue.parent ? yield* Effect.option(get(issue.parent)) : Option.none();
      const base = opt.base ?? (Option.isSome(parent) ? issueBranch(parent.value.number) : undefined);
      if (Option.isSome(parent)) {
        const placeError = yield* projects.workplace(where, parent.value.number, true, "").pipe(
          Effect.as(""),
          Effect.catch((e) => Effect.succeed(e.message)),
        );
        if (placeError) return { refused: placeError };
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
        yield* core.apply({ type: "issueRemoved", id: issue.id });
      }
      if (hired.retainedWork) return { ...hired, refused: t("server.issue.workKept", { refused: hired.refused ?? "", n: issue.number }) };
      return hired.session && evicted ? { ...hired, evicted } : hired;
    });

    /** Starting it and its dry run ask the same, so neither refuses what the other allows. */
    const readyOf = Effect.fn("Issue.readyOf")(function* (issue: T.Issue, assignedAgent: string | undefined = assignedAgentOf(issue)) {
      if (issue.refining) return yield* Effect.fail(refused(t("server.issue.drafting", { name: issue.refining.name })));
      const pick = [lookIn.agent, { say: t("server.issue.pickHint", { n: issue.number }) }];
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
              dispatch = yield* recordTrigger(db, {
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

    /** In the board's order: one that cannot go any more leaves the queue. */
    const refreshQueue = Effect.fn("Issue.refreshQueue")(function* () {
      const inputs = yield* mailbox.queuedInputs;
      yield* joinChildren.pipe(bestEffort("vibevalley: child issues could not be merged"));
      const all = yield* everyIssue;
      for (const issue of all) {
        if (issue.status !== "todo" || isForOrchestrator(issue, store.isOrchestrator)) continue;
        if (blockedIssues(issue, all).length > 0) continue;
        const title = cut(issue.title, 40);
        yield* Effect.gen(function* () {
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
        }).pipe(
          Effect.tap((session) => (session !== "" ? core.notice("info", t("server.issue.queuedStarted", { title, session })) : Effect.void)),
          Effect.catch((failure) => {
            const why = reasonOf(failure);
            return queueRow(issue.id, false, chat.defaultChannel()).pipe(
              Effect.matchEffect({
                onFailure: () => core.notice("warn", t("server.issue.queuedStuck", { title, why })),
                onSuccess: () => core.notice("warn", t("server.issue.queuedBack", { title, why })),
              }),
            );
          }),
        );
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

    return { hire, readyOf, ready, send, beginOrchestrator, toOrchestrator, start, refreshQueue, reopen, scheduled, ofCron };
  });

export type IssueDispatch = Effect.Success<ReturnType<typeof issueDispatch>>;
