import { t } from "@vibevalley/i18n";
import type { BoardSummary, DoingView, Issue, IssuePromptKind, IssueStage, IssueStageKind, Session, SessionEvent, SessionView } from "@vibevalley/protocol";
import { sessionProfile, sessionRepo, sessionWorktree } from "@vibevalley/protocol/rules";
import { sessionId } from "@vibevalley/protocol/schema";

import { spanText, tookText } from "../../../infra/base/format";
import type { Tone } from "./cards";
import { endedAt, issueTitle, needsWorktreeCheck } from "./issue";
import { localizeIssueError } from "./issueError";
/** An action's words as a sentence starts them (English capitalizes; Chinese has no case). */
const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const stageTone: Record<IssueStageKind, Tone> = {
  draft: "faint",
  queued: "faint",
  working: "water",
  asking: "wheat",
  reviewing: "wheat",
  stuck: "berry",
  done: "leaf",
  canceled: "faint",
};

/** The block that asks the user for the one thing: its head and what it says under it. */
interface UserQuestion {
  head: string;
  line?: string;
  settingsHref?: string;
  tone: Tone;
}

const nothing: DoingView = { action: "none", label: "", actionText: "" };

const doingOf = (s: SessionView): DoingView => (s.phase._tag === "working" ? s.phase.doing : nothing);

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

/** Derives a prompt kind locally only when `BoardSlice.boardSummary` does not carry this issue. */
function fallbackPromptOf(stage: IssueStage, issue: Issue): IssuePromptKind | undefined {
  switch (stage.state) {
    case "asking":
      return "asking";
    case "reviewing":
      if (issue.deliveryEvidence?.check?.status === "failed") return "review_after_failed_check";
      return issue.reviewedAt !== undefined ? "reviewed" : "handed_back";
    case "stuck": {
      const reason = stage.stuck;
      if (reason === undefined) return "stuck_unknown";
      switch (reason) {
        case "conflict":
          return "stuck_conflict";
        case "failed":
          return "stuck_failed";
        case "interrupted":
          return "stuck_interrupted";
        case "quiet":
          return "stuck_quiet";
      }
      break;
    }
    case "canceled":
      return stage.lead === "reopen" ? "canceled_reopenable" : undefined;
    case "draft":
    case "queued":
    case "working":
    case "done":
      return undefined;
  }
}

/** Every prompt kind has copy: add one when a prompt kind is added. */
function userQuestionFromPrompt(prompt: IssuePromptKind, issue: Issue, head: Session): UserQuestion {
  const who = head.name;
  const rawSaid = head.lastRun?.summary;
  const localizedSaid = rawSaid ? localizeIssueError(rawSaid) : undefined;
  const saidFields = localizedSaid ? { line: localizedSaid.text, ...(localizedSaid.settingsHref ? { settingsHref: localizedSaid.settingsHref } : {}) } : {};
  switch (prompt) {
    case "asking":
      return { head: t("web.issue.issue.asking", { who, n: issue.questions.length }), line: t("web.issue.issue.askingLine"), tone: "wheat" };
    case "review_after_failed_check":
      return { head: t("web.issue.issue.reviewAfterFailedCheck"), ...saidFields, tone: "wheat" };
    case "reviewed":
      return { head: t("web.issue.issue.reviewed"), ...saidFields, tone: "leaf" };
    case "handed_back":
      return { head: t("web.issue.issue.handedBack", { who }), ...saidFields, tone: "wheat" };
    case "stuck_conflict":
      return {
        head: t("web.issue.issue.conflict", { base: issue.conflict?.base ?? t("web.issue.issue.main") }),
        ...(issue.conflict ? { line: issue.conflict.files.join(t("web.issue.issue.and")) } : {}),
        tone: "berry",
      };
    case "stuck_failed":
      return { head: t("web.issue.issue.failed"), ...saidFields, tone: "berry" };
    case "stuck_interrupted":
      return { head: t("web.issue.issue.interrupted"), ...saidFields, tone: "wheat" };
    case "stuck_quiet":
      return { head: t("web.issue.issue.quiet", { who }), line: t("web.issue.issue.quietLine"), tone: "berry" };
    case "stuck_unknown":
      return { head: t("web.issue.issue.stuck"), tone: "berry" };
    case "canceled_reopenable":
      return { head: t("web.issue.issue.canceled"), line: t("web.issue.issue.reopenLine"), tone: "faint" };
  }
}

/** The one thing the user is asked for, worded; undefined when nothing is asked of the user. */
function userQuestion(stage: IssueStage, issue: Issue, head: Session, boardSummary?: BoardSummary): UserQuestion | undefined {
  const entry = boardSummary?.byIssue[issue.id];
  const prompt = entry !== undefined ? entry.prompt : fallbackPromptOf(stage, issue);
  return prompt !== undefined ? userQuestionFromPrompt(prompt, issue, head) : undefined;
}

const emptySession = (issue: Issue): Session => ({
  id: sessionId(issue.id),
  controller: "issueBoard",
  role: "worker",
  name: "",
  runtime: "",
  policy: { kind: "sandboxDir" },
  bindings: [],
  phase: { _tag: "resting" },
  hiredAt: issue.createdAt,
  brief: issue.title,
  runs: 0,
});

/** `sessions` oldest first; `session` the one on the farm now, if any. */
export function issueState(issue: Issue, sessions: Session[], session: SessionView | undefined, issues: Issue[], boardSummary?: BoardSummary) {
  const head = session ?? sessions.at(-1) ?? emptySession(issue);
  const first = sessions[0] ?? head;
  const parent = issues.find((item) => item.id === issue.parent);
  const stage = issue.stage;
  const current = session ? doingOf(session) : nothing;
  const rows = criteriaRows(issue);
  // Each helper once, the first time it worked the issue.
  const crew = sessions.filter((s, i) => !sessions.slice(0, i).some((x) => (sessionProfile(x) ?? x.id) === (sessionProfile(s) ?? s.id)));
  const hand = sessionWorktree(head) !== undefined ? session : undefined;
  const title = issueTitle(issue, issues);

  /** The status summary, one part each: the stage, how long, who, the rounds, the time used, the money. cny is all the issue's runs when known. */
  const statusParts = (now: number, cny?: number): string[] => {
    const s = session ?? head;
    const runs = Math.round(s.runs);
    const waited = stage.since !== undefined ? now - stage.since : undefined;
    const used = (endedAt(head) ?? now) - first.hiredAt;
    const spentCny = cny ?? s.spent?.cny;
    return [
      t(`shared.stage.${stage.state}`),
      ...(waited === undefined ? [] : [waited < 60_000 ? t("web.issue.issue.justNow") : t("web.issue.issue.since", { span: spanText(waited) })]),
      head.name,
      ...(runs > 0 ? [t("web.issue.issue.ran", { n: runs })] : []),
      ...(used >= 60_000 ? [t("web.issue.issue.used", { span: spanText(used) })] : []),
      ...(spentCny !== undefined ? [`¥${spentCny.toFixed(2)}`] : []),
    ];
  };

  return {
    issue,
    head,
    session,
    stage,
    inFamily: issue.parent !== undefined,
    open: stage.state !== "done" && stage.state !== "canceled",
    title,
    description: issue.description || (title === head.brief ? "" : head.brief),
    repo: issue.repo ?? sessionRepo(head),
    parentText: parent?.title ?? issue.parent ?? "",
    ask: userQuestion(stage, issue, head, boardSummary),
    needsWorktreeCheck:
      boardSummary?.byIssue[issue.id]?.needsWorktreeCheck ?? (stage.state !== "done" && stage.state !== "canceled" && needsWorktreeCheck(head)),
    /** The lead act and the rest the user may do, as the server says. */
    lead: stage.lead,
    others: stage.acts.map((a) => a.act).filter((a) => a !== stage.lead),
    criteria: rows,
    met: rows.filter((r) => r.result === "met").length,
    doing:
      stage.state === "working" && current.action !== "none"
        ? current.label
          ? t("web.issue.issue.doingLabel", { action: capitalized(current.actionText), label: current.label })
          : t("web.issue.issue.doing", { action: capitalized(current.actionText) })
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
    statusParts,
    /** The status summary on one line. */
    statusLine: (now: number, cny?: number) => statusParts(now, cny).join(" · "),
    usedLine(steps: SessionEvent[], now: number) {
      const s = session ?? head;
      const runs = s.runs > 0 ? Math.round(s.runs) : steps.filter((e) => e.type === "run/start").length;
      return [
        t("web.issue.card.runs", { n: runs }),
        tookText((endedAt(head) ?? now) - head.hiredAt),
        ...(s.spent?.cny !== undefined ? [t("web.base.money.spent", { yuan: `¥${s.spent.cny.toFixed(2)}` })] : []),
        ...(head.spent && head.spent.tokens > 0 ? [`${Math.round(head.spent.tokens)} token`] : []),
      ].join(" · ");
    },
    /** What it made, while there is a worktree to read it from. */
    showsChanges: issue.deliveryEvidence?.mergedCommit !== undefined || (session !== undefined && stage.state !== "done" && stage.state !== "canceled"),
  };
}

/** The empty work log says why. */
export const noStepsText = (head: Session) => (endedAt(head) === undefined ? t("web.issue.issue.noSteps") : t("web.issue.issue.stepsGone"));
