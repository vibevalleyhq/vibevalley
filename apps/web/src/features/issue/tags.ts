import { t } from "@vibevalley/i18n";
import type { Issue } from "@vibevalley/protocol";
import { closedText } from "@vibevalley/protocol/rules";
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
