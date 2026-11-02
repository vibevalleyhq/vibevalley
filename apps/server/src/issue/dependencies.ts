import { dagProblems } from "@vibevalley/agent/dag";
import type * as T from "@vibevalley/protocol";

export function dependencyProblems(issues: readonly Pick<T.Issue, "id" | "parent" | "blockedBy">[]) {
  const children = Map.groupBy(
    issues.filter((issue) => issue.parent !== undefined),
    (issue) => issue.parent!,
  );
  return dagProblems(issues.map((issue) => ({ id: issue.id, after: [...issue.blockedBy, ...(children.get(issue.id) ?? []).map((child) => child.id)] })));
}

export function blockedIssues(issue: Pick<T.Issue, "blockedBy">, issues: readonly Pick<T.Issue, "id" | "status">[]): string[] {
  const settled = new Set<string>(issues.filter((item) => item.status === "done" || item.status === "canceled").map((item) => item.id));
  return issue.blockedBy.filter((id) => !settled.has(id));
}
