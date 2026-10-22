// Harvesting an issue: its session's work taken into the main branch, by a local merge or a pull request, and the pull
// requests followed until GitHub merges or closes them. What a failed merge says (a conflict, a failed check) is decided
// here, for the board, the command line and the manager's tool alike.

import type { Changes, Conflict, Issue, IssueClose, PullRequest, PullRequestState } from "@vibevalley/protocol";
import { Effect, Semaphore } from "effect";
import type { SqlClient } from "effect/sql";
import * as q from "../../db/generated/issue.sql.ts";
import type { ChannelShape } from "../channel/chat.ts";
import type { CoreShape } from "../core/core.ts";
import { type ApiError, missing, reasonOf, refused } from "../errors.ts";
import { type Merged, MergeFailure, type ProjectShape, type Workplace } from "../project/project.ts";
import type { SessionShape } from "../session/session.ts";
import { statusMove } from "./moves.ts";
import { conflictBrief, pullRequestConclusion } from "./rules.ts";

/** What harvesting needs of the issues around it. */
export interface HarvestDeps {
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

export function harvesting(d: HarvestDeps) {
  const { core, sessions, projects, chat, db, inTx, get, list, latest, liveSession, publish } = d;
  /** Harvests by pull request and the poll of their states, one at a time. */
  const prLock = Semaphore.makeUnsafe(1);

  const conflictOf = (changes: Changes): Conflict | undefined =>
    changes.conflicts && changes.conflicts.length > 0 ? { base: changes.base, files: changes.conflicts } : undefined;
  const sameConflict = (a: Conflict | undefined, b: Conflict | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

  /** What the session's branch would bring; the preview is the freshest word on conflicts, and the state follows it. */
  const sessionChanges = (id: string) =>
    Effect.gen(function* () {
      const place = sessions.place(id);
      if (!place) return undefined;
      const changes = yield* projects.changes(place).pipe(Effect.mapError((e) => refused(e.message)));
      const conflict = conflictOf(changes);
      const session = sessions.sessionOf(id);
      if (session && !sameConflict(session.conflict, conflict)) yield* core.apply({ type: "conflict", id, ...(conflict ? { conflict } : {}) });
      return changes;
    });

  const recheck = (id: string) =>
    Effect.gen(function* () {
      const place = sessions.place(id);
      const session = sessions.sessionOf(id);
      if (!place || !session) return;
      const conflict = yield* projects.conflict(place, session.conflict?.base ?? "");
      if (!sameConflict(session.conflict, conflict)) yield* core.apply({ type: "conflict", id, ...(conflict ? { conflict } : {}) });
    });

  const mergeError = (id: string, err: unknown) =>
    Effect.gen(function* () {
      const session = sessions.sessionOf(id);
      const failure =
        err instanceof MergeFailure
          ? err
          : new MergeFailure("error", typeof err === "object" && err !== null && "_tag" in err ? reasonOf(err as ApiError) : String(err));
      if (!session) return refused(failure.reasonText || failure.message);
      if (failure.kind === "conflict") {
        const files = failure.files.join("、");
        yield* core.notice("warn", `${session.name} 的分支合进 ${failure.base} 会冲突（${files}），先没收。可以让它自己把冲突解决掉`);
        return refused(
          `没收：合进 ${failure.base} 会冲突（${files}）。${session.name} 还在地里，分支和 worktree 都在。要它解决就用 tell 告诉它：${conflictBrief(failure.base, failure.files)}`,
        );
      }
      let why = failure.reasonText;
      if (failure.kind === "check") {
        const told = yield* Effect.result(chat.tellSession("user", id, failure.reasonText + "\n请修好检查，再交回来。", ""));
        if (told._tag === "Failure") why += "\n给帮工带话失败：" + reasonOf(told.failure);
      }
      yield* core.notice("warn", `${session.name} 的活没收进去：${why}`);
      return refused(`没收进去：${why}。${session.name} 还在地里`);
    });

  const mergeSession = (id: string) =>
    Effect.gen(function* () {
      const session = sessions.sessionOf(id);
      if (!session) return yield* Effect.fail(missing("帮工 " + id));
      const merged = yield* Effect.result(sessions.handOver(id, "merged", (place) => projects.merge(place)));
      if (merged._tag === "Failure") return yield* Effect.fail(yield* mergeError(id, merged.failure));
      yield* core.notice("info", `收了 ${session.name} 的活：${merged.success.text}`);
      return merged.success.text;
    });

  const savePullRequest = (id: string, pr: PullRequest) => Effect.andThen(db(q.setIssuePullRequest({ id, pull_request: JSON.stringify(pr) })), publish(id));

  /** The harvest as a pull request: opened (or the open one pushed to) with the session's conclusion, and kept on the issue. */
  const pullRequestOf = (place: Workplace, issue: Issue, said: string) =>
    Effect.gen(function* () {
      const pr = yield* projects
        .submitPullRequest(place, issue, pullRequestConclusion(said))
        .pipe(Effect.mapError((e) => (e instanceof MergeFailure ? e : new MergeFailure("error", e.message))));
      yield* savePullRequest(issue.id, pr).pipe(Effect.mapError((e) => new MergeFailure("error", reasonOf(e))));
      return { pullRequest: pr, text: "PR：" + pr.url, commits: 0 } as Merged;
    });

  const merge = (id: string) =>
    prLock.withPermits(1)(
      Effect.gen(function* () {
        const issue = yield* get(id);
        // Whoever questions (the board, the command line, the manager's tool) is held to the same table: a round that
        // failed, or a required acceptance not passed, is not harvested.
        if (!issue.graph && !issue.task) {
          const [m, why] = statusMove(issue, "done");
          if (m === "none") return yield* Effect.fail(refused(why));
        }
        const session = yield* liveSession(id);
        if (issue.project && !issue.graph && !issue.task && (issue.pullRequest?.state === "open" || projects.usesPullRequests(issue.project))) {
          const merged = yield* Effect.result(sessions.handOver(session, "merged", (place, said) => pullRequestOf(place, issue, said)));
          if (merged._tag === "Failure") return yield* Effect.fail(yield* mergeError(session, merged.failure));
          return merged.success.text;
        }
        return yield* mergeSession(session);
      }),
    );

  const finishPullRequest = (issue: Issue, state: PullRequestState) =>
    Effect.gen(function* () {
      const closed: IssueClose = state === "closed" ? "dismissed" : "merged";
      const id = yield* latest(issue.id);
      if (sessions.find(id))
        yield* sessions
          .handOver(id, closed, (place) =>
            projects.finishPullRequest(place.project, issue.number).pipe(Effect.mapError((e) => new MergeFailure("error", e.message))),
          )
          .pipe(Effect.mapError((e) => (e instanceof MergeFailure ? refused(e.reasonText) : e)));
      else yield* projects.finishPullRequest(issue.project!, issue.number).pipe(Effect.mapError((e) => refused(e.message)));
      yield* inTx(
        Effect.andThen(
          db(q.closeIssue({ id: issue.id, closed, closed_at: Date.now() })),
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

  return { merge, sessionChanges, recheck, conflictOf, refreshPullRequests };
}
