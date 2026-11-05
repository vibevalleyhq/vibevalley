import { Clock, Effect, Schema } from "effect";

import type * as T from "@vibevalley/protocol";
import { DeliverableValues, IssueStatusValues, defaultOrchestrator } from "@vibevalley/protocol";
import { assignedAgentOf, closedText, latestSessionIdOf, phaseText, shortTitle } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";

import { Agent } from "#/agent/agent.ts";
import { actsForOwner } from "#/base/actor.ts";
import { head } from "#/base/clip.ts";
import { Channel, type Info } from "#/channel/channel.ts";
import { explicitMandate, inferredMandate, mandateNoteFits } from "#/issue/creation.ts";
import { Issue } from "#/issue/issue.ts";
import { openFindings } from "#/issue/status.ts";
import { Mailbox } from "#/mailbox/mailbox.ts";
import { Runtime } from "#/runtime/runtime.ts";
import { Session } from "#/session/session.ts";

import {
  answers,
  changesText,
  issueDetail,
  issueLine,
  issueHandbackDescription,
  issueHandbackRecorded,
  issuePrSubmitDescription,
  issuePrSubmitted,
  issueReportDescription,
  issueReportRecorded,
  noSuchPriority,
  noSuchStatus,
  ownerAgentWord,
  priorityOf,
  sessionLine,
  statusOf,
} from "./prompts.ts";
import {
  type Who,
  type Orchestrator,
  type SessionInput,
  said,
  answered,
  callerOf,
  customTool,
  participant,
  tool,
  sessionSchemaTool,
  toolParameters,
} from "./schemas.ts";

type IssueTool = "issue.get" | "issue.diff.get" | "session.stop";
const spaces = /\s+/gu;
const IssueReportInput = Schema.Struct({
  summary: Schema.String,
  questions: Schema.optionalKey(Schema.mutable(Schema.Array(S.Question))),
  checks: Schema.optionalKey(Schema.mutable(Schema.Array(S.CriterionCheck))),
  remember: Schema.optionalKey(Schema.mutable(Schema.Array(S.IssueReportMemory))),
  prSubmit: Schema.optionalKey(Schema.Boolean),
  answer: Schema.optionalKey(S.IssueAnswer),
});
const IssueHandbackInput = Schema.Struct({ envelope: Schema.String, reason: Schema.String });
const IssuePrSubmitInput = Schema.Struct({ summary: Schema.optionalKey(Schema.String) });

export const issueTools = Effect.gen(function* () {
  const clock = yield* Clock.Clock;
  const agents = yield* Agent;
  const run = yield* Session;
  const runtimes = yield* Runtime;
  const chat = yield* Channel;
  const issue = yield* Issue;
  const mailbox = yield* Mailbox;

  // The orchestrator may name a session by its id, its name, or words that contain its name.
  const findSession = (key: string) => {
    const all = run.presentSessions();
    return all.find((session) => session.id === key) ?? all.find((session) => session.name === key) ?? all.find((session) => key.includes(session.name));
  };

  // The orchestrator names an issue by its number (#41, 41), its id, or the name or id of a helper working it.
  const findIssue = Effect.fnUntraced(function* (key: string): Effect.fn.Return<T.Issue | string> {
    const k = key.trim().replace(/^#/u, "");
    const all = yield* issue.list();
    if (/^\d+$/u.test(k)) return all.find((item) => item.number === Number(k)) ?? answers.noIssueNumber(k);
    const byId = all.find((item) => item.id === k);
    if (byId) return byId;
    const session = findSession(k);
    const of = session?.issue ? all.find((item) => item.id === session.issue) : undefined;
    return of ?? answers.noIssueOrAgent(k);
  });

  const withIssue = <E>(key: string, f: (issue: T.Issue) => Effect.Effect<string, E>) =>
    // findIssue's text is the refusal the model reads, a result like f's: not a failure to filter out.
    // @effect-diagnostics-next-line flatMapConditionalToFilterOrFail:off
    Effect.flatMap(findIssue(key), (item) => (typeof item === "string" ? Effect.succeed(item) : f(item)));

  const issueTool = <E>(op: IssueTool, f: (issue: T.Issue) => Effect.Effect<string, E>) => tool(op, (p) => withIssue(p.id, f));

  /** The helper on the farm working the issue now, if any: its newest session. */
  const workerOf = (issue: T.Issue) => {
    const last = latestSessionIdOf(issue);
    return last === undefined ? undefined : run.sessionOf(last);
  };

  const whoOf = (issue: T.Issue) => {
    const agent = assignedAgentOf(issue);
    return workerOf(issue)?.name ?? (agent === defaultOrchestrator ? ownerAgentWord : agent ? (agents.agent(agent)?.name ?? "") : "");
  };

  const nobodyOn = (issue: T.Issue) => answers.nobodyOn(issue.number);

  const numberOf = (session: T.Session) => (session.issue ? issue.onBoard().find((item) => item.id === session.issue)?.number : undefined);

  // Which profile takes a brief: the one named (a profile's name or id, or a runtime), else the one the owner picked for this input, else by the farm's rule.
  const choose = Effect.fnUntraced(function* (brief: string, name: string, picked: string): Effect.fn.Return<T.Agent | string> {
    const key = name.trim();
    const a = yield* runtimes.choose(brief, key, picked);
    if (!a) return answers.noAgentToDispatch;
    if (key && a.id !== key && a.name !== key && a.runtime !== key) return answers.noAgentOrRuntime(key);
    return a;
  });

  const roster = tool("session.list", () =>
    Effect.sync(() => {
      const all = run.presentSessions();
      return all.length === 0
        ? answers.roster.empty
        : all.map((session) => sessionLine(session, clock.currentTimeMillisUnsafe(), numberOf(session))).join("\n");
    }),
  );

  const sessionList = sessionSchemaTool("session.list", () =>
    Effect.sync(() => {
      // Listed without @: an @ wakes someone, and models copy what they read.
      const lines = [answers.sessionList.intro];
      for (const h of run.presentSessions())
        lines.push(
          answers.sessionList.row(
            h.id,
            h.name,
            h.runtime,
            h.project ?? "?",
            phaseText(h, clock.currentTimeMillisUnsafe()),
            head(h.brief.replace(spaces, " "), 60),
          ),
        );
      lines.push(answers.sessionList.wake);
      return lines.join("\n");
    }),
  );

  const issueReport = (who: Who) =>
    customTool(
      "issue_report",
      issueReportDescription,
      toolParameters(IssueReportInput),
      Schema.decodeUnknownEffect(IssueReportInput),
      Effect.fn("Tool.issueReport")(function* (report) {
        const caller = yield* callerOf(who);
        if (!caller.session) return issueReportRecorded(false);
        if (report.prSubmit === true) yield* issue.submitPullRequest(caller.session, report.summary);
        yield* run.report(caller.session, {
          ...report,
          questions: report.questions ?? [],
          checks: report.checks ?? [],
          remember: report.remember ?? [],
          prSubmit: report.prSubmit ?? false,
        });
        return issueReportRecorded(true);
      }),
    );

  const issueHandback = (who: Who) =>
    customTool(
      "issue_handback",
      issueHandbackDescription,
      toolParameters(IssueHandbackInput),
      Schema.decodeUnknownEffect(IssueHandbackInput),
      Effect.fn("Tool.issueHandback")(function* ({ envelope, reason }) {
        const caller = yield* callerOf(who);
        yield* mailbox.returnInput(caller.session, envelope, reason);
        return issueHandbackRecorded;
      }),
    );

  const issuePrSubmit = (who: Who) =>
    customTool(
      "issue_pr_submit",
      issuePrSubmitDescription,
      toolParameters(IssuePrSubmitInput),
      Schema.decodeUnknownEffect(IssuePrSubmitInput),
      Effect.fn("Tool.issuePrSubmit")(function* ({ summary }) {
        const caller = yield* callerOf(who);
        return issuePrSubmitted(yield* issue.submitPullRequest(caller.session, summary));
      }),
    );

  const issueGet = issueTool(
    "issue.get",
    Effect.fn("Tool.issueGet")(function* (item: T.Issue) {
      const w = workerOf(item);
      const timeline = yield* Effect.orElseSucceed(issue.timeline(item.id), () => undefined);
      const lines = [issueDetail(item, whoOf(item), timeline, yield* Clock.currentTimeMillis)];
      if (w)
        lines.push(
          sessionLine(w, yield* Clock.currentTimeMillis, item.number),
          answers.check.workdir(run.cwdOf(w.id) ?? ""),
          answers.check.lastReport(run.lastTextOf(w.id)),
        );
      return lines.join("\n");
    }),
  );

  const issueDiff = (who: Who) =>
    issueTool(
      "issue.diff.get",
      Effect.fn("Tool.issueDiff")(
        function* (item: T.Issue) {
          const c = yield* callerOf(who);
          return changesText(yield* issue.changes(item.id, c.actor));
        },
        Effect.catch((e) => Effect.succeed(answers.changes.failed(said(e)))),
      ),
    );

  // Review is judging what came back against what the issue asked for; a pass only makes it ready, completing it stays
  // the owner's (issue_status_update to done).
  const issueReview = tool(
    "issue.review",
    Effect.fn("Tool.issueReview")(
      function* (p: Orchestrator<"issue.review">) {
        return yield* withIssue(p.id, (item) =>
          issue
            .review(item.id, { pass: p.pass, ...(p.findings ? { findings: p.findings } : {}), ...(p.text ? { text: p.text } : {}) })
            .pipe(Effect.map((done) => (p.pass ? answers.accept.passed(done.number) : answers.accept.failed(done.number, openFindings(done))))),
        );
      },
      Effect.catch((e) => Effect.succeed(said(e))),
    ),
  );

  const issueComment = (who: Who) =>
    tool(
      "issue.comment.create",
      Effect.fn("Tool.issueComment")(
        function* (p: Orchestrator<"issue.comment.create">) {
          const c = yield* callerOf(who);
          return yield* withIssue(p.id, (item) => {
            const w = workerOf(item);
            if (!w) return Effect.succeed(nobodyOn(item));
            return Effect.as(chat.tellSession(participant(c), w.id, p.text, ""), answers.tell.told(item.number, w.name));
          });
        },
        Effect.catch((e) => Effect.succeed(answers.tell.failed(said(e)))),
      ),
    );

  const sessionStop = (who: Who) =>
    issueTool(
      "session.stop",
      Effect.fn("Tool.sessionStop")(
        function* (item: T.Issue) {
          yield* callerOf(who);
          yield* issue.stop(item.id);
          return answers.stop.stopped(item.number);
        },
        Effect.catch((e) => Effect.succeed(said(e))),
      ),
    );

  const issueList = tool(
    "issue.list",
    Effect.fn("Tool.issueList")(function* (p: Orchestrator<"issue.list">) {
      const status = p.status ? statusOf(p.status) : undefined;
      if (p.status && !status) return noSuchStatus(p.status, IssueStatusValues);
      const { limit: _, status: __, ...rest } = p;
      const found = yield* issue.query({ ...rest, ...(status ? { status } : {}) });
      if (found.length === 0) return p.wantsOwner === true ? answers.issues.noneWaiting : answers.issues.none;
      const now = yield* Clock.currentTimeMillis;
      const limit = p.limit != null && p.limit > 0 ? Math.trunc(p.limit) : 20;
      const more = found.length > limit ? answers.issues.moreNote(found.length - limit) : "";
      return (
        found
          .slice(0, limit)
          .map((item) => issueLine(item, whoOf(item), now))
          .join("\n") + more
      );
    }),
  );

  const issueCreate = (who: Who) =>
    tool(
      "issue.create",
      Effect.fn("Tool.issueCreate")(function* (p: Orchestrator<"issue.create">) {
        const c = yield* callerOf(who);
        if (p.draft === true && p.start === true) return answers.issueCreate.draftWithStartRefused;
        if (!mandateNoteFits(p.description ?? "")) return answers.issueCreate.noteTooLong;
        let channel: Info;
        if (p.channel) {
          const byName = yield* chat.channelByName(p.channel);
          if (!byName) return answers.issueCreate.noChannel(p.channel);
          channel = byName;
        } else channel = yield* chat.topOf(c.here);
        const parent = p.parent ? yield* issue.get(yield* issue.idOf(p.parent)) : undefined;
        const blockedBy = yield* Effect.forEach(p.blockedBy ?? [], (ref) => Effect.map(issue.idOf(ref), S.issueId));
        const project = (p.project ?? parent?.project ?? "").trim() || channel.project;
        if (p.start === true && !project) return answers.issueCreate.noDefaultProject(channel.name);
        const priority = p.priority ? priorityOf(p.priority) : undefined;
        if (p.priority && !priority) return noSuchPriority(p.priority);
        const deliver = p.deliver ? DeliverableValues.find((d) => d === p.deliver) : undefined;
        if (p.deliver && !deliver) return answers.issueCreate.noDeliver;
        let agent: string | undefined = parent ? assignedAgentOf(parent) : undefined;
        if (p.agent || p.start === true) {
          const a = yield* choose(p.title + "\n" + (p.description ?? ""), p.agent ?? agent ?? "", p.start === true ? c.picked : "");
          if (typeof a === "string") return answers.issueCreate.notRecorded(a);
          agent = a.id;
        }
        const item = yield* issue
          .add(
            {
              title: p.title,
              ...(parent ? { parent: parent.id } : {}),
              ...(blockedBy.length > 0 ? { blockedBy } : {}),
              ...(p.description ? { description: p.description } : {}),
              ...(project ? { project } : {}),
              ...(agent ? { agent } : {}),
              ...(priority ? { priority } : {}),
              ...(deliver ? { deliver } : {}),
            },
            actsForOwner(c.actor) ? explicitMandate(c.envelope, p.autoSubmitPr ?? false) : inferredMandate(c.envelope),
          )
          .pipe(Effect.catch((e) => Effect.succeed(answers.issueCreate.notRecordedFailed(said(e)))));
        if (typeof item === "string") return item;
        const noted = answers.issueCreate.noted(item.number, shortTitle(item.title), item.deliver === "answer");
        if (p.start === true) {
          // Written down first: a start that fails leaves the issue in the backlog, and trying again starts it, not a second one.
          const sent = yield* issue
            .start(item.id, channel.id)
            .pipe(Effect.catch((e) => Effect.succeed(answers.issueCreate.queuedNoStart(noted, said(e)))));
          if (typeof sent === "string") return sent;
          if (sent.queued) return answers.issueCreate.queuedInChannel(noted, channel.name, sent.queued);
          const h = sent.session ? run.sessionOf(sent.session) : undefined;
          const branch = h?.branch ? answers.issueCreate.branchNote(h.branch) : "";
          return answers.issueCreate.dispatched(
            noted,
            channel.name,
            h ? answers.issueCreate.who(h.name, h.id) : answers.issueCreate.noAgentFallback,
            h?.project ?? project,
            branch,
          );
        }
        if (p.draft !== true) return answers.issueCreate.inBacklog(noted, answers.issueCreate.notStartedNote);
        const refined = yield* issue.refine(item.id, [p.title, p.description ?? ""].join("\n").trim(), channel.id).pipe(
          Effect.as(answers.issueCreate.draftingNote),
          Effect.catch((e) => Effect.succeed(answers.issueCreate.draftFailed(said(e)))),
        );
        return answers.issueCreate.inBacklog(noted, refined);
      }),
    );

  const issueUpdate = (who: Who) =>
    tool(
      "issue.update",
      Effect.fn("Tool.issueUpdate")(
        function* (p: Orchestrator<"issue.update">) {
          const c = yield* callerOf(who);
          return yield* withIssue(p.id, (item) => {
            const priority = p.priority ? priorityOf(p.priority) : undefined;
            if (p.priority && !priority) return Effect.succeed(noSuchPriority(p.priority));
            let agent: string | undefined;
            if (p.agent) {
              const a = agents.named(p.agent);
              if (!a) return Effect.succeed(answers.noProfileNamed(p.agent));
              agent = a.id;
            }
            return issue
              .edit(
                item.id,
                {
                  ...(p.title !== undefined ? { title: p.title } : {}),
                  ...(p.description !== undefined ? { description: p.description } : {}),
                  ...(p.project !== undefined ? { project: p.project } : {}),
                  ...(agent ? { agent } : {}),
                  ...(priority ? { priority } : {}),
                  ...(p.deliver ? { deliver: p.deliver } : {}),
                  ...(p.criteria !== undefined ? { criteria: p.criteria } : {}),
                },
                c.actor,
              )
              .pipe(Effect.map((done) => answers.issueUpdate.updated(issueLine(done, whoOf(done), clock.currentTimeMillisUnsafe()).slice(2))));
          });
        },
        Effect.catch((e) => Effect.succeed(answers.issueUpdate.failed(said(e)))),
      ),
    );

  const issueStatus = (who: Who) =>
    tool(
      "issue.status.update",
      Effect.fn("Tool.issueStatus")(function* (p: Orchestrator<"issue.status.update">) {
        const c = yield* callerOf(who);
        const to = statusOf(p.status);
        if (!to) return noSuchStatus(p.status, ["backlog", "todo", "done", "canceled"]);
        return yield* withIssue(
          p.id,
          Effect.fnUntraced(
            function* (item: T.Issue) {
              // Sent out with nobody named yet: chosen by the farm's rule, the owner's pick first; another one named hands it over.
              let agent: string | undefined;
              if (p.agent || (to === "todo" && item.status === "backlog" && !assignedAgentOf(item))) {
                const chosen = yield* choose(item.title + "\n" + item.description, p.agent ?? "", p.agent ? "" : c.picked);
                if (typeof chosen === "string") return answers.issueStatus.notMoved(chosen);
                agent = chosen.id;
              }
              const done = yield* issue.setStatus(item.id, to, p.text ?? "", c.here, c.actor, agent ? { agent: agent } : {});
              // Completing says what it delivered, which follows the issue: merged, no change, its branch kept, or a PR still open.
              if (to === "done" && done.status === "done") return `#${done.number} ${closedText(done)}`;
              if (to === "done" && done.pullRequest?.state === "open") return answers.issueStatus.prOpenNote(done.number, done.pullRequest.url);
              return answers.issueStatus.moved(issueLine(done, whoOf(done), yield* Clock.currentTimeMillis).slice(2));
            },
            Effect.catch((e) => Effect.succeed(answers.issueStatus.notMoved(said(e)))),
          ),
        );
      }),
    );
  const issueSplit = (who: Who) =>
    sessionSchemaTool(
      "issue.split",
      Effect.fn("Tool.issueSplit")(function* (p: SessionInput<"issue.split">) {
        const caller = yield* callerOf(who);
        const drafts = p.tasks.map((item) => ({ ...item, needs: item.needs ?? [], scope: item.scope ?? [] }));
        return yield* answered(Effect.flatMap(issue.idOf(caller.session), (id) => issue.split(id, p.title ?? "", drafts, caller.actor)));
      }),
    );

  return {
    numberOf,
    issueSplit,
    roster,
    sessionList,
    issueGet,
    issueDiff,
    issueReview,
    issueComment,
    sessionStop,
    issueList,
    issueCreate,
    issueUpdate,
    issueStatus,
    issueReport,
    issueHandback,
    issuePrSubmit,
    findIssue,
  };
});
