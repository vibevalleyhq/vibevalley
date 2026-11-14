import { list, t } from "@vibevalley/i18n";

import type { Conflict, Retry, Session } from "../shapes";

/** It takes one of the places for those working at once. */

/** A short span: seconds under a minute (at least one), else minutes. */
export const spanText = (ms: number) =>
  ms < 60_000 ? t("shared.seconds", { n: Math.max(1, Math.round(ms / 1000)) }) : t("shared.minutes", { n: Math.round(ms / 60_000) });

export type Need =
  | { readonly kind: "quiet"; readonly since: number }
  | { readonly kind: "retrying"; readonly retry: Retry }
  | { readonly kind: "conflict"; readonly conflict: Conflict }
  | { readonly kind: "review" }
  | { readonly kind: "fix" };

export function needOf(h: Session, conflict?: Conflict): Need | undefined {
  const p = h.phase;
  switch (p._tag) {
    case "working":
      if (p.quietSince !== undefined) return { kind: "quiet", since: p.quietSince };
      if (p.retry !== undefined) return { kind: "retrying", retry: p.retry };
      return undefined;
    case "done":
      return conflict ? { kind: "conflict", conflict } : { kind: "review" };
    case "failed":
      return { kind: "fix" };
    case "resting":
      return conflict ? { kind: "conflict", conflict } : undefined;
    default:
      return undefined;
  }
}

/** The span placeholder in phaseWords. */
const phaseSpan = "{span}";

/** What a session is doing in words, how long it has been quiet left as {span}. */
export function phaseWords(h: Session, conflict?: Conflict): string {
  const need = needOf(h, conflict);
  const conflictWords = need?.kind === "conflict" ? t("shared.phase.conflict", { base: need.conflict.base, files: list(need.conflict.files) }) : "";
  const p = h.phase;
  switch (p._tag) {
    case "working": {
      const action = t(`shared.action.${p.doing.action}`);
      const what = p.doing.label !== "" ? t("shared.phase.workingOn", { action, label: p.doing.label }) : t("shared.phase.working", { action });
      if (need?.kind === "quiet") return t("shared.phase.quiet", { what, span: phaseSpan });
      if (need?.kind === "retrying")
        return need.retry.of != null && need.retry.of !== 0
          ? t("shared.phase.retryingOf", { what, attempt: need.retry.attempt, of: need.retry.of })
          : t("shared.phase.retrying", { what, attempt: need.retry.attempt });
      return what;
    }
    case "done":
      return t("shared.phase.done", { conflict: conflictWords });
    case "failed":
      return t("shared.phase.failed");
    case "resting": {
      // No last run is a session that has not finished one yet (a new orchestrator), not one that broke off.
      const outcome = h.lastRun?.outcome;
      return outcome === undefined
        ? t("shared.phase.rested", { conflict: conflictWords })
        : t("shared.phase.resting", { last: t(`shared.outcome.${outcome}`), conflict: conflictWords });
    }
    default:
      return "";
  }
}
