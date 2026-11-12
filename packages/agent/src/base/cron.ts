/**
 * Cron expressions as reminders have always read them (the rules of Effect's Cron, which they were first written for):
 * five fields, or six with seconds first; `*`, lists, ranges, steps and month and weekday names; times are this
 * machine's; day of month and weekday are either-or unless one of them is a wildcard.
 */
export interface Cron {
  readonly seconds: ReadonlySet<number>;
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly days: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly weekdays: ReadonlySet<number>;
  /** Both day of month and weekday must match. */
  readonly and: boolean;
}

interface Field {
  readonly min: number;
  readonly max: number;
  readonly aliases?: Readonly<Record<string, number>>;
  readonly normalize?: (n: number) => number;
}

const second: Field = { min: 0, max: 59 };
const minute: Field = { min: 0, max: 59 };
const hour: Field = { min: 0, max: 23 };
const day: Field = { min: 1, max: 31 };
const month: Field = {
  min: 1,
  max: 12,
  aliases: { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 },
};
const weekday: Field = {
  min: 0,
  max: 7,
  normalize: (n) => (n === 7 ? 0 : n),
  aliases: { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 },
};

const decimal = /^\d+$/u;

const valueOf = (text: string, aliases?: Readonly<Record<string, number>>) => aliases?.[text.toLowerCase()] ?? (decimal.test(text) ? Number(text) : Number.NaN);

/** An empty set is every value. */
function parseField(input: string, f: Field): { readonly values: Set<number>; readonly wildcard: boolean } | string {
  const values = new Set<number>();
  const normalize = f.normalize ?? ((n: number) => n);
  const parts = input.split(",");
  const stepOf = (part: string): [string, number | undefined] => {
    const at = part.indexOf("/");
    if (at < 0) return [part, undefined];
    const step = part.slice(at + 1);
    return [part.slice(0, at), decimal.test(step) ? Number(step) : Number.NaN];
  };
  const [firstRaw, firstStep] = stepOf(parts[0] ?? "");
  const wildcard = firstRaw === "*";
  const every = wildcard && (firstStep === undefined || firstStep === 1);
  const add = (n: number) => {
    if (!every) values.add(normalize(n));
  };
  for (const [index, part] of parts.entries()) {
    const [raw, step] = index === 0 ? [firstRaw, firstStep] : stepOf(part);
    if (step !== undefined) {
      if (!Number.isInteger(step)) return "Expected step value to be a positive integer";
      if (step < 1) return "Expected step value to be greater than 0";
      if (step > f.max) return `Expected step value to be less than or equal to ${f.max}`;
    }
    if (raw === "*") {
      if (index === 0 && (step === undefined || step === 1)) continue;
      for (let i = f.min; i <= f.max; i += step ?? 1) add(i);
      continue;
    }
    const dash = raw.indexOf("-");
    const left = valueOf(dash < 0 ? raw : raw.slice(0, dash), f.aliases);
    const right = dash < 0 ? undefined : valueOf(raw.slice(dash + 1), f.aliases);
    if (!Number.isInteger(left)) return "Expected a positive integer";
    if (left < f.min || left > f.max) return `Expected a value between ${f.min} and ${f.max}`;
    if (right === undefined) {
      for (let i = left; i <= (step === undefined ? left : f.max); i += step ?? 1) add(i);
      continue;
    }
    if (!Number.isInteger(right)) return "Expected a positive integer";
    if (right < f.min || right > f.max) return `Expected a value between ${f.min} and ${f.max}`;
    if (left > right) return "Invalid value range";
    for (let i = left; i <= right; i += step ?? 1) add(i);
  }
  return { values, wildcard };
}

/** The expression, or why it is not one. */
export function parseCronExpression(expr: string): { readonly ok: true; readonly cron: Cron } | { readonly ok: false; readonly problem: string } {
  const segments = expr
    .trim()
    .split(/\s+/u)
    .filter((s) => s !== "");
  if (segments.length !== 5 && segments.length !== 6) return { ok: false, problem: "Invalid number of segments in cron expression" };
  if (segments.length === 5) segments.unshift("0");
  const [s, m, h, dm, mo, wd] = segments;
  const seconds = parseField(s ?? "", second);
  if (typeof seconds === "string") return { ok: false, problem: seconds };
  const minutes = parseField(m ?? "", minute);
  if (typeof minutes === "string") return { ok: false, problem: minutes };
  const hours = parseField(h ?? "", hour);
  if (typeof hours === "string") return { ok: false, problem: hours };
  const days = parseField(dm ?? "", day);
  if (typeof days === "string") return { ok: false, problem: days };
  const months = parseField(mo ?? "", month);
  if (typeof months === "string") return { ok: false, problem: months };
  const weekdays = parseField(wd ?? "", weekday);
  if (typeof weekdays === "string") return { ok: false, problem: weekdays };
  return {
    ok: true,
    cron: {
      seconds: seconds.values,
      minutes: minutes.values,
      hours: hours.values,
      days: days.values,
      months: months.values,
      weekdays: weekdays.values,
      and: (days.wildcard || weekdays.wildcard) && days.values.size !== 0 && weekdays.values.size !== 0,
    },
  };
}

const has = (set: ReadonlySet<number>, n: number) => set.size === 0 || set.has(n);

function dayMatches(c: Cron, d: Date): boolean {
  if (c.days.size === 0 && c.weekdays.size === 0) return true;
  if (c.and) return has(c.days, d.getDate()) && has(c.weekdays, d.getDay());
  if (c.weekdays.size === 0) return c.days.has(d.getDate());
  if (c.days.size === 0) return c.weekdays.has(d.getDay());
  return c.days.has(d.getDate()) || c.weekdays.has(d.getDay());
}

/** How far ahead next looks before it says there is none (an expression like Feb 30 never comes). */
const horizonYears = 8;

/** The first time after from (from the second after it) the expression matches; undefined when none comes. */
export function nextCron(c: Cron, from: Date): Date | undefined {
  const d = new Date(Math.floor(from.getTime() / 1000) * 1000 + 1000);
  const limit = from.getFullYear() + horizonYears;
  while (d.getFullYear() <= limit) {
    if (!has(c.months, d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(c, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!has(c.hours, d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!has(c.minutes, d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    if (!has(c.seconds, d.getSeconds())) {
      d.setSeconds(d.getSeconds() + 1, 0);
      continue;
    }
    return d;
  }
  return undefined;
}
