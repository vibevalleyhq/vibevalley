// Which farm a session is on and which plot it works: the server places and pictures it there, the page draws it there.

import { type Session } from "../shapes";

/** The farm a session's bed is on: each project has its own, and the sessions without one share one. */
export const farmOf = (h: Session): string => h.project ?? "";

/** The plot a session works, the key of `FarmView.plots`: its issue, so a reopened issue keeps its plot; one with no issue is its own. */
export const plotKeyOf = (h: Session): string => h.issue ?? h.id;
