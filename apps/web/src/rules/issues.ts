// An issue's lane, title and status and priority words.

import {
  type WorkspaceState,
  type Issue,
  type IssueStatus,
  orchestratorAgent,
  type Priority,
  type Run,
  type RunTrigger,
  type Session,
  type TaskGraph,
} from "@vibevalley/protocol";

export type IssueTag = "working" | "waiting" | "harvested" | "merged" | "dropped" | "lost" | "answered" | "closed";

export const tagLabel: Record<IssueTag, string> = {
  working: "处理中",
  waiting: "等你看",
  harvested: "已收获",
  merged: "合进了计划",
  dropped: "没收就收工了",
  lost: "丢了",
  answered: "管家答完了",
  closed: "已关",
};

export const tagOpen = (t: IssueTag) => t === "working" || t === "waiting";

export function issueTag(issue: Issue): IssueTag {
  if (issue.status === "in_progress") return "working";
  if (issue.status === "in_review") return "waiting";
  switch (issue.closed) {
    case "merged":
      return "harvested";
    case "merged_into_graph":
      return "merged";
    case "dismissed":
      return "dropped";
    case "lost":
      return "lost";
    case "answered":
      return "answered";
    case undefined:
      return "closed";
  }
}

export const statusLabel: Record<IssueStatus, string> = {
  backlog: "草稿",
  todo: "待办",
  in_progress: "处理中",
  in_review: "等你看",
  done: "已关",
  canceled: "收工了",
};

export const priorityLabel: Record<Priority, string> = { urgent: "紧急", high: "高", medium: "普通", low: "低" };

export const isForOrchestrator = (issue: Issue) => issue.assignee === orchestratorAgent;

export function issueTitle(issue: Issue, graphs: TaskGraph[] = []) {
  const job = issue.title.trim();
  if (!job) return issue.id;
  const graph = issue.parent ? graphs.find((g) => g.id === issue.parent) : undefined;
  if (graph) return `${graph.title} · ${job}`;
  return job.split("\n")[0]!.trim();
}

export const issueIs = (issue: Issue, id: string) => issue.id === id || issue.sessions.includes(id);

export function taskLine(g: TaskGraph) {
  switch (g.state) {
    case "splitting":
      return "在拆步骤";
    case "draft":
      return "拆好了，看过再开工";
    case "running":
      return `做到 ${Math.round(g.settled ?? 0)} / ${g.tasks.length} 步`;
    case "paused":
      return "暂停了";
    case "ripe":
      return "都做完了，等你收获";
    case "done":
      return "收获了";
    case "abandoned":
      return "放弃了";
  }
}

/** When it ended; undefined for one on the farm. */
export const endedAt = (s: Session) => (s.phase._tag === "closed" ? s.phase.at : undefined);

/** The session on the farm now for an open issue. */
export function issueSession(core: WorkspaceState | undefined, issue: Issue): Session | undefined {
  if (!core || issue.sessions.length === 0 || issue.closed !== undefined) return undefined;
  const last = issue.sessions[issue.sessions.length - 1];
  return core.sessions.find((s) => s.id === last);
}

export type Lane = "todo" | "working" | "waiting" | "closed";
export const lanes: Lane[] = ["todo", "working", "waiting", "closed"];
export const laneLabel: Record<Lane, string> = { todo: "待办", working: "处理中", waiting: "等你看", closed: "已关" };

/** The status a lane's header is drawn with: the one its cards mostly have. */
export const laneStatus: Record<Lane, IssueStatus> = { todo: "todo", working: "in_progress", waiting: "in_review", closed: "done" };

/** The three acts of a plot (docs/concepts.md): talk it through, get it worked, finish it. */
export type Stage = "talk" | "work" | "finish";
export const stages: Stage[] = ["talk", "work", "finish"];
export const stageLabel: Record<Stage, string> = { talk: "聊清楚", work: "安排活", finish: "完成" };

export function stageOf(s: IssueStatus): Stage {
  if (s === "backlog") return "talk";
  if (s === "todo" || s === "in_progress") return "work";
  return "finish";
}

/** The title an issue made by the plus has until the owner says what it is for. */
export const newIssueTitle = "新工单";

/** A draft came back into it (or the owner wrote it out): it has more than a title. */
export const isRefined = (issue: Issue) => (issue.description ?? "") !== "" || (issue.criteria ?? []).length > 0;

export function laneOf(s: IssueStatus): Lane {
  if (s === "backlog" || s === "todo") return "todo";
  if (s === "in_progress") return "working";
  if (s === "in_review") return "waiting";
  return "closed";
}

export type Move = "start" | "close" | "reopen";

/** A drop between lanes, if the server lets the issue go there (`Issue.moves`). A task's issue has no moves. */
export function moveOf(from: Lane, to: Lane, moves: IssueStatus[]): Move | undefined {
  if (from === "todo" && to === "working" && moves.includes("todo")) return "start";
  if ((from === "working" || from === "waiting") && to === "closed" && (moves.includes("done") || moves.includes("canceled"))) return "close";
  if (from === "closed" && to === "working" && moves.includes("todo")) return "reopen";
  return undefined;
}

export const issueInTask = (issue: Issue, session: Session | undefined) =>
  issue.graph !== undefined || issue.parent !== undefined || session?.graph !== undefined || issue.closed === "merged_into_graph";

/** Every word of the query is somewhere in the fields, ignoring case. */
export function matchesQuery(query: string, fields: (string | undefined)[]) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = fields
    .filter((f): f is string => f !== undefined)
    .join("\n")
    .toLowerCase();
  return words.every((w) => text.includes(w));
}

export const closedShown = 15;

export function runTriggerText(t: RunTrigger) {
  switch (t.kind) {
    case "issue":
      return "派出去";
    case "comment":
      return t.message ? `带话（#${t.message.slice(0, 8)}）` : "带话";
    case "task":
      return "种植计划";
    case "recurrence":
      return t.missed ? "定时（补跑）" : "定时";
    case "refine":
      return "起草";
    case "runtime":
      return "农机自己";
  }
}

const outcomeText = { completed: "做完了", failed: "没做成", interrupted: "叫停了" } as const;

/** One line for a run: what started it, how it went, how long, what it cost, what it heard while it ran. */
export const runText = (r: Run, now: number, took: (ms: number) => string) =>
  [
    runTriggerText(r.triggeredBy),
    r.outcome ? outcomeText[r.outcome] : "正在干",
    took((r.endedAt ?? now) - r.startedAt),
    ...(r.spent?.cny !== undefined ? [`¥${r.spent.cny.toFixed(2)}`] : []),
    ...(r.heard.length ? [`中途听到 ${r.heard.length} 句`] : []),
  ].join(" · ");
