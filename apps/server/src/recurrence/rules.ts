import { t } from "@vibevalley/i18n";
// When a recurrence runs: what is due, whether it was missed, what a run leaves, and
// whether a recurrence waits for the owner's yes.

import type { Recurrence, RecurrenceRequest } from "@vibevalley/protocol";
import { actsForOwner, type Actor } from "../base/actor.ts";
import { givenZone, minEveryMinutes, nextOf, nextRun, parseCron, recurrenceTime } from "./when.ts";
import { Cron, DateTime } from "effect";

/** A run later than this after it was due was missed (the server was off), and says so. */
const missedAfterMs = 5 * 60_000;

/** Each once, however many runs it missed. */
export const dueRecurrences = (all: readonly Recurrence[], now: number) =>
  all.filter((s) => {
    const next = nextRun(s);
    return next !== undefined && next <= now;
  });

export const isMissed = (s: Recurrence, now: number) => now - (nextRun(s) ?? now) > missedAfterMs;

/** A one-off runs once: then it is off. */
export const afterRun = (s: Recurrence, now: number): Recurrence => ({ ...s, lastRun: now, enabled: s.when.kind === "once" ? false : s.enabled });

/**
 * Whether a recurrence waits for the owner's yes before it can come due. One set on the owner's word never waits. Without
 * it, only a one-off follow-up for the asker itself goes ahead: one that comes back again, or sends a helper (who spends
 * money) straight away, waits.
 */
export function needsOK(req: RecurrenceRequest, by: Actor): boolean {
  return !actsForOwner(by) && (req.when.kind !== "once" || (req.agent ?? "").trim() !== "");
}

export function recurrenceProblem(req: RecurrenceRequest, now: number): string {
  if (req.name.trim() === "") return t("server.recurrence.problem.noName");
  if (req.text.trim() === "") return t("server.recurrence.problem.noText");
  if (req.tz !== undefined && !givenZone(req.tz)) return t("server.recurrence.problem.zone", { tz: req.tz });
  const w = req.when;
  switch (w.kind) {
    case "once":
      return w.at > now ? "" : t("server.recurrence.problem.past");
    case "every":
      return w.minutes >= minEveryMinutes ? "" : t("server.recurrence.problem.every", { min: minEveryMinutes });
    case "daily":
      return recurrenceTime.test(w.time) ? "" : t("server.recurrence.problem.time", { time: w.time });
    case "weekly": {
      if (!recurrenceTime.test(w.time)) return t("server.recurrence.problem.time", { time: w.time });
      const days = w.days ?? [];
      return days.length > 0 && !days.some((d) => !Number.isInteger(d) || d < 0 || d > 6) ? "" : t("server.recurrence.problem.days");
    }
    case "cron":
      return cronProblem(w.expr, now, req.tz);
  }
  return t("server.recurrence.problem.kind");
}

export function dueText(s: Recurrence, missed: boolean): string {
  return t("server.recurrence.due", { name: s.name, missed, text: s.text });
}

// Five fields, minute, hour, day of month, month and day of week, each a comma list of *, n or a-b, any with /step.
// Day of week is 0 to 7, both 0 and 7 Sunday. As in Vixie cron, when neither day field starts with *, a day matching
// either one is due; otherwise it must match both.

function cronProblem(expr: string, now: number, tz: string | undefined): string {
  const spec = parseCron(expr);
  if (typeof spec === "string") return spec;
  const timeZone = tz === undefined ? DateTime.zoneMakeLocal() : givenZone(tz)!;
  return nextOf(Cron.make({ ...spec, tz: timeZone }), now) === undefined ? t("server.recurrence.cron.never", { expr }) : "";
}
