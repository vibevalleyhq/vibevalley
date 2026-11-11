import { dagProblems } from "@vibevalley/agent/dag";
import type * as T from "@vibevalley/protocol";

export function dependencyProblems(issues: readonly Pick<T.Issue, "id" | "parent" | "blockedBy">[]) {
  const children = Map.groupBy(
    issues.filter((issue): issue is Pick<T.Issue, "id" | "blockedBy"> & { readonly parent: T.IssueId } => issue.parent !== undefined),
    (issue) => issue.parent,
  );
  return dagProblems(issues.map((issue) => ({ id: issue.id, after: [...issue.blockedBy, ...(children.get(issue.id) ?? []).map((child) => child.id)] })));
}

export function blockedIssues(issue: Pick<T.Issue, "blockedBy">, issues: readonly Pick<T.Issue, "id" | "status">[]): string[] {
  const settled = new Set<string>(issues.filter((item) => item.status === "done" || item.status === "canceled").map((item) => item.id));
  return issue.blockedBy.filter((id) => !settled.has(id));
}

export function acceptanceAncestors(issue: T.Issue, all: readonly T.Issue[]): T.Issue[] {
  const byId = new Map<string, T.Issue>(all.map((item) => [item.id, item]));
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    for (const before of byId.get(id)?.blockedBy ?? []) visit(before);
  };
  for (const id of issue.blockedBy) visit(id);
  return all.filter((item) => visited.has(item.id) && item.status === "done" && item.constraints?.acceptance === true);
}
