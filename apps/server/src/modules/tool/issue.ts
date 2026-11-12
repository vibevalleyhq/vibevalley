import { z } from "zod";

import type * as T from "@vibevalley/protocol";
import { defaultOrchestrator } from "@vibevalley/protocol";
import { isApiError } from "@vibevalley/protocol/api";
import { assignedAgentOf, closedText, latestSessionIdOf, phaseText, shortTitle } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";

import { head } from "#/base/clip.ts";
import { AgentChoiceRefused, IssueCreateRefused } from "#/modules/issue/issue.ts";
import { openFindings } from "#/modules/issue/status.ts";

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
import { type Who, type Orchestrator, type SessionInput, said, answered, callerOf, customTool, tool, sessionSchemaTool } from "./schemas.ts";
import type { ToolDeps } from "./tool.ts";

type IssueTool = "issue.get" | "issue.diff.get" | "session.stop";
const spaces = /\s+/gu;
const IssueReportInput = z.object({
  summary: z.string(),
  questions: z.exactOptional(z.array(S.Question)),
  checks: z.exactOptional(z.array(S.CriterionCheck)),
  remember: z.exactOptional(z.array(S.IssueReportMemory)),
  prSubmit: z.exactOptional(z.boolean()),
  answer: z.exactOptional(S.IssueAnswer),
});
const IssueHandbackInput = z.object({ envelope: z.string(), reason: z.string() });
const IssuePrSubmitInput = z.object({ summary: z.exactOptional(z.string()) });

/** An issue the model named that is not on the farm: its message is the answer the model reads. */
class IssueNotFound extends Error {
  override readonly name = "IssueNotFound";
}

const choiceWords = (choice: AgentChoiceRefused): string =>
  choice.kind === "noneAvailable" ? answers.noAgentToDispatch : answers.noAgentOrRuntime(choice.key);

const createRefusalWords = (refusal: IssueCreateRefused): string => {
  switch (refusal.reason) {
    case "draftWithStart":
      return answers.issueCreate.draftWithStartRefused;
    case "noteTooLong":
      return answers.issueCreate.noteTooLong;
    case "noChannel":
      return answers.issueCreate.noChannel(refusal.channel ?? "");
    case "noDefaultRepo":
      return answers.issueCreate.noDefaultRepo(refusal.channel ?? "");
    case "agentChoice":
      return answers.issueCreate.notRecorded(refusal.choice ? choiceWords(refusal.choice) : answers.noAgentToDispatch);
    case "notRecorded":
      return answers.issueCreate.notRecordedFailed(refusal.error ? said(refusal.error) : "");
  }
};

export function issueTools(deps: Pick<ToolDeps, "clock" | "log" | "agent" | "session" | "issue">) {
  const { clock, agent: agents, session: run, issue } = deps;
  const log = deps.log.child("tool");

  // Resolves `#41`, `41`, an issue id, or the name or id of a helper working it via Issue.get / Issue.idOf.
  const findIssue = async (key: string): Promise<T.Issue> => {
    const k = key.trim().replace(/^#/u, "");
    try {
      return await issue.get(key);
    } catch (e) {
      if (!isApiError(e)) throw e;
      throw new IssueNotFound(/^\d+$/u.test(k) ? answers.noIssueNumber(k) : answers.noIssueOrAgent(k), { cause: e });
    }
  };

  const withIssue = async (key: string, f: (issue: T.Issue) => Promise<string>): Promise<string> => {
    let item: T.Issue;
    try {
      item = await findIssue(key);
    } catch (e) {
      if (e instanceof IssueNotFound) return e.message;
      throw e;
    }
    return f(item);
  };

  const issueTool = (op: IssueTool, f: (issue: T.Issue) => Promise<string>) => tool(op, (p) => withIssue(p.id, f));

  /** The helper on the farm working the issue now, if any: its newest session. */
  const workerOf = (item: T.Issue) => {
    const last = latestSessionIdOf(item);
    return last === undefined ? undefined : run.live(last).session;
  };

  const whoOf = (item: T.Issue) => {
    const agent = assignedAgentOf(item);
    return workerOf(item)?.name ?? (agent === defaultOrchestrator ? userAgentWord : agent ? (agents.agent(agent)?.name ?? "") : "");
  };

  const nobodyOn = (item: T.Issue) => answers.nobodyOn(item.number);

  const numberOf = (session: T.Session) => (session.issue ? issue.onBoard().find((item) => item.id === session.issue)?.number : undefined);

  const roster = tool("session.list", () => {
    const all = run.hired();
    return all.length === 0 ? answers.roster.empty : all.map((session) => sessionLine(session, clock.now(), numberOf(session))).join("\n");
  });

  const sessionList = sessionSchemaTool("session.list", () => {
    // Listed without @: an @ wakes someone, and models copy what they read.
    const lines = [answers.sessionList.intro];
    for (const h of run.hired())
      lines.push(answers.sessionList.row(h.id, h.name, h.runtime, h.repo ?? "?", phaseText(h, clock.now()), head(h.brief.replace(spaces, " "), 60)));
    lines.push(answers.sessionList.wake);
    return lines.join("\n");
  });

  const issueReport = (who: Who) =>
    customTool("issue_report", issueReportDescription, IssueReportInput, async (report) => {
      const caller = callerOf(who);
      if (!caller.session) return issueReportRecorded(false);
      if (report.prSubmit === true) await issue.submitPullRequest(caller.session, report.summary);
      await run.report(caller.session, {
        ...report,
        questions: report.questions ?? [],
        checks: report.checks ?? [],
        remember: report.remember ?? [],
        prSubmit: report.prSubmit ?? false,
      });
      return issueReportRecorded(true);
    });

  const issueHandback = (who: Who) =>
    customTool("issue_handback", issueHandbackDescription, IssueHandbackInput, async ({ envelope, reason }) => {
      const caller = callerOf(who);
      await run.decline(caller.session, envelope, reason);
      return issueHandbackRecorded;
    });

  const issuePrSubmit = (who: Who) =>
    customTool("issue_pr_submit", issuePrSubmitDescription, IssuePrSubmitInput, async ({ summary }) => {
      const caller = callerOf(who);
      const pullRequestSubmitted = await issue.submitPullRequest(caller.session, summary);
      return issuePrSubmitted(pullRequestSubmitted);
    });

  const issueGet = issueTool("issue.get", async (item) => {
    const w = workerOf(item);
    let timeline: T.IssueTimeline | undefined;
    try {
      timeline = await issue.timeline(item.id);
    } catch (e) {
      // The detail reads without its milestones rather than not at all.
      log.warn("issue.get: no timeline for", item.id, e);
    }
    const now = clock.now();
    const lines = [issueDetail(item, whoOf(item), timeline, now)];
    if (w) lines.push(sessionLine(w, now, item.number), answers.check.workdir(run.live(w.id).cwd ?? ""), answers.check.lastReport(run.live(w.id).lastText));
    return lines.join("\n");
  });

  const issueDiff = (who: Who) =>
    issueTool("issue.diff.get", async (item) => {
      try {
        const c = callerOf(who);
        return changesText(await issue.changes(item.id, c.actor));
      } catch (e) {
        return answers.changes.failed(said(e));
      }
    });

  // Review is judging what came back against what the issue asked for; a pass only makes it ready, completing it stays
  // the user's (issue_status_update to done).
  const issueReview = tool("issue.review", async (p: Orchestrator<"issue.review">) => {
    try {
      return await withIssue(p.id, async (item) => {
        const done = await issue.review(item.id, { pass: p.pass, ...(p.findings ? { findings: p.findings } : {}), ...(p.text ? { text: p.text } : {}) });
        return p.pass ? answers.accept.passed(done.number) : answers.accept.failed(done.number, openFindings(done));
      });
    } catch (e) {
      return said(e);
    }
  });

  const issueComment = (who: Who) =>
    tool("issue.comment.create", async (p: Orchestrator<"issue.comment.create">) => {
      try {
        const c = callerOf(who);
        return await withIssue(p.id, async (item) => {
          const receipt = await issue.comment(item.id, p.text, "", c.actor);
          return receipt.worker ? answers.tell.told(item.number, receipt.worker.name) : nobodyOn(item);
        });
      } catch (e) {
        return answers.tell.failed(said(e));
      }
    });

  const sessionStop = (who: Who) =>
    issueTool("session.stop", async (item) => {
      try {
        callerOf(who);
        await issue.stop(item.id);
        return answers.stop.stopped(item.number);
      } catch (e) {
        return said(e);
      }
    });

  const issueList = tool("issue.list", async (p: Orchestrator<"issue.list">) => {
    const { limit: _, ...rest } = p;
    const found = await issue.query(rest);
    if (found.length === 0) return p.wantsUser === true ? answers.issues.noneWaiting : answers.issues.none;
    const now = clock.now();
    const limit = p.limit != null && p.limit > 0 ? Math.trunc(p.limit) : 20;
    const more = found.length > limit ? answers.issues.moreNote(found.length - limit) : "";
    return (
      found
        .slice(0, limit)
        .map((item) => issueLine(item, whoOf(item), now))
        .join("\n") + more
    );
  });

  const issueCreate = (who: Who) =>
    tool("issue.create", async (p: Orchestrator<"issue.create">) => {
      try {
        const c = callerOf(who);
        const created = await issue.create({
          title: p.title,
          ...(p.parent ? { parent: p.parent } : {}),
          ...(p.blockedBy ? { blockedBy: p.blockedBy } : {}),
          ...(p.description ? { description: p.description } : {}),
          ...(p.repo ? { repo: p.repo } : {}),
          ...(p.agent ? { agent: p.agent } : {}),
          ...(p.priority ? { priority: p.priority } : {}),
          ...(p.deliver ? { deliver: p.deliver } : {}),
          ...(p.autoSubmitPr !== undefined ? { autoSubmitPr: p.autoSubmitPr } : {}),
          by: c.actor,
          envelope: c.envelope,
          channel: p.channel || c.here,
          channelByName: Boolean(p.channel),
          pickedAgent: c.picked,
          chooseAgent: Boolean(p.agent) || p.start === true,
          enforceNoteLimit: true,
          ...(p.start !== undefined ? { start: p.start } : {}),
          ...(p.draft !== undefined ? { draft: p.draft } : {}),
        });
        const item = created.issue;
        const noted = answers.issueCreate.noted(item.number, shortTitle(item.title), item.deliver === "answer");
        switch (created.step._tag) {
          case "Backlog":
            return answers.issueCreate.inBacklog(noted, answers.issueCreate.notStartedNote);
          case "StartFailed":
            return answers.issueCreate.queuedNoStart(noted, said(created.step.error));
          case "Dispatched": {
            if (created.step.queued) return answers.issueCreate.queuedInChannel(noted, created.step.channelName, created.step.queued);
            const h = created.step.session;
            const branch = h?.branch ? answers.issueCreate.branchNote(h.branch) : "";
            return answers.issueCreate.dispatched(
              noted,
              created.step.channelName,
              h ? answers.issueCreate.who(h.name, h.id) : answers.issueCreate.noAgentFallback,
              created.step.repo,
              branch,
            );
          }
          case "Drafting":
            return answers.issueCreate.inBacklog(noted, answers.issueCreate.draftingNote);
          case "DraftFailed":
            return answers.issueCreate.inBacklog(noted, answers.issueCreate.draftFailed(said(created.step.error)));
        }
      } catch (e) {
        return e instanceof IssueCreateRefused ? createRefusalWords(e) : said(e);
      }
    });

  const issueUpdate = (who: Who) =>
    tool("issue.update", async (p: Orchestrator<"issue.update">) => {
      try {
        const c = callerOf(who);
        return await withIssue(p.id, async (item) => {
          let agent: string | undefined;
          if (p.agent) {
            const a = agents.named(p.agent);
            if (!a) return answers.noProfileNamed(p.agent);
            agent = a.id;
          }
          const done = await issue.edit(
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
          );
          return answers.issueUpdate.updated(issueLine(done, whoOf(done), clock.now()).slice(2));
        });
      } catch (e) {
        return answers.issueUpdate.failed(said(e));
      }
    });

  const issueStatus = (who: Who) =>
    tool("issue.status.update", async (p: Orchestrator<"issue.status.update">) => {
      const c = callerOf(who);
      const to = p.status;
      return withIssue(p.id, async (item) => {
        try {
          // Sent out with nobody named yet: chosen by the farm's rule, the user's pick first; another one named hands it over.
          let agent: string | undefined;
          if (p.agent || (to === "todo" && item.status === "backlog" && !assignedAgentOf(item))) {
            const chosen = await issue.chooseAgent(item.title + "\n" + item.description, p.agent ?? "", p.agent ? "" : c.picked);
            agent = chosen.id;
          }
          const done = await issue.setStatus(item.id, to, p.text ?? "", c.here, c.actor, agent ? { agent: agent } : {});
          // Completing says what it delivered, which follows the issue: merged, no change, its branch kept, or a PR still open.
          if (to === "done" && done.status === "done") return `#${done.number} ${closedText(done)}`;
          if (to === "done" && done.pullRequest?.state === "open") return answers.issueStatus.prOpenNote(done.number, done.pullRequest.url);
          return answers.issueStatus.moved(issueLine(done, whoOf(done), clock.now()).slice(2));
        } catch (e) {
          return answers.issueStatus.notMoved(e instanceof AgentChoiceRefused ? choiceWords(e) : said(e));
        }
      });
    });

  const issueSplit = (who: Who) =>
    sessionSchemaTool("issue.split", async (p: SessionInput<"issue.split">) => {
      const caller = callerOf(who);
      const drafts = p.tasks.map((item) => ({ ...item, needs: item.needs ?? [], scope: item.scope ?? [] }));
      return answered(async () => issue.split(await issue.idOf(caller.session), p.title ?? "", drafts, caller.actor));
    });

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
}
