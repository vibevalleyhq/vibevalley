import { t } from "@vibevalley/i18n";
import type { Issue, IssueTimeline, Milestone, MilestoneKind, Run, RunTrigger, Spent } from "@vibevalley/protocol";
import { closedText, plainText } from "@vibevalley/protocol/rules";
import { or } from "@/base/order.ts";
function startWords(trigger: RunTrigger, first: boolean): [MilestoneKind, string] {
  switch (trigger.kind) {
    case "refine":
      return ["started", t("server.issue.timeline.refine")];
    case "comment":
      return ["told", t("server.issue.timeline.told")];
    case "issue":
      return ["started", first ? t("server.issue.timeline.start") : t("server.issue.timeline.restart")];
    case "task":
      return ["started", t("server.issue.timeline.graph")];
    case "cron":
      return ["started", t("server.issue.timeline.cron", { missed: trigger.missed ?? false })];
    case "runtime":
      return ["started", t("server.issue.timeline.runtime")];
  }
}

/** runs oldest first; names: a session's name by its id. The milestones come newest first, the questions it waits on now
 * with its last run. */
export function milestonesOf(issue: Issue, runs: readonly Run[], names: ReadonlyMap<string, string>): IssueTimeline {
  const out: Milestone[] = [{ at: issue.createdAt, kind: "opened", text: t("server.issue.timeline.opened") }];
  const lastDone = runs.findLastIndex((r) => r.endedAt !== undefined);
  runs.forEach((r, i) => {
    const who = names.get(r.session);
    const by = who !== undefined ? { who } : {};
    const draft = r.triggeredBy.kind === "refine";
    const [kind, text] = startWords(r.triggeredBy, !runs.slice(0, i).some((x) => x.triggeredBy.kind !== "refine"));
    out.push({ at: r.startedAt, kind, ...by, text });
    if (r.endedAt === undefined || r.outcome === undefined) return;
    const said = r.summary ? t("server.issue.timeline.said", { summary: plainText(r.summary) }) : "";
    switch (r.outcome) {
      case "completed":
        if (i === lastDone && issue.questions.length > 0)
          out.push({
            at: r.endedAt,
            kind: "asked",
            ...by,
            text: t("server.issue.timeline.asked", { questions: issue.questions.map((a) => a.question).join(" / ") }),
          });
        else
          out.push({
            at: r.endedAt,
            kind: draft ? "refined" : "reported",
            ...by,
            text: (draft ? t("server.issue.timeline.refined") : t("server.issue.timeline.reported")) + said,
          });
        break;
      case "failed":
        out.push({ at: r.endedAt, kind: "failed", ...by, text: t("shared.outcome.failed") + said });
        break;
      case "interrupted":
        out.push({ at: r.endedAt, kind: "stopped", ...by, text: t("shared.outcome.interrupted") + said });
        break;
    }
  });
  const sentBack = new Map<number, string[]>();
  for (const f of issue.findings) sentBack.set(f.at, [...(sentBack.get(f.at) ?? []), f.text]);
  for (const [at, lines] of sentBack)
    out.push({ at, kind: "rejected", text: t("server.issue.timeline.rejected", { lines: lines.join(t("server.issue.timeline.rejectedSeparator")) }) });
  if (issue.reviewedAt !== undefined) out.push({ at: issue.reviewedAt, kind: "accepted", text: t("server.issue.timeline.accepted") });
  if (issue.closedAt !== undefined) out.push({ at: issue.closedAt, kind: "closed", text: closedText(issue) });
  // Newest first; at the same moment, the later step of the story first.
  const milestones = out
    .map((m, i) => [m, i] as const)
    .toSorted((a, b) => or(b[0].at - a[0].at, b[1] - a[1]))
    .map(([m]) => m);
  const spent = runs.reduce<Spent | undefined>((sum, r) => {
    if (!r.spent) return sum;
    const cny = r.spent.cny === undefined ? sum?.cny : (sum?.cny ?? 0) + r.spent.cny;
    return { tokens: (sum?.tokens ?? 0) + r.spent.tokens, ...(cny !== undefined ? { cny } : {}) };
  }, undefined);
  return { milestones, ...(spent ? { spent } : {}) };
}
