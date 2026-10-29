// An issue's tag on a card: queued, working, waiting or closed, and its status in words.

import { t } from "@vibevalley/i18n";
import { closedText } from "@vibevalley/protocol/rules";
import type { Issue } from "@vibevalley/protocol";
/** Where a dispatched issue is on the board: not sent yet, in the works, waiting on the owner, or closed. */
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

/** The tag in words: the status while open, what its close says after. */
export const tagText = (issue: Issue) => (tagOpen(issueTag(issue)) ? t(`shared.status.${issue.status}`) : closedText(issue));
