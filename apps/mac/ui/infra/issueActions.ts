import { t } from "@vibevalley/i18n";
import { type ActorRef, type Changes, type Issue, type IssueAct, type IssueAction, VibeValleyApiError } from "@vibevalley/protocol";
import { latestSessionIdOf, omitUndefined } from "@vibevalley/protocol/rules";
import { issueId } from "@vibevalley/protocol/schema";

import { api, newSendKey } from "./api";
import { defineQuery, retryRead, useQuery } from "./query";

/** Default placeholder title used when creating an untitled issue draft. */
export const newIssueTitle = t("web.issue.boardLabels.newIssue");

/** Looks up the stage action descriptor matching an `IssueAct` on an issue. */
export const actionOf = (issue: Issue, act: IssueAct) => issue.stage.acts.find((a) => a.act === act);

/** An action sent once, without an overlay (the farm's bed tools, which play their effect after it). */
export function perform(issue: Issue, a: IssueAction, words = "", sendKey = "", revision?: Changes["revision"]): Promise<unknown> {
  switch (a.does) {
    case "move":
      return api.issue.status.update({ id: issue.id, status: a.status, ...(words ? { text: words } : {}), ...(revision ? { revision } : {}) });
    case "say":
      return api.issue.comment.create({ id: issue.id, text: words, ...(sendKey ? { sendKey } : {}) });
    case "stop": {
      const session = latestSessionIdOf(issue);
      return session === undefined ? Promise.resolve() : api.session.stop({ id: session });
    }
  }
}

/** Approves the currently inspected diff revision for a change-delivering top-level issue. */
export async function approveShownChanges(issue: Issue, shown: Changes) {
  const revision = issue.deliver === "change" && !issue.parent ? shown.revision : undefined;
  if (revision) await api.issue.review({ id: issue.id, pass: true, revision });
  return { revision };
}

const changesQuery = defineQuery({
  key: (input: { id: string; sinceTree?: string }) => ["issues", "changes", input.id, input.sinceTree ?? ""],
  fetch: (input, context) => api.issue.diff.get(input, context),
  ...retryRead,
});

/** What completing the issue would merge; read only while it is shown. */
export const useIssueChanges = (id: () => string, shown: () => boolean = () => true, sinceTree?: () => string | undefined) =>
  useQuery(
    () => {
      const since = sinceTree?.();
      return changesQuery(since ? { id: id(), sinceTree: since } : { id: id() });
    },
    { enabled: shown },
  );

/** The request key of the issue a box writes: the same words written again after a failure (a lost reply) are the same issue, made once. */
export function createWriteKey() {
  let last: { words: string; agent: string; repo: string; key: string } | undefined;
  return {
    for: (words: string, agent: string, repo: string) => {
      if (last?.words !== words || last.agent !== agent || last.repo !== repo) last = { words, agent, repo, key: newSendKey() };
      return last.key;
    },
    used: () => void (last = undefined),
  };
}

/** The plus: an issue made at once in the backlog. With words, they are its title and its draft starts from them. */
export async function writeIssue(
  text: string,
  agent: string,
  repo: string,
  requestKey: string,
  machineId = "",
  attachments?: readonly string[],
  tags?: readonly string[],
  dates?: { startAt?: number | undefined; dueAt?: number | undefined; parent?: string | undefined; owner?: ActorRef | undefined },
): Promise<{ issue: Issue; refused: string }> {
  const words = text.trim();
  const made = await api.issue.create(
    omitUndefined({
      title: words || newIssueTitle,
      repo: repo || undefined,
      agent: agent || undefined,
      machineId: machineId || undefined,
      attachments: attachments && attachments.length > 0 ? [...attachments] : undefined,
      tags: tags && tags.length > 0 ? [...tags] : undefined,
      parent: dates?.parent ? issueId(dates.parent) : undefined,
      startAt: dates?.startAt,
      dueAt: dates?.dueAt,
      owner: dates?.owner,
      requestKey,
    }),
  );
  if (!words) return { issue: made, refused: "" };
  try {
    return { issue: await api.issue.refine({ id: made.id, text: words }), refused: "" };
  } catch (e) {
    if (e instanceof VibeValleyApiError) return { issue: made, refused: e.reason };
    throw e;
  }
}
