import { omitUndefined } from "@vibevalley/protocol/rules";
import { t } from "@vibevalley/i18n";
// A task graph's own rules: reading one from a splitter's answer, editing its steps, what
// each step is told, and which steps start.

import { Result, Schema, SchemaIssue } from "effect";
import { messageOf } from "@/errors.ts";
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
import { blockedBy, canEditTask, canRemoveTask, graphProblems, isAcceptance, isSettled, taskOf, taskView } from "./graph.ts";
import { graphFrom } from "./issues.ts";

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
    scope: [...(draft.scope ?? [])],
    acceptance: draft.acceptance ?? false,
    frozen: [],
    commits: [],
    conclusion: "",
    state: "waiting",
    tries: 0,
    ...taskView(),
  };
}

export type ParsedSplit = { readonly ok: true; readonly title?: string; readonly tasks: Task[] } | { readonly ok: false; readonly problems: string[] };

const taskBlock = /```(?:json)?[^\n]*\n([\s\S]*?)```/g;

/** JSON as Go's decoder reads it; the words for one that does not read say what Go's would where they are the same failure. */
function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (e) {
    const message = messageOf(e);
    throw new Error(body.trim() === "" || /end of JSON input/i.test(message) ? "unexpected end of JSON input" : message, { cause: e });
  }
}

const formatIssue = SchemaIssue.makeFormatterDefault();

const StepDraftSchema: Schema.Codec<StepDraft> = Schema.Struct({
  id: Schema.String,
  title: Schema.optionalKey(Schema.String),
  brief: Schema.String,
  needs: Schema.optionalKey(Schema.Array(Schema.String)),
  agent: Schema.optionalKey(Schema.String),
  check: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.Array(Schema.String)),
  acceptance: Schema.optionalKey(Schema.Boolean),
});

/** Optional fields may be missing but never null; other keys are ignored. */
const SplitDraft = Schema.Struct({ title: Schema.optionalKey(Schema.String), tasks: Schema.Array(StepDraftSchema) });

/** The first thing wrong with a split, in the words the model is answered with: where it is (["tasks"][0]["brief"]) and
 * what it should have been. */
function splitProblem(issue: SchemaIssue.Issue, path: readonly PropertyKey[] = []): string {
  const at = path.map((k) => (typeof k === "number" ? `[${k}]` : `["${String(k)}"]`)).join("");
  switch (issue._tag) {
    case "Pointer":
      return splitProblem(issue.issue, [...path, ...issue.path]);
    case "Composite":
      return issue.issues[0] ? splitProblem(issue.issues[0], path) : t("server.task.parse.shape", { why: formatIssue(issue) });
    case "MissingKey":
      return t("server.task.parse.missing", { at });
    case "InvalidType":
      switch (issue.ast._tag) {
        case "String":
          return t("server.task.parse.string", { at });
        case "Arrays":
          return t("server.task.parse.array", { at });
        case "Boolean":
          return t("server.task.parse.boolean", { at });
        case "Objects":
          return path.length === 0 ? t("server.task.parse.object") : t("server.task.parse.stepObject", { at });
        default:
          return t("server.task.parse.shape", { why: formatIssue(issue) });
      }
    default:
      return t("server.task.parse.shape", { why: formatIssue(issue) });
  }
}

function decodeSplitDraft(raw: unknown): { title?: string; tasks: readonly StepDraft[] } | string {
  const r = Schema.decodeUnknownResult(SplitDraft)(raw);
  return Result.isSuccess(r) ? r.success : splitProblem(r.failure.issue);
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
    return { ok: true, title: title, tasks };
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
        ? t("server.task.edit.taskSettled", { title: task.title, state: t(`server.task.taskState.${task.state}`) })
        : t("server.task.edit.graphSettled", { state: t(`server.task.graphState.${graph.state}`) }),
    };
  const base: Task = task ?? freshTask({ id, brief: "" });
  const agent = edit.agent !== undefined ? edit.agent.trim() : base.agent;
  const check = edit.check !== undefined ? edit.check.trim() : base.check;
  const scope = edit.scope ?? base.scope;
  const { agent: _a, check: _c, ...rest } = base;
  const next: Task = {
    ...rest,
    ...(edit.title !== undefined ? { title: edit.title.trim() || id } : {}),
    ...(edit.brief !== undefined ? { brief: edit.brief.trim() } : {}),
    ...(edit.needs !== undefined ? { needs: [...edit.needs] } : {}),
    ...(agent ? { agent } : {}),
    ...(check ? { check } : {}),
    scope: [...scope],
  };
  if (task) return checked(withTask(graph, id, () => next));
  return checked({ ...graph, tasks: [...graph.tasks, next] });
}

export function removeTask(graph: TaskGraph, id: string): EditResult {
  const task = taskOf(graph, id);
  if (!task) return { ok: false, problem: t("server.task.edit.noStep", { id }) };
  if (!canRemoveTask(graph, task))
    return { ok: false, problem: t("server.task.edit.cannotRemove", { title: task.title, state: t(`server.task.taskState.${task.state}`) }) };
  return checked({ ...graph, tasks: graph.tasks.filter((n) => n.id !== id).map((n) => ({ ...n, needs: n.needs.filter((x) => x !== id) })) });
}

export const changeOf = (e: GraphEvent) => ({
  graph: e.graph,
  ...(e.task !== undefined ? { task: e.task } : {}),
  kind: e.kind,
  ...(e.session !== undefined ? { session: e.session } : {}),
  // A change is sparse: what the event has nothing of is left out.
  ...(e.detail ? { detail: e.detail } : {}),
  ...(e.changes.length > 0 ? { changes: e.changes } : {}),
  ...(e.commits.length > 0 ? { commits: e.commits } : {}),
});

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

// Criteria and checks are no graph's: the issues it writes carry none (Issues.putTask).
type Draft = Omit<
  Issue,
  "number" | "priority" | "createdAt" | "sessions" | "status" | "moves" | "review" | "findings" | "questions" | "attention" | "criteria" | "checks"
>;

export const defaultParallel = 3;

export const autoRetries = 2;

export const readyTasks = (graph: TaskGraph): Task[] =>
  graph.state !== "running" ? [] : graph.tasks.filter((n) => n.state === "waiting" && blockedBy(graph, n).length === 0);

export const withTask = (graph: TaskGraph, id: string, change: (n: Task) => Task): TaskGraph => ({
  ...graph,
  tasks: graph.tasks.map((n) => (n.id === id ? change(n) : n)),
});

export function ancestorsOf(graph: TaskGraph, task: Task): Task[] {
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

export const isLast = (graph: TaskGraph, task: Task) => !graph.tasks.some((n) => n.needs.includes(task.id));

export function acceptanceChecks(graph: TaskGraph, task: Task): string[] {
  const out: string[] = [];
  if (!isLast(graph, task)) return out;
  for (const n of acceptancesOf(graph, task)) if (n.check && !out.includes(n.check) && n.check !== task.check) out.push(n.check);
  return out;
}
