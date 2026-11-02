import type * as T from "@vibevalley/protocol";

export const awaitsPullRequest = (issue: Pick<T.Issue, "pullRequest">, session: Pick<T.Session, "phase" | "lastRun"> | undefined) =>
  issue.pullRequest?.state === "open" && session?.phase._tag === "resting" && session.lastRun?.outcome === "completed";

export const waitsForHuman = (issue: Pick<T.Issue, "stage">) =>
  issue.stage.state === "asking" || issue.stage.state === "stuck" || issue.stage.state === "reviewing";
