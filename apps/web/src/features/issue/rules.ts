// An issue's lane, title and status and priority words.

import { issuesWording } from "./words";
import { wording } from "@vibevalley/protocol/words";
import { closedText } from "@vibevalley/protocol/rules";
import {
  type WorkspaceState,
  type Issue,
  type IssueStatus,
  orchestratorAgent,
  type Run,
  type RunTrigger,
  type Session,
  type TaskGraph,
} from "@vibevalley/protocol";

/** Where a dispatched issue is on the board: not sent yet, in the works, waiting on the owner, or closed. */
export type IssueTag = "queued" | "working" | "waiting" | "closed";

export function issueTag(issue: Issue): IssueTag {
  switch (issue.status) {
    case "backlog":
    case "todo":
      return "queued";
    case "in_progress":
      return "working";
    case "in_review":
      return "waiting";
    case "done":
    case "canceled":
      return "closed";
  }
}

export const tagOpen = (t: IssueTag) => t !== "closed";

/** The tag in words: the status while open, what its close says after. */
export const tagText = (issue: Issue) => (tagOpen(issueTag(issue)) ? wording().status[issue.status] : closedText(issue));

export const isForOrchestrator = (issue: Issue) => issue.assignee === orchestratorAgent;

export function issueTitle(issue: Issue, graphs: TaskGraph[] = []) {
  const job = issue.title.trim();
  if (!job) return issue.id;
  const graph = issue.parent ? graphs.find((g) => g.id === issue.parent) : undefined;
  if (graph) return `${graph.title} · ${job}`;
  return job.split("\n")[0]!.trim();
}

export const issueIs = (issue: Issue, id: string) => issue.id === id || issue.sessions.some((s) => s === id);

export function taskLine(g: TaskGraph) {
  switch (g.state) {
    case "splitting":
      return issuesWording().graph.splitting;
    case "draft":
      return issuesWording().graph.draft;
    case "running":
      return issuesWording().graph.running(Math.round(g.settled ?? 0), g.tasks.length);
    case "paused":
      return issuesWording().graph.paused;
    case "ready":
      return issuesWording().graph.ready;
    case "done":
      return issuesWording().graph.done;
    case "abandoned":
      return issuesWording().graph.abandoned;
  }
}

/** When it ended; undefined for one on the farm. */
export const endedAt = (s: Session) => (s.phase._tag === "closed" ? s.phase.at : undefined);

/** The session on the farm now for an open issue. */
export function issueSession(core: WorkspaceState | undefined, issue: Issue): Session | undefined {
  if (!core || issue.sessions.length === 0 || issue.closedAt !== undefined) return undefined;
  const last = issue.sessions[issue.sessions.length - 1];
  return core.sessions.find((s) => s.id === last);
}

export type Lane = "todo" | "working" | "waiting" | "closed";
export const lanes: Lane[] = ["todo", "working", "waiting", "closed"];
export const laneLabel: Record<Lane, string> = {
  todo: issuesWording().boardLabels.lane.todo,
  working: issuesWording().boardLabels.lane.working,
  waiting: issuesWording().boardLabels.lane.waiting,
  closed: issuesWording().boardLabels.lane.closed,
};

/** The status a lane's header is drawn with: the one its cards mostly have. */
export const laneStatus: Record<Lane, IssueStatus> = { todo: "todo", working: "in_progress", waiting: "in_review", closed: "done" };

/** The three acts of a plot (docs/concepts.md): talk it through, get it worked, finish it. */
export type Stage = "talk" | "work" | "finish";
export const stages: Stage[] = ["talk", "work", "finish"];
export const stageLabel: Record<Stage, string> = {
  talk: issuesWording().boardLabels.stage.talk,
  work: issuesWording().boardLabels.stage.work,
  finish: issuesWording().boardLabels.stage.finish,
};

export function stageOf(s: IssueStatus): Stage {
  if (s === "backlog") return "talk";
  if (s === "todo" || s === "in_progress") return "work";
  return "finish";
}

/** The title an issue made by the plus has until the owner says what it is for. */
export const newIssueTitle = issuesWording().boardLabels.newIssue;

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
  issue.graph !== undefined || issue.parent !== undefined || session?.graph !== undefined || issue.delivered === "merged_into_parent";

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

function runTriggerText(t: RunTrigger) {
  switch (t.kind) {
    case "issue":
      return issuesWording().trigger.issue;
    case "comment":
      return t.message ? issuesWording().trigger.commentNumbered(t.message.slice(0, 8)) : issuesWording().trigger.comment;
    case "task":
      return issuesWording().trigger.task;
    case "recurrence":
      return t.missed ? issuesWording().trigger.missed : issuesWording().trigger.recurrence;
    case "refine":
      return issuesWording().trigger.refine;
    case "runtime":
      return issuesWording().trigger.runtime;
  }
}

/** One line for a run: what started it, how it went, how long, what it cost, what it heard while it ran. */
export const runText = (r: Run, now: number, took: (ms: number) => string) =>
  [
    runTriggerText(r.triggeredBy),
    r.outcome ? wording().outcome[r.outcome] : issuesWording().run.working,
    took((r.endedAt ?? now) - r.startedAt),
    ...(r.spent?.cny !== undefined ? [`¥${r.spent.cny.toFixed(2)}`] : []),
    ...(r.heard.length ? [issuesWording().run.heard(r.heard.length)] : []),
  ].join(" · ");
