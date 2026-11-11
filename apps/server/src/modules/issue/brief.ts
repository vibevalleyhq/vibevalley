import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { closedText, plainText, shortTitle } from "@vibevalley/protocol/rules";

import { or } from "#/base/order.ts";

import { answerFormat, answerOpening, criteriaHead, pullRequestDelivery } from "./prompts.ts";
/** The criteria go last, so whoever works it checks each one before handing the work back; an answer issue reports its answer through issue_report. */
export function issueBrief(pick: Pick<T.Issue, "title" | "description" | "criteria"> & { readonly deliver?: T.Deliverable }): string {
  let brief = pick.title;
  if (pick.description) brief += "\n\n" + pick.description;
  if (pick.criteria.length > 0) brief += "\n\n" + criteriaHead + "\n" + pick.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  if (pick.deliver === "pull_request") brief += "\n\n" + pullRequestDelivery;
  return pick.deliver === "answer" ? answerOpening + "\n\n" + brief + "\n\n" + answerFormat : brief;
}

/** fix-up for an answer that could not be read; cureWords is the one for a failed round. */
export const answerCureWords = (problem: string) => t("server.issue.brief.answerUnread", { problem }) + "\n" + answerFormat;

/** The first line with words is the title, the rest the description. */
export function splitBrief(brief: string): [string, string] {
  const lines = brief.replaceAll("\r\n", "\n").split("\n");
  const i = lines.findIndex((l) => l.trim() !== "");
  const firstLine = lines[i];
  if (i < 0 || firstLine === undefined) return ["", ""];
  const first = firstLine.trim();
  const title = shortTitle(first);
  if (title !== first) return [title, lines.slice(i).join("\n").trim()];
  return [
    first,
    lines
      .slice(i + 1)
      .join("\n")
      .trim(),
  ];
}

export const resumeWords = () => t("server.issue.brief.resume");

/** Calling it twice gives the same brief: a fix-up told before is taken off first. */
export function cureWords(brief: string): string {
  let original = brief;
  if (original.startsWith(t("server.issue.brief.cureHead"))) original = original.slice(t("server.issue.brief.cureHead").length);
  if (original.endsWith(t("server.issue.brief.cureTail"))) original = original.slice(0, -t("server.issue.brief.cureTail").length);
  return t("server.issue.brief.cure", { brief: original });
}

export const findingsOf = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** The structured issue_report carries the short result; the PR fallback keeps the worker's complete last answer. */
export const pullRequestConclusion = (text: string) => text.trim();

function startWords(trigger: T.RunTrigger, first: boolean): [T.Milestone["kind"], string] {
  switch (trigger.kind) {
    case "refine":
      return ["started", t("server.issue.timeline.refine")];
    case "comment":
      return ["told", t("server.issue.timeline.told")];
    case "issue":
      return ["started", first ? t("server.issue.timeline.start") : t("server.issue.timeline.restart")];
    case "cron":
      return ["started", t("server.issue.timeline.cron", { missed: trigger.missed ?? false })];
    case "runtime":
      return ["started", t("server.issue.timeline.runtime")];
  }
}

/** runs oldest first. names: a session's name by its id. */
export function milestonesOf(issue: T.Issue, runs: readonly T.Run[], names: ReadonlyMap<string, string>): T.IssueTimeline {
  const out: T.Milestone[] = [{ at: issue.createdAt, kind: "opened", text: t("server.issue.timeline.opened") }];
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
  const spent = runs.reduce<T.Spent | undefined>((sum, r) => {
    if (!r.spent) return sum;
    const cny = r.spent.cny === undefined ? sum?.cny : (sum?.cny ?? 0) + r.spent.cny;
    return { tokens: (sum?.tokens ?? 0) + r.spent.tokens, ...(cny !== undefined ? { cny } : {}) };
  }, undefined);
  return { milestones, ...(spent ? { spent } : {}) };
}
