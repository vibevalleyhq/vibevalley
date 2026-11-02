// An issue's title in one short line, and its state in words, as the board, the phone, the tools and the orchestrator say them.

import { t } from "@vibevalley/i18n";

import type { Assignment, Issue, SessionId } from "../shapes";

const titleMax = 40;

/** The responsibility in force now. */
export const assignmentOf = (issue: Pick<Issue, "assignments">): Assignment | undefined =>
  issue.assignments.findLast((assignment) => assignment.endedAt === undefined);

export const assignedAgentOf = (issue: Pick<Issue, "assignments">): string | undefined => assignmentOf(issue)?.agent;

/** Every execution, in assignment and start order. */
export const executionsOf = (issue: Pick<Issue, "assignments">): Assignment["executions"] => issue.assignments.flatMap((assignment) => assignment.executions);

/** The external helper contexts that executed it, in order. */
export const sessionIdsOf = (issue: Pick<Issue, "assignments">): SessionId[] =>
  executionsOf(issue).flatMap((execution) => (execution.kind === "worker" ? [execution.session] : []));

export const latestSessionIdOf = (issue: Pick<Issue, "assignments">): SessionId | undefined => sessionIdsOf(issue).at(-1);

/** One short line for a title: its first line, and of a long one, the first sentence, else up to its last pause that fits;
 * failing those, cut. Lengths are characters. */
export function shortTitle(text: string): string {
  const line = (text.split("\n").find((l) => l.trim() !== "") ?? "").trim();
  const chars = [...line];
  if (chars.length <= titleMax) return line;
  const head = chars.slice(0, titleMax + 1).join("");
  const sentence = /^(.{4,}?)[。！？!?；;]/u.exec(head)?.[1];
  if (sentence) return sentence.trim();
  const pause = Math.max(-1, ...[...head.matchAll(/[：:，,、]/gu)].map((m) => m.index));
  if (pause >= 4) return head.slice(0, pause).trim();
  return chars.slice(0, titleMax - 1).join("") + "…";
}

/** What its close says: done with what it delivered, or canceled and why. */
export const closedText = (pick: Pick<Issue, "status" | "delivered" | "canceled">): string => {
  return pick.delivered
    ? t("shared.doneWith", { what: t(`shared.delivered.${pick.delivered}`) })
    : pick.canceled
      ? t("shared.canceledFor", { why: t(`shared.canceled.${pick.canceled}`) })
      : t(`shared.status.${pick.status}`);
};
