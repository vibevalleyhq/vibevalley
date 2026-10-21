// When a schedule runs: what is due, whether it was missed, what a run leaves, and
// whether a schedule waits for the owner's yes.

import type { Schedule, ScheduleBy, ScheduleRequest } from "@vibevalley/protocol";
import { nextRun } from "@vibevalley/protocol/rules";

/** A run later than this after it was due was missed (the server was off), and says so. */
const missedAfterMs = 5 * 60_000;

/** Each once, however many runs it missed. */
export const dueSchedules = (all: readonly Schedule[], now: number) =>
  all.filter((s) => {
    const next = nextRun(s);
    return next !== undefined && next <= now;
  });

export const isMissed = (s: Schedule, now: number) => now - (nextRun(s) ?? now) > missedAfterMs;

/** A one-off runs once: then it is off. */
export const afterRun = (s: Schedule, now: number): Schedule => ({ ...s, lastRun: now, enabled: s.when.kind === "once" ? false : s.enabled });

/**
 * Whether a schedule waits for the owner's yes before it can come due. The owner's own never waits, nor the manager's when
 * the owner asked in this run. Without the owner, the manager may only set itself a one-off follow-up: one that comes back
 * again, or sends a helper (who spends money) straight away, waits.
 */
export function needsOK(req: ScheduleRequest, by: ScheduleBy, ownerInRun: boolean): boolean {
  switch (by) {
    case "owner":
      return false;
    case "manager":
      return ownerInRun ? false : req.when.kind !== "once" || (req.agent ?? "").trim() !== "";
  }
}
