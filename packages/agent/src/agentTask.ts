// An agent's own tasks: those it does itself or hands to a subagent, each waiting for
// others. The edges' rules are protocol's (dagProblems), shared with a task graph's steps; what a task's states mean is
// this file's. Every function here is pure: a graph in, a new graph out.

import { Schema } from "effect";

import { dagIDValid, dagProblems } from "./dag.ts";
import { head } from "./head.ts";
import { agentTask as words } from "./prompts.ts";

export type By = "self" | "subagent";
export type State = "waiting" | "working" | "done" | "failed" | "skipped";

export interface AgentTask {
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
const maxTasks = 30;

/** Retries a subagent's task gets after its first failure. */
const retries = 1;

/** Done or skipped: what lets the tasks after it start. */
const settled = (t: AgentTask) => t.state === "done" || t.state === "skipped";

const find = (g: readonly AgentTask[], id: string) => g.findIndex((t) => t.id === id);

/** Waiting, and every task it waits for settled. */
const ready = (g: readonly AgentTask[], t: AgentTask) => t.state === "waiting" && t.after.every((x) => find(g, x) >= 0 && settled(g[find(g, x)]!));

export const readyTasks = (g: readonly AgentTask[]) => g.filter((t) => ready(g, t));

/** Each task's state, in order: to tell whether a change changed anything. */
export const states = (g: readonly AgentTask[]) => g.map((t) => t.state);

/** Every task settled: the graph is finished and can be put away. */
export const finished = (g: readonly AgentTask[]) => g.length > 0 && g.every(settled);

/** The edges' problems, in words a model fixes them by. */
function edgeProblems(g: readonly AgentTask[]): string[] {
  return dagProblems(g.map((t) => ({ id: t.id, after: [...t.after] }))).map((p) => {
    switch (p.kind) {
      case "duplicate":
        return words.duplicateId(p.id);
      case "self":
        return words.selfWait(p.id);
      case "missing":
        return words.missingAfter(p.id, p.other);
      case "circle":
        return words.circle(p.circle);
    }
  });
}

/** Adds tasks to the graph, all or none: a batch with any problem changes nothing, and the problems say why. */
export function add(g: readonly AgentTask[], more: readonly Partial<AgentTask>[]): [AgentTask[], string[]] {
  const problems: string[] = [];
  if (more.length === 0) problems.push(words.noTasks);
  const next: AgentTask[] = [...g];
  for (const t of more) {
    const id = (t.id ?? "").trim();
    const brief = (t.brief ?? "").trim();
    if (!dagIDValid(id)) problems.push(words.invalidId(id));
    if (!brief) problems.push(words.noBrief(id));
    next.push({
      id,
      title: (t.title ?? "").trim() || head(brief, 20),
      brief,
      after: [...(t.after ?? [])],
      by: t.by || "self",
      state: "waiting",
    });
  }
  if (next.length > maxTasks) problems.push(words.tooMany(maxTasks, next.length));
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

const stateWords: Record<State, string> = words.stateWords;

export class AgentTaskError extends Schema.TaggedError<AgentTaskError, { readonly brand: unique symbol }>()("AgentTaskError", { message: Schema.String }) {}

export function update(g: readonly AgentTask[], id: string, c: Change): AgentTask[] {
  const i = find(g, id);
  if (i < 0) throw new AgentTaskError({ message: words.notFound(id) });
  const was = g[i]!;
  const open = was.state === "waiting" || was.state === "failed";
  if ((c.brief !== undefined || c.after !== undefined) && !open) throw new AgentTaskError({ message: words.cannotChangeBrief(id, stateWords[was.state]) });
  let t: AgentTask = { ...was };
  if (c.brief !== undefined) {
    if (!c.brief.trim()) throw new AgentTaskError({ message: words.emptyBrief });
    t = { ...t, brief: c.brief.trim() };
  }
  if (c.after !== undefined) t = { ...t, after: [...c.after] };
  if (c.result !== undefined) t = { ...t, result: c.result.trim() };
  if (c.state !== undefined && c.state !== t.state) {
    const to = c.state;
    if (to === "waiting" && (t.state === "failed" || t.state === "skipped")) t = { ...t, tries: (t.tries ?? 0) + 1, state: "waiting" };
    else if ((to === "done" || to === "failed" || to === "skipped") && (t.state === "waiting" || t.state === "working")) t = { ...t, state: to };
    else throw new AgentTaskError({ message: words.cannotMove(id, stateWords[t.state], stateWords[to]) });
  }
  const next = [...g];
  next[i] = t;
  if (c.after !== undefined) {
    const problems = edgeProblems(next);
    if (problems.length > 0) throw new AgentTaskError({ message: words.problems(problems) });
  }
  return next;
}

/** The whole graph as the model reads it: what each task is at, who does it, what it waits for, what it came to. */
export function text(g: readonly AgentTask[]): string {
  if (g.length === 0) return words.none;
  const lines = [words.header(g.length, readyTasks(g).length)];
  for (const t of g) {
    const mark = t.state === "waiting" ? (ready(g, t) ? words.canDo : words.waitingFor) : stateWords[t.state];
    let line = "- [" + mark + "] " + t.id + " " + t.title;
    if (t.by === "subagent") line += words.bySubagent;
    if (t.after.length > 0 && !settled(t)) line += words.waitingOn(t.after);
    if (t.result) line += " → " + head(t.result.split(/\s+/u).filter(Boolean).join(" "), 80);
    lines.push(line);
  }
  return lines.join("\n");
}

/** A subagent takes it: waiting to working. */
export const begin = (g: readonly AgentTask[], id: string) => g.map((t) => (t.id === id && t.state === "waiting" ? { ...t, state: "working" as const } : t));

/** A subagent came back: done with what it said, or failed with why. A failure within retries goes back to waiting. */
export function settle(g: readonly AgentTask[], id: string, result: string, failed: boolean): AgentTask[] {
  return g.map((t) => {
    if (t.id !== id || t.state !== "working") return t;
    const said = { ...t, result: result.trim() };
    if (!failed) return { ...said, state: "done" as const };
    return (t.tries ?? 0) < retries ? { ...said, tries: (t.tries ?? 0) + 1, state: "waiting" as const } : { ...said, state: "failed" as const };
  });
}

/** Subagents that stopped before coming back (the agent was stopped, or the process went): their tasks wait again. */
export const requeue = (g: readonly AgentTask[], ids?: readonly string[]) =>
  g.map((t) => (t.state === "working" && (!ids || ids.includes(t.id)) ? { ...t, state: "waiting" as const } : t));
