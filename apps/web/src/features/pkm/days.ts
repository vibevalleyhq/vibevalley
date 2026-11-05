import { currentLocale, type Locale } from "@vibevalley/i18n";

const two = (n: number) => String(n).padStart(2, "0");

export const dayKey = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
};

/** The local midnight of a day; NaN for a value that is not one. */
const midnightOf = (day: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(day.trim());
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : Number.NaN;
};

/** A journal's title: Nov 3 Mon (the year too when it is not this year's); undefined for a value that is not a day. */
export function dayTitle(day: string, today: string, locale: Locale = currentLocale()): string | undefined {
  const at = midnightOf(day);
  if (Number.isNaN(at)) return undefined;
  const otherYear = day.slice(0, 4) !== today.slice(0, 4);
  return new Intl.DateTimeFormat(locale, { ...(otherYear ? { year: "numeric" } : {}), month: "long", day: "numeric", weekday: "short" }).format(at);
}

/** A page's title as the owner reads it: a journal by its day (Nov 3 Tue), any other page by its title. */
export const titleFor = (title: string, day: string | undefined) => (day ? dayTitle(day, dayKey(Date.now())) : undefined) ?? title;

/** Days from today to day: 0 today, negative once it is past; undefined for a value that is not a day. */
export function daysUntil(day: string, today: string): number | undefined {
  const at = midnightOf(day);
  const now = midnightOf(today);
  if (Number.isNaN(at) || Number.isNaN(now)) return undefined;
  // To the nearest day: a day across a daylight saving change is 23 or 25 hours.
  return Math.round((at - now) / 86_400_000);
}

export interface MonthDay {
  readonly day: string;
  readonly inMonth: boolean;
}

/** The weeks of a month (month 0 is January), Monday first, filled out with the days of the months around it. */
export function monthWeeks(year: number, month: number): MonthDay[][] {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const cells = Math.ceil((lead + days) / 7) * 7;
  const weeks: MonthDay[][] = [];
  for (let i = 0; i < cells; i += 1) {
    const at = new Date(year, month, 1 - lead + i);
    if (i % 7 === 0) weeks.push([]);
    weeks.at(-1)?.push({ day: dayKey(at.getTime()), inMonth: at.getMonth() === month });
  }
  return weeks;
}

/** The month's name above the grid: Nov 2026. */
export const monthTitle = (year: number, month: number, locale: Locale = currentLocale()) =>
  new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(new Date(year, month, 1));

/** The weekdays over the grid's columns, Monday first: Mon..Sun. */
export const weekdayNames = (locale: Locale = currentLocale()) =>
  Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(locale, { weekday: "narrow" }).format(new Date(2024, 0, 1 + i)));
