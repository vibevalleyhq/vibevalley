import { Clock, Effect, Semaphore } from "effect";

import { dagIDValid, dagProblems } from "@vibevalley/agent/dag";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { assignedAgentOf, isBusy, latestSessionIdOf } from "@vibevalley/protocol/rules";
import { issueId } from "@vibevalley/protocol/schema";

import { Agent } from "#/agent/agent.ts";
import { actsForOwner, type Actor } from "#/base/actor.ts";
import { newId } from "#/base/ids.ts";
import { Channel } from "#/channel/channel.ts";
import { missing, lookIn, reasonOf, refused } from "#/base/errors.ts";
import { causeMessage, Db } from "#/infra/db.ts";
import { bestEffort } from "#/infra/log.ts";
import { Mailbox } from "#/mailbox/mailbox.ts";
import { recordTrigger } from "#/mailbox/payload.ts";
import { issueBranch, Project } from "#/project/project.ts";
import { MergeFailure, type Workplace } from "#/project/workplace.ts";
import { Session } from "#/session/session.ts";
import * as q from "#db/issue.sql.ts";

import { assignTo } from "./assignment.ts";
import { issueRow, maxChildren } from "./creation.ts";
import { verifyChild } from "./merge.ts";
import { needsOwner } from "./prompts.ts";
import type { IssueRecords } from "./records.ts";
import { isClosed } from "./status.ts";

export const issueSplitting = (r: IssueRecords) =>
  Effect.gen(function* () {
    const store = yield* Agent;
    const projects = yield* Project;
    const sessions = yield* Session;
    const chat = yield* Channel;
    const mailbox = yield* Mailbox;
    const db = yield* Db;
    const { worked, everyIssue, get, publish, issueWords, complete, changesOf, setConflict, asked } = r;
    const splitting = yield* Semaphore.make(1);
    const split = Effect.fn("Issue.split")(function* (id: string, title: string, drafts: readonly T.IssueChildDraft[], by: Actor) {
      const parent = yield* get(id);
      if (by.kind === "session") {
        const caller = sessions.sessionOf(by.id);
        if (!caller || caller.refining || latestSessionIdOf(parent) !== by.id || caller.issue !== parent.id)
          return yield* Effect.fail(refused(t("server.issue.split.notCurrent")));
      } else if (!actsForOwner(by)) return yield* Effect.fail(refused(needsOwner));
      if (isClosed(parent.status)) return yield* Effect.fail(refused(t("server.issue.dependencies.closedParent")));
      const parentProject = parent.project;
      if (!parentProject) return yield* Effect.fail(refused(t("server.issue.noProject")));
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
            project: parentProject,
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
      if (session && sessions.present(session)) {
        if (!sessions.sessionOf(session)?.branch) return yield* Effect.fail(refused(t("server.issue.split.needsBranch")));
        const changes = yield* changesOf(parent);
        if (changes && changes.uncommitted.length > 0) return yield* Effect.fail(refused(t("server.issue.split.commitFirst")));
      }
      const channel = (yield* chat.topOf(session ? (sessions.sessionOf(session)?.channel ?? "") : "")).id;
      const at = yield* Clock.currentTimeMillis;
      const dispatches: T.Trigger[] = [];
      const assignments = yield* db
        .attemptTx(
          Effect.gen(function* () {
            const current = yield* q.getIssue({ id });
            const family = yield* q.family({ id });
            if (current.closed_at !== null || family.some((item) => item.parent === id)) return yield* Effect.fail(refused(t("server.issue.split.already")));
            if (title.trim())
              yield* q.editIssue({
                id,
                title: title.trim(),
                description: current.description,
                project: current.project,
                priority: current.priority,
                criteria: current.criteria,
                deliver: current.deliver,
              });
            return yield* Effect.forEach(rows, (row) =>
              Effect.gen(function* () {
                yield* q.addIssue(issueRow(row.id, row.req, parent.mandate, at));
                dispatches.push(
                  yield* recordTrigger(db, {
                    source: "workbench",
                    key: newId(),
                    actor: { kind: "system", id: "system" },
                    text: [row.req.title, row.req.description].filter(Boolean).join("\n\n"),
                    threads: [`issue:${row.id}`],
                    addressed: "thread_owner",
                    replyChannel: channel,
                    meta: { ingressRecipient: row.req.agent ?? "", issue: row.id, trigger: { kind: "issue" }, dispatch: true },
                    at,
                  }),
                );
                yield* q.queueIssue({ id: row.id, at });
                return yield* assignTo(row.id, row.req.agent, at);
              }),
            );
          }),
        )
        .pipe(
          Effect.catchTags({
            SqlError: (error) => Effect.fail(refused(causeMessage(error))),
            SchemaError: Effect.die,
            NoSuchElementError: () => Effect.fail(missing(t("server.issue.issueRef", { ref: id }), [lookIn.issue])),
          }),
        );
      for (const assignment of assignments) worked.changed(assignment.changed);
      yield* Effect.forEach(dispatches, (dispatch) => mailbox.receive(dispatch).pipe(bestEffort(`issue: route ${dispatch.id}`)), { discard: true });
      yield* Effect.forEach(rows, (row) => publish(row.id), { discard: true });
      yield* publish(id);
      return (
        t("server.issue.split.created", { n: parent.number, count: rows.length }) +
        "\n" +
        rows.map((row) => `${row.req.title}: vv://issue/${row.id}`).join("\n")
      );
    }, splitting.withPermits(1));

    const joining = yield* Semaphore.make(1);
    const joinChildren = Effect.fn("Issue.joinChildren")(
      function* () {
        const all = yield* everyIssue;
        yield* Effect.forEach(
          all.filter((item): item is T.Issue & { readonly parent: T.IssueId } => item.parent !== undefined && item.stage.state === "reviewing"),
          (child) =>
            Effect.gen(function* () {
              const parent = yield* get(child.parent);
              const parentProject = parent.project;
              if (!parentProject || isClosed(parent.status)) return;
              const session = latestSessionIdOf(child);
              if (!session || !sessions.present(session)) return;
              const parentSession = latestSessionIdOf(parent);
              const parentWorker = parentSession ? sessions.sessionOf(parentSession) : undefined;
              if (parentWorker && isBusy(parentWorker)) return;
              yield* sessions
                .handOver(
                  session,
                  "completed",
                  (place) =>
                    Effect.gen(function* () {
                      const constraints = yield* verifyChild(projects, child, parent, all, place);
                      if (constraints) yield* db.run(q.setIssueConstraints({ id: child.id, constraints: JSON.stringify(constraints) }));
                      const mergeIntoParent = (target: Workplace) => projects.mergeInto(place, issueBranch(parent.number), target.cwd);
                      const merged =
                        parentSession && sessions.present(parentSession)
                          ? yield* sessions
                              .withIdleWorkplace(parentSession, mergeIntoParent)
                              .pipe(Effect.mapError((error) => (error._tag === "MergeFailure" ? error : MergeFailure.error(reasonOf(error)))))
                          : yield* Effect.flatMap(projects.workplace(parentProject, parent.number, true, ""), mergeIntoParent);
                      yield* complete(child.id, "merged_into_parent");
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
      },
      joining.withPermits(1),
    );

    return { split, joinChildren };
  });

export type IssueSplitting = Effect.Success<ReturnType<typeof issueSplitting>>;
