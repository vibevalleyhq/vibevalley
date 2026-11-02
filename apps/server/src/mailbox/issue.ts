import type * as T from "@vibevalley/protocol";

/** The issue holds its mailbox until the owner answers: it asks, is stuck, or waits for the owner's verdict. */
export const waitsForHuman = (issue: Pick<T.Issue, "stage">) =>
  issue.stage.state === "asking" || issue.stage.state === "stuck" || issue.stage.state === "reviewing";
