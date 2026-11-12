import { Semaphore } from "@vibevalley/async";
import { list, t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { userId } from "@vibevalley/protocol";
import { latestSessionIdOf } from "@vibevalley/protocol/rules";

import { ApiError, BizCode, lookIn, missing, refuseIn } from "#/base/errors.ts";
import type { Core } from "#/core/core.ts";
import type { Logger } from "#/infra/log.ts";
import type { Channel } from "#/modules/channel/channel.ts";
import { issueBranch, type Repo } from "#/modules/repo/repo.ts";
import { type Merged, MergeFailure, RepoError, type Workplace } from "#/modules/repo/workplace.ts";
import { NotTakenIn, type Session } from "#/modules/session/session.ts";

import { pullRequestConclusion } from "./brief.ts";
import { acceptanceAncestors } from "./dependencies.ts";
import { statusMove } from "./moves.ts";

const refused = refuseIn(BizCode.IssueRefused);

interface MergeDeps {
  readonly core: Core;
  readonly log: Logger;
  readonly sessions: Session;
  readonly repos: Repo;
  readonly chat: Channel;
  readonly get: (ref: string) => Promise<T.Issue>;
  readonly list: () => Promise<T.Issue[]>;
  /** The issue's latest session while it is on the farm. */
  readonly liveSession: (id: string) => Promise<string>;
  readonly setConflict: (id: string, conflict: T.Conflict | undefined) => Promise<void>;
  readonly savePullRequest: (id: string, pr: T.PullRequest) => Promise<void>;
  readonly finishPullRequest: (issue: T.Issue, state: T.PullRequestState) => Promise<void>;
}

/** A repo's failure as a merge's: git or GitHub said no. */
const asMergeFailure = (e: unknown): unknown =>
  e instanceof MergeFailure ? e : e instanceof RepoError || e instanceof ApiError ? MergeFailure.error(e.message) : e;

/** A merge's or a repo's failure told as the issue's refusal. */
const asRefusal = (e: unknown): unknown => (e instanceof MergeFailure || e instanceof RepoError ? refused(e.message) : e);

export function merging(d: MergeDeps) {
  const { core, log, sessions, repos, chat, get, list, liveSession, savePullRequest, finishPullRequest: finishPullRequestRecord } = d;
  /** Merges by pull request and the poll of their states, one at a time. */
  const prLock = new Semaphore(1);

  const notTaken = async (id: string, n: NotTakenIn) => {
    const issue = sessions.live(id).session?.issue;
    if (issue && n.failure.kind === "conflict") await d.setConflict(issue, { base: n.failure.base, files: [...n.failure.files] });
    let [user, line] = [n.user, n.notice];
    if (n.fix) {
      let untold = "";
      try {
        await chat.post({ _tag: "Tell", from: userId, session: id, text: n.fix, sendKey: "" });
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        untold = t("server.issue.merge.tellFailed", { why: e.message });
      }
      [user, line] = [user + untold, line + untold];
    }
    core.notice("warn", line);
    return refused(user);
  };
  const handedOver = async (id: string, use: (place: Workplace, said: string) => Promise<Merged>) => {
    try {
      return await sessions.handOver(id, "merged", async (place, said) => {
        const merged = await use(place, said);
        const issue = sessions.live(id).session?.issue;
        if (issue) await d.setConflict(issue, undefined);
        return merged;
      });
    } catch (e) {
      if (e instanceof NotTakenIn) throw await notTaken(id, e);
      throw e;
    }
  };

  const mergeSession = async (id: string) => {
    const session = sessions.live(id).session;
    if (!session) throw missing(t("server.issue.helperRef", { id }), [lookIn.session]);
    const merged = await handedOver(id, (place) => repos.merge(place));
    core.notice("info", t("server.issue.merge.merged", { name: session.name, text: merged.text }));
    return merged.text;
  };

  /** Throws MergeFailure. */
  const pullRequestOf = async (place: Workplace, issue: T.Issue, said: string): Promise<Merged> => {
    let pr: T.PullRequest;
    let thread: string;
    try {
      pr = await repos.submitPullRequest(place, issue, pullRequestConclusion(said));
      thread = await chat.issueThread(issue.id, issue.title);
    } catch (e) {
      throw asMergeFailure(e);
    }
    await chat.post({
      _tag: "Notice",
      channel: thread,
      text: t("server.issue.prDelivered", { url: pr.url }),
      code: "issue_pr_delivery",
      sendKey: `issue-pr:${issue.id}:${pr.url}`,
    });
    await savePullRequest(issue.id, pr);
    return { pullRequest: pr, text: t("shared.join.labeled", { label: "PR", text: pr.url }), commits: 0 };
  };

  const merge = (id: string, accepted: boolean = false): Promise<string> =>
    prLock.with(async () => {
      const issue = await get(id);
      // Whoever asks (the board, the command line, the orchestrator's tool) is held to the same table.
      if (!accepted) {
        const [m, why] = statusMove(issue, "done");
        if (m === "none") throw refused(why);
      }
      const last = latestSessionIdOf(issue);
      if (issue.repo && (!last || !sessions.live(last).reachable) && (await list()).some((child) => child.parent === issue.id)) {
        const repo = issue.repo;
        try {
          return await sessions.withCheckout(repo, issue.number, async (place) => {
            if (issue.pullRequest?.state === "open" || repos.usesPullRequests(repo)) return (await pullRequestOf(place, issue, issue.description)).text;
            let merged: Merged;
            try {
              merged = await repos.merge(place);
            } catch (error) {
              if (error instanceof MergeFailure && error.kind === "conflict") await d.setConflict(issue.id, { base: error.base, files: [...error.files] });
              throw error;
            }
            await d.setConflict(issue.id, undefined);
            return merged.text;
          });
        } catch (e) {
          throw asRefusal(e);
        }
      }
      const session = await liveSession(id);
      if (issue.repo && (issue.pullRequest?.state === "open" || repos.usesPullRequests(issue.repo))) {
        return (await handedOver(session, (place, said) => pullRequestOf(place, issue, said))).text;
      }
      return mergeSession(session);
    });

  const finishPullRequest = async (issue: T.Issue, state: T.PullRequestState) => {
    const closed = state === "closed" ? "dismissed" : "merged";
    const id = latestSessionIdOf(issue);
    if (id && sessions.live(id).reachable) {
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
    await finishPullRequestRecord(issue, state);
  };

  const refreshPullRequests = (): Promise<void> =>
    prLock.with(async () => {
      for (const issue of await list()) {
        if (issue.pullRequest?.state !== "open" || !issue.repo) continue;
        try {
          const state = await repos.pullRequestState(issue.repo, issue.pullRequest.number);
          if (state === "open") continue;
          if (issue.deliver === "pull_request" || issue.closedAt !== undefined) await savePullRequest(issue.id, { ...issue.pullRequest, state });
          else await finishPullRequest(issue, state);
        } catch (e) {
          // One pull request that cannot be read or finished now is tried again on the next round; the rest go on.
          if (!(e instanceof RepoError || e instanceof ApiError || e instanceof MergeFailure)) throw e;
          log.warn(`vibevalley: refresh pull requests: issue #${issue.number}: ${e.message}`);
        }
      }
    });

  const submit = (id: string, session: string, summary?: string): Promise<string> =>
    prLock.with(async () => {
      try {
        const submitted = await sessions.withWorkplace(session, async (place) => {
          const issue = await get(id);
          if (issue.status === "done" || issue.status === "canceled") throw refused(t("server.issue.closedReopen"));
          return pullRequestOf(place, issue, summary ?? [issue.title, issue.description].filter(Boolean).join("\n\n"));
        });
        return submitted.text;
      } catch (error) {
        if (error instanceof MergeFailure) throw refused(error.message);
        throw error;
      }
    });

  return { merge, refreshPullRequests, submit };
}

/** Throws MergeFailure when the child's work does not pass its checks. */
export async function verifyChild(repos: Repo, child: T.Issue, parent: T.Issue, all: readonly T.Issue[], place: Workplace) {
  const constraints = child.constraints;
  const inherited = acceptanceAncestors(child, all);
  const changed = async () => {
    try {
      return await repos.changedFiles(place.cwd, issueBranch(parent.number));
    } catch (error) {
      if (error instanceof RepoError) throw MergeFailure.error(error.message);
      throw error;
    }
  };
  if (constraints?.acceptance === true) {
    if (!constraints.check) throw MergeFailure.failedCheck(t("server.issue.verification.acceptanceNeedsCheck"));
    if ((await repos.run(place.cwd, constraints.check)).ok)
      throw MergeFailure.failedCheck(t("server.issue.verification.acceptancePassed", { check: constraints.check }));
    return { ...constraints, frozen: await changed() };
  }
  const frozen = new Set(inherited.flatMap((item) => item.constraints?.frozen ?? []));
  const checkFrozen = async () => {
    const touched = (await changed()).filter((file) => frozen.has(file));
    if (touched.length > 0) throw MergeFailure.failedCheck(t("server.issue.verification.frozen", { files: list(touched) }));
  };
  if (frozen.size > 0) await checkFrozen();
  const leaf = !all.some((item) => item.parent === child.parent && item.status !== "canceled" && item.blockedBy.includes(child.id));
  const checks = new Set([constraints?.check, ...(leaf ? inherited.map((item) => item.constraints?.check) : [])].flatMap((check) => (check ? [check] : [])));
  for (const check of checks) {
    const result = await repos.run(place.cwd, check);
    if (!result.ok) throw MergeFailure.failedCheck(t("server.issue.verification.failed", { check, output: result.output }));
  }
  if (frozen.size > 0) await checkFrozen();
  return constraints;
}
