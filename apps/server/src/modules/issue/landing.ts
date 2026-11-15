import { Semaphore } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { userId } from "@vibevalley/protocol";
import { isBusy, issueScopeOf, latestSessionIdOf } from "@vibevalley/protocol/rules";

import { ApiError, BizCode, lookIn, messageOf, missing, refuseIn } from "#/base/errors.ts";
import type { Core } from "#/core/core.ts";
import { issueBranch, type PullRequest, type Repo } from "#/modules/repo/repo.ts";
import { type CheckoutChecks, type Merged, MergeFailure, RepoError, type Workplace } from "#/modules/repo/workplace.ts";
import { NotTakenIn, type Session } from "#/modules/session/session.ts";

import { acceptanceAncestors } from "./dependencies.ts";
import type { IssueLifecycle } from "./lifecycle.ts";
import { statusMove } from "./moves.ts";

const refused = refuseIn(BizCode.IssueRefused);

/** What the pull module hands down to the issues once built; until then, local merges only. */
export interface IssuePullPort {
  readonly usesPullRequests: (repo: string) => boolean;
  readonly ofIssue: (id: T.IssueId) => PullRequest | undefined;
  readonly submitForIssue: (place: Workplace, issue: T.Issue, conclusion: string, signal?: AbortSignal) => Promise<PullRequest>;
}

export const unattachedPullPort: IssuePullPort = {
  usesPullRequests: () => false,
  ofIssue: () => undefined,
  submitForIssue: () => Promise.reject(new RepoError(t("server.issue.prSubmitUnavailable"))),
};

/** The structured issue_report carries the short result; the PR fallback keeps the worker's complete last answer. */
export const pullRequestConclusion = (text: string) => text.trim();

/** The issue's work goes in as a pull request: one is open, or its repo goes by pull requests. */
export const goesByPullRequest = (issue: Pick<T.Issue, "pullRequest">, usesPullRequests: boolean) => issue.pullRequest?.state === "open" || usesPullRequests;

/** A followed pull request's end finishes its issue: one still open that delivers by merging (one that delivers the
 * pull request itself is done already, and a closed one only keeps the state). */
export const finishesWithPullRequest = (issue: Pick<T.Issue, "deliver" | "closedAt">) => issue.deliver !== "pull_request" && issue.closedAt === undefined;

/** What a child's work must pass before it merges into its parent: its own check, the acceptance ancestors' frozen
 * files, and (the last of its siblings) their checks. */
export function childChecks(child: T.Issue, all: readonly T.Issue[]): CheckoutChecks {
  const constraints = child.constraints;
  const inherited = acceptanceAncestors(child, all);
  if (constraints?.acceptance === true) return { acceptance: true, check: constraints.check ?? "" };
  const frozen = [...new Set(inherited.flatMap((item) => item.constraints?.frozen ?? []))];
  const leaf = !all.some((item) => item.parent === child.parent && item.status !== "canceled" && item.blockedBy.includes(child.id));
  const checks = [
    ...new Set([constraints?.check, ...(leaf ? inherited.map((item) => item.constraints?.check) : [])].flatMap((check) => (check ? [check] : []))),
  ];
  return { acceptance: false, frozen, checks };
}

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
  readonly repo: Repo;
  readonly session: Session;
  readonly pullPort: () => IssuePullPort;
  /** Words for a session, said where it works (issue.ts sayTo). */
  readonly tell: (from: string, session: string, text: string) => Promise<void>;
}

const asMergeFailure = (e: unknown): unknown =>
  e instanceof MergeFailure ? e : e instanceof RepoError || e instanceof ApiError ? MergeFailure.error(e.message) : e;

/** A merge's or a repo's failure told as the issue's refusal. */
const asRefusal = (e: unknown): unknown => (e instanceof MergeFailure || e instanceof RepoError ? refused(e.message) : e);

/** An issue's work delivered: merged into main, submitted through the pull port, or (a child's) merged into its parent's
 * branch, from its helper's workplace (which then lets go) or from the issue's own checkout. What the delivery finds is
 * written on the issue at each point, before its helper lets go, so the issue reads it first. */
export function issueLanding(r: Pick<IssueLifecycle, "get" | "everyIssue" | "setConflict">, deps: LandingDeps) {
  const { core, repo: repos, session: sessions, pullPort, tell } = deps;
  const { get, everyIssue, setConflict } = r;
  const reachable = (id: string) => sessions.live(id).reachable;
  const prLock = new Semaphore(1);

  /** An issue's own checkout in its repo, when no helper holds it; kept for the next helper. */
  const withCheckout = async <A>(repo: string, issue: number, use: (place: Workplace) => Promise<A>) =>
    use(await repos.checkout({ repo, issue, worktree: true, base: "" }));

  const pullRequestOf = async (place: Workplace, issue: T.Issue, said: string): Promise<Merged> => {
    let pr: PullRequest;
    try {
      pr = await pullPort().submitForIssue(place, issue, pullRequestConclusion(said));
    } catch (e) {
      throw asMergeFailure(e);
    }
    return { pullRequest: pr, text: t("shared.join.labeled", { label: "PR", text: pr.url }), commits: 0 };
  };

  const handedOver = (id: string, use: (place: Workplace, said: string) => Promise<Merged>) =>
    sessions.handOver(id, "merged", async (place, said) => {
      const merged = await use(place, said);
      const own = sessions.live(id).session;
      const issue = own ? issueScopeOf(own) : undefined;
      if (issue) await setConflict(issue, undefined);
      return merged;
    });

  const mergeCheckout = async (issue: T.Issue, repo: string) => {
    try {
      return await withCheckout(repo, issue.number, async (place) => {
        if (goesByPullRequest(issue, pullPort().usesPullRequests(repo))) return (await pullRequestOf(place, issue, issue.description)).text;
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
  const mergeDirect = async (issue: T.Issue, fromCheckout: boolean): Promise<string> => {
    const last = latestSessionIdOf(issue);
    const usesPullRequests = issue.repo ? pullPort().usesPullRequests(issue.repo) : false;
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

  const notTaken = async (id: string, n: NotTakenIn) => {
    const own = sessions.live(id).session;
    const issue = own ? issueScopeOf(own) : undefined;
    if (issue && n.failure.kind === "conflict") await setConflict(issue, { base: n.failure.base, files: [...n.failure.files] });
    let [user, line] = [n.user, n.notice];
    if (n.fix) {
      let untold = "";
      try {
        await tell(userId, id, n.fix);
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        untold = t("server.issue.merge.tellFailed", { why: e.message });
      }
      [user, line] = [user + untold, line + untold];
    }
    core.notice("warn", line);
    return refused(user);
  };

  const merge = (id: string, accepted: boolean = false): Promise<string> =>
    prLock.with(async () => {
      const issue = await get(id);
      // Whoever asks (the board, the command line, the orchestrator's tool) is held to the same table.
      if (!accepted) {
        const [m, why] = statusMove(issue, "done");
        if (m === "none") throw refused(why);
      }
      // A parent's children merged into its branch: it goes from its own checkout once its helper is gone.
      const fromCheckout = (await everyIssue()).some((child) => child.parent === issue.id);
      try {
        return await mergeDirect(issue, fromCheckout);
      } catch (e) {
        const last = latestSessionIdOf(issue);
        if (e instanceof NotTakenIn && last !== undefined) throw await notTaken(last, e);
        throw e;
      }
    });

  /** The helper's work submitted as the issue's pull request while it stays; read gives the issue under the helper's
   * workplace lock (refused when it is closed). Throws MergeFailure. */
  const submitPullRequest = async (session: string, read: () => Promise<T.Issue>, summary: string | undefined) => {
    const submitted = await sessions.withWorkplace(session, async (place) => {
      const issue = await read();
      return pullRequestOf(place, issue, summary ?? [issue.title, issue.description].filter(Boolean).join("\n\n"));
    });
    return submitted.text;
  };

  const submit = (id: string, session: string, summary?: string): Promise<string> =>
    prLock.with(async () => {
      try {
        return await submitPullRequest(
          session,
          async () => {
            const issue = await get(id);
            if (issue.status === "done" || issue.status === "canceled") throw refused(t("server.issue.closedReopen"));
            return issue;
          },
          summary,
        );
      } catch (error) {
        if (error instanceof MergeFailure) throw refused(error.message);
        throw error;
      }
    });

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
    submit,
    mergeChild,
    changesOf,
    /** Whether the session's work still conflicts with base. */
    conflictOf: (session: string, base: string) => sessions.withWorkplace(session, (place) => repos.conflict(place, base)),
  };
}

export type IssueLanding = ReturnType<typeof issueLanding>;
