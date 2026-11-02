import { t } from "@vibevalley/i18n";
import type { Issue } from "@vibevalley/protocol";
export function issueTitle(issue: Issue, issues: Issue[] = []) {
  const title = issue.title.trim();
  if (!title) return issue.id;
  const parent = issue.parent ? issues.find((item) => item.id === issue.parent) : undefined;
  if (parent) return `${parent.title} · ${title}`;
  return title.split("\n")[0]!.trim();
}

export const newIssueTitle = t("web.issue.boardLabels.newIssue");
