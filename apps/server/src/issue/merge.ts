import { Clock, Effect, Semaphore, Predicate } from "effect";
import type { SqlClient } from "effect/sql";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { ownerId } from "@vibevalley/protocol";

import type { Channel } from "@/channel/chat.ts";
import type { Core } from "@/core/core.ts";
import { type ApiError, missing, lookIn, reasonOf, refused } from "@/errors.ts";
import type { Project } from "@/project/project.ts";
import { type Merged, MergeFailure, type ProjectError, type Workplace } from "@/project/shapes.ts";
import type { NotTakenIn, Session } from "@/session/session.ts";

import * as q from "../../db/generated/issue.sql.ts";
import { pullRequestConclusion } from "./brief.ts";
import { statusMove } from "./moves.ts";

export interface MergeDeps {
  readonly core: Core["Service"];
  readonly sessions: Session["Service"];
  readonly projects: Project["Service"];
  readonly chat: Channel["Service"];
  readonly db: <A, E>(e: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.Effect<A>;
  readonly inTx: <A, E>(e: Effect.Effect<A, E>) => Effect.Effect<A, Exclude<E, { _tag: "SqlError" }>>;
  readonly get: (ref: string) => Effect.Effect<T.Issue, ApiError>;
  readonly list: Effect.Effect<T.Issue[]>;
  /** The issue's latest session, refused when it was never sent. */
  readonly latest: (id: string) => Effect.Effect<string, ApiError>;
  /** The issue's latest session while it is on the farm. */
  readonly liveSession: (id: string) => Effect.Effect<string, ApiError>;
  readonly publish: (id: string) => Effect.Effect<void>;
}

export function merging(d: MergeDeps) {
  const { core, sessions, projects, chat, db, inTx, get, list, latest, liveSession, publish } = d;
  /** Merges by pull request and the poll of their states, one at a time. */
  const prLock = Semaphore.makeUnsafe(1);

  const notTaken = Effect.fnUntraced(function* (id: string, n: NotTakenIn) {
    let [owner, line] = [n.owner, n.notice];
    if (n.fix) {
      const told = yield* Effect.result(chat.tellSession(ownerId, id, n.fix, ""));
      if (told._tag === "Failure")
        [owner, line] = [
          owner + t("server.issue.merge.tellFailed", { why: reasonOf(told.failure) }),
          line + t("server.issue.merge.tellFailed", { why: reasonOf(told.failure) }),
        ];
    }
    yield* core.notice("warn", line);
    return refused(owner);
  });
  const handedOver = (id: string, use: (place: Workplace, said: string) => Effect.Effect<Merged, MergeFailure | ProjectError>) =>
    sessions.handOver(id, "merged", use).pipe(Effect.catchTag("NotTakenIn", (e) => Effect.flatMap(notTaken(id, e), Effect.fail)));

  const mergeSession = Effect.fn("Issue.mergeSession")(function* (id: string) {
    const session = sessions.sessionOf(id);
    if (!session) return yield* Effect.fail(missing(t("server.issue.helperRef", { id }), [lookIn.session]));
    const merged = yield* handedOver(id, (place) => projects.merge(place));
    yield* core.notice("info", t("server.issue.merge.merged", { name: session.name, text: merged.text }));
    return merged.text;
  });

  const savePullRequest = (id: string, pr: T.PullRequest) => Effect.andThen(db(q.setIssuePullRequest({ id, pull_request: JSON.stringify(pr) })), publish(id));

  const pullRequestOf = Effect.fnUntraced(function* (place: Workplace, issue: T.Issue, said: string) {
    const pr = yield* projects
      .submitPullRequest(place, issue, pullRequestConclusion(said))
      .pipe(Effect.mapError((e) => (Predicate.isTagged(e, "MergeFailure") ? e : MergeFailure.error(e.message))));
    yield* savePullRequest(issue.id, pr).pipe(Effect.mapError((e) => MergeFailure.error(reasonOf(e))));
    return { pullRequest: pr, text: t("shared.join.labeled", { label: "PR", text: pr.url }), commits: 0 };
  });

  const merge = Effect.fn("Issue.merge")(
    function* (id: string) {
      const issue = yield* get(id);
      // Whoever asks (the board, the command line, the orchestrator's tool) is held to the same table.
      if (!issue.graph && !issue.task) {
        const [m, why] = statusMove(issue, "done");
        if (m === "none") return yield* Effect.fail(refused(why));
      }
      const session = yield* liveSession(id);
      if (issue.project && !issue.graph && !issue.task && (issue.pullRequest?.state === "open" || projects.usesPullRequests(issue.project))) {
        return (yield* handedOver(session, (place, said) => pullRequestOf(place, issue, said))).text;
      }
      return yield* mergeSession(session);
    },
    (effect) => prLock.withPermits(1)(effect),
  );

  const finishPullRequest = Effect.fnUntraced(function* (issue: T.Issue, state: T.PullRequestState) {
    const closed = state === "closed" ? "dismissed" : "merged";
    const id = yield* latest(issue.id);
    if (sessions.find(id))
      yield* sessions
        .handOver(id, closed, (place) => projects.finishPullRequest(place.project, issue.number))
        .pipe(Effect.catchTag("NotTakenIn", (e) => Effect.fail(refused(e.failure.reasonText))));
    else yield* projects.finishPullRequest(issue.project!, issue.number).pipe(Effect.mapError((e) => refused(e.message)));
    yield* inTx(
      Effect.andThen(
        db(
          state === "closed"
            ? q.cancelIssue({ id: issue.id, canceled: "dismissed", closed_at: yield* Clock.currentTimeMillis })
            : q.completeIssue({ id: issue.id, delivered: "pull_request", closed_at: yield* Clock.currentTimeMillis }),
        ),
        db(q.setIssuePullRequest({ id: issue.id, pull_request: JSON.stringify({ ...issue.pullRequest, state }) })),
      ),
    );
    yield* publish(issue.id);
  });

  const refreshPullRequests = prLock.withPermits(1)(
    Effect.gen(function* () {
      for (const issue of yield* list) {
        if (issue.pullRequest?.state !== "open" || !issue.project) continue;
        const state = yield* Effect.result(projects.pullRequestState(issue.project, issue.pullRequest.number));
        const done = state._tag === "Failure" ? state : state.success === "open" ? undefined : yield* Effect.result(finishPullRequest(issue, state.success));
        if (done?._tag === "Failure")
          yield* Effect.logWarning(
            `vibevalley: refresh pull requests: issue #${issue.number}: ${done.failure instanceof Error ? done.failure.message : reasonOf(done.failure)}`,
          );
      }
    }),
  );

  return { merge, refreshPullRequests };
}
