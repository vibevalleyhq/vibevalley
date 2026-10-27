// What a session is doing and what it waits on.

import type { Conflict, Retry, Session } from "../shapes";
import { wording } from "../words";

/** It takes one of the places for those working at once. */
export const isBusy = (h: Session) => h.phase._tag === "arriving" || h.phase._tag === "working";

/** How many more may start working now: on the whole farm (workspace at once), and in the project (perProject at once,
 * 0 for no limit of its own). except is a session about to work again, which does not count against itself. The server
 * refuses a start by it (noRoom) and the map draws its open plots by it. */
export function roomLeft(sessions: readonly Session[], project: string, workspace: number, perProject: number, except = "") {
  const busy = sessions.filter((h) => isBusy(h) && h.id !== except);
  const inProject = busy.filter((h) => h.project === project).length;
  return {
    farm: Math.max(0, workspace - busy.length),
    project: perProject > 0 ? Math.max(0, perProject - inProject) : Infinity,
    busy: busy.length,
    inProject,
  };
}

export type Need =
  | { readonly kind: "quiet"; readonly since: number }
  | { readonly kind: "retrying"; readonly retry: Retry }
  | { readonly kind: "conflict"; readonly conflict: Conflict }
  | { readonly kind: "review" }
  | { readonly kind: "fix" };

export function needOf(h: Session): Need | undefined {
  const p = h.phase;
  switch (p._tag) {
    case "working":
      if (p.quietSince !== undefined) return { kind: "quiet", since: p.quietSince };
      if (p.retry !== undefined) return { kind: "retrying", retry: p.retry };
      return undefined;
    case "done":
      return h.conflict ? { kind: "conflict", conflict: h.conflict } : { kind: "review" };
    case "failed":
      return { kind: "fix" };
    case "resting":
      return h.conflict ? { kind: "conflict", conflict: h.conflict } : undefined;
    default:
      return undefined;
  }
}

/** The span placeholder in phaseWords. */
const phaseSpan = "{span}";

/** phaseWords as said at now. */
export function phaseText(h: Session, now: number): string {
  const said = phaseWords(h);
  const need = needOf(h);
  return need?.kind === "quiet" ? said.replaceAll(phaseSpan, wording().span(now - need.since)) : said;
}

/** What a session is doing in words, how long it has been quiet left as {span}. */
export function phaseWords(h: Session): string {
  const w = wording();
  const need = needOf(h);
  const conflict = need?.kind === "conflict" ? w.phase.conflict(need.conflict.base, need.conflict.files ?? []) : "";
  const p = h.phase;
  switch (p._tag) {
    case "arriving":
      return w.phase.arriving;
    case "working": {
      const what = w.phase.working(w.action[p.doing.action] ?? "", p.doing.label);
      if (need?.kind === "quiet") return w.phase.quiet(what, phaseSpan);
      if (need?.kind === "retrying") return w.phase.retrying(what, need.retry.attempt, need.retry.of);
      return what;
    }
    case "done":
      return w.phase.done(conflict);
    case "failed":
      return w.phase.failed;
    case "resting": {
      const outcome = h.lastRun?.outcome;
      return w.phase.resting(outcome === undefined ? w.phase.unfinished : w.outcome[outcome], conflict);
    }
    default:
      return "";
  }
}
