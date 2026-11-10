import { Clock, Effect, Schema } from "effect";

import type * as T from "@vibevalley/protocol";
import { defaultOrchestrator } from "@vibevalley/protocol";
import { assignedAgentOf, closedText, latestSessionIdOf, phaseText, shortTitle } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";

import { Agent } from "#/agent/agent.ts";
import { actsForUser } from "#/base/actor.ts";
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
  userAgentWord,
  sessionLine,
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
    const all = run.hired();
    return all.find((session) => session.id === key) ?? all.find((session) => session.name === key) ?? all.find((session) => key.includes(session.name));
  };

  // The orchestrator names an issue by its number (#41, 41), its id, or the name or id of a helper working it.
  const findIssue = Effect.fnUntraced(function* (key: string): Effect.fn.Return<T.Issue, string> {
    const k = key.trim().replace(/^#/u, "");
    const all = yield* issue.list();
    if (/^\d+$/u.test(k)) {
      const byNumber = all.find((item) => item.number === Number(k));
      if (!byNumber) return yield* Effect.fail(answers.noIssueNumber(k));
      return byNumber;
    }
    const byId = all.find((item) => item.id === k);
    if (byId) return byId;
    const session = findSession(k);
    const of = session?.issue ? all.find((item) => item.id === session.issue) : undefined;
    if (!of) return yield* Effect.fail(answers.noIssueOrAgent(k));
    return of;
  });

  const withIssue = <E>(key: string, f: (issue: T.Issue) => Effect.Effect<string, E>) =>
    Effect.matchEffect(findIssue(key), { onFailure: Effect.succeed, onSuccess: f });

  const issueTool = <E>(op: IssueTool, f: (issue: T.Issue) => Effect.Effect<string, E>) => tool(op, (p) => withIssue(p.id, f));

  /** The helper on the farm working the issue now, if any: its newest session. */
  const workerOf = (issue: T.Issue) => {
    const last = latestSessionIdOf(issue);
    return last === undefined ? undefined : run.sessionOf(last);
  };

  const whoOf = (issue: T.Issue) => {
    const agent = assignedAgentOf(issue);
    return workerOf(issue)?.name ?? (agent === defaultOrchestrator ? userAgentWord : agent ? (agents.agent(agent)?.name ?? "") : "");
  };

  const nobodyOn = (issue: T.Issue) => answers.nobodyOn(issue.number);

  const numberOf = (session: T.Session) => (session.issue ? issue.onBoard().find((item) => item.id === session.issue)?.number : undefined);

  // Which profile takes a brief: the one named (a profile's name or id, or a runtime), else the one the user picked for this input, else by the farm's rule.
  const choose = Effect.fnUntraced(function* (brief: string, name: string, picked: string): Effect.fn.Return<T.Agent, string> {
    const key = name.trim();
    const a = yield* runtimes.choose(brief, key, picked);
    if (!a) return yield* Effect.fail(answers.noAgentToDispatch);
    if (key && a.id !== key && a.name !== key && a.runtime !== key) return yield* Effect.fail(answers.noAgentOrRuntime(key));
    return a;
  });

  const roster = tool("session.list", () =>
    Effect.sync(() => {
      const all = run.hired();
      return all.length === 0
        ? answers.roster.empty
        : all.map((session) => sessionLine(session, clock.currentTimeMillisUnsafe(), numberOf(session))).join("\n");
    }),
  );

  const sessionList = sessionSchemaTool("session.list", () =>
    Effect.sync(() => {
      // Listed without @: an @ wakes someone, and models copy what they read.
      const lines = [answers.sessionList.intro];
      for (const h of run.hired())
        lines.push(
          answers.sessionList.row(
            h.id,
            h.name,
            h.runtime,
            h.repo ?? "?",
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
        yield* mailbox.decline(caller.session, envelope, reason);
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
        const pullRequestSubmitted = yield* issue.submitPullRequest(caller.session, summary);
        return issuePrSubmitted(pullRequestSubmitted);
      }),
    );

  const issueGet = issueTool(
    "issue.get",
    Effect.fn("Tool.issueGet")(function* (item: T.Issue) {
      const w = workerOf(item);
      const timeline = yield* Effect.orElseSucceed(issue.timeline(item.id), () => undefined);
      const now = yield* Clock.currentTimeMillis;
      const lines = [issueDetail(item, whoOf(item), timeline, now)];
      if (w) lines.push(sessionLine(w, now, item.number), answers.check.workdir(run.cwdOf(w.id) ?? ""), answers.check.lastReport(run.lastTextOf(w.id)));
      return lines.join("\n");
    }),
  );

  const issueDiff = (who: Who) =>
    issueTool(
      "issue.diff.get",
      Effect.fn("Tool.issueDiff")(
        function* (item: T.Issue) {
          const c = yield* callerOf(who);
          const changes2 = yield* issue.changes(item.id, c.actor);
          return changesText(changes2);
        },
        Effect.catch((e) => Effect.succeed(answers.changes.failed(said(e)))),
      ),
    );

  // Review is judging what came back against what the issue asked for; a pass only makes it ready, completing it stays
  // the user's (issue_status_update to done).
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
            return Effect.as(
              chat.post({ _tag: "Tell", from: participant(c), session: w.id, text: p.text, sendKey: "" }),
              answers.tell.told(item.number, w.name),
            );
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
      const { limit: _, ...rest } = p;
      const found = yield* issue.query(rest);
      if (found.length === 0) return p.wantsUser === true ? answers.issues.noneWaiting : answers.issues.none;
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
      Effect.fn("Tool.issueCreate")(
        function* (p: Orchestrator<"issue.create">) {
          const c = yield* callerOf(who);
          if (p.draft === true && p.start === true) return answers.issueCreate.draftWithStartRefused;
          if (!mandateNoteFits(p.description ?? "")) return answers.issueCreate.noteTooLong;
          let channel: Info;
          if (p.channel) {
            const byName = yield* chat.channelByName(p.channel);
            if (!byName) return answers.issueCreate.noChannel(p.channel);
            channel = byName;
          } else channel = yield* chat.topOf(c.here);
          let parent: T.Issue | undefined;
          if (p.parent) {
            const parentId = yield* issue.idOf(p.parent);
            parent = yield* issue.get(parentId);
          }
          const blockedBy = yield* Effect.forEach(p.blockedBy ?? [], (ref) => Effect.map(issue.idOf(ref), S.issueId));
          const repo = (p.repo ?? parent?.repo ?? "").trim() || channel.repo;
          if (p.start === true && !repo) return answers.issueCreate.noDefaultRepo(channel.name);
          let agent: string | undefined = parent ? assignedAgentOf(parent) : undefined;
          if (p.agent || p.start === true) {
            const a = yield* choose(p.title + "\n" + (p.description ?? ""), p.agent ?? agent ?? "", p.start === true ? c.picked : "").pipe(
              Effect.mapError((why) => answers.issueCreate.notRecorded(why)),
            );
            agent = a.id;
          }
          const item = yield* issue
            .add(
              {
                title: p.title,
                ...(parent ? { parent: parent.id } : {}),
                ...(blockedBy.length > 0 ? { blockedBy } : {}),
                ...(p.description ? { description: p.description } : {}),
                ...(repo ? { repo } : {}),
                ...(agent ? { agent } : {}),
                ...(p.priority ? { priority: p.priority } : {}),
                ...(p.deliver ? { deliver: p.deliver } : {}),
              },
              actsForUser(c.actor) ? explicitMandate(c.envelope, p.autoSubmitPr ?? false) : inferredMandate(c.envelope),
            )
            .pipe(Effect.mapError((e) => answers.issueCreate.notRecordedFailed(said(e))));
          const noted = answers.issueCreate.noted(item.number, shortTitle(item.title), item.deliver === "answer");
          if (p.start === true) {
            // Written down first: a start that fails leaves the issue in the backlog, and trying again starts it, not a second one.
            const sent = yield* issue.start(item.id, channel.id).pipe(Effect.mapError((e) => answers.issueCreate.queuedNoStart(noted, said(e))));
            if (sent.queued) return answers.issueCreate.queuedInChannel(noted, channel.name, sent.queued);
            const h = sent.session ? run.sessionOf(sent.session) : undefined;
            const branch = h?.branch ? answers.issueCreate.branchNote(h.branch) : "";
            return answers.issueCreate.dispatched(
              noted,
              channel.name,
              h ? answers.issueCreate.who(h.name, h.id) : answers.issueCreate.noAgentFallback,
              h?.repo ?? repo,
              branch,
            );
          }
          if (p.draft !== true) return answers.issueCreate.inBacklog(noted, answers.issueCreate.notStartedNote);
          const refined = yield* issue.refine(item.id, [p.title, p.description ?? ""].join("\n").trim(), channel.id).pipe(
            Effect.as(answers.issueCreate.draftingNote),
            Effect.catch((e) => Effect.succeed(answers.issueCreate.draftFailed(said(e)))),
          );
          return answers.issueCreate.inBacklog(noted, refined);
        },
        Effect.catchIf(
          (e) => typeof e === "string",
          (e) => Effect.succeed(e),
        ),
      ),
    );

  const issueUpdate = (who: Who) =>
    tool(
      "issue.update",
      Effect.fn("Tool.issueUpdate")(
        function* (p: Orchestrator<"issue.update">) {
          const c = yield* callerOf(who);
          return yield* withIssue(p.id, (item) => {
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
                  ...(p.repo !== undefined ? { repo: p.repo } : {}),
                  ...(agent ? { agent } : {}),
                  ...(p.priority ? { priority: p.priority } : {}),
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
        const to = p.status;
        return yield* withIssue(
          p.id,
          Effect.fnUntraced(
            function* (item: T.Issue) {
              // Sent out with nobody named yet: chosen by the farm's rule, the user's pick first; another one named hands it over.
              let agent: string | undefined;
              if (p.agent || (to === "todo" && item.status === "backlog" && !assignedAgentOf(item))) {
                const chosen = yield* choose(item.title + "\n" + item.description, p.agent ?? "", p.agent ? "" : c.picked);
                agent = chosen.id;
              }
              const done = yield* issue.setStatus(item.id, to, p.text ?? "", c.here, c.actor, agent ? { agent: agent } : {});
              // Completing says what it delivered, which follows the issue: merged, no change, its branch kept, or a PR still open.
              if (to === "done" && done.status === "done") return `#${done.number} ${closedText(done)}`;
              if (to === "done" && done.pullRequest?.state === "open") return answers.issueStatus.prOpenNote(done.number, done.pullRequest.url);
              const now = yield* Clock.currentTimeMillis;
              return answers.issueStatus.moved(issueLine(done, whoOf(done), now).slice(2));
            },
            Effect.catch((e) => Effect.succeed(answers.issueStatus.notMoved(typeof e === "string" ? e : said(e)))),
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
