// When a schedule runs: what is due, whether it was missed, what a run leaves, and
// whether a schedule waits for the owner's yes.

import type { Schedule, ScheduleBy, ScheduleRequest } from "@vibevalley/protocol";
import { givenZone, minEveryMinutes, nextOf, nextRun, parseCron, scheduleTime } from "@vibevalley/protocol/rules";
import { Cron, DateTime } from "effect";

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

export function scheduleProblem(req: ScheduleRequest, now: number): string {
  if (req.name.trim() === "") return "定时要有个名字";
  if (req.text.trim() === "") return "定时要写到点了做什么";
  if (req.tz !== undefined && !givenZone(req.tz)) return "不认识这个时区：" + req.tz;
  const w = req.when;
  switch (w.kind) {
    case "once":
      return w.at > now ? "" : "一次性的时间要在以后";
    case "every":
      return w.minutes >= minEveryMinutes ? "" : `间隔至少 ${minEveryMinutes} 分钟`;
    case "daily":
      return scheduleTime.test(w.time) ? "" : "时间写成 HH:MM，比如 09:00：" + w.time;
    case "weekly": {
      if (!scheduleTime.test(w.time)) return "时间写成 HH:MM，比如 09:00：" + w.time;
      const days = w.days ?? [];
      return days.length > 0 && !days.some((d) => d < 0 || d > 6) ? "" : "每周的哪几天：0 到 6，0 是周日";
    }
    case "cron":
      return cronProblem(w.expr, now, req.tz);
  }
  return "不认识这种定时";
}

export function dueText(s: Schedule, missed: boolean): string {
  return "⏰ 定时「" + s.name + "」到点了" + (missed ? "（服务端没开着时错过的，补一次）" : "") + "：" + s.text;
}

// ── Cron ──
// Five fields, minute, hour, day of month, month and day of week, each a comma list of *, n or a-b, any with /step.
// Day of week is 0 to 7, both 0 and 7 Sunday. As in Vixie cron, when neither day field starts with *, a day matching
// either one is due; otherwise it must match both.

function cronProblem(expr: string, now: number, tz: string | undefined): string {
  const spec = parseCron(expr);
  if (typeof spec === "string") return spec;
  const timeZone = tz === undefined ? DateTime.zoneMakeLocal() : givenZone(tz)!;
  return nextOf(Cron.make({ ...spec, tz: timeZone }), now) === undefined ? "这个 cron 永远不会到点：" + expr : "";
}
