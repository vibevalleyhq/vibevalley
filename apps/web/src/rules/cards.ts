// The issue board's cards (BoardCard, BoardFilter), how each looks (rowFacts, cardLook), and what a drop between
// lanes does (cardMove, laneOrder).

import type { WorkspaceState, Issue, IssueHistory, IssueStatus, Priority, Session, TaskGraph } from "@vibevalley/protocol";
import { type Ordering, orderRows, type RowFacts } from "./board";
import {
  endedAt,
  issueSession,
  issueTag,
  type IssueTag,
  isForAssistant,
  issueTitle,
  type Lane,
  laneOf,
  laneStatus,
  matchesQuery,
  moveOf,
  type Move,
  tagLabel,
  tagOpen,
  taskLine,
} from "./issues";
import { ago, tookText } from "./time";
import { shortTitle, attentionLabel, attentionWantsOwner } from "@vibevalley/protocol/rules";
import { attentionTone } from "./issueState";

/** The palette's names (src/style.css) a mark or flag is tinted with. */
export type Tone = "berry" | "wheat" | "water" | "leaf" | "faint" | "muted";

export type BoardCard =
  | { kind: "todo"; id: string; lane: Lane; issue: Issue }
  /** `sessions` are the real live and ended ones, oldest first; `session` the one on the farm now. */
  | { kind: "issue"; id: string; lane: Lane; issue: Issue; sessions: Session[]; tag: IssueTag; session?: Session }
  | { kind: "missing"; id: string; lane: Lane; issue: Issue; missing: string[] }
  /** An issue for the assistant: open while the assistant works on it, closed once it has answered; never dragged. */
  | { kind: "assistant"; id: string; lane: Lane; issue: Issue }
  /** `issue` is the task's own issue: its number, when it was made and last moved. */
  | { kind: "task"; id: string; lane: Lane; graph: TaskGraph; issue?: Issue };

export const cardProject = (c: BoardCard) => (c.kind === "task" ? c.graph.project : c.issue.project);
export const cardAgent = (c: BoardCard) => (c.kind === "task" ? undefined : c.issue.assignee);

/** A task is its own card; a step of one is on the board once a helper has worked it. */
export function buildCards(rows: IssueHistory[], core: WorkspaceState | undefined, graphs: TaskGraph[]): BoardCard[] {
  const cards: BoardCard[] = [];
  for (const row of rows) {
    const issue = row.issue;
    const base = { id: issue.id, lane: laneOf(issue.status), issue };
    if (isForAssistant(issue)) cards.push({ kind: "assistant", ...base });
    else if (issue.graph === undefined && (issue.parent === undefined || issue.sessions.length > 0)) {
      if (issue.sessions.length === 0) cards.push({ kind: "todo", ...base, lane: "todo" });
      else if (row.missingSessions.length > 0 || row.sessions.length === 0) cards.push({ kind: "missing", ...base, missing: row.missingSessions });
      else cards.push({ kind: "issue", ...base, sessions: row.sessions, tag: issueTag(issue), session: issueSession(core, issue) });
    }
  }
  // A task's lane is its parent issue's status, which the server works out from the task's state.
  for (const row of rows) {
    if (row.issue.graph === undefined || laneOf(row.issue.status) === "closed") continue;
    const graph = graphs.find((g) => g.id === row.issue.id);
    if (graph) cards.push({ kind: "task", id: `task:${graph.id}`, lane: laneOf(row.issue.status), graph, issue: row.issue });
  }
  return cards;
}

function cardWords(c: BoardCard): (string | undefined)[] {
  switch (c.kind) {
    case "todo":
    case "missing":
      return [c.issue.title, c.issue.description, c.issue.project];
    case "issue": {
      const head = c.sessions[c.sessions.length - 1]!;
      return [c.issue.title, c.issue.description, head.name, c.issue.project, c.issue.id, head.lastRun?.summary];
    }
    case "assistant":
      return [c.issue.title, c.issue.description, c.issue.project, c.issue.id, "管家"];
    case "task":
      return [c.graph.title, c.graph.goal, c.graph.project, c.graph.id];
  }
}

export interface BoardFilter {
  query: string;
  project: string;
  agent: string;
}

export const noFilter: BoardFilter = { query: "", project: "", agent: "" };
export const filterAny = (f: BoardFilter) => f.query.trim() !== "" || f.project !== "" || f.agent !== "";
export const filterShows = (f: BoardFilter, c: BoardCard) =>
  (f.project === "" || cardProject(c) === f.project) && (f.agent === "" || cardAgent(c) === f.agent) && matchesQuery(f.query, cardWords(c));

const issueUpdated = (i: Issue) => Math.max(i.createdAt, i.queuedAt ?? 0, i.closedAt ?? 0, i.reviewedAt ?? 0);

export function rowFacts(c: BoardCard): RowFacts {
  switch (c.kind) {
    case "todo":
    case "assistant":
    case "missing":
      return {
        lane: c.lane,
        priority: c.issue.priority,
        createdAt: c.issue.createdAt,
        updatedAt: issueUpdated(c.issue),
        project: c.issue.project,
        agent: c.issue.assignee,
      };
    case "issue":
      return {
        lane: c.lane,
        priority: c.issue.priority,
        createdAt: c.issue.createdAt,
        updatedAt: Math.max(issueUpdated(c.issue), ...c.sessions.flatMap((s) => [s.hiredAt, s.lastRun?.at ?? 0, endedAt(s) ?? 0])),
        project: c.issue.project,
        agent: c.issue.assignee,
      };
    case "task":
      return {
        lane: c.lane,
        createdAt: c.issue?.createdAt ?? c.graph.createdAt,
        updatedAt: c.issue ? issueUpdated(c.issue) : c.graph.createdAt,
        project: c.graph.project,
      };
  }
}

/** What a card and a list row both show. `detail` is everything else: it is the hover tip. */
export interface CardLook {
  /** `#12`, or undefined for a task whose issue the board has not read. */
  number?: string;
  title: string;
  status: IssueStatus;
  statusTone?: Tone;
  priority?: Priority;
  flags: { text: string; tone: Tone }[];
  detail: string;
  progress?: { done: number; total: number };
}

const numberOf = (i: Issue) => `#${i.number}`;

export function cardLook(c: BoardCard, nameOf: (agent: string) => string, graphs: TaskGraph[], now: number): CardLook {
  const flags: CardLook["flags"] = [];
  const lines: string[] = [];
  switch (c.kind) {
    case "todo": {
      const item = c.issue;
      if (item.refining) flags.push({ text: `${item.refining.name}在起草`, tone: "water" });
      else if (item.status === "backlog") flags.push({ text: "草稿", tone: "wheat" });
      if (item.queuedAt !== undefined) flags.push({ text: "排队中", tone: "water" });
      if (item.recurrence !== undefined) flags.push({ text: "定时", tone: "faint" });
      lines.push(item.assignee === undefined ? "还没选帮工" : nameOf(item.assignee));
      if (item.assignee === undefined || item.project === undefined) lines.push("没选帮工或项目，开工前要选好");
      lines.push(item.queuedAt !== undefined ? `等空地，${ago(item.queuedAt, now)}排上的` : `写于 ${ago(item.createdAt, now)}`);
      return { number: numberOf(item), title: item.title, status: item.status, priority: item.priority, flags, detail: lines.join("\n") };
    }
    case "issue": {
      const { issue, sessions, tag, session } = c;
      const head = sessions[sessions.length - 1]!;
      const phase = session?.phase;
      const now0 = session ?? head;
      // The board says what the page says: the attention, when it waits on the owner.
      if (attentionWantsOwner(issue.attention.state)) flags.push({ text: attentionLabel[issue.attention.state], tone: attentionTone[issue.attention.state] });
      if (tag === "lost") flags.push({ text: "丢了", tone: "berry" });
      if (issue.recurrence !== undefined) flags.push({ text: "定时", tone: "faint" });
      lines.push(head.name);
      if (phase?._tag === "working" && phase.quietSince !== undefined) lines.push(`${tookText(now - phase.quietSince)}没动静`);
      if (sessions.length > 1) lines.push(`第 ${sessions.length} 次`);
      const turns = Math.round(now0.runs);
      const cny = now0.spent?.cny;
      const took = tagOpen(tag) ? `开了 ${tookText(now - head.hiredAt)}` : `用了 ${tookText((issue.closedAt ?? endedAt(head) ?? now) - sessions[0]!.hiredAt)}`;
      lines.push([tag === "working" ? `第 ${turns + 1} 轮` : `${turns} 轮`, took, ...(cny !== undefined ? [`¥${cny.toFixed(2)}`] : [])].join(" · "));
      const said = now0.lastRun?.summary;
      if (tag === "waiting" && said) lines.push(said);
      if (!tagOpen(tag)) lines.push(`${tagLabel[tag]} · ${ago(issue.closedAt ?? endedAt(head) ?? head.hiredAt, now)}`);
      return {
        number: numberOf(issue),
        title: shortTitle(issueTitle(issue, graphs)),
        status: issue.status,
        statusTone: tag === "lost" ? "berry" : undefined,
        priority: issue.priority,
        flags,
        detail: lines.join("\n"),
      };
    }
    case "assistant": {
      const { issue } = c;
      if (issue.recurrence !== undefined) flags.push({ text: "定时", tone: "faint" });
      const tag = issueTag(issue);
      lines.push(tagOpen(tag) ? "管家在做" : `${tagLabel[tag]} · ${ago(issue.closedAt ?? issue.createdAt, now)}`);
      return { number: numberOf(issue), title: issue.title, status: issue.status, priority: issue.priority, flags, detail: lines.join("\n") };
    }
    case "missing":
      flags.push({ text: "记录缺失", tone: "berry" });
      return {
        number: numberOf(c.issue),
        title: c.issue.title,
        status: c.issue.status,
        priority: c.issue.priority,
        flags,
        detail: `执行记录缺失：${c.missing.join("、")}`,
      };
    case "task":
      return {
        number: c.issue ? numberOf(c.issue) : undefined,
        title: `计划：${c.graph.title}`,
        status: c.issue?.status ?? laneStatus[c.lane],
        flags,
        detail: taskLine(c.graph),
        progress: { done: Math.round(c.graph.settled ?? 0), total: c.graph.tasks.length },
      };
  }
}

export function cardMove(c: BoardCard, to: Lane): Move | undefined {
  if (c.kind === "todo" || c.kind === "issue") return moveOf(c.lane, to, c.issue.moves);
  return undefined;
}

function closedAt(c: BoardCard) {
  switch (c.kind) {
    case "issue":
      return c.issue.closedAt ?? c.sessions[c.sessions.length - 1]!.hiredAt;
    case "task":
      return 0;
    default:
      return c.issue.closedAt ?? c.issue.createdAt;
  }
}

/** A lane's cards in the order the owner picked; the closed lane by default newest closed first. */
export function laneOrder(lane: Lane, cards: BoardCard[], ordering: Ordering) {
  if (lane === "closed" && ordering === "manual") return [...cards].sort((a, b) => closedAt(b) - closedAt(a));
  return orderRows(cards, ordering, rowFacts);
}
