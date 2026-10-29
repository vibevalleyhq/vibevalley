import { t } from "@vibevalley/i18n";
import { type Crop, dayMs } from "@vibevalley/protocol";

export const two = (n: number) => String(n).padStart(2, "0");

/** The server counts commits by the same day. */
const dayKey = (d: Date) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;

export interface CalendarDay {
  readonly day: string;
  readonly at: Date;
  readonly commits: number;
  /** 0 bare, 1 seeded, 2 sprouting, 3 leafy, 4 in flower. */
  readonly level: number;
  readonly future: boolean;
}

export interface Calendar {
  readonly weeks: readonly (readonly CalendarDay[])[];
  readonly months: readonly { readonly week: number; readonly label: string }[];
}

/** By the calendar: a day is not always 24 hours. */
const plusDays = (from: Date, offset: number) => new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset);

/** Monday first, the last column this week; levels go against the year's 95th percentile, so one huge day does not leave
 * the rest bare. */
export function calendarOf(days: readonly { day: string; commits: number }[], now: Date, weeks = 53): Calendar {
  const commits = new Map(days.map((d) => [d.day, Math.round(d.commits)]));
  const today = plusDays(now, 0);
  const weekday = (today.getDay() + 6) % 7;
  const start = plusDays(plusDays(today, -weekday), -(weeks - 1) * 7);
  const busyDays = [...commits.values()].filter((n) => n > 0).sort((a, b) => a - b);
  const q = busyDays.length === 0 ? 0 : busyDays[Math.min(busyDays.length - 1, Math.max(0, Math.floor(0.95 * busyDays.length)))]!;
  const busy = q < 1 ? 1 : q;
  const level = (n: number) => (n <= 0 ? 0 : Math.min(4, Math.max(0, Math.ceil((4 * n) / busy))));
  const grid: CalendarDay[][] = [];
  const months: { week: number; label: string }[] = [];
  for (let w = 0; w < weeks; w++) {
    const column: CalendarDay[] = [];
    for (let d = 0; d < 7; d++) {
      const at = plusDays(start, w * 7 + d);
      const day = dayKey(at);
      const n = commits.get(day) ?? 0;
      column.push({ day, at, commits: n, level: level(n), future: at > today });
      if ((at.getDate() === 1 || (w === 0 && d === 0)) && months.at(-1)?.week !== w)
        months.push({ week: w, label: t("web.base.time.month", { month: at.getMonth() + 1 }) });
    }
    grid.push(column);
  }
  if (months.length > 1 && months[1]!.week - months[0]!.week < 3) months.shift();
  return { weeks: grid, months };
}

export interface Streaks {
  readonly total: number;
  readonly days: number;
  readonly longest: number;
  /** The current run goes to today, or to yesterday if none yet today. */
  readonly current: number;
  /** The latest, on a tie. */
  readonly busiest?: { readonly day: string; readonly commits: number };
}

export function streaksOf(calendar: Calendar): Streaks {
  const days = calendar.weeks.flat().filter((d) => !d.future);
  let longest = 0;
  let run = 0;
  let busiest: { day: string; commits: number } | undefined;
  for (const d of days) {
    run = d.commits > 0 ? run + 1 : 0;
    if (run > longest) longest = run;
    if (d.commits > 0 && d.commits >= (busiest?.commits ?? 0)) busiest = { day: d.day, commits: d.commits };
  }
  let current = 0;
  const last = days.at(-1);
  for (let i = days.length - 1 - (last && last.commits === 0 ? 1 : 0); i >= 0 && days[i]!.commits > 0; i--) current++;
  return { total: days.reduce((n, d) => n + d.commits, 0), days: days.filter((d) => d.commits > 0).length, longest, current, ...(busiest ? { busiest } : {}) };
}

export interface Growth {
  readonly crop: Crop;
  readonly label: string;
}

export function growthOf(last: number | undefined, now: number): Growth {
  if (last === undefined) return { crop: "empty", label: t("web.project.project.growth.empty") };
  const days = (now - last) / dayMs;
  if (days <= 1) return { crop: "flowering", label: t("web.project.project.growth.flowering") };
  if (days <= 7) return { crop: "leafy", label: t("web.project.project.growth.leafy") };
  if (days <= 30) return { crop: "sprout", label: t("web.project.project.growth.sprout") };
  if (days <= 90) return { crop: "dry", label: t("web.project.project.growth.dry") };
  return { crop: "withered", label: t("web.project.project.growth.withered") };
}

export function since(at: number, now: number) {
  const minutes = Math.max(0, (now - at) / 60000);
  if (minutes < 2) return t("web.base.time.justNow");
  if (minutes < 60) return t("web.base.time.minutesAgo", { m: Math.round(minutes) });
  const hours = minutes / 60;
  if (hours < 24) return t("web.base.time.hoursAgo", { h: Math.round(hours) });
  const days = hours / 24;
  if (days < 45) return t("web.base.time.daysAgo", { d: Math.round(days) });
  if (days < 365) return t("web.base.time.monthsAgo", { m: Math.round(days / 30) });
  return t("web.base.time.yearsAgo", { y: (days / 365).toFixed(1) });
}

export const dateText = (at: number) => {
  const d = new Date(Math.round(at));
  return t("web.base.time.date", { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() });
};

export const dayText = (d: Date) =>
  t("web.base.time.day", { m: d.getMonth() + 1, d: d.getDate(), weekday: t(`web.base.time.weekdays.${d.getDay() as Weekday}`) });

/** A day of the week as Date.getDay counts it, Sunday first. */
type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
