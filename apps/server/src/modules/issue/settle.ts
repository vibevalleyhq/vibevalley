import { list, t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { IssueStatusValues } from "@vibevalley/protocol";
import { assignmentOf, assignedAgentOf, isOneOf, latestSessionIdOf, sessionIdsOf } from "@vibevalley/protocol/rules";

import { BizCode, lookIn, refuseIn } from "#/base/errors.ts";
import type { Time } from "#/infra/time.ts";
import type { Agent } from "#/modules/agent/agent.ts";
import { issueBranch, type Repo } from "#/modules/repo/repo.ts";
import { RepoError } from "#/modules/repo/workplace.ts";
import type { Runtime } from "#/modules/runtime/runtime.ts";
import { conflictBrief } from "#/modules/session/briefing.ts";
import type { Session } from "#/modules/session/session.ts";

import { answerCureWords, cureWords, findingsOf, resumeWords } from "./brief.ts";
import type { IssueDispatch } from "./dispatch.ts";
import type { IssueLanding } from "./landing.ts";
import type { IssueLifecycle } from "./lifecycle.ts";
import { type Move, nextSteps, statusMove } from "./moves.ts";
import { nullText } from "./rows.ts";
import { assignedOnDuty } from "./status.ts";

const refused = refuseIn(BizCode.IssueRefused);

export interface StatusOptions {
  /** Moving to todo: the profile that takes it on (a name or an id). */
  readonly agent?: string;
}

export interface SettleDeps {
  readonly agent: Agent;
  readonly repo: Repo;
  readonly runtime: Runtime;
  readonly session: Session;
  readonly clock: Time;
  readonly landing: Pick<IssueLanding, "changesOf">;
}

/** A status move settled before anything changes: what it is, the words it goes with, who takes the issue on. */
export interface SettledMove {
  readonly issue: T.Issue;
  readonly to: T.IssueStatus;
  readonly move: Exclude<Move, "none">;
  readonly said: string;
  readonly taker: T.Agent | undefined;
  readonly delivery: "kept" | "none" | "merge" | "submitted" | "submit" | undefined;
  readonly commits: number;
}

export function issueSettling(r: IssueLifecycle, d: Pick<IssueDispatch, "readyOf">, deps: SettleDeps) {
  const { agent: store, repo: repos, runtime: runtimes, session: sessions, clock } = deps;
  const { changesOf } = deps.landing;
  const { unsent } = r;
  const { readyOf } = d;
  /** The commits on the issue's branch that the main branch does not have. */
  const commitsOf = async (issue: T.Issue) => {
    if (!issue.repo) return 0;
    try {
      return (await repos.branchChanges(issue.repo, issueBranch(issue.number)))?.commits.length ?? 0;
    } catch (e) {
      if (e instanceof RepoError) throw refused(e.message);
      throw e;
    }
  };

  /** The profile that takes an issue on as it moves to todo. undefined when it is the one it has. */
  const takerOf = async (issue: T.Issue, to: T.IssueStatus, key: string) => {
    const a = store.named(key.trim());
    if (!a) throw refused(t("server.issue.noProfileNamed", { key }), [lookIn.agent]);
    if (a.id === assignedAgentOf(issue)) return undefined;
    if (to !== "todo") throw refused(t("server.issue.handOverOnTodo"));
    if (issue.status === "in_progress" && issue.stage.state === "working") throw refused(t("server.issue.stopFirst", { n: issue.number }));
    if (!a.enabled) throw refused(t("server.issue.disabled", { name: a.name }));
    for (const i of await runtimes.problemsOf(a)) if (i.level === "error") throw refused(t("server.issue.cannotSend", { name: a.name, why: i.text }));
    return a;
  };

  /** The issue as a move would see it once the user's unsaved fields are saved (issue.status saves them first). */
  const withEdit = async (issue: T.Issue, edit: T.IssueUpdate | undefined) => {
    if (!edit) return issue;
    const reworded = Object.keys(edit).some((k) => k !== "deliver");
    if (reworded) await unsent(issue.id);
    const { agent, ...fields } = edit;
    if (agent === undefined) return { ...issue, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) };
    const nextAgent = nullText(agent);
    const current = assignmentOf(issue);
    const at = clock.now();
    const assignments = [
      ...issue.assignments.map((assignment) => (assignment.id === current?.id && assignment.agent !== nextAgent ? { ...assignment, endedAt: at } : assignment)),
      ...(nextAgent && current?.agent !== nextAgent
        ? [{ id: "preview", issue: issue.id, agent: nextAgent, assignedAt: at, executions: [] } satisfies T.Assignment]
        : []),
    ];
    return { ...issue, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)), assignments };
  };

  /** The move and what it settles before anything changes. refused as the move itself would be. */
  const settledMove = async (issue: T.Issue, to: T.IssueStatus, text: string, opt: StatusOptions): Promise<SettledMove> => {
    if (!isOneOf(IssueStatusValues, to)) throw refused(t("server.issue.noStatus", { to }));
    const taker = opt.agent ? await takerOf(issue, to, opt.agent) : undefined;
    const [move, why] = statusMove(issue, to);
    const said = text.trim();
    if (move === "none") throw refused(why, nextSteps(issue));
    // Stuck, it goes back with the server's own words for why; otherwise the user says what this round is for.
    if (move === "round" && !taker && !said && issue.stage.state !== "stuck") throw refused(t("server.issue.roundNeedsWords"));
    let delivery: SettledMove["delivery"];
    let commits = 0;
    if (move === "complete") {
      const needsPr = issue.deliver === "pull_request" && (!issue.pullRequest || issue.pullRequest.state === "closed");
      if (needsPr && (!issue.repo || !repos.usesPullRequests(issue.repo))) throw refused(t("server.issue.deliveryNeedsPr"));
      commits = await commitsOf(issue);
      delivery = needsPr ? "submit" : issue.deliver === "pull_request" ? "submitted" : commits === 0 ? "none" : issue.deliver === "branch" ? "kept" : "merge";
    }
    return { issue, to, move, said, taker, delivery, commits };
  };

  const helperName = (issue: T.Issue) => {
    const last = latestSessionIdOf(issue);
    return (last !== undefined ? sessions.live(last).session?.name : undefined) ?? t("server.issue.helper");
  };

  const stuckWords = async (issue: T.Issue) => {
    const last = latestSessionIdOf(issue);
    switch (issue.stage.stuck) {
      case "conflict": {
        const conflict = issue.conflict;
        if (!conflict) throw refused(t("server.issue.noConflict", { name: helperName(issue) }));
        return conflictBrief(conflict.base, conflict.files);
      }
      case "failed": {
        const lastRun = last !== undefined ? sessions.live(last).session?.lastRun : undefined;
        const unread = issue.deliver === "answer" && lastRun?.outcome === "completed" && !lastRun.answer;
        return unread
          ? answerCureWords(t("server.session.answer.noBlock"))
          : cureWords((last !== undefined ? sessions.live(last).session?.brief : undefined) ?? issue.title);
      }
      case "interrupted":
        return resumeWords();
      // Quiet, or not stuck: the server has no words of its own for the round.
      case "quiet":
      default:
        throw refused(t("server.issue.roundNeedsWords"));
    }
  };

  /** A settled move in words, one step a line; what it reads to say so (who would go, the room, a merge's conflicts) is read, not changed. */
  const movesWords = async (p: SettledMove): Promise<string[]> => {
    const item = p.issue;
    const n = `#${item.number}`;
    switch (p.move) {
      case "start": {
        if (assignedOnDuty(item, store.isOrchestrator)) return [t("server.issue.does.toOrchestrator", { n })];
        const [, agent, repo] = await readyOf(item, p.taker?.id);
        const full = sessions.room(agent.runtime, repo);
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
          await stuckWords(item);
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
        if (p.delivery === "submitted") return [t("server.issue.acceptSubmittedPr")];
        if (p.delivery === "none") return [t("server.issue.does.completeNone", { n }), t("server.issue.does.helperLeaves", { helper: helperName(item) })];
        if (p.delivery === "kept")
          return [t("server.issue.does.completeKept", { n, commits: p.commits }), t("server.issue.does.helperLeaves", { helper: helperName(item) })];
        const changes = await changesOf(item);
        const pr = item.repo !== undefined && (item.pullRequest?.state === "open" || repos.usesPullRequests(item.repo));
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
  };

  return { commitsOf, takerOf, withEdit, settledMove, helperName, stuckWords, movesWords };
}
