import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { isBusy, latestSessionIdOf } from "@vibevalley/protocol/rules";

import { ApiError, BizCode, lookIn, messageOf, missing, refuseIn } from "#/base/errors.ts";
import type { Core } from "#/core/core.ts";
import type { Logger } from "#/infra/log.ts";
import { issueBranch, type Repo } from "#/modules/repo/repo.ts";
import { type CheckoutChecks, type Merged, MergeFailure, RepoError, type Workplace } from "#/modules/repo/workplace.ts";

import { type Lifecycle, NotTakenIn } from "./lifecycle.ts";

const refused = refuseIn(BizCode.IssueRefused);

/** The structured issue_report carries the short result; the PR fallback keeps the worker's complete last answer. */
export const pullRequestConclusion = (text: string) => text.trim();

/** The issue module's side of delivering an issue's work: what the delivery writes on the issue at the points it
 * reaches, before its helper lets go, so the issue reads them first. */
export interface IssueRecord {
  /** The issue's conflict as the delivery found it; undefined once its work went in. */
  readonly conflict: (issue: string, conflict: T.Conflict | undefined) => Promise<void>;
  /** A pull request submitted for the issue: told in its thread and kept on it. Throws MergeFailure when it cannot be told. */
  readonly pullRequestSubmitted: (issue: T.Issue, pr: T.PullRequest) => Promise<void>;
  /** A followed pull request's new state, kept on the issue as it stands. */
  readonly pullRequestState: (issue: string, pr: T.PullRequest) => Promise<void>;
  /** A followed pull request merged or closed, and its issue finished with it. */
  readonly pullRequestFinished: (issue: T.Issue, state: T.PullRequestState) => Promise<void>;
}

/** An issue whose pull request is followed: finishes says its closing finishes the issue (else only its state is kept). */
export interface FollowedPullRequest {
  readonly issue: T.Issue;
  readonly finishes: boolean;
}

export interface Landing {
  /** The issue's work merged into main, or submitted as its pull request (one is open, or its repo goes by pull
   * requests): from its helper's workplace, which then lets go; from the issue's own checkout when no helper holds it
   * and fromCheckout. Throws NotTakenIn when the helper's work does not go in (the helper stays). */
  readonly merge: (issue: T.Issue, fromCheckout: boolean, record: IssueRecord) => Promise<string>;
  /** The helper's work submitted as the issue's pull request while it stays; read gives the issue under the helper's
   * workplace lock (refused when it is closed). Throws MergeFailure. */
  readonly submitPullRequest: (session: string, read: () => Promise<T.Issue>, summary: string | undefined, record: IssueRecord) => Promise<string>;
  /** Each followed pull request's state read; one merged or closed is kept, or finishes its issue. One that cannot be
   * read or finished now is tried again next time. */
  readonly refreshPullRequests: (followed: readonly FollowedPullRequest[], record: IssueRecord) => Promise<void>;
  /** A child's work checked and merged into its parent's branch (the parent's helper's workplace, else its checkout),
   * then its helper lets go; merged runs before it does. Undefined when it waits: the child's helper is gone or the
   * parent's works. Throws NotTakenIn when the work does not go in. */
  readonly mergeChild: (
    child: T.Issue,
    parent: T.Issue,
    checks: CheckoutChecks,
    merged: (frozen: readonly string[] | undefined) => Promise<void>,
  ) => Promise<Merged | undefined>;
  /** The issue's work: in its helper's workplace while one holds it, else on its branch; none without a repo or a branch.
   * Throws RepoError. */
  readonly changesOf: (issue: T.Issue) => Promise<T.Changes | undefined>;
  /** Whether the session's work still conflicts with base. */
  readonly conflictOf: (session: string, base: string) => Promise<T.Conflict | undefined>;
}

export interface LandingDeps {
  readonly core: Core;
  readonly log: Logger;
  readonly repo: Repo;
  readonly lifecycle: Pick<Lifecycle, "handOver" | "withWorkplace" | "withIdleWorkplace" | "sessionOf" | "isReachable">;
}

/** A repo's failure as a merge's: git or GitHub said no. */
const asMergeFailure = (e: unknown): unknown =>
  e instanceof MergeFailure ? e : e instanceof RepoError || e instanceof ApiError ? MergeFailure.error(e.message) : e;

/** A merge's or a repo's failure told as the issue's refusal. */
const asRefusal = (e: unknown): unknown => (e instanceof MergeFailure || e instanceof RepoError ? refused(e.message) : e);

export function makeLanding(deps: LandingDeps): Landing {
  const { core, repo: repos, lifecycle } = deps;
  const log = deps.log.child("landing");

  /** An issue's own checkout in its repo, when no helper holds it; kept for the next helper. */
  const withCheckout = async <A>(repo: string, issue: number, use: (place: Workplace) => Promise<A>) =>
    use(await repos.checkout({ repo, issue, worktree: true, base: "" }));

  const pullRequestOf = async (place: Workplace, issue: T.Issue, said: string, record: IssueRecord): Promise<Merged> => {
    let pr: T.PullRequest;
    try {
      pr = await repos.submitPullRequest(place, issue, pullRequestConclusion(said));
    } catch (e) {
      throw asMergeFailure(e);
    }
    await record.pullRequestSubmitted(issue, pr);
    return { pullRequest: pr, text: t("shared.join.labeled", { label: "PR", text: pr.url }), commits: 0 };
  };

  const handedOver = (id: string, use: (place: Workplace, said: string) => Promise<Merged>, record: IssueRecord) =>
    lifecycle.handOver(id, "merged", async (place, said) => {
      const merged = await use(place, said);
      const issue = lifecycle.sessionOf(id)?.issue;
      if (issue) await record.conflict(issue, undefined);
      return merged;
    });

  const mergeCheckout = async (issue: T.Issue, repo: string, record: IssueRecord) => {
    try {
      return await withCheckout(repo, issue.number, async (place) => {
        if (issue.pullRequest?.state === "open" || repos.usesPullRequests(repo)) return (await pullRequestOf(place, issue, issue.description, record)).text;
        let merged: Merged;
        try {
          merged = await repos.merge(place);
        } catch (error) {
          if (error instanceof MergeFailure && error.kind === "conflict") await record.conflict(issue.id, { base: error.base, files: [...error.files] });
          throw error;
        }
        await record.conflict(issue.id, undefined);
        return merged.text;
      });
    } catch (e) {
      throw asRefusal(e);
    }
  };

  const merge = async (issue: T.Issue, fromCheckout: boolean, record: IssueRecord): Promise<string> => {
    const last = latestSessionIdOf(issue);
    if (issue.repo && (!last || !lifecycle.isReachable(last)) && fromCheckout) return mergeCheckout(issue, issue.repo, record);
    if (last === undefined) throw refused(t("server.issue.notStarted"));
    if (!lifecycle.isReachable(last)) throw missing(t("server.issue.helperRef", { id: last }), [lookIn.session]);
    if (issue.repo && (issue.pullRequest?.state === "open" || repos.usesPullRequests(issue.repo)))
      return (await handedOver(last, (place, said) => pullRequestOf(place, issue, said, record), record)).text;
    const session = lifecycle.sessionOf(last);
    if (!session) throw missing(t("server.issue.helperRef", { id: last }), [lookIn.session]);
    const merged = await handedOver(last, (place) => repos.merge(place), record);
    core.notice("info", t("server.issue.merge.merged", { name: session.name, text: merged.text }));
    return merged.text;
  };

  const submitPullRequest = async (session: string, read: () => Promise<T.Issue>, summary: string | undefined, record: IssueRecord) => {
    const submitted = await lifecycle.withWorkplace(session, async (place) => {
      const issue = await read();
      return pullRequestOf(place, issue, summary ?? [issue.title, issue.description].filter(Boolean).join("\n\n"), record);
    });
    return submitted.text;
  };

  const finishPullRequest = async (issue: T.Issue, state: T.PullRequestState, record: IssueRecord) => {
    const closed = state === "closed" ? "dismissed" : "merged";
    const id = latestSessionIdOf(issue);
    if (id && lifecycle.isReachable(id)) {
      try {
        await lifecycle.handOver(id, closed, (place) => repos.finishPullRequest(place.repo, issue.number));
      } catch (e) {
        if (e instanceof NotTakenIn) throw refused(e.failure.reasonText);
        throw e;
      }
    } else if (issue.repo) {
      try {
        await repos.finishPullRequest(issue.repo, issue.number);
      } catch (e) {
        throw asRefusal(e);
      }
    }
    await record.pullRequestFinished(issue, state);
  };

  const refreshPullRequests = async (followed: readonly FollowedPullRequest[], record: IssueRecord) => {
    for (const { issue, finishes } of followed) {
      if (issue.pullRequest?.state !== "open" || !issue.repo) continue;
      try {
        const state = await repos.pullRequestState(issue.repo, issue.pullRequest.number);
        if (state === "open") continue;
        if (finishes) await finishPullRequest(issue, state, record);
        else await record.pullRequestState(issue.id, { ...issue.pullRequest, state });
      } catch (e) {
        // One pull request that cannot be read or finished now is tried again on the next round; the rest go on.
        if (!(e instanceof RepoError || e instanceof ApiError || e instanceof MergeFailure)) throw e;
        log.warn(`vibevalley: refresh pull requests: issue #${issue.number}: ${e.message}`);
      }
    }
  };

  const mergeChild = async (child: T.Issue, parent: T.Issue, checks: CheckoutChecks, merged: (frozen: readonly string[] | undefined) => Promise<void>) => {
    const parentRepo = parent.repo;
    const session = latestSessionIdOf(child);
    if (!parentRepo || !session || !lifecycle.isReachable(session)) return undefined;
    const parentSession = latestSessionIdOf(parent);
    const parentWorker = parentSession ? lifecycle.sessionOf(parentSession) : undefined;
    if (parentWorker && isBusy(parentWorker)) return undefined;
    return lifecycle.handOver(
      session,
      "completed",
      async (place) => {
        const frozen = await repos.verifyCheckout(place, issueBranch(parent.number), checks);
        const mergeIntoParent = (target: Workplace) => repos.mergeInto(place, issueBranch(parent.number), target.cwd);
        let into: Merged;
        if (parentSession && lifecycle.isReachable(parentSession)) {
          try {
            into = await lifecycle.withIdleWorkplace(parentSession, mergeIntoParent);
          } catch (error) {
            throw error instanceof MergeFailure ? error : MergeFailure.error(messageOf(error));
          }
        } else into = await withCheckout(parentRepo, parent.number, mergeIntoParent);
        await merged(frozen);
        return into;
      },
      "helper",
    );
  };

  const changesOf = async (issue: T.Issue): Promise<T.Changes | undefined> => {
    const session = latestSessionIdOf(issue);
    if (session && lifecycle.isReachable(session)) return lifecycle.withWorkplace(session, (place) => repos.changes(place));
    return issue.repo ? repos.branchChanges(issue.repo, issueBranch(issue.number)) : undefined;
  };

  return {
    merge,
    submitPullRequest,
    refreshPullRequests,
    mergeChild,
    changesOf,
    conflictOf: (session, base) => lifecycle.withWorkplace(session, (place) => repos.conflict(place, base)),
  };
}
