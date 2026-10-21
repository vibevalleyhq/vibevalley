// A task graph is issues: the graph's own and one per step.

import type { CoreState, GraphState, Issue, IssueClose, Task, TaskGraph } from "../shapes";
import { asksForYou, blockedBy, graphSpent, isSettled, layersOf } from "./tasks";
import { compare, compareText, or } from "./text";

export const taskIssueID = (graph: string, key: string) => graph + "." + key;

const graphClosed = (s: GraphState): IssueClose | undefined => (s === "done" ? "merged" : s === "abandoned" ? "dismissed" : undefined);

function taskClosed(graph: GraphState, n: Task): IssueClose | undefined {
  if (n.state === "merged") return "merged_into_graph";
  if (n.state === "skipped" || graph === "done" || graph === "abandoned") return "dismissed";
  return undefined;
}

type Draft = Omit<Issue, "number" | "priority" | "createdAt" | "sessions" | "status" | "moves" | "acceptance" | "findings" | "asks">;

/** What only the issues know (their runs, priority, when they were written down and closed) comes from before; one closing now closes at now. */
export function graphIssues(graph: TaskGraph, before: readonly Issue[], now: number): Issue[] {
  const was = new Map(before.map((t) => [t.id, t]));
  const keep = (draft: Draft, closed: IssueClose | undefined): Issue => {
    const t = { ...draft, sessions: [], priority: "medium", createdAt: graph.createdAt } as unknown as Issue;
    const old = was.get(t.id);
    if (old) {
      Object.assign(t, { sessions: old.sessions, priority: old.priority, createdAt: old.createdAt, status: old.status });
      if (closed !== undefined && old.closedAt !== undefined) t.closedAt = old.closedAt;
    }
    t.sessions ??= [];
    t.closed = closed;
    if (closed !== undefined && t.closedAt === undefined) t.closedAt = now;
    return t;
  };
  const project = graph.project;
  const out = [
    keep(
      {
        id: graph.id,
        title: graph.title,
        description: graph.goal,
        project,
        // A helper's issue split under it keeps who it was given to.
        assignee: was.get(graph.id)?.assignee,
        graph: { state: graph.state, branch: graph.branch, parallel: graph.parallel, note: graph.note },
      },
      graphClosed(graph.state),
    ),
  ];
  (graph.tasks ?? []).forEach((n, i) => {
    const blocked = (n.needs ?? []).map((need) => taskIssueID(graph.id, need));
    out.push(
      keep(
        {
          id: taskIssueID(graph.id, n.id),
          title: n.title,
          description: n.brief,
          project,
          assignee: n.agent,
          rank: i > 0 ? i : undefined,
          parent: graph.id,
          blockedBy: blocked.length > 0 ? blocked : undefined,
          task: {
            key: n.id,
            state: n.state,
            check: n.check,
            scope: n.scope,
            acceptance: n.acceptance,
            frozen: n.frozen,
            session: n.session,
            conclusion: n.conclusion,
            commits: n.commits,
            spent: n.spent,
            tries: n.tries,
            failures: n.failures,
          },
        },
        taskClosed(graph.state, n),
      ),
    );
  });
  return out;
}

function graphFrom(parent: Issue, issues: readonly Issue[]): TaskGraph {
  const g = parent.graph!;
  const graph: TaskGraph = {
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
  };
  const steps = issues.filter((t) => t.parent === parent.id && t.task).sort((a, b) => or(compare(a.rank ?? 0, b.rank ?? 0), compareText(a.id, b.id)));
  for (const t of steps) {
    const s = t.task!;
    graph.tasks.push({
      id: s.key,
      title: t.title,
      brief: t.description ?? "",
      needs: (t.blockedBy ?? []).map((b) => (b.startsWith(parent.id + ".") ? b.slice(parent.id.length + 1) : b)),
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
    });
  }
  let settled = 0;
  graph.tasks = graph.tasks.map((n) => {
    if (isSettled(n)) settled++;
    const blocked = blockedBy(graph, n);
    return blocked.length > 0 ? { ...n, blockedBy: blocked } : n;
  });
  if (settled > 0) graph.settled = settled;
  graph.layers = layersOf(graph.tasks);
  if (asksForYou(graph)) graph.asksForYou = true;
  graph.spent = graphSpent(graph);
  return graph;
}

export function graphsOf(state: CoreState): TaskGraph[] {
  const issues = state.issues ?? [];
  return issues
    .filter((t) => t.graph)
    .map((t) => graphFrom(t, issues))
    .sort((a, b) => or(compare(a.createdAt, b.createdAt), compareText(a.id, b.id)));
}

export function graphOf(state: CoreState, id: string): TaskGraph | undefined {
  const issues = state.issues ?? [];
  const t = issues.find((t) => t.id === id && t.graph);
  return t ? graphFrom(t, issues) : undefined;
}
