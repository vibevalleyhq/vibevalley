// What changed in a task graph, step by step, and how each change is said. What is kept is the fact (a field's key, a
// count), so the history reads in the locale of whoever reads it.

import { list, t } from "@vibevalley/i18n";
import type { GraphEventKind, Task, TaskFieldChange, TaskGraph, GraphEvent } from "@vibevalley/protocol";
import { taskOf } from "./graph.ts";

/** A graph event before it is stored: no id, actor or time yet. */
export interface GraphChange {
  graph: string;
  task?: string;
  kind: GraphEventKind;
  session?: string;
  detail?: string;
  changes?: TaskFieldChange[];
  commits?: string[];
}

/** A task's fields as a graph's history keeps them (TaskFieldChange.field): the key, said at read time. */
export type TaskField = "title" | "brief" | "needs" | "agent" | "check" | "scope";

const taskFields: readonly { field: TaskField; text: (n: Task) => string }[] = [
  { field: "title", text: (n) => n.title },
  { field: "brief", text: (n) => n.brief },
  { field: "needs", text: (n) => list(n.needs) },
  { field: "agent", text: (n) => n.agent ?? "" },
  { field: "check", text: (n) => n.check ?? "" },
  { field: "scope", text: (n) => list(n.scope) },
];

const isField = (f: string): f is TaskField => taskFields.some((x) => x.field === f);

/** The changes as they are shown: each field by its name. */
export const renderedChanges = (changes: readonly TaskFieldChange[]): TaskFieldChange[] =>
  changes.map((c) => ({ ...c, field: isField(c.field) ? t(`server.task.field.${c.field}`) : c.field }));

export function taskFieldChanges(was: Task, now: Task): TaskFieldChange[] {
  const out: TaskFieldChange[] = [];
  for (const f of taskFields) {
    const from = f.text(was);
    const to = f.text(now);
    if (from !== to) out.push({ field: f.field, from, to });
  }
  return out;
}

/** Every write of a graph goes through here, so its history misses nothing. before undefined: a new graph. */
export function graphChanges(before: TaskGraph | undefined, after: TaskGraph): GraphChange[] {
  const out: GraphChange[] = [];
  const graph = (kind: GraphEventKind, detail?: string) => out.push(detail ? { graph: after.id, kind, detail } : { graph: after.id, kind });
  if (!before) {
    graph("splitting", after.goal);
    return out;
  }
  if (before.state !== after.state) {
    switch (after.state) {
      case "splitting":
        break;
      case "draft":
        graph("drafted", String(after.tasks.length));
        break;
      case "running":
        if (before.state === "paused") graph("resumed");
        else graph("started", after.branch);
        break;
      case "paused":
        graph("paused", after.note);
        break;
      case "ready":
        graph("ready");
        break;
      case "done":
        graph("merged");
        break;
      case "abandoned":
        graph("abandoned", after.note);
        break;
    }
  } else if (after.note && before.note !== after.note) {
    graph("noted", after.note);
  }
  if (before.state === "splitting" || after.state === "abandoned") return out;

  const step = (n: Task, kind: GraphEventKind, extra: Partial<GraphChange> = {}) => out.push({ ...extra, graph: after.id, task: n.id, kind });
  for (const n of after.tasks) {
    const was = taskOf(before, n.id);
    if (!was) {
      step(n, "task_added", { detail: n.title });
      continue;
    }
    const changes = taskFieldChanges(was, n);
    if (changes.length > 0) step(n, "task_edited", { changes });
    if (was.state === n.state) {
      if (n.state === "working" && n.tries > was.tries) step(n, "task_sent_back", n.session ? { session: n.session } : {});
      continue;
    }
    const session = n.session ?? was.session;
    const who: Partial<GraphChange> = session ? { session } : {};
    switch (n.state) {
      case "working":
        step(n, was.state === "failed" ? "task_retried" : "task_started", who);
        break;
      case "merged":
        if (n.conclusion) who.detail = n.conclusion;
        if (n.commits.length > 0) who.commits = n.commits;
        step(n, "task_merged", who);
        break;
      case "failed":
        if (n.conclusion) who.detail = n.conclusion;
        step(n, "task_failed", who);
        break;
      case "waiting":
        step(n, was.state === "failed" ? "task_retried" : "task_requeued", who);
        break;
      case "skipped":
        step(n, "task_skipped");
        break;
    }
  }
  for (const was of before.tasks) {
    if (!after.tasks.some((n) => n.id === was.id)) out.push({ graph: after.id, task: was.id, kind: "task_removed", detail: was.title });
  }
  return out;
}

export function graphEventText(e: GraphChange, titleOf: (task: string) => string = (id) => id): string {
  const step = t("server.task.event.step", { title: e.task ? titleOf(e.task) : "" });
  const by = e.session ? t("server.task.event.by", { session: e.session }) : "";
  const detail = e.detail ?? "";
  const why = detail ? t("server.task.event.why", { detail }) : "";
  switch (e.kind) {
    case "splitting":
      return t("server.task.event.splitting", { why });
    case "drafted":
      return detail ? t("server.task.event.draftedSteps", { steps: detail }) : t("server.task.event.drafted");
    case "started":
      return detail ? t("server.task.event.startedOn", { branch: detail }) : t("server.task.event.started");
    case "paused":
      return t("server.task.event.paused", { why });
    case "resumed":
      return t("server.task.event.resumed");
    case "ready":
      return t("server.task.event.ready");
    case "merged":
      return t("server.task.event.merged");
    case "abandoned":
      return t("server.task.event.abandoned", { why });
    case "noted":
      return detail;
    case "task_started":
      return t("server.task.event.taskStarted", { step, by });
    case "task_sent_back":
      return t("server.task.event.taskSentBack", { step, by, why });
    case "task_merged":
      return (e.commits ?? []).length > 0
        ? t("server.task.event.taskMergedCommits", { step, commits: list(e.commits ?? []), why })
        : t("server.task.event.taskMerged", { step, why });
    case "task_failed":
      return t("server.task.event.taskFailed", { step, why });
    case "task_retried":
      return t("server.task.event.taskRetried", { step });
    case "task_requeued":
      return t("server.task.event.taskRequeued", { step });
    case "task_skipped":
      return t("server.task.event.taskSkipped", { step });
    case "task_edited":
      return t("server.task.event.taskEdited", {
        step: step,
        fields: list((e.changes ?? []).map((c) => (isField(c.field) ? t(`server.task.field.${c.field}`) : c.field))),
      });
    case "task_added":
      return t("server.task.event.taskAdded", { step });
    case "task_removed":
      return t("server.task.event.taskRemoved", { title: e.detail || (e.task ?? "") });
  }
}

export const changeOf = (e: GraphEvent) => ({
  graph: e.graph,
  ...(e.task !== undefined ? { task: e.task } : {}),
  kind: e.kind,
  ...(e.session !== undefined ? { session: e.session } : {}),
  ...(e.detail ? { detail: e.detail } : {}),
  ...(e.changes.length > 0 ? { changes: e.changes } : {}),
  ...(e.commits.length > 0 ? { commits: e.commits } : {}),
});
