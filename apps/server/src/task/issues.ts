// A task graph is issues: the graph's own and one per step.

import type { WorkspaceState, Issue, TaskGraph, GraphState, Task, IssueId } from "@vibevalley/protocol";
import { asksForYou, blockedBy, graphSpent, graphView, isSettled, layersOf, taskView } from "./graph.ts";
import { compare, compareText, or } from "@/base/order.ts";
import { omitUndefined } from "@vibevalley/protocol/rules";

import { issueId } from "@vibevalley/protocol/schema";
export function graphFrom(parent: Issue, issues: readonly Issue[]): TaskGraph {
  const g = parent.graph!;
  const graph: TaskGraph = omitUndefined({
    id: parent.id,
    title: parent.title,
    goal: parent.description,
    project: parent.project ?? "",
    state: g.state,
    branch: g.branch,
    parallel: g.parallel,
    note: g.note ?? "",
    createdAt: parent.createdAt,
    tasks: [],
    ...graphView(),
  });
  const steps = issues
    .filter((t) => t.parent === parent.id && t.task !== undefined)
    .toSorted((a, b) => or(compare(a.rank ?? 0, b.rank ?? 0), compareText(a.id, b.id)));
  for (const t of steps) {
    const s = t.task!;
    graph.tasks.push(
      omitUndefined({
        id: s.key,
        title: t.title,
        brief: t.description,
        needs: t.blockedBy.map((b) => (b.startsWith(parent.id + ".") ? b.slice(parent.id.length + 1) : b)),
        agent: t.assignee,
        check: s.check,
        scope: s.scope,
        acceptance: s.acceptance,
        frozen: s.frozen,
        state: s.state,
        session: s.session,
        conclusion: s.conclusion ?? "",
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
    .toSorted((a, b) => or(compare(a.createdAt, b.createdAt), compareText(a.id, b.id)));
}

export const taskIssueID = (graph: string, key: string): IssueId => issueId(graph + "." + key);

/** An issue of a task graph as it is written down: what the graph says, and what only the issue knows from before. */
export type GraphIssue = Draft & Pick<Issue, "priority" | "createdAt">;

/** What only the issues know (priority, when they were written down and closed) comes from before; one closing now closes at now. */
export function graphIssues(graph: TaskGraph, before: readonly Issue[], now: number): GraphIssue[] {
  const was = new Map(before.map((item) => [item.id, item]));
  const keep = (draft: Draft, closed: Closing | undefined): GraphIssue => {
    const { delivered: _delivered, canceled: _canceled, closedAt: drafted, ...rest } = draft;
    const old = was.get(draft.id);
    const closedAt = closed === undefined ? drafted : (old?.closedAt ?? now);
    return {
      ...rest,
      priority: old?.priority ?? "medium",
      createdAt: old?.createdAt ?? graph.createdAt,
      ...closed,
      ...(closedAt !== undefined ? { closedAt } : {}),
    };
  };
  const project = graph.project;
  const out = [
    keep(
      omitUndefined({
        id: issueId(graph.id),
        title: graph.title,
        description: graph.goal,
        project,
        // A helper's issue split under it keeps who it was given to.
        assignee: was.get(issueId(graph.id))?.assignee,
        deliver: "change" as const,
        blockedBy: [],
        graph: omitUndefined({ state: graph.state, branch: graph.branch, parallel: graph.parallel, note: graph.note || undefined }),
      }),
      graphClosed(graph.state),
    ),
  ];
  graph.tasks.forEach((n, i) => {
    out.push(
      keep(
        omitUndefined({
          id: taskIssueID(graph.id, n.id),
          title: n.title,
          description: n.brief,
          project,
          deliver: "change" as const,
          assignee: n.agent,
          rank: i > 0 ? i : undefined,
          parent: issueId(graph.id),
          blockedBy: n.needs.map((need) => taskIssueID(graph.id, need)),
          task: omitUndefined({
            key: n.id,
            state: n.state,
            check: n.check,
            scope: n.scope,
            acceptance: n.acceptance,
            frozen: n.frozen,
            session: n.session,
            conclusion: n.conclusion || undefined,
            commits: n.commits,
            spent: n.spent,
            tries: n.tries,
            failures: n.failures,
          }),
        }),
        taskClosed(graph.state, n),
      ),
    );
  });
  return out;
}

export function graphOf(state: WorkspaceState, id: string): TaskGraph | undefined {
  const issues = state.issues;
  const item = issues.find((issue) => issue.id === id && issue.graph !== undefined);
  return item ? graphFrom(item, issues) : undefined;
}

type Closing = { readonly delivered: "merged" | "merged_into_parent" } | { readonly canceled: "dismissed" };

const graphClosed = (s: GraphState): Closing | undefined =>
  s === "done" ? { delivered: "merged" } : s === "abandoned" ? { canceled: "dismissed" } : undefined;

function taskClosed(graph: GraphState, n: Task): Closing | undefined {
  if (n.state === "merged") return { delivered: "merged_into_parent" };
  if (n.state === "skipped" || graph === "done" || graph === "abandoned") return { canceled: "dismissed" };
  return undefined;
}

// Criteria and checks are no graph's: the issues it writes carry none (Issues.putTask).
type Draft = Omit<
  Issue,
  "number" | "priority" | "createdAt" | "sessions" | "status" | "moves" | "review" | "findings" | "questions" | "attention" | "criteria" | "checks"
>;
