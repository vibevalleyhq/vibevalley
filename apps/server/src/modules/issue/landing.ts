import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { isBusy, latestSessionIdOf } from "@vibevalley/protocol/rules";

import { ApiError, BizCode, lookIn, messageOf, missing, refuseIn } from "#/base/errors.ts";
import type { Core } from "#/core/core.ts";
import type { Logger } from "#/infra/log.ts";
import type { Channel } from "#/modules/channel/channel.ts";
import { issueBranch, type Repo } from "#/modules/repo/repo.ts";
import { type CheckoutChecks, type Merged, MergeFailure, RepoError, type Workplace } from "#/modules/repo/workplace.ts";
import { NotTakenIn, type Session } from "#/modules/session/session.ts";

import type { IssueLifecycle } from "./lifecycle.ts";

const refused = refuseIn(BizCode.IssueRefused);

/** The structured issue_report carries the short result; the PR fallback keeps the worker's complete last answer. */
export const pullRequestConclusion = (text: string) => text.trim();

/** An issue whose pull request is followed: finishes says its closing finishes the issue (else only its state is kept). */
export interface FollowedPullRequest {
  readonly issue: T.Issue;
  readonly finishes: boolean;
}

/** The issue's work goes in as a pull request: one is open, or its repo goes by pull requests. */
export const goesByPullRequest = (issue: Pick<T.Issue, "pullRequest">, usesPullRequests: boolean) => issue.pullRequest?.state === "open" || usesPullRequests;

/** How an issue's work goes in: from its own checkout (no helper holds it and its children merged into it), refused
 * (never started, or its helper is gone), or from its helper's workplace as a pull request or a merge into main. */
export type LandingRoute =
  | { readonly kind: "checkout"; readonly repo: string }
  | { readonly kind: "notStarted" }
  | { readonly kind: "helperGone" | "pullRequest" | "merge"; readonly session: string };

export function landingRouteOf(
  issue: Pick<T.Issue, "repo" | "pullRequest">,
  helper: { readonly last: string | undefined; readonly reachable: boolean },
  fromCheckout: boolean,
  usesPullRequests: boolean,
): LandingRoute {
  const { last, reachable } = helper;
  if (issue.repo && (!last || !reachable) && fromCheckout) return { kind: "checkout", repo: issue.repo };
  if (last === undefined) return { kind: "notStarted" };
  if (!reachable) return { kind: "helperGone", session: last };
  if (issue.repo && goesByPullRequest(issue, usesPullRequests)) return { kind: "pullRequest", session: last };
  return { kind: "merge", session: last };
}

export interface LandingDeps {
  readonly core: Core;
  readonly log: Logger;
  readonly repo: Repo;
  readonly session: Session;
  readonly channel: Channel;
}

/** A repo's failure as a merge's: git or GitHub said no. */
const asMergeFailure = (e: unknown): unknown =>
  e instanceof MergeFailure ? e : e instanceof RepoError || e instanceof ApiError ? MergeFailure.error(e.message) : e;

/** A merge's or a repo's failure told as the issue's refusal. */
const asRefusal = (e: unknown): unknown => (e instanceof MergeFailure || e instanceof RepoError ? refused(e.message) : e);

/** An issue's work delivered: merged into main, submitted as its pull request, or (a child's) merged into its parent's
 * branch, from its helper's workplace (which then lets go) or from the issue's own checkout; and its pull request
 * followed to its end. What the delivery finds is written on the issue at each point, before its helper lets go, so
 * the issue reads it first. */
export function issueLanding(r: Pick<IssueLifecycle, "setConflict" | "savePullRequest" | "finishPullRequest">, deps: LandingDeps) {
  const { core, repo: repos, session: sessions, channel: chat } = deps;
  const log = deps.log.child("landing");
  const { setConflict, savePullRequest } = r;
  const reachable = (id: string) => sessions.live(id).reachable;

  /** An issue's own checkout in its repo, when no helper holds it; kept for the next helper. */
  const withCheckout = async <A>(repo: string, issue: number, use: (place: Workplace) => Promise<A>) =>
    use(await repos.checkout({ repo, issue, worktree: true, base: "" }));

  /** A pull request submitted for the issue: told in its thread and kept on it. Throws MergeFailure when it cannot be told. */
  const pullRequestSubmitted = async (issue: T.Issue, pr: T.PullRequest) => {
    let thread: string;
    try {
      thread = await chat.issueThread(issue.id, issue.title);
    } catch (e) {
      throw e instanceof ApiError ? MergeFailure.error(e.message) : e;
    }
    await chat.post({
      _tag: "Notice",
      channel: thread,
      text: t("server.issue.prDelivered", { url: pr.url }),
      code: "issue_pr_delivery",
      sendKey: `issue-pr:${issue.id}:${pr.url}`,
    });
    await savePullRequest(issue.id, pr);
  };

  const pullRequestOf = async (place: Workplace, issue: T.Issue, said: string): Promise<Merged> => {
    let pr: T.PullRequest;
    try {
      pr = await repos.submitPullRequest(place, issue, pullRequestConclusion(said));
    } catch (e) {
      throw asMergeFailure(e);
    }
    await pullRequestSubmitted(issue, pr);
    return { pullRequest: pr, text: t("shared.join.labeled", { label: "PR", text: pr.url }), commits: 0 };
  };

  const handedOver = (id: string, use: (place: Workplace, said: string) => Promise<Merged>) =>
    sessions.handOver(id, "merged", async (place, said) => {
      const merged = await use(place, said);
      const issue = sessions.live(id).session?.issue;
      if (issue) await setConflict(issue, undefined);
      return merged;
    });

  const mergeCheckout = async (issue: T.Issue, repo: string) => {
    try {
      return await withCheckout(repo, issue.number, async (place) => {
        if (goesByPullRequest(issue, repos.usesPullRequests(repo))) return (await pullRequestOf(place, issue, issue.description)).text;
        let merged: Merged;
        try {
          merged = await repos.merge(place);
        } catch (error) {
          if (error instanceof MergeFailure && error.kind === "conflict") await setConflict(issue.id, { base: error.base, files: [...error.files] });
          throw error;
        }
        await setConflict(issue.id, undefined);
        return merged.text;
      });
    } catch (e) {
      throw asRefusal(e);
    }
  };

  /** The issue's work merged into main, or submitted as its pull request (one is open, or its repo goes by pull
   * requests): from its helper's workplace, which then lets go; from the issue's own checkout when no helper holds it
   * and fromCheckout. Throws NotTakenIn when the helper's work does not go in (the helper stays). */
  const merge = async (issue: T.Issue, fromCheckout: boolean): Promise<string> => {
    const last = latestSessionIdOf(issue);
    const usesPullRequests = issue.repo ? repos.usesPullRequests(issue.repo) : false;
    const route = landingRouteOf(issue, { last, reachable: last !== undefined && reachable(last) }, fromCheckout, usesPullRequests);
    switch (route.kind) {
      case "checkout":
        return mergeCheckout(issue, route.repo);
      case "notStarted":
        throw refused(t("server.issue.notStarted"));
      case "helperGone":
        throw missing(t("server.issue.helperRef", { id: route.session }), [lookIn.session]);
      case "pullRequest":
        return (await handedOver(route.session, (place, said) => pullRequestOf(place, issue, said))).text;
      case "merge": {
        const session = sessions.live(route.session).session;
        if (!session) throw missing(t("server.issue.helperRef", { id: route.session }), [lookIn.session]);
        const merged = await handedOver(route.session, (place) => repos.merge(place));
        core.notice("info", t("server.issue.merge.merged", { name: session.name, text: merged.text }));
        return merged.text;
      }
    }
  };

  /** The helper's work submitted as the issue's pull request while it stays; read gives the issue under the helper's
   * workplace lock (refused when it is closed). Throws MergeFailure. */
  const submitPullRequest = async (session: string, read: () => Promise<T.Issue>, summary: string | undefined) => {
    const submitted = await sessions.withWorkplace(session, async (place) => {
      const issue = await read();
      return pullRequestOf(place, issue, summary ?? [issue.title, issue.description].filter(Boolean).join("\n\n"));
    });
    return submitted.text;
  };

  const finishPullRequest = async (issue: T.Issue, state: T.PullRequestState) => {
    const closed = state === "closed" ? "dismissed" : "merged";
    const id = latestSessionIdOf(issue);
    if (id && reachable(id)) {
      try {
        await sessions.handOver(id, closed, (place) => repos.finishPullRequest(place.repo, issue.number));
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
    await r.finishPullRequest(issue, state);
  };

  /** Each followed pull request's state read; one merged or closed is kept, or finishes its issue. One that cannot be
   * read or finished now is tried again next time. */
  const refreshPullRequests = async (followed: readonly FollowedPullRequest[]) => {
    for (const { issue, finishes } of followed) {
      if (issue.pullRequest?.state !== "open" || !issue.repo) continue;
      try {
        const state = await repos.pullRequestState(issue.repo, issue.pullRequest.number);
        if (state === "open") continue;
        if (finishes) await finishPullRequest(issue, state);
        else await savePullRequest(issue.id, { ...issue.pullRequest, state });
      } catch (e) {
        // One pull request that cannot be read or finished now is tried again on the next round; the rest go on.
        if (!(e instanceof RepoError || e instanceof ApiError || e instanceof MergeFailure)) throw e;
        log.warn(`vibevalley: refresh pull requests: issue #${issue.number}: ${e.message}`);
      }
    }
  };

  /** A child's work checked and merged into its parent's branch (the parent's helper's workplace, else its checkout),
   * then its helper lets go; merged runs before it does. Undefined when it waits: the child's helper is gone or the
   * parent's works. Throws NotTakenIn when the work does not go in. */
  const mergeChild = async (
    child: T.Issue,
    parent: T.Issue,
    checks: CheckoutChecks,
    merged: (frozen: readonly string[] | undefined) => Promise<void>,
  ): Promise<Merged | undefined> => {
    const parentRepo = parent.repo;
    const session = latestSessionIdOf(child);
    if (!parentRepo || !session || !reachable(session)) return undefined;
    const parentSession = latestSessionIdOf(parent);
    const parentWorker = parentSession ? sessions.live(parentSession).session : undefined;
    if (parentWorker && isBusy(parentWorker)) return undefined;
    return sessions.handOver(
      session,
      "completed",
      async (place) => {
        const frozen = await repos.verifyCheckout(place, issueBranch(parent.number), checks);
        const mergeIntoParent = (target: Workplace) => repos.mergeInto(place, issueBranch(parent.number), target.cwd);
        let into: Merged;
        if (parentSession && reachable(parentSession)) {
          try {
            into = await sessions.withIdleWorkplace(parentSession, mergeIntoParent);
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

  /** The issue's work: in its helper's workplace while one holds it, else on its branch; none without a repo or a branch.
   * A repo's failure to read it is told as a refusal. */
  const changesOf = async (issue: T.Issue): Promise<T.Changes | undefined> => {
    try {
      const session = latestSessionIdOf(issue);
      if (session && reachable(session)) return await sessions.withWorkplace(session, (place) => repos.changes(place));
      return issue.repo ? await repos.branchChanges(issue.repo, issueBranch(issue.number)) : undefined;
    } catch (e) {
      throw e instanceof RepoError ? refused(e.message) : e;
    }
  };

  return {
    merge,
    submitPullRequest,
    refreshPullRequests,
    mergeChild,
    changesOf,
    /** Whether the session's work still conflicts with base. */
    conflictOf: (session: string, base: string) => sessions.withWorkplace(session, (place) => repos.conflict(place, base)),
  };
}

export type IssueLanding = ReturnType<typeof issueLanding>;
