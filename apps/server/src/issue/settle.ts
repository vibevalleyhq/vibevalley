import { Clock, Effect } from "effect";

import { list, t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { IssueStatusValues } from "@vibevalley/protocol";
import { assignmentOf, assignedAgentOf, isOneOf, latestSessionIdOf, sessionIdsOf } from "@vibevalley/protocol/rules";

import { Agent } from "#/agent/agent.ts";
import { lookIn, refused } from "#/base/errors.ts";
import { issueBranch, Repo } from "#/repo/repo.ts";
import { Runtime } from "#/runtime/runtime.ts";
import { conflictBrief } from "#/session/briefing.ts";
import { Session } from "#/session/session.ts";

import { answerCureWords, cureWords, findingsOf, resumeWords } from "./brief.ts";
import type { IssueDispatch } from "./dispatch.ts";
import type { IssueLifecycle } from "./lifecycle.ts";
import { nextSteps, statusMove } from "./moves.ts";
import { nullText } from "./rows.ts";
import { isForOrchestrator } from "./status.ts";

export interface StatusOptions {
  /** Moving to todo: the profile that takes it on (a name or an id). */
  readonly agent?: string;
}

export const issueSettling = (r: IssueLifecycle, d: Pick<IssueDispatch, "readyOf">) =>
  Effect.gen(function* () {
    const store = yield* Agent;
    const repos = yield* Repo;
    const runtimes = yield* Runtime;
    const sessions = yield* Session;
    const { unsent, changesOf } = r;
    const { readyOf } = d;
    /** The commits on the issue's branch that the main branch does not have; none for one without a repo or branch. */
    const commitsOf = (issue: T.Issue) =>
      issue.repo
        ? Effect.mapBoth(repos.branchChanges(issue.repo, issueBranch(issue.number)), {
            onFailure: (e) => refused(e.message),
            onSuccess: (c) => c?.commits.length ?? 0,
          })
        : Effect.succeed(0);

    /** The profile that takes an issue on as it moves to todo. undefined when it is the one it has. */
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

    /** The issue as a move would see it once the owner's unsaved fields are saved (issue.status saves them first). */
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
        ...issue.assignments.map((assignment) =>
          assignment.id === current?.id && assignment.agent !== nextAgent ? { ...assignment, endedAt: at } : assignment,
        ),
        ...(nextAgent && current?.agent !== nextAgent
          ? [{ id: "preview", issue: issue.id, agent: nextAgent, assignedAt: at, executions: [] } satisfies T.Assignment]
          : []),
      ];
      return { ...issue, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)), assignments };
    });

    /** The move and what it settles before anything changes. refused as the move itself would be. */
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
          const [, agent, repo] = yield* readyOf(item, p.taker?.id);
          const full = sessions.noRoom(agent.runtime, repo);
          return full
            ? [t("server.issue.does.sendTo", { n, agent: agent.name }), t("server.issue.does.noRoom", { full })]
            : [repo ? t("server.issue.does.startIn", { n, agent: agent.name, repo }) : t("server.issue.does.start", { n, agent: agent.name })];
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
          const pr = item.repo !== undefined && (item.pullRequest?.state === "open" || repos.usesPullRequests(item.repo));
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

    return { commitsOf, takerOf, withEdit, settledMove, helperName, stuckWords, movesWords };
  });
