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
function dayTitle(day: string, today: string, locale: Locale = currentLocale()): string | undefined {
  const at = midnightOf(day);
  if (Number.isNaN(at)) return undefined;
  const otherYear = day.slice(0, 4) !== today.slice(0, 4);
  return new Intl.DateTimeFormat(locale, { ...(otherYear ? { year: "numeric" } : {}), month: "long", day: "numeric", weekday: "short" }).format(at);
}

/** A page's title as the user reads it: a journal by its day (Nov 3 Tue), any other page by its title. */
export const titleFor = (title: string, day: string | undefined) => (day ? dayTitle(day, dayKey(Date.now())) : undefined) ?? title;

/** Days from today to day: 0 today, negative once it is past; undefined for a value that is not a day. */
export function daysUntil(day: string, today: string): number | undefined {
  const at = midnightOf(day);
  const now = midnightOf(today);
  if (Number.isNaN(at) || Number.isNaN(now)) return undefined;
  return Math.round((at - now) / 86_400_000);
}
