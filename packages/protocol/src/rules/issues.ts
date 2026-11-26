import { t } from "@vibevalley/i18n";

import type { Assignment, Issue, SessionId } from "../shapes";

/** The responsibility in force now. */
const assignmentOf = (issue: Pick<Issue, "assignments">): Assignment | undefined =>
  issue.assignments.findLast((assignment) => assignment.endedAt === undefined);

export const assignedAgentOf = (issue: Pick<Issue, "assignments">): string | undefined => assignmentOf(issue)?.agent;

/** Every execution, in assignment and start order. */
export const executionsOf = (issue: Pick<Issue, "assignments">): Assignment["executions"] => issue.assignments.flatMap((assignment) => assignment.executions);

/** The external helper contexts that executed it, in order. */
export const sessionIdsOf = (issue: Pick<Issue, "assignments">): SessionId[] =>
  executionsOf(issue).flatMap((execution) => (execution.kind === "worker" ? [execution.session] : []));

export const latestSessionIdOf = (issue: Pick<Issue, "assignments">): SessionId | undefined => sessionIdsOf(issue).at(-1);

/** What its close says: done with what it delivered, or canceled and why. */
export const closedText = (pick: Pick<Issue, "status" | "delivered" | "canceled">): string =>
  pick.delivered
    ? t("shared.doneWith", { what: t(`shared.delivered.${pick.delivered}`) })
    : pick.canceled
      ? t("shared.canceledFor", { why: t(`shared.canceled.${pick.canceled}`) })
      : t(`shared.status.${pick.status}`);
