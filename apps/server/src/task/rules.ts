import { t } from "@vibevalley/i18n";
// A task graph's own rules: reading one from a splitter's answer, editing its steps, what
// each step is told, and which steps start.

import { taskWording } from "./words.ts";
import {
  type WorkspaceState,
  type GraphEvent,
  type GraphState,
  type Issue,
  type Task,
  type TaskEdit,
  type TaskGraph,
  type IssueId,
} from "@vibevalley/protocol";
import { issueId } from "@vibevalley/protocol/schema";
import { blockedBy, canEditTask, canRemoveTask, graphProblems, isAcceptance, isSettled, taskOf } from "./graph.ts";
import { graphFrom } from "./issues.ts";

/** The farm's limits come on top. */
export function startable(graph: TaskGraph): Task[] {
  const working = graph.tasks.filter((n) => n.state === "working").length;
  return readyTasks(graph).slice(0, Math.max(0, graph.parallel - working));
}

export const allSettled = (graph: TaskGraph) => graph.tasks.length > 0 && graph.tasks.every(isSettled);

export function frozenOf(graph: TaskGraph, task: Task): string[] {
  const out: string[] = [];
  for (const n of acceptancesOf(graph, task)) for (const f of n.frozen ?? []) if (!out.includes(f)) out.push(f);
  return out;
}

export const frozenTouched = (graph: TaskGraph, task: Task, changed: readonly string[]) => {
  const frozen = frozenOf(graph, task);
  return changed.filter((f) => frozen.includes(f));
};

/** A step as whoever splits writes it: the splitting session in its json block, a helper through issue_split. */
export interface StepDraft {
  readonly id: string;
  readonly title?: string;
  readonly brief: string;
  readonly needs?: readonly string[];
  readonly agent?: string;
  readonly check?: string;
  readonly scope?: readonly string[];
  readonly acceptance?: boolean;
}

export function freshTask(draft: StepDraft): Task {
  const id = draft.id.trim();
  const agent = (draft.agent ?? "").trim();
  const check = (draft.check ?? "").trim();
  return {
    id,
    title: (draft.title ?? "").trim() || id,
    brief: draft.brief.trim(),
    needs: (draft.needs ?? []).map((x) => x.trim()),
    ...(agent ? { agent } : {}),
    ...(check ? { check } : {}),
    ...(draft.scope && draft.scope.length > 0 ? { scope: [...draft.scope] } : {}),
    ...(draft.acceptance ? { acceptance: true } : {}),
    state: "waiting",
    tries: 0,
  };
}

export type ParsedSplit = { readonly ok: true; readonly title?: string; readonly tasks: Task[] } | { readonly ok: false; readonly problems: string[] };

const taskBlock = /```(?:json)?[^\n]*\n([\s\S]*?)```/g;

/** JSON as Go's decoder reads it; the words for one that does not read say what Go's would where they are the same failure. */
function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(body.trim() === "" || /end of JSON input/i.test(message) ? "unexpected end of JSON input" : message, { cause: e });
  }
}

/** Optional fields may be missing but never null; other keys are ignored. */
function decodeSplitDraft(raw: unknown): { title?: string; tasks: StepDraft[] } | string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return t("server.task.parse.object");
  const obj = raw as Record<string, unknown>;
  let title: string | undefined;
  if ("title" in obj) {
    if (typeof obj.title !== "string") return t("server.task.parse.string", { at: `["title"]` });
    title = obj.title;
  }
  if (!Array.isArray(obj.tasks)) return t("server.task.parse.array", { at: `["tasks"]` });
  const tasks: StepDraft[] = [];
  for (const [i, item] of obj.tasks.entries()) {
    const at = `["tasks"][${i}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) return t("server.task.parse.stepObject", { at });
    const o = item as Record<string, unknown>;
    const text = (key: string, required: boolean): string | undefined | { problem: string } => {
      if (!(key in o)) return required ? { problem: t("server.task.parse.missing", { at: `${at}["${key}"]` }) } : undefined;
      return typeof o[key] === "string" ? o[key] : { problem: t("server.task.parse.string", { at: `${at}["${key}"]` }) };
    };
    const texts = (key: string): string[] | undefined | { problem: string } => {
      if (!(key in o)) return undefined;
      const a = o[key];
      if (!Array.isArray(a)) return { problem: t("server.task.parse.array", { at: `${at}["${key}"]` }) };
      const bad = a.findIndex((x) => typeof x !== "string");
      return bad >= 0 ? { problem: t("server.task.parse.string", { at: `${at}["${key}"][${bad}]` }) } : (a as string[]);
    };
    const step: Record<string, unknown> = {};
    for (const [key, read] of [
      ["id", () => text("id", true)],
      ["title", () => text("title", false)],
      ["brief", () => text("brief", true)],
      ["needs", () => texts("needs")],
      ["agent", () => text("agent", false)],
      ["check", () => text("check", false)],
      ["scope", () => texts("scope")],
    ] as const) {
      const v = read();
      if (v !== undefined && typeof v === "object" && !Array.isArray(v)) return v.problem;
      if (v !== undefined) step[key] = v;
    }
    if ("acceptance" in o) {
      if (typeof o.acceptance !== "boolean") return t("server.task.parse.boolean", { at: at + `["acceptance"]` });
      step.acceptance = o.acceptance;
    }
    tasks.push(step as unknown as StepDraft);
  }
  return { ...(title !== undefined ? { title } : {}), tasks };
}

export function parseSplit(text: string): ParsedSplit {
  const blocks = [...text.matchAll(taskBlock)].map((m) => m[1]!);
  if (blocks.length === 0) return { ok: false, problems: [t("server.task.parse.noBlock")] };
  let last = "";
  for (let i = blocks.length - 1; i >= 0; i--) {
    let raw: unknown;
    try {
      raw = parseJson(blocks[i]!);
    } catch (e) {
      last = t("server.task.parse.unreadable", { why: (e as Error).message });
      continue;
    }
    const draft = decodeSplitDraft(raw);
    if (typeof draft === "string") {
      last = t("server.task.parse.shape", { why: draft });
      continue;
    }
    const tasks = draft.tasks.map(freshTask);
    const problems = graphProblems(tasks);
    if (problems.length > 0) return { ok: false, problems };
    const title = (draft.title ?? "").trim();
    return { ok: true, ...(title ? { title } : {}), tasks };
  }
  return { ok: false, problems: [last] };
}

export type EditResult = { readonly ok: true; readonly graph: TaskGraph } | { readonly ok: false; readonly problem: string };

const checked = (graph: TaskGraph): EditResult => {
  const problems = graphProblems(graph.tasks);
  return problems.length > 0 ? { ok: false, problem: problems[0]! } : { ok: true, graph };
};

/** needs and scope count as given when there, as an empty JSON array decodes. */
export function editTask(graph: TaskGraph, id: string, edit: TaskEdit): EditResult {
  const task = taskOf(graph, id);
  if (!canEditTask(graph, task))
    return {
      ok: false,
      problem: task
        ? t("server.task.edit.taskSettled", { title: task.title, state: taskWording().taskState[task.state] })
        : t("server.task.edit.graphSettled", { state: taskWording().graphState[graph.state] }),
    };
  const base: Task = task ?? { id, title: id, brief: "", needs: [], state: "waiting", tries: 0 };
  const agent = edit.agent !== undefined ? edit.agent.trim() : base.agent;
  const check = edit.check !== undefined ? edit.check.trim() : base.check;
  const scope = edit.scope !== undefined ? edit.scope : base.scope;
  const { agent: _a, check: _c, scope: _s, ...rest } = base;
  const next: Task = {
    ...rest,
    ...(edit.title !== undefined ? { title: edit.title.trim() || id } : {}),
    ...(edit.brief !== undefined ? { brief: edit.brief.trim() } : {}),
    ...(edit.needs !== undefined ? { needs: [...edit.needs] } : {}),
    ...(agent ? { agent } : {}),
    ...(check ? { check } : {}),
    ...(scope && scope.length > 0 ? { scope: [...scope] } : {}),
  };
  if (task) return checked(withTask(graph, id, () => next));
  return checked({ ...graph, tasks: [...graph.tasks, next] });
}

export function removeTask(graph: TaskGraph, id: string): EditResult {
  const task = taskOf(graph, id);
  if (!task) return { ok: false, problem: t("server.task.edit.noStep", { id }) };
  if (!canRemoveTask(graph, task))
    return { ok: false, problem: t("server.task.edit.cannotRemove", { title: task.title, state: taskWording().taskState[task.state] }) };
  return checked({ ...graph, tasks: graph.tasks.filter((n) => n.id !== id).map((n) => ({ ...n, needs: n.needs.filter((x) => x !== id) })) });
}

export const changeOf = (e: GraphEvent) => ({
  graph: e.graph,
  ...(e.task !== undefined ? { task: e.task } : {}),
  kind: e.kind,
  ...(e.session !== undefined ? { session: e.session } : {}),
  ...(e.detail !== undefined ? { detail: e.detail } : {}),
  ...(e.changes !== undefined ? { changes: e.changes } : {}),
  ...(e.commits !== undefined ? { commits: e.commits } : {}),
});

export const taskIssueID = (graph: string, key: string): IssueId => issueId(graph + "." + key);

/** What only the issues know (their runs, priority, when they were written down and closed) comes from before; one closing now closes at now. */
export function graphIssues(graph: TaskGraph, before: readonly Issue[], now: number): Issue[] {
  const was = new Map(before.map((item) => [item.id, item]));
  const keep = (draft: Draft, closed: Closing | undefined): Issue => {
    const item = { ...draft, sessions: [], priority: "medium", createdAt: graph.createdAt } as unknown as Issue;
    const old = was.get(item.id);
    if (old) {
      Object.assign(item, { sessions: old.sessions, priority: old.priority, createdAt: old.createdAt, status: old.status });
      if (closed !== undefined && old.closedAt !== undefined) item.closedAt = old.closedAt;
    }
    item.sessions ??= [];
    delete item.delivered;
    delete item.canceled;
    if (closed) Object.assign(item, closed);
    if (closed !== undefined && item.closedAt === undefined) item.closedAt = now;
    return item;
  };
  const project = graph.project;
  const out = [
    keep(
      {
        id: issueId(graph.id),
        title: graph.title,
        description: graph.goal,
        project,
        // A helper's issue split under it keeps who it was given to.
        assignee: was.get(issueId(graph.id))?.assignee,
        deliver: "change",
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
          deliver: "change",
          assignee: n.agent,
          rank: i > 0 ? i : undefined,
          parent: issueId(graph.id),
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

export function graphOf(state: WorkspaceState, id: string): TaskGraph | undefined {
  const issues = state.issues ?? [];
  const item = issues.find((issue) => issue.id === id && issue.graph);
  return item ? graphFrom(item, issues) : undefined;
}

/** How a task graph's issue closes: done with what it delivered, or canceled. */
type Closing = { readonly delivered: "merged" | "merged_into_parent" } | { readonly canceled: "dismissed" };

const graphClosed = (s: GraphState): Closing | undefined =>
  s === "done" ? { delivered: "merged" } : s === "abandoned" ? { canceled: "dismissed" } : undefined;

/** A step merged into its graph's branch is done; one skipped, or left when its graph ended, is not. */
function taskClosed(graph: GraphState, n: Task): Closing | undefined {
  if (n.state === "merged") return { delivered: "merged_into_parent" };
  if (n.state === "skipped" || graph === "done" || graph === "abandoned") return { canceled: "dismissed" };
  return undefined;
}

type Draft = Omit<Issue, "number" | "priority" | "createdAt" | "sessions" | "status" | "moves" | "review" | "findings" | "questions" | "attention">;

export const defaultParallel = 3;

export const autoRetries = 2;

export const readyTasks = (graph: TaskGraph): Task[] =>
  graph.state !== "running" ? [] : (graph.tasks ?? []).filter((n) => n.state === "waiting" && blockedBy(graph, n).length === 0);

export const withTask = (graph: TaskGraph, id: string, change: (n: Task) => Task): TaskGraph => ({
  ...graph,
  tasks: (graph.tasks ?? []).map((n) => (n.id === id ? change(n) : n)),
});

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
