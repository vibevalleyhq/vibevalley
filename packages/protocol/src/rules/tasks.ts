// A task graph's rules. Texts are measured as JavaScript does.

import type { GraphAction, GraphState, Spent, Task, TaskAction, TaskGraph, TaskState } from "../shapes";
import { isOpen } from "./core";
import { dagLayers, dagIDValid, type DagNode, dagProblems } from "./dag";
import { slice } from "./text";

/** More steps than this means the job should be split into tasks. */
export const maxTasks = 12;
export const defaultParallel = 3;
export const autoRetries = 2;

export const taskOf = (graph: TaskGraph, id: string) => (graph.tasks ?? []).find((n) => n.id === id);

export const isSettled = (n: Task) => n.state === "merged" || n.state === "skipped";

export const asksForYou = (graph: TaskGraph) =>
  graph.state === "draft" || graph.state === "ripe" || (isOpen(graph) && (graph.tasks ?? []).some((n) => n.state === "failed"));

export function blockedBy(graph: TaskGraph, task: Task): string[] {
  return (task.needs ?? []).filter((id) => {
    const need = taskOf(graph, id);
    return !need || !isSettled(need);
  });
}

export const readyTasks = (graph: TaskGraph): Task[] =>
  graph.state !== "running" ? [] : (graph.tasks ?? []).filter((n) => n.state === "waiting" && blockedBy(graph, n).length === 0);

export const withTask = (graph: TaskGraph, id: string, change: (n: Task) => Task): TaskGraph => ({
  ...graph,
  tasks: (graph.tasks ?? []).map((n) => (n.id === id ? change(n) : n)),
});

export function graphSpent(graph: TaskGraph): Spent | undefined {
  let spent = false;
  let priced = false;
  let tokens = 0;
  let cny = 0;
  for (const n of graph.tasks ?? []) {
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

export const graphStateText: Record<GraphState, string> = {
  splitting: "在拆",
  draft: "等你看过再开工",
  running: "在做",
  paused: "暂停了",
  ripe: "做完了，等收获",
  done: "收完了",
  abandoned: "放弃了",
};

/** What each graph action is called; the buttons and the refusals say the same word. */
export const graphActionText: Record<GraphAction, string> = { start: "开工", pause: "暂停", resume: "继续", abandon: "放弃", merge: "收获" };

/** The short tag beside a graph's state in the list; graphStateText is the longer sentence. */
export const graphStateTag: Record<GraphState, string> = {
  splitting: "在拆",
  draft: "等你看",
  running: "在做",
  paused: "暂停了",
  ripe: "可收获",
  done: "收完了",
  abandoned: "放弃了",
};

export const taskStateText: Record<TaskState, string> = { waiting: "等着", working: "在做", merged: "合进去了", failed: "没做成", skipped: "跳过了" };

/** What each task action is called. */
export const taskActionText: Record<TaskAction, string> = { retry: "重试", skip: "跳过" };

export const isAcceptance = (n: Task) => n.acceptance === true;

export function ancestorsOf(graph: TaskGraph, task: Task): Task[] {
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const need of taskOf(graph, id)?.needs ?? []) visit(need);
  };
  for (const need of task.needs ?? []) visit(need);
  return (graph.tasks ?? []).filter((n) => n.id !== task.id && seen.has(n.id));
}

export const acceptancesOf = (graph: TaskGraph, task: Task) => ancestorsOf(graph, task).filter((n) => isAcceptance(n) && n.state === "merged");

export const isLast = (graph: TaskGraph, task: Task) => !(graph.tasks ?? []).some((n) => (n.needs ?? []).includes(task.id));

export function acceptanceChecks(graph: TaskGraph, task: Task): string[] {
  const out: string[] = [];
  if (!isLast(graph, task)) return out;
  for (const n of acceptancesOf(graph, task)) if (n.check && !out.includes(n.check) && n.check !== task.check) out.push(n.check);
  return out;
}

const dagOf = (tasks: readonly Task[]): DagNode[] => tasks.map((n) => ({ id: n.id, after: n.needs ?? [] }));

export function graphProblems(tasks: readonly Task[] | null | undefined): string[] {
  const all = tasks ?? [];
  const problems: string[] = [];
  if (all.length === 0) problems.push("计划里一步都没有");
  if (all.length > maxTasks) problems.push(`最多 ${maxTasks} 步，这里有 ${all.length} 步：把小的步骤合并`);
  const ids = new Set<string>();
  for (const n of all) {
    if (!dagIDValid(n.id)) problems.push("「" + n.id + "」不能当步骤 id：用简短的英文，比如 api");
    if (ids.has(n.id)) problems.push("步骤 id「" + n.id + "」重复了");
    ids.add(n.id);
    if (n.brief.trim() === "") problems.push("「" + n.id + "」没有工单");
    if (isAcceptance(n) && (n.check ?? "").trim() === "") problems.push("验收步骤「" + n.id + "」没有检查命令：验收就是这条命令");
  }
  for (const p of dagProblems(dagOf(all))) {
    switch (p.kind) {
      case "self":
        problems.push("「" + p.id + "」不能等自己");
        break;
      case "missing":
        problems.push("「" + p.id + "」要等的「" + p.other + "」不存在");
        break;
      case "circle":
        if (problems.length === 0) problems.push("这几步互相等，成了一个圈：" + p.circle.join("、"));
        break;
      case "duplicate":
        // Said above, in the step's own place.
        break;
    }
  }
  return problems;
}

export const layersOf = (tasks: readonly Task[] | null | undefined) => dagLayers(dagOf(tasks ?? []));

export function graphText(graph: TaskGraph): string {
  const tasks = graph.tasks ?? [];
  const merged = tasks.filter(isSettled).length;
  let head = "「" + graph.title + "」（" + graph.id + "，项目 " + graph.project;
  if (graph.branch) head += "，分支 " + graph.branch;
  head += "）：" + graphStateText[graph.state];
  if (tasks.length > 0) head += `，${merged}/${tasks.length} 步做完`;
  if (graph.note) head += "。" + graph.note;
  const lines = [head];
  for (const n of tasks) {
    let detail = taskStateText[n.state];
    if (n.state === "waiting") {
      const waits = blockedBy(graph, n);
      if (waits.length > 0) detail = "等 " + waits.join("、");
    }
    let line = "  - " + n.id + " " + n.title + (isAcceptance(n) ? "（验收）" : "") + "：" + detail;
    if (n.session) line += "（帮工 " + n.session + "）";
    if (n.conclusion) line += "；" + slice(n.conclusion, 0, 80);
    lines.push(line);
  }
  return lines.join("\n");
}

/** What the graph's state allows now; the frame carries it so the client does not repeat the switch. */
export function graphActions(graph: TaskGraph): GraphAction[] {
  const out: GraphAction[] = [];
  if (graph.state === "draft" && graphProblems(graph.tasks).length === 0) out.push("start");
  if (graph.state === "running") out.push("pause");
  if (graph.state === "paused") out.push("resume");
  if (graph.state === "ripe" && graph.branch !== undefined) out.push("merge");
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
