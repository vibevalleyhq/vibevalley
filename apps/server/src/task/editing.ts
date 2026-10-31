import { t } from "@vibevalley/i18n";
import type { Task, TaskDraft, TaskEdit, TaskGraph } from "@vibevalley/protocol";

import { canEditTask, canRemoveTask, graphProblems, taskOf, taskView, withTask } from "./graph.ts";

/** A task as whoever splits writes it: the splitting session in its json block, a helper through issue_split. */
export function freshTask(draft: TaskDraft): Task {
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
