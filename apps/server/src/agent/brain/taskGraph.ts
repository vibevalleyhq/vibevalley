// An agent's own task graph: tasks it does itself or hands to a helper, each waiting for
// others. The edges' rules are protocol's (dagProblems), shared with a task graph's steps; what a task's states mean is
// this file's. Every function here is pure: a graph in, a new graph out.

import { dagIDValid, dagProblems } from "@vibevalley/protocol/rules";
import { head } from "../../base/text.ts";

export type By = "self" | "helper";
export type State = "waiting" | "working" | "done" | "failed" | "skipped";

export interface Task {
  /** The model's own short id: "read", "fix-auth". */
  readonly id: string;
  readonly title: string;
  /** What to do, where, what counts as done, what to report. */
  readonly brief: string;
  /** Ids that must be done or skipped first. */
  readonly after: readonly string[];
  readonly by: By;
  readonly state: State;
  readonly result?: string;
  readonly tries?: number;
}

/** A graph past this is a project, not one piece of work: it belongs in issues. */
export const maxTasks = 30;

/** Retries a helper's task gets after its first failure. */
export const retries = 1;

/** Done or skipped: what lets the tasks after it start. */
const settled = (t: Task) => t.state === "done" || t.state === "skipped";

const find = (g: readonly Task[], id: string) => g.findIndex((t) => t.id === id);

/** Waiting, and every task it waits for settled. */
const ready = (g: readonly Task[], t: Task) => t.state === "waiting" && t.after.every((x) => find(g, x) >= 0 && settled(g[find(g, x)]!));

export const readyTasks = (g: readonly Task[]) => g.filter((t) => ready(g, t));

/** Each task's state, in order: to tell whether a change changed anything. */
export const states = (g: readonly Task[]) => g.map((t) => t.state);

/** Every task settled: the graph is finished and can be put away. */
export const finished = (g: readonly Task[]) => g.length > 0 && g.every(settled);

/** The edges' problems, in words a model fixes them by. */
function edgeProblems(g: readonly Task[]): string[] {
  return dagProblems(g.map((t) => ({ id: t.id, after: [...t.after] }))).map((p) => {
    switch (p.kind) {
      case "duplicate":
        return "id「" + p.id + "」重复了";
      case "self":
        return "「" + p.id + "」不能等自己";
      case "missing":
        return "「" + p.id + "」要等的「" + p.other + "」不存在";
      case "circle":
        return "这几件互相等，成了一个圈：" + p.circle.join("、");
    }
  });
}

/** Adds tasks to the graph, all or none: a batch with any problem changes nothing, and the problems say why. */
export function add(g: readonly Task[], more: readonly Partial<Task>[]): [Task[], string[]] {
  const problems: string[] = [];
  if (more.length === 0) problems.push("一件任务都没有");
  const next: Task[] = [...g];
  for (const t of more) {
    const id = (t.id ?? "").trim();
    const brief = (t.brief ?? "").trim();
    if (!dagIDValid(id)) problems.push("「" + id + "」不能当 id：用简短的英文，比如 read、fix-auth");
    if (!brief) problems.push("「" + id + "」没有写要做什么（brief）");
    next.push({ id, title: (t.title ?? "").trim() || head(brief, 20), brief, after: [...(t.after ?? [])], by: t.by || "self", state: "waiting" });
  }
  if (next.length > maxTasks) problems.push(`最多 ${maxTasks} 件，这里有 ${next.length} 件：把小的合并，或者先做完一部分`);
  const all = problems.length === 0 ? edgeProblems(next) : problems;
  return all.length > 0 ? [[...g], all] : [next, []];
}

/** What a model may change on one task; undefined leaves it. */
export interface Change {
  readonly state?: State;
  readonly result?: string;
  readonly brief?: string;
  readonly after?: readonly string[];
}

const stateWords: Record<State, string> = { waiting: "还没做", working: "在做", done: "做完了", failed: "没做成", skipped: "跳过了" };

export class TaskError extends Error {}

export function update(g: readonly Task[], id: string, c: Change): Task[] {
  const i = find(g, id);
  if (i < 0) throw new TaskError("没有「" + id + "」这件任务");
  const was = g[i]!;
  const open = was.state === "waiting" || was.state === "failed";
  if ((c.brief !== undefined || c.after !== undefined) && !open) throw new TaskError("「" + id + "」已经" + stateWords[was.state] + "，不能再改要做什么或等谁");
  let t: Task = { ...was };
  if (c.brief !== undefined) {
    if (!c.brief.trim()) throw new TaskError("brief 是空的");
    t = { ...t, brief: c.brief.trim() };
  }
  if (c.after !== undefined) t = { ...t, after: [...c.after] };
  if (c.result !== undefined) t = { ...t, result: c.result.trim() };
  if (c.state !== undefined && c.state !== t.state) {
    const to = c.state;
    if (to === "waiting" && (t.state === "failed" || t.state === "skipped")) t = { ...t, tries: (t.tries ?? 0) + 1, state: "waiting" };
    else if ((to === "done" || to === "failed" || to === "skipped") && (t.state === "waiting" || t.state === "working")) t = { ...t, state: to };
    else throw new TaskError("「" + id + "」" + stateWords[t.state] + "，不能改成" + stateWords[to]);
  }
  const next = [...g];
  next[i] = t;
  if (c.after !== undefined) {
    const problems = edgeProblems(next);
    if (problems.length > 0) throw new TaskError(problems.join("；"));
  }
  return next;
}

/** The whole graph as the model reads it: what each task is at, who does it, what it waits for, what it came to. */
export function text(g: readonly Task[]): string {
  if (g.length === 0) return "现在没有任务。";
  const lines = [`任务（${g.length} 件，${readyTasks(g).length} 件可以做）：`];
  for (const t of g) {
    const mark = t.state === "waiting" ? (ready(g, t) ? "可以做" : "等着") : stateWords[t.state];
    let line = "- [" + mark + "] " + t.id + " " + t.title;
    if (t.by === "helper") line += "（帮手做）";
    if (t.after.length > 0 && !settled(t)) line += "（等 " + t.after.join("、") + "）";
    if (t.result) line += " → " + head(t.result.split(/\s+/).filter(Boolean).join(" "), 80);
    lines.push(line);
  }
  return lines.join("\n");
}

/** A helper takes it: waiting to working. */
export const begin = (g: readonly Task[], id: string) => g.map((t) => (t.id === id && t.state === "waiting" ? { ...t, state: "working" as const } : t));

/** A helper came back: done with what it said, or failed with why. A failure within retries goes back to waiting. */
export function settle(g: readonly Task[], id: string, result: string, failed: boolean): Task[] {
  return g.map((t) => {
    if (t.id !== id || t.state !== "working") return t;
    const said = { ...t, result: result.trim() };
    if (!failed) return { ...said, state: "done" as const };
    return (t.tries ?? 0) < retries ? { ...said, tries: (t.tries ?? 0) + 1, state: "waiting" as const } : { ...said, state: "failed" as const };
  });
}

/** Helpers that stopped before coming back (the agent was stopped, or the process went): their tasks wait again. */
export const requeue = (g: readonly Task[], ids?: readonly string[]) =>
  g.map((t) => (t.state === "working" && (!ids || ids.includes(t.id)) ? { ...t, state: "waiting" as const } : t));
