// Which farm a session is on: the server places it there, the page draws it there.

import { type Session } from "../shapes";

/** The farm a session's bed is on: each project has its own, and the sessions without one share one. */
export const farmOf = (h: Session): string => h.project ?? "";
