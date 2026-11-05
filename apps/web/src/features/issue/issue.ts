import { t } from "@vibevalley/i18n";
import type { Issue, IssueStatus, Run, RunTrigger, Session, SessionView, WorkspaceView } from "@vibevalley/protocol";
import { assignedAgentOf, closedText, latestSessionIdOf, sessionIdsOf } from "@vibevalley/protocol/rules";
/** An orchestrator answers it: no helper works it. */
export const isForOrchestrator = (issue: Issue, orchestrators: ReadonlySet<string>) => orchestrators.has(assignedAgentOf(issue) ?? "");

export const issueIs = (issue: Issue, id: string) => issue.id === id || sessionIdsOf(issue).some((session) => session === id);

/** undefined while it is still running. */
export const endedAt = (s: Session) => (s.phase._tag === "closed" ? s.phase.at : undefined);

export function issueSession(core: WorkspaceView | undefined, issue: Issue): SessionView | undefined {
  if (!core || issue.closedAt !== undefined) return undefined;
  const last = latestSessionIdOf(issue);
  if (last === undefined) return undefined;
  return core.sessions.find((s) => s.id === last);
}

export const isRefined = (issue: Issue) => issue.description !== "" || issue.criteria.length > 0;

export type Stage = "talk" | "work" | "finish";

export const stages: Stage[] = ["talk", "work", "finish"];

export const stageLabel: Record<Stage, string> = {
  talk: t("web.issue.boardLabels.stage.talk"),
  work: t("web.issue.boardLabels.stage.work"),
  finish: t("web.issue.boardLabels.stage.finish"),
};

export function stageOf(s: IssueStatus): Stage {
  if (s === "backlog") return "talk";
  if (s === "todo" || s === "in_progress") return "work";
  return "finish";
}

export type IssueTag = "queued" | "working" | "waiting" | "closed";

export function issueTag(issue: Issue): IssueTag {
  switch (issue.status) {
    case "backlog":
    case "todo":
      return "queued";
    case "in_progress":
      return "working";
    case "in_review":
      return "waiting";
    case "done":
    case "canceled":
      return "closed";
  }
}

export const tagOpen = (tag: IssueTag) => tag !== "closed";

export const tagText = (issue: Issue) => (tagOpen(issueTag(issue)) ? t(`shared.status.${issue.status}`) : closedText(issue));

export function issueTitle(issue: Issue, issues: Issue[] = []) {
  const title = issue.title.trim();
  if (!title) return issue.id;
  const parent = issue.parent ? issues.find((item) => item.id === issue.parent) : undefined;
  if (parent) return `${parent.title} · ${title}`;
  return (title.split("\n")[0] ?? title).trim();
}

export const newIssueTitle = t("web.issue.boardLabels.newIssue");

function runTriggerText(trigger: RunTrigger) {
  switch (trigger.kind) {
    case "issue":
      return t("web.issue.trigger.issue");
    case "comment":
      return trigger.message ? t("web.issue.trigger.commentNumbered", { id: trigger.message.slice(0, 8) }) : t("web.issue.trigger.comment");
    case "cron":
      return trigger.missed === true ? t("web.issue.trigger.missed") : t("web.issue.trigger.cron");
    case "refine":
      return t("web.issue.trigger.refine");
    case "runtime":
      return t("web.issue.trigger.runtime");
  }
}

export const runText = (r: Run, now: number, took: (ms: number) => string) =>
  [
    runTriggerText(r.triggeredBy),
    r.outcome ? t(`shared.outcome.${r.outcome}`) : t("web.issue.run.working"),
    took((r.endedAt ?? now) - r.startedAt),
    ...(r.spent?.cny !== undefined ? [`¥${r.spent.cny.toFixed(2)}`] : []),
    ...(r.heard.length > 0 ? [t("web.issue.run.heard", { n: r.heard.length })] : []),
  ].join(" · ");
