import { Clock, Effect, Semaphore, Predicate } from "effect";

import { list, t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { ownerId } from "@vibevalley/protocol";
import { latestSessionIdOf } from "@vibevalley/protocol/rules";

import { type ApiError, missing, lookIn, reasonOf, refused } from "#/base/errors.ts";
import type { Channel } from "#/channel/channel.ts";
import type { Core } from "#/core/core.ts";
import type { Db } from "#/infra/db.ts";
import { issueBranch, type Repo } from "#/repo/repo.ts";
import { type Merged, MergeFailure, type RepoError, type Workplace } from "#/repo/workplace.ts";
import type { NotTakenIn, Session } from "#/session/session.ts";
import * as q from "#db/issue.sql.ts";

import { pullRequestConclusion } from "./brief.ts";
import { acceptanceAncestors } from "./dependencies.ts";
import { statusMove } from "./moves.ts";

interface MergeDeps {
  readonly core: Core["Service"];
  readonly sessions: Session["Service"];
  readonly repos: Repo["Service"];
  readonly chat: Channel["Service"];
  readonly db: Db["Service"];
  readonly get: (ref: string) => Effect.Effect<T.Issue, ApiError>;
  readonly list: Effect.Effect<T.Issue[]>;
  /** The issue's latest session while it is on the farm. */
  readonly liveSession: (id: string) => Effect.Effect<string, ApiError>;
  readonly publish: (id: string) => Effect.Effect<void>;
  readonly setConflict: (id: string, conflict: T.Conflict | undefined) => Effect.Effect<void>;
}

export function merging(d: MergeDeps) {
  const { core, sessions, repos, chat, db, get, list, liveSession, publish } = d;
  /** Merges by pull request and the poll of their states, one at a time. */
  const prLock = Semaphore.makeUnsafe(1);

  const notTaken = Effect.fnUntraced(function* (id: string, n: NotTakenIn) {
    const issue = sessions.sessionOf(id)?.issue;
    if (issue && n.failure.kind === "conflict") yield* d.setConflict(issue, { base: n.failure.base, files: [...n.failure.files] });
    let [owner, line] = [n.owner, n.notice];
    if (n.fix) {
      const untold = yield* chat
        .tellSession(ownerId, id, n.fix, "")
        .pipe(Effect.match({ onSuccess: () => "", onFailure: (e) => t("server.issue.merge.tellFailed", { why: reasonOf(e) }) }));
      [owner, line] = [owner + untold, line + untold];
    }
    yield* core.notice("warn", line);
    return refused(owner);
  });
  const handedOver = (id: string, use: (place: Workplace, said: string) => Effect.Effect<Merged, MergeFailure | RepoError>) =>
    sessions
      .handOver(id, "merged", (place, said) =>
        use(place, said).pipe(
          Effect.tap(() => {
            const issue = sessions.sessionOf(id)?.issue;
            return issue ? d.setConflict(issue, undefined) : Effect.void;
          }),
        ),
      )
      .pipe(Effect.catchTag("NotTakenIn", (e) => Effect.flatMap(notTaken(id, e), Effect.fail)));

  const mergeSession = Effect.fn("Issue.mergeSession")(function* (id: string) {
    const session = sessions.sessionOf(id);
    if (!session) return yield* Effect.fail(missing(t("server.issue.helperRef", { id }), [lookIn.session]));
    const merged = yield* handedOver(id, (place) => repos.merge(place));
    yield* core.notice("info", t("server.issue.merge.merged", { name: session.name, text: merged.text }));
    return merged.text;
  });

  const savePullRequest = Effect.fnUntraced(function* (id: string, pr: T.PullRequest) {
    yield* db.run(q.setIssuePullRequest({ id, pull_request: JSON.stringify(pr) }));
    yield* publish(id);
  });

  const pullRequestOf = Effect.fnUntraced(function* (place: Workplace, issue: T.Issue, said: string) {
    const pr = yield* repos
      .submitPullRequest(place, issue, pullRequestConclusion(said))
      .pipe(Effect.mapError((e) => (Predicate.isTagged(e, "MergeFailure") ? e : MergeFailure.error(e.message))));
    yield* savePullRequest(issue.id, pr).pipe(Effect.mapError((e) => MergeFailure.error(reasonOf(e))));
    return { pullRequest: pr, text: t("shared.join.labeled", { label: "PR", text: pr.url }), commits: 0 };
  });

  const merge = Effect.fn("Issue.merge")(
    function* (id: string, accepted: boolean = false) {
      const issue = yield* get(id);
      // Whoever asks (the board, the command line, the orchestrator's tool) is held to the same table.
      if (!accepted) {
        const [m, why] = statusMove(issue, "done");
        if (m === "none") return yield* Effect.fail(refused(why));
      }
      const last = latestSessionIdOf(issue);
      if (issue.repo && (!last || !sessions.present(last)) && (yield* list).some((child) => child.parent === issue.id)) {
        const place = yield* repos.workplace(issue.repo, issue.number, true, "").pipe(Effect.mapError((error) => refused(error.message)));
        if (issue.pullRequest?.state === "open" || repos.usesPullRequests(issue.repo))
          return (yield* pullRequestOf(place, issue, issue.description).pipe(Effect.mapError((error) => refused(error.message)))).text;
        return (yield* repos.merge(place).pipe(
          Effect.tap(() => d.setConflict(issue.id, undefined)),
          Effect.tapError((error) => (error.kind === "conflict" ? d.setConflict(issue.id, { base: error.base, files: [...error.files] }) : Effect.void)),
          Effect.mapError((error) => refused(error.message)),
        )).text;
      }
      const session = yield* liveSession(id);
      if (issue.repo && (issue.pullRequest?.state === "open" || repos.usesPullRequests(issue.repo))) {
        return (yield* handedOver(session, (place, said) => pullRequestOf(place, issue, said))).text;
      }
      return yield* mergeSession(session);
    },
    (effect) => prLock.withPermits(1)(effect),
  );

  const finishPullRequest = Effect.fnUntraced(function* (issue: T.Issue, state: T.PullRequestState) {
    const closed = state === "closed" ? "dismissed" : "merged";
    const id = latestSessionIdOf(issue);
    if (id && sessions.present(id))
      yield* sessions
        .handOver(id, closed, (place) => repos.finishPullRequest(place.repo, issue.number))
        .pipe(Effect.catchTag("NotTakenIn", (e) => Effect.fail(refused(e.failure.reasonText))));
    else if (issue.repo) yield* repos.finishPullRequest(issue.repo, issue.number).pipe(Effect.mapError((e) => refused(e.message)));
    yield* db.inTx(
      Effect.andThen(
        db.run(
          state === "closed"
            ? q.cancelIssue({ id: issue.id, canceled: "dismissed", closed_at: yield* Clock.currentTimeMillis })
            : q.completeIssue({ id: issue.id, delivered: "pull_request", closed_at: yield* Clock.currentTimeMillis }),
        ),
        db.run(q.setIssuePullRequest({ id: issue.id, pull_request: JSON.stringify({ ...issue.pullRequest, state }) })),
      ),
    );
    yield* publish(issue.id);
  });

  const refreshPullRequests = Effect.fn("Issue.refreshPullRequests")(function* () {
    for (const issue of yield* list) {
      if (issue.pullRequest?.state !== "open" || !issue.repo) continue;
      yield* repos.pullRequestState(issue.repo, issue.pullRequest.number).pipe(
        Effect.flatMap((state) => (state === "open" ? Effect.void : finishPullRequest(issue, state))),
        Effect.catch((e) => Effect.logWarning(`vibevalley: refresh pull requests: issue #${issue.number}: ${e instanceof Error ? e.message : reasonOf(e)}`)),
      );
    }
  }, prLock.withPermits(1));

  const submit = Effect.fn("Issue.submitWorkingPullRequest")(function* (id: string, session: string, summary?: string) {
    const submitted = yield* sessions
      .withWorkplace(session, (place) =>
        Effect.gen(function* () {
          const issue = yield* get(id);
          if (issue.status === "done" || issue.status === "canceled") return yield* Effect.fail(refused(t("server.issue.closedReopen")));
          return yield* pullRequestOf(place, issue, summary ?? [issue.title, issue.description].filter(Boolean).join("\n\n"));
        }),
      )
      .pipe(
        Effect.catchTags({
          MergeFailure: (error) => Effect.fail(refused(error.message)),
        }),
      );
    return submitted.text;
  });

  return { merge, refreshPullRequests, submit };
}

export const verifyChild = Effect.fn("Issue.verifyChild")(function* (
  repos: Repo["Service"],
  child: T.Issue,
  parent: T.Issue,
  all: readonly T.Issue[],
  place: Workplace,
) {
  const constraints = child.constraints;
  const inherited = acceptanceAncestors(child, all);
  const changed = () => repos.changedFiles(place.cwd, issueBranch(parent.number)).pipe(Effect.mapError((error) => MergeFailure.error(error.message)));
  if (constraints?.acceptance === true) {
    if (!constraints.check) return yield* MergeFailure.failedCheck(t("server.issue.verification.acceptanceNeedsCheck"));
    if ((yield* repos.run(place.cwd, constraints.check)).ok)
      return yield* MergeFailure.failedCheck(t("server.issue.verification.acceptancePassed", { check: constraints.check }));
    return { ...constraints, frozen: yield* changed() };
  }
  const frozen = new Set(inherited.flatMap((item) => item.constraints?.frozen ?? []));
  const checkFrozen = Effect.gen(function* () {
    const touched = (yield* changed()).filter((file) => frozen.has(file));
    if (touched.length > 0) return yield* MergeFailure.failedCheck(t("server.issue.verification.frozen", { files: list(touched) }));
  });
  if (frozen.size > 0) yield* checkFrozen;
  const leaf = !all.some((item) => item.parent === child.parent && item.status !== "canceled" && item.blockedBy.includes(child.id));
  const checks = new Set([constraints?.check, ...(leaf ? inherited.map((item) => item.constraints?.check) : [])].flatMap((check) => (check ? [check] : [])));
  yield* Effect.forEach(
    checks,
    (check) =>
      Effect.gen(function* () {
        const result = yield* repos.run(place.cwd, check);
        if (!result.ok) return yield* MergeFailure.failedCheck(t("server.issue.verification.failed", { check, output: result.output }));
      }),
    { discard: true },
  );
  if (frozen.size > 0) yield* checkFrozen;
  return constraints;
});
