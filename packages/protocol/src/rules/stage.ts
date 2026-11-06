import type { IssueStageKind } from "../shapes";

/** Questions the owner for something: the page leads with it, the board flags it. */
export const stageWantsOwner = (s: IssueStageKind) => s === "asking" || s === "reviewing" || s === "stuck";
