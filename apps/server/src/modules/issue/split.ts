import { dagIDValid, dagProblems } from "@vibevalley/agent/dag";
import { Semaphore } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { assignedAgentOf, latestSessionIdOf } from "@vibevalley/protocol/rules";
import { issueId } from "@vibevalley/protocol/schema";

import { actsForUser, type Actor } from "#/base/actor.ts";
import { ApiError, BizCode, refuseIn } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import type { Agent } from "#/modules/agent/agent.ts";
import type { Channel } from "#/modules/channel/channel.ts";
import { NotTakenIn, type Session } from "#/modules/session/session.ts";

import { maxChildren } from "./creation.ts";
import type { IssueLifecycle } from "./lifecycle.ts";
import { childChecks } from "./merge.ts";
import { needsUser } from "./prompts.ts";
import { isClosed } from "./status.ts";

const refused = refuseIn(BizCode.IssueRefused);

export interface SplitDeps {
  readonly agent: Agent;
  readonly session: Session;
  readonly channel: Channel;
}

export type IssueSplitting = ReturnType<typeof issueSplitting>;

export function issueSplitting(r: IssueLifecycle, deps: SplitDeps) {
  const { agent: store, session: sessions, channel: chat } = deps;
  const { everyIssue, get, publish, issueWords, changesOf, setConflict, asked, saveSplit, completeChild } = r;
  const splitting = new Semaphore(1);
  const split = (id: string, title: string, drafts: readonly T.IssueChildDraft[], by: Actor): Promise<string> =>
    splitting.with(async () => {
      const parent = await get(id);
      if (by.kind === "agent" && by.role === "worker") {
        const caller = sessions.live(by.id).session;
        if (!caller || caller.refining || latestSessionIdOf(parent) !== by.id || caller.issue !== parent.id) throw refused(t("server.issue.split.notCurrent"));
      } else if (!actsForUser(by)) throw refused(needsUser);
      if (isClosed(parent.status)) throw refused(t("server.issue.dependencies.closedParent"));
      const parentRepo = parent.repo;
      if (!parentRepo) throw refused(t("server.issue.noRepo"));
      if ((await everyIssue()).some((item) => item.parent === parent.id)) throw refused(t("server.issue.split.already"));
      if (
        drafts.length === 0 ||
        drafts.length > maxChildren ||
        drafts.some((draft) => !dagIDValid(draft.id)) ||
        dagProblems(drafts.map((draft) => ({ id: draft.id, after: draft.needs ?? [] }))).length > 0
      )
        throw refused(t("server.issue.split.invalid", { max: maxChildren }));
      const withIds = drafts.map((draft) => ({ draft, childId: issueId(newId()) }));
      const ids = new Map(withIds.map(({ draft, childId }) => [draft.id, childId]));
      const rows = withIds.map(({ draft, childId }) => {
        const named = draft.agent?.trim() || assignedAgentOf(parent);
        const agent = store.agents().find((candidate) => candidate.id === named || candidate.name === named);
        if (!agent || agent.role !== "worker" || !agent.enabled) throw refused(t("server.issue.split.agent", { agent: named ?? "" }));
        const [childTitle, description] = issueWords({
          title: draft.title?.trim() || draft.brief,
          description: draft.title?.trim() ? draft.brief : "",
        });
        const check = draft.check?.trim();
        if (draft.acceptance === true && !check) throw refused(t("server.issue.verification.acceptanceNeedsCheck"));
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
      });
      const session = latestSessionIdOf(parent);
      if (session && sessions.live(session).reachable) {
        if (!sessions.live(session).session?.branch) throw refused(t("server.issue.split.needsBranch"));
        const changes = await changesOf(parent);
        if (changes && changes.uncommitted.length > 0) throw refused(t("server.issue.split.commitFirst"));
      }
      const channel = (await chat.topOf(session ? (sessions.live(session).session?.channel ?? "") : "")).id;
      await saveSplit(id, title, channel, parent.mandate, rows);
      return (
        t("server.issue.split.created", { n: parent.number, count: rows.length }) +
        "\n" +
        rows.map((row) => `${row.req.title}: vv://issue/${row.id}`).join("\n")
      );
    });

  const joining = new Semaphore(1);
  const joinOne = async (child: T.Issue & { readonly parent: T.IssueId }, all: readonly T.Issue[]) => {
    const parent = await get(child.parent);
    if (!parent.repo || isClosed(parent.status)) return;
    const checks = childChecks(child, all);
    try {
      const merged = await sessions.mergeChild(child, parent, checks, (frozen) =>
        completeChild(child.id, checks.acceptance && child.constraints ? { ...child.constraints, frozen: [...(frozen ?? [])] } : child.constraints),
      );
      if (!merged) return;
      await setConflict(child.id, undefined);
    } catch (failure) {
      if (!(failure instanceof NotTakenIn) && !(failure instanceof ApiError)) throw failure;
      if (failure instanceof NotTakenIn && failure.failure.kind === "conflict")
        await setConflict(child.id, { base: failure.failure.base, files: [...failure.failure.files] });
      await asked(child.id, [{ question: failure.message, options: [] }]);
    }
    await publish(parent.id);
  };
  const joinChildren = (): Promise<void> =>
    joining.with(async () => {
      const all = await everyIssue();
      for (const child of all.filter((item): item is T.Issue & { readonly parent: T.IssueId } => item.parent !== undefined && item.stage.state === "reviewing"))
        await joinOne(child, all);
    });

  return { split, joinChildren };
}
