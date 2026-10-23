// Merging an issue's work: its session's commits taken into the main branch, by a local merge or a pull request, and the pull
// requests followed until GitHub merges or closes them. What a failed merge says (a conflict, a failed check) is decided
// here, for the board, the command line and the orchestrator's tool alike.

import type { Issue, PullRequest, PullRequestState } from "@vibevalley/protocol";
import { Effect, Semaphore } from "effect";
import type { SqlClient } from "effect/sql";
import * as q from "../../db/generated/issue.sql.ts";
import type { ChannelShape } from "../channel/chat.ts";
import type { CoreShape } from "../core/core.ts";
import { type ApiError, missing, lookIn, reasonOf, refused } from "../errors.ts";
import { type Merged, MergeFailure, type ProjectShape, type Workplace } from "../project/project.ts";
import { NotTakenIn, type SessionShape } from "../session/session.ts";
import { statusMove } from "./moves.ts";
import { pullRequestConclusion } from "./rules.ts";

/** What merging needs of the issues around it. */
export interface MergeDeps {
  readonly core: CoreShape;
  readonly sessions: SessionShape;
  readonly projects: ProjectShape;
  readonly chat: ChannelShape;
  readonly db: <A, E>(e: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.Effect<A>;
  readonly inTx: <A, E>(e: Effect.Effect<A, E>) => Effect.Effect<A, Exclude<E, { _tag: "SqlError" }>>;
  readonly get: (ref: string) => Effect.Effect<Issue, ApiError>;
  readonly list: Effect.Effect<Issue[]>;
  /** The issue's latest session, refused when it was never sent. */
  readonly latest: (id: string) => Effect.Effect<string, ApiError>;
  /** The issue's latest session while it is on the farm. */
  readonly liveSession: (id: string) => Effect.Effect<string, ApiError>;
  /** The issue read back and put on the board. */
  readonly publish: (id: string) => Effect.Effect<void>;
}

export function merging(d: MergeDeps) {
  const { core, sessions, projects, chat, db, inTx, get, list, latest, liveSession, publish } = d;
  /** Merges by pull request and the poll of their states, one at a time. */
  const prLock = Semaphore.makeUnsafe(1);

  /** Work that did not go in: the helper is sent back with what it is to fix, in the issue's thread as from the owner;
   * the owner is told the rest. */
  const notTaken = (id: string, n: NotTakenIn) =>
    Effect.gen(function* () {
      let [owner, line] = [n.owner, n.notice];
      if (n.fix) {
        const told = yield* Effect.result(chat.tellSession("user", id, n.fix, ""));
        if (told._tag === "Failure")
          [owner, line] = [owner + "\n给帮工带话失败：" + reasonOf(told.failure), line + "\n给帮工带话失败：" + reasonOf(told.failure)];
      }
      yield* core.notice("warn", line);
      return refused(owner);
    });
  /** The session's work taken in by use; what did not go in is said as above. */
  const handedOver = (id: string, use: (place: Workplace, said: string) => Effect.Effect<Merged, unknown>) =>
    sessions.handOver(id, "merged", use).pipe(Effect.catchTag("NotTakenIn", (e) => Effect.flatMap(notTaken(id, e), Effect.fail)));

  const mergeSession = (id: string) =>
    Effect.gen(function* () {
      const session = sessions.sessionOf(id);
      if (!session) return yield* Effect.fail(missing("帮工 " + id, [lookIn.session]));
      const merged = yield* handedOver(id, (place) => projects.merge(place));
      yield* core.notice("info", `${session.name} 的活合进去了：${merged.text}`);
      return merged.text;
    });

  const savePullRequest = (id: string, pr: PullRequest) => Effect.andThen(db(q.setIssuePullRequest({ id, pull_request: JSON.stringify(pr) })), publish(id));

  /** The merge as a pull request: opened (or the open one pushed to) with the session's conclusion, and kept on the issue. */
  const pullRequestOf = (place: Workplace, issue: Issue, said: string) =>
    Effect.gen(function* () {
      const pr = yield* projects
        .submitPullRequest(place, issue, pullRequestConclusion(said))
        .pipe(Effect.mapError((e) => (e instanceof MergeFailure ? e : MergeFailure.error(e.message))));
      yield* savePullRequest(issue.id, pr).pipe(Effect.mapError((e) => MergeFailure.error(reasonOf(e))));
      return { pullRequest: pr, text: "PR：" + pr.url, commits: 0 } as Merged;
    });

  const merge = (id: string) =>
    prLock.withPermits(1)(
      Effect.gen(function* () {
        const issue = yield* get(id);
        // Whoever asks (the board, the command line, the orchestrator's tool) is held to the same table: a round that
        // failed, or a required acceptance not passed, is not merged.
        if (!issue.graph && !issue.task) {
          const [m, why] = statusMove(issue, "done");
          if (m === "none") return yield* Effect.fail(refused(why));
        }
        const session = yield* liveSession(id);
        if (issue.project && !issue.graph && !issue.task && (issue.pullRequest?.state === "open" || projects.usesPullRequests(issue.project))) {
          return (yield* handedOver(session, (place, said) => pullRequestOf(place, issue, said))).text;
        }
        return yield* mergeSession(session);
      }),
    );

  const finishPullRequest = (issue: Issue, state: PullRequestState) =>
    Effect.gen(function* () {
      // A pull request merged is the issue done, delivered by it; one closed unmerged is the issue not done.
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
              ? q.cancelIssue({ id: issue.id, canceled: "dismissed", closed_at: Date.now() })
              : q.completeIssue({ id: issue.id, delivered: "pull_request", closed_at: Date.now() }),
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
            `vibevalley: refresh pull requests: 工单 #${issue.number}: ${done.failure instanceof Error ? done.failure.message : reasonOf(done.failure)}`,
          );
      }
    }),
  );

  return { merge, refreshPullRequests };
}
