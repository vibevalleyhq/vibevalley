// What a session is told of its issue (its brief, how to resume, how to cure a report it could not read) and what is
// read back from its report (findings, a pull request's conclusion).

import { t } from "@vibevalley/i18n";
import { reportVerdict } from "@/session/report.ts";
import type { Deliverable, Issue } from "@vibevalley/protocol";
import { shortTitle } from "@vibevalley/protocol/rules";
import { answerFormat, answerOpening, criteriaHead } from "./prompts.ts";
/** The criteria go last, so whoever works it checks each one before handing the work back; an answer issue's brief ends with the block parseAnswer reads. */
export function issueBrief(pick: Pick<Issue, "title" | "description" | "criteria"> & { readonly deliver?: Deliverable }): string {
  let brief = pick.title;
  if (pick.description) brief += "\n\n" + pick.description;
  if (pick.criteria.length > 0) brief += "\n\n" + criteriaHead + "\n" + pick.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  return pick.deliver === "answer" ? answerOpening + "\n\n" + brief + "\n\n" + answerFormat : brief;
}

/** 接着修 for an answer that could not be read; cureWords is the one for a failed round. */
export const answerCureWords = (problem: string) => t("server.issue.brief.answerUnread", { problem }) + "\n" + answerFormat;

/** The first line with words is the title, the rest the description; a first line too long for a title gives its
 * short title (shortTitle) and the whole brief is the description. */
export function splitBrief(brief: string): [string, string] {
  const lines = brief.replaceAll("\r\n", "\n").split("\n");
  const i = lines.findIndex((l) => l.trim() !== "");
  if (i < 0) return ["", ""];
  const first = lines[i]!.trim();
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

/** Calling it twice gives the same brief: a 接着修 told before is taken off first. */
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

/** A pull request's description: the session's conclusion (its 结论： part), else all it last said. */
export const pullRequestConclusion = (text: string) => reportVerdict(text) || text;
