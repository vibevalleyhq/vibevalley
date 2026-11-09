import { Effect, Semaphore } from "effect";

import { dagIDValid, dagProblems } from "@vibevalley/agent/dag";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { assignedAgentOf, isBusy, latestSessionIdOf } from "@vibevalley/protocol/rules";
import { issueId } from "@vibevalley/protocol/schema";

import { Agent } from "#/agent/agent.ts";
import { actsForOwner, type Actor } from "#/base/actor.ts";
import { reasonOf, refused } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import { Channel } from "#/channel/channel.ts";
import { issueBranch, Repo } from "#/repo/repo.ts";
import { MergeFailure, type Workplace } from "#/repo/workplace.ts";
import { Session } from "#/session/session.ts";

import { maxChildren } from "./creation.ts";
import type { IssueLifecycle } from "./lifecycle.ts";
import { verifyChild } from "./merge.ts";
import { needsOwner } from "./prompts.ts";
import { isClosed } from "./status.ts";

export const issueSplitting = (r: IssueLifecycle) =>
  Effect.gen(function* () {
    const store = yield* Agent;
    const repos = yield* Repo;
    const sessions = yield* Session;
    const chat = yield* Channel;
    const { everyIssue, get, publish, issueWords, changesOf, setConflict, asked, saveSplit, completeChild } = r;
    const splitting = yield* Semaphore.make(1);
    const split = Effect.fn("Issue.split")(function* (id: string, title: string, drafts: readonly T.IssueChildDraft[], by: Actor) {
      const parent = yield* get(id);
      if (by.kind === "agent" && by.role === "worker") {
        const caller = sessions.sessionOf(by.id);
        if (!caller || caller.refining || latestSessionIdOf(parent) !== by.id || caller.issue !== parent.id)
          return yield* Effect.fail(refused(t("server.issue.split.notCurrent")));
      } else if (!actsForOwner(by)) return yield* Effect.fail(refused(needsOwner));
      if (isClosed(parent.status)) return yield* Effect.fail(refused(t("server.issue.dependencies.closedParent")));
      const parentRepo = parent.repo;
      if (!parentRepo) return yield* Effect.fail(refused(t("server.issue.noRepo")));
      if ((yield* everyIssue).some((item) => item.parent === parent.id)) return yield* Effect.fail(refused(t("server.issue.split.already")));
      if (
        drafts.length === 0 ||
        drafts.length > maxChildren ||
        drafts.some((draft) => !dagIDValid(draft.id)) ||
        dagProblems(drafts.map((draft) => ({ id: draft.id, after: draft.needs ?? [] }))).length > 0
      )
        return yield* Effect.fail(refused(t("server.issue.split.invalid", { max: maxChildren })));
      const withIds = drafts.map((draft) => ({ draft, childId: issueId(newId()) }));
      const ids = new Map(withIds.map(({ draft, childId }) => [draft.id, childId]));
      const rows = yield* Effect.forEach(withIds, ({ draft, childId }) =>
        Effect.gen(function* () {
          const named = draft.agent?.trim() || assignedAgentOf(parent);
          const agent = store.agents().find((candidate) => candidate.id === named || candidate.name === named);
          if (!agent || agent.role !== "worker" || !agent.enabled) return yield* Effect.fail(refused(t("server.issue.split.agent", { agent: named ?? "" })));
          const [childTitle, description] = yield* issueWords({
            title: draft.title?.trim() || draft.brief,
            description: draft.title?.trim() ? draft.brief : "",
          });
          const check = draft.check?.trim();
          if (draft.acceptance === true && !check) return yield* Effect.fail(refused(t("server.issue.verification.acceptanceNeedsCheck")));
          const req: T.IssueRequest = {
            title: childTitle,
            description,
            parent: parent.id,
            repo: parentRepo,
            agent: agent.id,
            priority: parent.priority,
            blockedBy: (draft.needs ?? []).flatMap((need) => {
              const dep = ids.get(need);
              return dep ? [dep] : [];
            }),
            constraints: { acceptance: draft.acceptance === true, scope: draft.scope ?? [], frozen: [], ...(check ? { check } : {}) },
          };
          return { id: childId, req };
        }),
      );
      const session = latestSessionIdOf(parent);
      if (session && sessions.isReachable(session)) {
        if (!sessions.sessionOf(session)?.branch) return yield* Effect.fail(refused(t("server.issue.split.needsBranch")));
        const changes = yield* changesOf(parent);
        if (changes && changes.uncommitted.length > 0) return yield* Effect.fail(refused(t("server.issue.split.commitFirst")));
      }
      const channel = (yield* chat.topOf(session ? (sessions.sessionOf(session)?.channel ?? "") : "")).id;
      yield* saveSplit(id, title, channel, parent.mandate, rows);
      return (
        t("server.issue.split.created", { n: parent.number, count: rows.length }) +
        "\n" +
        rows.map((row) => `${row.req.title}: vv://issue/${row.id}`).join("\n")
      );
    }, splitting.withPermits(1));

    const joining = yield* Semaphore.make(1);
    const joinChildren = Effect.fn("Issue.joinChildren")(function* () {
      const all = yield* everyIssue;
      yield* Effect.forEach(
        all.filter((item): item is T.Issue & { readonly parent: T.IssueId } => item.parent !== undefined && item.stage.state === "reviewing"),
        (child) =>
          Effect.gen(function* () {
            const parent = yield* get(child.parent);
            const parentRepo = parent.repo;
            if (!parentRepo || isClosed(parent.status)) return;
            const session = latestSessionIdOf(child);
            if (!session || !sessions.isReachable(session)) return;
            const parentSession = latestSessionIdOf(parent);
            const parentWorker = parentSession ? sessions.sessionOf(parentSession) : undefined;
            if (parentWorker && isBusy(parentWorker)) return;
            yield* sessions
              .handOver(
                session,
                "completed",
                (place) =>
                  Effect.gen(function* () {
                    const constraints = yield* verifyChild(repos, child, parent, all, place);
                    const mergeIntoParent = (target: Workplace) => repos.mergeInto(place, issueBranch(parent.number), target.cwd);
                    const merged =
                      parentSession && sessions.isReachable(parentSession)
                        ? yield* sessions
                            .withIdleWorkplace(parentSession, mergeIntoParent)
                            .pipe(Effect.mapError((error) => (error._tag === "MergeFailure" ? error : MergeFailure.error(reasonOf(error)))))
                        : yield* Effect.flatMap(repos.workplace(parentRepo, parent.number, true, ""), mergeIntoParent);
                    yield* completeChild(child.id, constraints);
                    return merged;
                  }),
                "helper",
              )
              .pipe(
                Effect.tap(() => setConflict(child.id, undefined)),
                Effect.catch((failure) =>
                  Effect.andThen(
                    failure._tag === "NotTakenIn" && failure.failure.kind === "conflict"
                      ? setConflict(child.id, { base: failure.failure.base, files: [...failure.failure.files] })
                      : Effect.void,
                    asked(child.id, [{ question: failure._tag === "NotTakenIn" ? failure.message : reasonOf(failure), options: [] }]),
                  ),
                ),
              );
            yield* publish(parent.id);
          }),
        { discard: true },
      );
    }, joining.withPermits(1));

    return { split, joinChildren };
  });

export type IssueSplitting = Effect.Success<ReturnType<typeof issueSplitting>>;
