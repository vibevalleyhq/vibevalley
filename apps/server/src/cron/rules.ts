import { t } from "@vibevalley/i18n";
// When a cron runs: what is due, whether it was missed, what a run leaves, and
// whether a cron waits for the owner's yes.

import type { Cron, CronRequest } from "@vibevalley/protocol";
import { actsForOwner, type Actor } from "../base/actor.ts";
import { givenZone, minEveryMinutes, nextOf, nextRun, parseCron, cronTime } from "./when.ts";
import { Cron as EffectCron, DateTime } from "effect";

/** A run later than this after it was due was missed (the server was off), and says so. */
const missedAfterMs = 5 * 60_000;

/** Each once, however many runs it missed. */
export const dueCrons = (all: readonly Cron[], now: number) =>
  all.filter((s) => {
    const next = nextRun(s);
    return next !== undefined && next <= now;
  });

export const isMissed = (s: Cron, now: number) => now - (nextRun(s) ?? now) > missedAfterMs;

/** A one-off runs once: then it is off. */
export const afterRun = (s: Cron, now: number): Cron => ({ ...s, lastRun: now, enabled: s.when.kind === "once" ? false : s.enabled });

/**
 * Whether a cron waits for the owner's yes before it can come due. One set on the owner's word never waits. Without
 * it, only a one-off follow-up for the asker itself goes ahead: one that comes back again, or sends a helper (who spends
 * money) straight away, waits.
 */
export function needsOK(req: CronRequest, by: Actor): boolean {
  return !actsForOwner(by) && (req.when.kind !== "once" || (req.agent ?? "").trim() !== "");
}

export function cronProblem(req: CronRequest, now: number): string {
  if (req.name.trim() === "") return t("server.cron.problem.noName");
  if (req.text.trim() === "") return t("server.cron.problem.noText");
  if (req.tz !== undefined && !givenZone(req.tz)) return t("server.cron.problem.zone", { tz: req.tz });
  const w = req.when;
  switch (w.kind) {
    case "once":
      return w.at > now ? "" : t("server.cron.problem.past");
    case "every":
      return w.minutes >= minEveryMinutes ? "" : t("server.cron.problem.every", { min: minEveryMinutes });
    case "daily":
      return cronTime.test(w.time) ? "" : t("server.cron.problem.time", { time: w.time });
    case "weekly": {
      if (!cronTime.test(w.time)) return t("server.cron.problem.time", { time: w.time });
      const days = w.days ?? [];
      return days.length > 0 && !days.some((d) => !Number.isInteger(d) || d < 0 || d > 6) ? "" : t("server.cron.problem.days");
    }
    case "cron":
      return exprProblem(w.expr, now, req.tz);
  }
  return t("server.cron.problem.kind");
}

export function dueText(s: Cron, missed: boolean): string {
  return t("server.cron.due", { name: s.name, missed, text: s.text });
}

// Five fields, minute, hour, day of month, month and day of week, each a comma list of *, n or a-b, any with /step.
// Day of week is 0 to 7, both 0 and 7 Sunday. As in Vixie cron, when neither day field starts with *, a day matching
// either one is due; otherwise it must match both.

function exprProblem(expr: string, now: number, tz: string | undefined): string {
  const spec = parseCron(expr);
  if (typeof spec === "string") return spec;
  const timeZone = tz === undefined ? DateTime.zoneMakeLocal() : givenZone(tz)!;
  return nextOf(EffectCron.make({ ...spec, tz: timeZone }), now) === undefined ? t("server.cron.expr.never", { expr }) : "";
}
