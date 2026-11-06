import { t } from "@vibevalley/i18n";
import type { DoingView, Issue, IssueStage, IssueStageKind, Session, SessionEvent, SessionView } from "@vibevalley/protocol";
import { shortTitle } from "@vibevalley/protocol/rules";
import { sessionId } from "@vibevalley/protocol/schema";

import { spanText, tookText } from "#/base/format.ts";

import type { Tone } from "./cards";
import { endedAt, issueTitle } from "./issue";
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

/** The block that asks the owner for the one thing: its head and what it says under it. */
interface OwnerQuestion {
  head: string;
  line?: string;
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

/** The one thing the owner is asked for, worded; undefined when nothing is asked of the owner. */
function ownerQuestion(stage: IssueStage, issue: Issue, head: Session): OwnerQuestion | undefined {
  const who = head.name;
  const said = head.lastRun?.summary;
  switch (stage.state) {
    case "asking":
      return { head: t("web.issue.issue.asking", { who, n: issue.questions.length }), line: t("web.issue.issue.askingLine"), tone: "wheat" };
    case "reviewing":
      return issue.reviewedAt !== undefined
        ? { head: t("web.issue.issue.reviewed"), ...(said ? { line: said } : {}), tone: "leaf" }
        : { head: t("web.issue.issue.handedBack", { who }), ...(said ? { line: said } : {}), tone: "wheat" };
    case "stuck":
      switch (stage.stuck) {
        case "conflict":
          return {
            head: t("web.issue.issue.conflict", { base: issue.conflict?.base ?? t("web.issue.issue.main") }),
            ...(issue.conflict ? { line: issue.conflict.files.join(t("web.issue.issue.and")) } : {}),
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
      return stage.lead === "reopen" ? { head: t("web.issue.issue.canceled"), line: t("web.issue.issue.reopenLine"), tone: "faint" } : undefined;
    case "draft":
    case "queued":
    case "working":
    case "done":
      return undefined;
  }
}

const emptySession = (issue: Issue): Session => ({
  id: sessionId(issue.id),
  role: "worker",
  name: "",
  agent: "",
  runtime: "",
  phase: { _tag: "resting" },
  hiredAt: issue.createdAt,
  brief: issue.title,
  runs: 0,
  refining: false,
});

/** `sessions` oldest first; `session` the one on the farm now, if any. */
export function issueState(issue: Issue, sessions: Session[], session: SessionView | undefined, issues: Issue[]) {
  const head = session ?? sessions.at(-1) ?? emptySession(issue);
  const first = sessions[0] ?? head;
  const parent = issues.find((item) => item.id === issue.parent);
  const stage = issue.stage;
  const current = session ? doingOf(session) : nothing;
  const rows = criteriaRows(issue);
  // Each helper once, the first time it worked the issue.
  const crew = sessions.filter((s, i) => !sessions.slice(0, i).some((x) => x.agent === s.agent));
  const hand = head.worktree !== undefined ? session : undefined;
  const fullTitle = issueTitle(issue, issues);
  const title = shortTitle(fullTitle);

  return {
    issue,
    head,
    session,
    stage,
    inFamily: issue.parent !== undefined,
    open: stage.state !== "done" && stage.state !== "canceled",
    title,
    /** The whole of a title too long for the page's first line goes with the description. */
    description: [title !== fullTitle ? fullTitle : "", issue.description || (title === head.brief ? "" : head.brief)].filter(Boolean).join("\n\n"),
    project: issue.project ?? head.project,
    parentText: parent?.title ?? issue.parent ?? "",
    ask: ownerQuestion(stage, issue, head),
    /** The lead act and the rest the owner may do, as the server says. */
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
    /** status summary line. cny is all the issue's runs when known. */
    statusLine(now: number, cny?: number) {
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
      ].join(" · ");
    },
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
    showsChanges: session !== undefined && stage.state !== "done" && stage.state !== "canceled",
  };
}

/** The empty work log says why. */
export const noStepsText = (head: Session) => (endedAt(head) === undefined ? t("web.issue.issue.noSteps") : t("web.issue.issue.stepsGone"));
