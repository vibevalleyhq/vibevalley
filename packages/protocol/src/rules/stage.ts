import type { IssueStageKind } from "../shapes";

/** Questions the user for something: the page leads with it, the board flags it. */
export const stageWantsUser = (s: IssueStageKind) => s === "asking" || s === "reviewing" || s === "stuck";
