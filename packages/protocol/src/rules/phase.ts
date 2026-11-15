import { t } from "@vibevalley/i18n";

import type { Session, SessionView } from "../shapes";

/** A short span: seconds under a minute (at least one), else minutes. */
const spanText = (ms: number) =>
  ms < 60_000 ? t("shared.seconds", { n: Math.max(1, Math.round(ms / 1000)) }) : t("shared.minutes", { n: Math.round(ms / 60_000) });

/** It takes one of the places for those working at once. */
export const isBusy = (h: Pick<Session, "phase">) => h.phase._tag === "working";

/** How many more may start working now: on the whole farm (space at once), and in the repo (perRepo at once, 0 for no limit of its own). */
export function roomLeft(sessions: readonly Pick<Session, "id" | "repo" | "phase">[], repo: string, space: number, perRepo: number, except = "") {
  const busy = sessions.filter((h) => isBusy(h) && h.id !== except);
  const inRepo = busy.filter((h) => h.repo === repo).length;
  return {
    farm: Math.max(0, space - busy.length),
    repo: perRepo > 0 ? Math.max(0, perRepo - inRepo) : Infinity,
    busy: busy.length,
    inRepo,
  };
}

/** The server's words for what the session is doing, how long it has been quiet filled in by the clock. */
export function phaseText(h: Pick<SessionView, "phase" | "phaseText">, now: number): string {
  const words = h.phaseText;
  return h.phase._tag === "working" && h.phase.quietSince !== undefined ? words.replaceAll("{span}", spanText(now - h.phase.quietSince)) : words;
}
