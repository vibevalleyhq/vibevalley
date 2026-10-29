// A task graph is issues: the graph's own and one per step.

import type { WorkspaceState, Issue, TaskGraph } from "@vibevalley/protocol";
import { asksForYou, blockedBy, graphSpent, graphView, isSettled, layersOf, taskView } from "./graph.ts";
import { compare, compareText, or } from "@/base/text.ts";
import { omitUndefined } from "@vibevalley/protocol/rules";

export function graphFrom(parent: Issue, issues: readonly Issue[]): TaskGraph {
  const g = parent.graph!;
  const graph: TaskGraph = omitUndefined({
    id: parent.id,
    title: parent.title,
    goal: parent.description ?? "",
    project: parent.project ?? "",
    state: g.state,
    branch: g.branch,
    parallel: g.parallel,
    note: g.note,
    createdAt: parent.createdAt,
    tasks: [],
    ...graphView(),
  });
  const steps = issues.filter((t) => t.parent === parent.id && t.task).sort((a, b) => or(compare(a.rank ?? 0, b.rank ?? 0), compareText(a.id, b.id)));
  for (const t of steps) {
    const s = t.task!;
    graph.tasks.push(
      omitUndefined({
        id: s.key,
        title: t.title,
        brief: t.description ?? "",
        needs: t.blockedBy.map((b) => (b.startsWith(parent.id + ".") ? b.slice(parent.id.length + 1) : b)),
        agent: t.assignee,
        check: s.check,
        scope: s.scope,
        acceptance: s.acceptance,
        frozen: s.frozen,
        state: s.state,
        session: s.session,
        conclusion: s.conclusion,
        commits: s.commits,
        spent: s.spent,
        tries: s.tries,
        failures: s.failures,
        ...taskView(),
      }),
    );
  }
  let settled = 0;
  graph.tasks = graph.tasks.map((n) => {
    if (isSettled(n)) settled++;
    return { ...n, blockedBy: blockedBy(graph, n) };
  });
  if (settled > 0) graph.settled = settled;
  graph.layers = layersOf(graph.tasks);
  graph.asksForYou = asksForYou(graph);
  const spent = graphSpent(graph);
  if (spent) graph.spent = spent;
  return graph;
}

export function graphsOf(state: WorkspaceState): TaskGraph[] {
  const issues = state.issues;
  return issues
    .filter((t) => t.graph)
    .map((t) => graphFrom(t, issues))
    .sort((a, b) => or(compare(a.createdAt, b.createdAt), compareText(a.id, b.id)));
}
