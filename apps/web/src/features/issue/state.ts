import { t } from "@vibevalley/i18n";
// What an issue's page says, top to bottom, for the owner: what it is, where it stands, what is asked of the owner, how far
// it is against its criteria; and what a bug on its plot is, and the changes to look at before completing. Where it stands (and what the
// owner may do) is the server's Issue.attention; this only words it.

import type { Changes, Doing, Issue, IssueAttention, Session, SessionEvent, Attention, TaskGraph } from "@vibevalley/protocol";
import { shortTitle } from "@vibevalley/protocol/rules";
import { endedAt, issueInTask, issueTitle } from "./rules";
import { tookText } from "@/base/format";
import type { Tone } from "./cards";

/** An action's words as a sentence starts them (English capitalizes; Chinese has no case). */
const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const attentionTone: Record<Attention, Tone> = {
  draft: "faint",
  queued: "faint",
  working: "water",
  asking: "wheat",
  reviewing: "wheat",
  stuck: "berry",
  done: "leaf",
  canceled: "faint",
};

/** How long, in round words: 不到 1 分钟, 3 分钟, 2 小时, 4 天. */
export function spanText(ms: number) {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return t("web.base.time.round.underMinute");
  if (m < 60) return t("web.base.time.round.minutes", { m });
  if (m < 60 * 24) return t("web.base.time.round.hours", { h: Math.floor(m / 60) });
  return t("web.base.time.round.days", { d: Math.floor(m / 60 / 24) });
}

/** The block that asks the owner for the one thing: its head and what it says under it. */
export interface OwnerQuestion {
  head: string;
  line?: string;
  tone: Tone;
}

const nothing: Doing = { action: "none", label: "" };
const doingOf = (s: Session): Doing => (s.phase._tag === "working" ? s.phase.doing : nothing);

/** One of the criteria as far as it got: the helper's word on it, if it gave one. */
export interface CriterionRow {
  text: string;
  result?: "met" | "unmet" | "unsure";
  proof?: string;
}

function criteriaRows(issue: Issue): CriterionRow[] {
  return issue.criteria.map((text, i) => {
    const c = issue.checks.find((x) => x.criterion === i);
    return { text, ...(c ? { result: c.result, ...(c.proof ? { proof: c.proof } : {}) } : {}) };
  });
}

/** The one thing the owner is asked for, worded; undefined when nothing is asked of the owner. */
function ownerQuestion(attention: IssueAttention, issue: Issue, head: Session): OwnerQuestion | undefined {
  const who = head.name;
  const said = head.lastRun?.summary;
  switch (attention.state) {
    case "asking":
      return { head: t("web.issue.issue.asking", { who, n: issue.questions.length }), line: t("web.issue.issue.askingLine"), tone: "wheat" };
    case "reviewing":
      return issue.reviewedAt !== undefined
        ? { head: t("web.issue.issue.reviewed"), ...(said ? { line: said } : {}), tone: "leaf" }
        : { head: t("web.issue.issue.handedBack", { who }), ...(said ? { line: said } : {}), tone: "wheat" };
    case "stuck":
      switch (attention.stuck) {
        case "conflict":
          return {
            head: t("web.issue.issue.conflict", { base: head.conflict?.base ?? t("web.issue.issue.main") }),
            ...(head.conflict ? { line: head.conflict.files.join(t("web.issue.issue.and")) } : {}),
            tone: "berry",
          };
        case "failed":
          return { head: t("web.issue.issue.failed"), ...(said ? { line: said } : {}), tone: "berry" };
        case "interrupted":
          return { head: t("web.issue.issue.interrupted"), ...(said ? { line: said } : {}), tone: "wheat" };
        case "quiet":
          return { head: t("web.issue.issue.quiet", { who }), line: t("web.issue.issue.quietLine"), tone: "berry" };
        // No reason given: under exactOptionalPropertyTypes a case undefined does not make this switch exhaustive.
        default:
          return { head: t("web.issue.issue.stuck"), tone: "berry" };
      }
    case "canceled":
      return attention.lead === "reopen" ? { head: t("web.issue.issue.canceled"), line: t("web.issue.issue.reopenLine"), tone: "faint" } : undefined;
    case "draft":
    case "queued":
    case "working":
    case "done":
      return undefined;
  }
}

/** `sessions` oldest first; `session` the one on the farm now, if any. */
export function issueState(issue: Issue, sessions: Session[], session: Session | undefined, graphs: TaskGraph[]) {
  const head = session ?? sessions[sessions.length - 1]!;
  const graphId = head.graph?.id ?? issue.parent ?? (issue.graph ? issue.id : undefined);
  const graph = graphId === undefined ? undefined : graphs.find((g) => g.id === graphId);
  const node = head.graph?.task === undefined || !graph ? undefined : graph.tasks.find((item) => item.id === head.graph!.task);
  const attention = issue.attention;
  const current = doingOf(head);
  const rows = criteriaRows(issue);
  // Each helper once, the first time it worked the issue.
  const crew = sessions.filter((s, i) => !sessions.slice(0, i).some((x) => x.agent === s.agent));
  const hand = head.worktree !== undefined ? session : undefined;
  const fullTitle = issueTitle(issue, graphs);
  const title = shortTitle(fullTitle);

  return {
    issue,
    head,
    session,
    attention,
    inTask: issueInTask(issue, session),
    open: attention.state !== "done" && attention.state !== "canceled",
    title,
    /** The whole of a title too long for the page's first line goes with the description. */
    description: [title !== fullTitle ? fullTitle : "", issue.description || (title === head.brief ? "" : head.brief)].filter(Boolean).join("\n\n"),
    project: issue.project ?? head.project,
    taskText: !graph
      ? t("web.issue.issue.inGraph")
      : !node
        ? t("web.issue.issue.splitting", { graph: graph.title })
        : t("web.issue.issue.graphStep", { graph: graph.title, step: node.title }),
    ask: ownerQuestion(attention, issue, head),
    /** The lead act and the rest the owner may do, as the server says. */
    lead: attention.lead,
    others: attention.acts.map((a) => a.act).filter((a) => a !== attention.lead),
    criteria: rows,
    met: rows.filter((r) => r.result === "met").length,
    doing:
      attention.state === "working" && current.action !== "none"
        ? current.label
          ? t("web.issue.issue.doingLabel", { action: capitalized(current.actionText ?? ""), label: current.label })
          : t("web.issue.issue.doing", { action: capitalized(current.actionText ?? "") })
        : undefined,
    openFindings: issue.findings.filter((f) => !f.resolved),
    resolvedFindings: issue.findings.filter((f) => f.resolved),
    crewLine:
      crew.length <= 1 && !hand
        ? undefined
        : // One plot, one worktree: only the session on it now changes the code.
          [crew.map((c) => c.name).join(t("web.issue.issue.and")), ...(hand ? [t("web.issue.issue.editing", { who: hand.name })] : [])].join(" · "),
    whoLine: head.runtime ? t("web.issue.issue.whoRuntime", { name: head.name, runtime: head.runtime }) : t("web.issue.issue.who", { name: head.name }),
    historyLine: t("web.issue.issue.history", {
      n: sessions.length,
      line: sessions.map((r) => t("web.issue.issue.historyItem", { name: r.name, id: r.id })).join(" → "),
    }),
    /** 在等你 · 3 分钟了 · Claude 师傅 · 第 2 轮 · 共用 4 分钟 · ¥0.42; cny is all the issue's runs when known. Under a
     * minute is 刚刚, and the time in all is left out then: two "under a minute"s said nothing. */
    statusLine(now: number, cny?: number) {
      const s = session ?? head;
      const turns = Math.round(s.runs);
      const waited = attention.since !== undefined ? now - attention.since : undefined;
      const used = (endedAt(head) ?? now) - sessions[0]!.hiredAt;
      return [
        t(`shared.attention.${attention.state}`),
        ...(waited === undefined ? [] : [waited < 60_000 ? t("web.issue.issue.justNow") : t("web.issue.issue.since", { span: spanText(waited) })]),
        head.name,
        ...(turns > 0 ? [t("web.issue.issue.ran", { n: turns })] : []),
        ...(used >= 60_000 ? [t("web.issue.issue.used", { span: spanText(used) })] : []),
        ...((cny ?? s.spent?.cny) !== undefined ? [`¥${(cny ?? s.spent!.cny!).toFixed(2)}`] : []),
      ].join(" · ");
    },
    usedLine(steps: SessionEvent[], now: number) {
      const s = session ?? head;
      const turns = s.runs > 0 ? Math.round(s.runs) : steps.filter((e) => e.type === "run/start").length;
      return [
        t("web.issue.card.turns", { n: turns }),
        tookText((endedAt(head) ?? now) - head.hiredAt),
        ...(s.spent?.cny !== undefined ? [t("web.base.money.spent", { yuan: `¥${s.spent.cny.toFixed(2)}` })] : []),
        ...(head.spent && head.spent.tokens > 0 ? [`${Math.round(head.spent.tokens)} token`] : []),
      ].join(" · ");
    },
    /** What it made, while there is a worktree to read it from. */
    showsChanges: session !== undefined && attention.state !== "done" && attention.state !== "canceled",
  };
}

export type IssueState = ReturnType<typeof issueState>;

/** A binary file counts -1: not counted. */
export const lineCounts = (c: Changes): [number, number] => [
  c.files.reduce((n, f) => n + Math.max(0, Math.round(f.added)), 0),
  c.files.reduce((n, f) => n + Math.max(0, Math.round(f.removed)), 0),
];

/** The one line over an issue's changes. */
export function changesLine(c: Changes) {
  const [added, removed] = lineCounts(c);
  const counts = { branch: c.branch ?? "", base: c.base, commits: c.commits.length, added, removed };
  return c.uncommitted.length
    ? t("web.issue.issue.changesUncommitted", { ...counts, uncommitted: c.uncommitted.length })
    : t("web.issue.issue.changes", counts);
}

/** The empty 干活过程 says why. */
export const noStepsText = (head: Session) => (endedAt(head) === undefined ? t("web.issue.issue.noSteps") : t("web.issue.issue.stepsGone"));

/** Nothing to merge: completing only lets the helper go. */
export const nothingChanged = (c: Changes) => c.commits.length === 0 && c.uncommitted.length === 0;

/** What a git status letter is, as a mark and a word; an unknown one is itself. */
export function changeKind(status: string) {
  switch (status) {
    case "A":
      return { mark: t("web.issue.issue.change.A.mark"), label: t("web.issue.issue.change.A.label") };
    case "M":
      return { mark: t("web.issue.issue.change.M.mark"), label: t("web.issue.issue.change.M.label") };
    case "D":
      return { mark: t("web.issue.issue.change.D.mark"), label: t("web.issue.issue.change.D.label") };
    default:
      return { mark: status, label: status };
  }
}

export type PatchMark = "added" | "removed" | "hunk" | "plain";

export const patchMarkOf = (line: string): PatchMark =>
  line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : line.startsWith("@@") ? "hunk" : "plain";

/** A patch from its first hunk: the header above it says nothing the file row does not. */
export function patchLines(text: string) {
  const lines = text.split("\n");
  return lines.slice(
    Math.max(
      0,
      lines.findIndex((l) => l.startsWith("@@")),
    ),
  );
}
