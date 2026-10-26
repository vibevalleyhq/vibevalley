// Where an issue stands for the owner: one state out of the issue's status, its session's phase, the questions, a
// conflict and the acceptance, with the one thing the owner is asked to do. The board, the farm and the page all say it.

import type { Attention } from "../shapes";

/** Questions the owner for something: the page leads with it, the board flags it. */
export const attentionWantsOwner = (s: Attention) => s === "asking" || s === "reviewing" || s === "stuck";
