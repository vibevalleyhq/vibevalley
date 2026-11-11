import { list, t } from "@vibevalley/i18n";
import type { Issue, IssueHistory, IssueStatus, Priority, Session, SessionView, SpaceView } from "@vibevalley/protocol";
import { assignedAgentOf, executionsOf, omitUndefined, sessionIdsOf, shortTitle, stageWantsUser } from "@vibevalley/protocol/rules";

import { ago, tookText } from "#/base/format.ts";
import { matches } from "#/base/search.ts";

import { endedAt, assignedOnDuty, issueSession, issueTag, type IssueTag, issueTitle, tagOpen, tagText } from "./issue";
import type { CardMove } from "./moves";
import { stageTone } from "./overview";

export type Lane = "todo" | "working" | "waiting" | "closed";

export const lanes: Lane[] = ["todo", "working", "waiting", "closed"];

export const laneLabel: Record<Lane, string> = {
  todo: t("web.issue.boardLabels.lane.todo"),
  working: t("web.issue.boardLabels.lane.working"),
  waiting: t("web.issue.boardLabels.lane.waiting"),
  closed: t("web.issue.boardLabels.lane.closed"),
};

/** The status a lane's header is drawn with: the one its cards mostly have. */
export const laneStatus: Record<Lane, IssueStatus> = { todo: "todo", working: "in_progress", waiting: "in_review", closed: "done" };

/** A card says its own status only where its lane does not: a draft in todo says so by its draft flag instead. */
export const ownStatus = (lane: Lane, status: IssueStatus) => status !== laneStatus[lane] && !(lane === "todo" && status === "backlog");

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

export const closedShown = 15;

// The board's and the list's rows.

/** Each issue the frame keeps, its sessions found on the farm, in the history, or (one that left after the history was read) as the frame last had it. */
export function boardRows(
  core: SpaceView | undefined,
  history: readonly IssueHistory[] | undefined,
  older: boolean,
  seen: ReadonlyMap<string, Session> = new Map(),
): IssueHistory[] | undefined {
  if (!core) return undefined;
  const read = new Map((history ?? []).map((r) => [r.issue.id, r]));
  const present = new Map<string, Session>(core.sessions.map((s) => [s.id, s]));
  const live = core.issues.map((issue): IssueHistory => {
    const row = read.get(issue.id);
    return {
      issue,
      sessions: sessionIdsOf(issue).flatMap((id) => present.get(id) ?? row?.sessions.find((s) => s.id === id) ?? seen.get(id) ?? []),
      missingSessions: (row?.missingSessions ?? []).filter((id) => sessionIdsOf(issue).includes(id) && !present.has(id)),
    };
  });
  if (!older || !history) return live;
  const kept = new Set(core.issues.map((i) => i.id));
  return [...live, ...history.filter((r) => !kept.has(r.issue.id))];
}

/** What the history adds to the frame changes only when an issue gets a session or one leaves the farm. */
export const historyKey = (core: SpaceView | undefined): string =>
  core
    ? `${core.issues
        .filter((i) => sessionIdsOf(i).length > 0)
        .map((i) => `${i.id}:${sessionIdsOf(i).join(",")}`)
        .join(";")}|${core.sessions.map((s) => s.id).join(",")}`
    : "";

/** The palette's names (src/style.css) a mark or flag is tinted with. */
export type Tone = "berry" | "wheat" | "water" | "leaf" | "faint" | "muted";

/** `move`: the user's move of it on its way (moves.ts), laid over the lane the frame gives. */
export type BoardCard = (
  | { kind: "todo"; id: string; lane: Lane; issue: Issue }
  /** `sessions` are the real live and ended ones, oldest first; `session` the one on the farm now. */
  | { kind: "issue"; id: string; lane: Lane; issue: Issue; sessions: Session[]; tag: IssueTag; session?: SessionView }
  | { kind: "missing"; id: string; lane: Lane; issue: Issue; missing: string[] }
  /** An issue for the orchestrator: open while the orchestrator works on it, closed once it has answered; never dragged. */
  | { kind: "orchestrator"; id: string; lane: Lane; issue: Issue }
  | { kind: "family"; id: string; lane: Lane; issue: Issue; children: Issue[] }
) & { readonly move?: CardMove };

export const cardRepo = (c: BoardCard) => c.issue.repo;
export const cardAgent = (c: BoardCard) => assignedAgentOf(c.issue);

export function buildCards(rows: IssueHistory[], core: SpaceView | undefined, orchestrators: ReadonlySet<string>): BoardCard[] {
  const cards: BoardCard[] = [];
  const families = new Map<string, Issue[]>();
  for (const row of rows) {
    if (!row.issue.parent) continue;
    const children = families.get(row.issue.parent) ?? [];
    children.push(row.issue);
    families.set(row.issue.parent, children);
  }
  for (const row of rows) {
    const issue = row.issue;
    const base = { id: issue.id, lane: laneOf(issue.status), issue };
    const children = families.get(issue.id) ?? [];
    if (children.length > 0) cards.push({ kind: "family", ...base, children });
    else if (assignedOnDuty(issue, orchestrators)) cards.push({ kind: "orchestrator", ...base });
    else {
      if (executionsOf(issue).length === 0) cards.push({ kind: "todo", ...base });
      else if (row.missingSessions.length > 0 || row.sessions.length === 0) cards.push({ kind: "missing", ...base, missing: row.missingSessions });
      else cards.push(omitUndefined({ kind: "issue" as const, ...base, sessions: row.sessions, tag: issueTag(issue), session: issueSession(core, issue) }));
    }
  }
  return cards;
}

function cardWords(c: BoardCard): (string | undefined)[] {
  switch (c.kind) {
    case "family":
    case "todo":
    case "missing":
      return [c.issue.title, c.issue.description, c.issue.repo];
    case "issue": {
      const head = c.sessions.at(-1);
      return [c.issue.title, c.issue.description, head?.name, c.issue.repo, c.issue.id, head?.lastRun?.summary];
    }
    case "orchestrator":
      return [c.issue.title, c.issue.description, c.issue.repo, c.issue.id, t("web.issue.card.orchestrator")];
  }
}

export interface BoardFilter {
  query: string;
  repo: string;
  agent: string;
}

export const noFilter: BoardFilter = { query: "", repo: "", agent: "" };
export const filterAny = (f: BoardFilter) => f.query.trim() !== "" || f.repo !== "" || f.agent !== "";
export const filterShows = (f: BoardFilter, c: BoardCard) =>
  (f.repo === "" || cardRepo(c) === f.repo) && (f.agent === "" || cardAgent(c) === f.agent) && matches(f.query, cardWords(c));

/** What a card and a list row both show. `detail` is everything else: it is the hover tip. */
interface CardLook {
  /** The issue's display number, such as #12. */
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

export function cardLook(c: BoardCard, nameOf: (agent: string) => string, issues: Issue[], now: number): CardLook {
  const flags: CardLook["flags"] = [];
  const lines: string[] = [];
  switch (c.kind) {
    case "family":
      return {
        number: numberOf(c.issue),
        title: c.issue.title,
        status: c.issue.status,
        priority: c.issue.priority,
        flags: [{ text: t(`shared.stage.${c.issue.stage.state}`), tone: stageTone[c.issue.stage.state] }],
        detail: c.issue.description,
        progress: { done: c.children.filter((child) => child.status === "done" || child.status === "canceled").length, total: c.children.length },
      };
    case "todo": {
      const item = c.issue;
      if (item.refining) flags.push({ text: t("web.issue.card.refining", { name: item.refining.name }), tone: "water" });
      else if (item.status === "backlog") flags.push({ text: t("web.issue.card.draft"), tone: "wheat" });
      if (item.queuedAt !== undefined) flags.push({ text: t("web.issue.card.queued"), tone: "water" });
      if (item.cron !== undefined) flags.push({ text: t("web.issue.card.cron"), tone: "faint" });
      const agent = assignedAgentOf(item);
      lines.push(agent === undefined ? t("web.issue.card.noHelper") : nameOf(agent));
      if (agent === undefined || item.repo === undefined) lines.push(t("web.issue.card.pickFirst"));
      lines.push(
        item.queuedAt !== undefined
          ? t("web.issue.card.waiting", { ago: ago(item.queuedAt, now) })
          : t("web.issue.card.written", { ago: ago(item.createdAt, now) }),
      );
      return { number: numberOf(item), title: item.title, status: item.status, priority: item.priority, flags, detail: lines.join("\n") };
    }
    case "issue": {
      const { issue, sessions, tag, session } = c;
      const head = sessions.at(-1);
      if (!head) {
        return { number: numberOf(issue), title: shortTitle(issueTitle(issue, issues)), status: issue.status, priority: issue.priority, flags, detail: "" };
      }
      const first = sessions[0] ?? head;
      const phase = session?.phase;
      const now0 = session ?? head;
      // The board says what the page says: the stage, when it waits on the user.
      // A stuck issue says why on the board as on its page (conflict).
      const st = issue.stage;
      if (stageWantsUser(st.state))
        flags.push({
          text: st.stuck
            ? t("shared.join.labeled", { label: t(`shared.stage.${st.state}`), text: t(`shared.stuck.${st.stuck}`) })
            : t(`shared.stage.${st.state}`),
          tone: stageTone[st.state],
        });
      if (issue.canceled === "lost") flags.push({ text: t("web.issue.card.lost"), tone: "berry" });
      if (issue.cron !== undefined) flags.push({ text: t("web.issue.card.cron"), tone: "faint" });
      lines.push(head.name);
      if (phase?._tag === "working" && phase.quietSince !== undefined) lines.push(t("web.issue.card.quiet", { took: tookText(now - phase.quietSince) }));
      if (sessions.length > 1) lines.push(t("web.issue.card.nth", { n: sessions.length }));
      const runs = Math.round(now0.runs);
      const cny = now0.spent?.cny;
      const took = tagOpen(tag)
        ? t("web.issue.card.open", { took: tookText(now - head.hiredAt) })
        : t("web.issue.card.used", { took: tookText((issue.closedAt ?? endedAt(head) ?? now) - first.hiredAt) });
      lines.push(
        [
          tag === "working" ? t("web.issue.card.run", { n: runs + 1 }) : t("web.issue.card.runs", { n: runs }),
          took,
          ...(cny !== undefined ? [`¥${cny.toFixed(2)}`] : []),
        ].join(" · "),
      );
      const said = now0.lastRun?.summary;
      if (tag === "waiting" && said) lines.push(said);
      if (!tagOpen(tag)) lines.push(`${tagText(issue)} · ${ago(issue.closedAt ?? endedAt(head) ?? head.hiredAt, now)}`);
      return omitUndefined({
        number: numberOf(issue),
        title: shortTitle(issueTitle(issue, issues)),
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
  }
}

export function cardMove(c: BoardCard, to: Lane): Move | undefined {
  if (c.kind === "todo" || c.kind === "issue" || c.kind === "family") return moveOf(c.lane, to, c.issue.moves);
  return undefined;
}
