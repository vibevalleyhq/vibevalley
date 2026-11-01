// Where an issue stands for the owner: one state out of the issue's status, its session's phase, the questions, a
// conflict and the acceptance, with the one thing the owner is asked to do. The board, the farm and the page all say it.

import type { IssueStageKind } from "../shapes";

/** Questions the owner for something: the page leads with it, the board flags it. */
export const stageWantsOwner = (s: IssueStageKind) => s === "asking" || s === "reviewing" || s === "stuck";
