// What changed in a task graph, step by step, and how each change is said.

import type { GraphActor, GraphEventKind, Task, TaskFieldChange, TaskGraph } from "@vibevalley/protocol";
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

const taskFields: readonly { field: string; text: (n: Task) => string }[] = [
  { field: "标题", text: (n) => n.title },
  { field: "工单", text: (n) => n.brief },
  { field: "要等的", text: (n) => (n.needs ?? []).join("、") },
  { field: "谁来做", text: (n) => n.agent ?? "" },
  { field: "检查", text: (n) => n.check ?? "" },
  { field: "该改的地方", text: (n) => (n.scope ?? []).join("、") },
];

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
        graph("drafted", `${(after.tasks ?? []).length} 步`);
        break;
      case "running":
        if (before.state === "paused") graph("resumed");
        else graph("started", after.branch);
        break;
      case "paused":
        graph("paused", after.note);
        break;
      case "ripe":
        graph("ripe");
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
  for (const n of after.tasks ?? []) {
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
        if ((n.commits ?? []).length > 0) who.commits = n.commits;
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
  for (const was of before.tasks ?? []) {
    if (!(after.tasks ?? []).some((n) => n.id === was.id)) out.push({ graph: after.id, task: was.id, kind: "task_removed", detail: was.title });
  }
  return out;
}

export const actorText: Record<GraphActor, string> = { user: "主人", manager: "管家", system: "农场", session: "帮工" };

export function graphEventText(e: GraphChange, titleOf: (task: string) => string = (id) => id): string {
  const step = e.task ? "「" + titleOf(e.task) + "」" : "「」";
  const by = e.session ? "（" + e.session + "）" : "";
  const detail = e.detail ?? "";
  const why = detail ? "：" + detail : "";
  switch (e.kind) {
    case "splitting":
      return "要拆一张计划" + why;
    case "drafted":
      return detail ? "拆好了，" + detail + "，等主人看" : "拆好了，等主人看";
    case "started":
      return detail ? "开工了，分支 " + detail : "开工了";
    case "paused":
      return "暂停了" + why;
    case "resumed":
      return "接着做了";
    case "ripe":
      return "都做完了，等收获";
    case "merged":
      return "收进了主分支";
    case "abandoned":
      return "放弃了" + why;
    case "noted":
      return detail;
    case "task_started":
      return step + "开工" + by;
    case "task_sent_back":
      return step + "退回去重做" + by + why;
    case "task_merged":
      return step + "合进了计划分支" + ((e.commits ?? []).length > 0 ? "（" + e.commits!.join("、") + "）" : "") + why;
    case "task_failed":
      return step + "没做成" + why;
    case "task_retried":
      return step + "重试";
    case "task_requeued":
      return step + "没有帮工在做了，重新排上";
    case "task_skipped":
      return step + "跳过了，后面的照做";
    case "task_edited":
      return "改了" + step + "的" + (e.changes ?? []).map((c) => c.field).join("、");
    case "task_added":
      return "加了一步" + step;
    case "task_removed":
      return "删了一步「" + (e.detail !== undefined ? e.detail : (e.task ?? "")) + "」";
  }
}
