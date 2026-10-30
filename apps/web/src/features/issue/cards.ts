import { list, t } from "@vibevalley/i18n";
import type { Issue, IssueHistory, IssueStatus, Priority, Session, TaskGraph, SessionView, WorkspaceView } from "@vibevalley/protocol";
import { attentionWantsOwner, omitUndefined, shortTitle } from "@vibevalley/protocol/rules";

import { ago, tookText } from "@/base/format";
import { matches } from "@/base/search";

import { type Ordering, orderRows, type RowFacts } from "./display";
import { endedAt, issueSession, isForOrchestrator } from "./issue";
import { type Lane, laneOf, laneStatus, moveOf, type Move } from "./lanes";
import { attentionTone } from "./overview";
import { issueTag, type IssueTag, tagText, tagOpen } from "./tags";
import { issueTitle, taskLine } from "./titles";

/** The palette's names (src/style.css) a mark or flag is tinted with. */
export type Tone = "berry" | "wheat" | "water" | "leaf" | "faint" | "muted";

export type BoardCard =
  | { kind: "todo"; id: string; lane: Lane; issue: Issue }
  /** `sessions` are the real live and ended ones, oldest first; `session` the one on the farm now. */
  | { kind: "issue"; id: string; lane: Lane; issue: Issue; sessions: Session[]; tag: IssueTag; session?: SessionView }
  | { kind: "missing"; id: string; lane: Lane; issue: Issue; missing: string[] }
  /** An issue for the orchestrator: open while the orchestrator works on it, closed once it has answered; never dragged. */
  | { kind: "orchestrator"; id: string; lane: Lane; issue: Issue }
  /** `issue` is the task's own issue: its number, when it was made and last moved. */
  | { kind: "task"; id: string; lane: Lane; graph: TaskGraph; issue?: Issue };

export const cardProject = (c: BoardCard) => (c.kind === "task" ? c.graph.project : c.issue.project);
export const cardAgent = (c: BoardCard) => (c.kind === "task" ? undefined : c.issue.assignee);

/** A task is its own card; a step of one is on the board once a helper has worked it. */
export function buildCards(rows: IssueHistory[], core: WorkspaceView | undefined, graphs: TaskGraph[], orchestrators: ReadonlySet<string>): BoardCard[] {
  const cards: BoardCard[] = [];
  for (const row of rows) {
    const issue = row.issue;
    const base = { id: issue.id, lane: laneOf(issue.status), issue };
    if (isForOrchestrator(issue, orchestrators)) cards.push({ kind: "orchestrator", ...base });
    else if (issue.graph === undefined && (issue.parent === undefined || issue.sessions.length > 0)) {
      if (issue.sessions.length === 0) cards.push({ kind: "todo", ...base, lane: "todo" });
      else if (row.missingSessions.length > 0 || row.sessions.length === 0) cards.push({ kind: "missing", ...base, missing: row.missingSessions });
      else cards.push(omitUndefined({ kind: "issue" as const, ...base, sessions: row.sessions, tag: issueTag(issue), session: issueSession(core, issue) }));
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
    case "orchestrator":
      return [c.issue.title, c.issue.description, c.issue.project, c.issue.id, t("web.issue.card.orchestrator")];
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
  (f.project === "" || cardProject(c) === f.project) && (f.agent === "" || cardAgent(c) === f.agent) && matches(f.query, cardWords(c));

const issueUpdated = (i: Issue) => Math.max(i.createdAt, i.queuedAt ?? 0, i.closedAt ?? 0, i.reviewedAt ?? 0);

export function rowFacts(c: BoardCard): RowFacts {
  switch (c.kind) {
    case "todo":
    case "orchestrator":
    case "missing":
      return omitUndefined({
        lane: c.lane,
        priority: c.issue.priority,
        createdAt: c.issue.createdAt,
        updatedAt: issueUpdated(c.issue),
        project: c.issue.project,
        agent: c.issue.assignee,
      });
    case "issue":
      return omitUndefined({
        lane: c.lane,
        priority: c.issue.priority,
        createdAt: c.issue.createdAt,
        updatedAt: Math.max(issueUpdated(c.issue), ...c.sessions.flatMap((s) => [s.hiredAt, s.lastRun?.at ?? 0, endedAt(s) ?? 0])),
        project: c.issue.project,
        agent: c.issue.assignee,
      });
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
      if (item.refining) flags.push({ text: t("web.issue.card.refining", { name: item.refining.name }), tone: "water" });
      else if (item.status === "backlog") flags.push({ text: t("web.issue.card.draft"), tone: "wheat" });
      if (item.queuedAt !== undefined) flags.push({ text: t("web.issue.card.queued"), tone: "water" });
      if (item.cron !== undefined) flags.push({ text: t("web.issue.card.cron"), tone: "faint" });
      lines.push(item.assignee === undefined ? t("web.issue.card.noHelper") : nameOf(item.assignee));
      if (item.assignee === undefined || item.project === undefined) lines.push(t("web.issue.card.pickFirst"));
      lines.push(
        item.queuedAt !== undefined
          ? t("web.issue.card.waiting", { ago: ago(item.queuedAt, now) })
          : t("web.issue.card.written", { ago: ago(item.createdAt, now) }),
      );
      return { number: numberOf(item), title: item.title, status: item.status, priority: item.priority, flags, detail: lines.join("\n") };
    }
    case "issue": {
      const { issue, sessions, tag, session } = c;
      const head = sessions[sessions.length - 1]!;
      const phase = session?.phase;
      const now0 = session ?? head;
      // The board says what the page says: the attention, when it waits on the owner.
      // A stuck issue says why on the board as on its page (有冲突, 没做成…).
      const st = issue.attention;
      if (attentionWantsOwner(st.state))
        flags.push({
          text: st.stuck
            ? t("shared.join.labeled", { label: t(`shared.attention.${st.state}`), text: t(`shared.stuck.${st.stuck}`) })
            : t(`shared.attention.${st.state}`),
          tone: attentionTone[st.state],
        });
      if (issue.canceled === "lost") flags.push({ text: t("web.issue.card.lost"), tone: "berry" });
      if (issue.cron !== undefined) flags.push({ text: t("web.issue.card.cron"), tone: "faint" });
      lines.push(head.name);
      if (phase?._tag === "working" && phase.quietSince !== undefined) lines.push(t("web.issue.card.quiet", { took: tookText(now - phase.quietSince) }));
      if (sessions.length > 1) lines.push(t("web.issue.card.nth", { n: sessions.length }));
      const turns = Math.round(now0.runs);
      const cny = now0.spent?.cny;
      const took = tagOpen(tag)
        ? t("web.issue.card.open", { took: tookText(now - head.hiredAt) })
        : t("web.issue.card.used", { took: tookText((issue.closedAt ?? endedAt(head) ?? now) - sessions[0]!.hiredAt) });
      lines.push(
        [
          tag === "working" ? t("web.issue.card.turn", { n: turns + 1 }) : t("web.issue.card.turns", { n: turns }),
          took,
          ...(cny !== undefined ? [`¥${cny.toFixed(2)}`] : []),
        ].join(" · "),
      );
      const said = now0.lastRun?.summary;
      if (tag === "waiting" && said) lines.push(said);
      if (!tagOpen(tag)) lines.push(`${tagText(issue)} · ${ago(issue.closedAt ?? endedAt(head) ?? head.hiredAt, now)}`);
      return omitUndefined({
        number: numberOf(issue),
        title: shortTitle(issueTitle(issue, graphs)),
        status: issue.status,
        statusTone: issue.canceled === "lost" ? ("berry" as const) : undefined,
        priority: issue.priority,
        flags,
        detail: lines.join("\n"),
      });
    }
    case "orchestrator": {
      const { issue } = c;
      if (issue.cron !== undefined) flags.push({ text: t("web.issue.card.cron"), tone: "faint" });
      const tag = issueTag(issue);
      lines.push(tagOpen(tag) ? t("web.issue.card.orchestratorWorking") : `${tagText(issue)} · ${ago(issue.closedAt ?? issue.createdAt, now)}`);
      return { number: numberOf(issue), title: issue.title, status: issue.status, priority: issue.priority, flags, detail: lines.join("\n") };
    }
    case "missing":
      flags.push({ text: t("web.issue.card.missingFlag"), tone: "berry" });
      return {
        number: numberOf(c.issue),
        title: c.issue.title,
        status: c.issue.status,
        priority: c.issue.priority,
        flags,
        detail: t("web.issue.card.missing", { what: list(c.missing) }),
      };
    case "task":
      return omitUndefined({
        number: c.issue ? numberOf(c.issue) : undefined,
        title: t("web.issue.card.graph", { title: c.graph.title }),
        status: c.issue?.status ?? laneStatus[c.lane],
        flags,
        detail: taskLine(c.graph),
        progress: { done: Math.round(c.graph.settled ?? 0), total: c.graph.tasks.length },
      });
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
  if (lane === "closed" && ordering === "manual") return [...cards].toSorted((a, b) => closedAt(b) - closedAt(a));
  return orderRows(cards, ordering, rowFacts);
}
