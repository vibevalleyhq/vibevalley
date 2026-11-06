import { type Session } from "../shapes";

/** The farm a session's bed is on: each repo has its own, and the sessions without one share one. */
export const farmOf = (h: Session): string => h.repo ?? "";

/** The plot a session works, the key of `FarmView.plots`: its issue, so a reopened issue keeps its plot; one with no issue is its own. */
export const plotKeyOf = (h: Session): string => h.issue ?? h.id;
