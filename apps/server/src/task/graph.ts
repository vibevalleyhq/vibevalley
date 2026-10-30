// Texts are measured as JavaScript does.

import { dagLayers, dagIDValid, type DagNode, dagProblems } from "@vibevalley/agent/dag";
import { list, t } from "@vibevalley/i18n";
import type { GraphAction, Spent, Task, TaskAction, TaskGraph } from "@vibevalley/protocol";

/** More steps than this means the job should be split into tasks. */
/** A step as the frame shows it before its acts are worked out (graphFrom does that): none yet. */
export const taskView = (): Pick<Task, "blockedBy" | "actions" | "actionText" | "canEdit" | "canRemove" | "stateText"> => ({
  stateText: "",
  blockedBy: [],
  actions: [],
  actionText: {},
  canEdit: false,
  canRemove: false,
});

/** A graph as the frame shows it before its acts and layers are worked out: none yet. */
export const graphView = (): Pick<TaskGraph, "actionText" | "actions" | "layers" | "asksForYou" | "stateTag"> => ({
  stateTag: "",
  actionText: {},
  actions: [],
  layers: [],
  asksForYou: false,
});

export const isOpen = (graph: { state: string }) => graph.state !== "done" && graph.state !== "abandoned";

export const maxTasks = 12;
export const taskOf = (graph: TaskGraph, id: string) => graph.tasks.find((n) => n.id === id);

export const isSettled = (n: Task) => n.state === "merged" || n.state === "skipped";

export const asksForYou = (graph: TaskGraph) =>
  graph.state === "draft" || graph.state === "ready" || (isOpen(graph) && graph.tasks.some((n) => n.state === "failed"));

export function blockedBy(graph: TaskGraph, task: Task): string[] {
  return task.needs.filter((id) => {
    const need = taskOf(graph, id);
    return !need || !isSettled(need);
  });
}

export function graphSpent(graph: TaskGraph): Spent | undefined {
  let spent = false;
  let priced = false;
  let tokens = 0;
  let cny = 0;
  for (const n of graph.tasks) {
    if (!n.spent) continue;
    spent = true;
    tokens += n.spent.tokens;
    if (n.spent.cny !== undefined) {
      priced = true;
      cny += n.spent.cny;
    }
  }
  if (!spent) return undefined;
  return priced ? { tokens, cny } : { tokens };
}

export const isAcceptance = (n: Task) => n.acceptance === true;

const dagOf = (tasks: readonly Task[]): DagNode[] => tasks.map((n) => ({ id: n.id, after: n.needs }));

export function graphProblems(tasks: readonly Task[]): string[] {
  const all = tasks;
  const problems: string[] = [];
  if (all.length === 0) problems.push(t("server.task.problem.empty"));
  if (all.length > maxTasks) problems.push(t("server.task.problem.tooMany", { max: maxTasks, n: all.length }));
  const ids = new Set<string>();
  for (const n of all) {
    if (!dagIDValid(n.id)) problems.push(t("server.task.problem.badId", { id: n.id }));
    if (ids.has(n.id)) problems.push(t("server.task.problem.duplicate", { id: n.id }));
    ids.add(n.id);
    if (n.brief.trim() === "") problems.push(t("server.task.problem.noBrief", { id: n.id }));
    if (isAcceptance(n) && (n.check ?? "").trim() === "") problems.push(t("server.task.problem.noCheck", { id: n.id }));
  }
  for (const p of dagProblems(dagOf(all))) {
    switch (p.kind) {
      case "self":
        problems.push(t("server.task.problem.self", { id: p.id }));
        break;
      case "missing":
        problems.push(t("server.task.problem.missing", { id: p.id, other: p.other }));
        break;
      case "circle":
        if (problems.length === 0) problems.push(t("server.task.problem.circle", { ids: list(p.circle) }));
        break;
      case "duplicate":
        // Said above, in the step's own place.
        break;
    }
  }
  return problems;
}

export const layersOf = (tasks: readonly Task[]) => dagLayers(dagOf(tasks));

/** What the graph's state allows now; the frame carries it so the client does not repeat the switch. */
export function graphActions(graph: TaskGraph): GraphAction[] {
  const out: GraphAction[] = [];
  if (graph.state === "draft" && graphProblems(graph.tasks).length === 0) out.push("start");
  if (graph.state === "running") out.push("pause");
  if (graph.state === "paused") out.push("resume");
  if (graph.state === "ready" && graph.branch !== undefined) out.push("merge");
  if (isOpen(graph)) out.push("abandon");
  return out;
}

/** What the graph and the step allow now: retry a failed step, skip a waiting or failed one. */
export function taskActions(graph: TaskGraph, task: Task): TaskAction[] {
  const out: TaskAction[] = [];
  if (graph.state !== "running" && graph.state !== "paused") return out;
  if (task.state === "failed") out.push("retry");
  if (task.state === "waiting" || task.state === "failed") out.push("skip");
  return out;
}

/** The graph's and the step's edit gate; undefined is adding a step in a draft. */
export const canEditTask = (graph: TaskGraph, task: Task | undefined) =>
  graph.state === "draft" || ((graph.state === "running" || graph.state === "paused") && (!task || task.state === "waiting" || task.state === "failed"));

/** canEditTask but a failed step is skipped, not deleted. */
export const canRemoveTask = (graph: TaskGraph, task: Task | undefined) => !!task && canEditTask(graph, task) && task.state !== "failed";

/** The farm's limits come on top. */
export function startable(graph: TaskGraph): Task[] {
  const working = graph.tasks.filter((n) => n.state === "working").length;
  return readyTasks(graph).slice(0, Math.max(0, graph.parallel - working));
}

export const allSettled = (graph: TaskGraph) => graph.tasks.length > 0 && graph.tasks.every(isSettled);

export function frozenOf(graph: TaskGraph, task: Task): string[] {
  const out: string[] = [];
  for (const n of acceptancesOf(graph, task)) for (const f of n.frozen) if (!out.includes(f)) out.push(f);
  return out;
}

export const frozenTouched = (graph: TaskGraph, task: Task, changed: readonly string[]) => {
  const frozen = frozenOf(graph, task);
  return changed.filter((f) => frozen.includes(f));
};

export const defaultParallel = 3;

export const autoRetries = 2;

export const readyTasks = (graph: TaskGraph): Task[] =>
  graph.state !== "running" ? [] : graph.tasks.filter((n) => n.state === "waiting" && blockedBy(graph, n).length === 0);

export const withTask = (graph: TaskGraph, id: string, change: (n: Task) => Task): TaskGraph => ({
  ...graph,
  tasks: graph.tasks.map((n) => (n.id === id ? change(n) : n)),
});

function ancestorsOf(graph: TaskGraph, task: Task): Task[] {
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const need of taskOf(graph, id)?.needs ?? []) visit(need);
  };
  for (const need of task.needs) visit(need);
  return graph.tasks.filter((n) => n.id !== task.id && seen.has(n.id));
}

export const acceptancesOf = (graph: TaskGraph, task: Task) => ancestorsOf(graph, task).filter((n) => isAcceptance(n) && n.state === "merged");

const isLast = (graph: TaskGraph, task: Task) => !graph.tasks.some((n) => n.needs.includes(task.id));

export function acceptanceChecks(graph: TaskGraph, task: Task): string[] {
  const out: string[] = [];
  if (!isLast(graph, task)) return out;
  for (const n of acceptancesOf(graph, task)) if (n.check && !out.includes(n.check) && n.check !== task.check) out.push(n.check);
  return out;
}
