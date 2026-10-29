import { list, t } from "@vibevalley/i18n";
// When a cron runs and how it is said. The next run is
// the first matching minute strictly after the last run. A wall time skipped by a clock change is taken as the same time
// before the change (02:30 on a spring-forward night is 03:30); a repeated one is its first occurrence.

import { Cron as EffectCron, DateTime, Option } from "effect";
import type { Cron, CronWhen } from "@vibevalley/protocol";

/** A day of the week by its number, Sunday 0. */
const weekday = (d: number) => t(`server.cron.weekdays.${d as 0 | 1 | 2 | 3 | 4 | 5 | 6}`);
export const minEveryMinutes = 1;

export const cronTime = /^([01]?\d|2[0-3]):([0-5]\d)$/;

const givenOffset = /^(?:GMT)?([+-])([01]\d|2[0-3])(?::?([0-5]\d))?$/;

const fixed = (sign: string, hours: string, minutes: string | undefined) =>
  DateTime.zoneMakeOffset((sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes ?? 0)) * 60_000);

const named = (tz: string) => (tz === "" || tz === "Local" ? undefined : Option.getOrUndefined(DateTime.zoneMakeNamed(tz)));

/** One parser for accepted, scheduled and displayed zones: IANA or a fixed offset, optionally prefixed with GMT. */
export function givenZone(tz: string): DateTime.TimeZone | undefined {
  const m = givenOffset.exec(tz);
  if (m) return fixed(m[1]!, m[2]!, m[3]);
  return tz.startsWith("+") || tz.startsWith("-") ? undefined : named(tz);
}

/**
 * The first run of the cron strictly after from. Cron walks the wall clock: a time a clock change skipped is taken as
 * the same time before the change (02:30 on a spring-forward night is 03:30), a repeated one is its first occurrence;
 * none at all (30 February) is undefined.
 */
export function nextOf(cron: EffectCron.Cron, from: number): number | undefined {
  try {
    return EffectCron.next(cron, new Date(from)).getTime();
  } catch {
    return undefined;
  }
}

export function nextRun(s: Cron): number | undefined {
  if (!s.enabled) return undefined;
  const from = s.lastRun ?? s.created;
  const w = s.when;
  switch (w.kind) {
    case "once":
      return s.lastRun === undefined ? w.at : undefined;
    case "every":
      // A fraction of a millisecond is due at the next whole one.
      return Math.ceil(from + w.minutes * 60_000);
    case "daily":
      return daily(from, w.time, [], s.tz);
    case "weekly":
      return daily(from, w.time, w.days, s.tz);
    case "cron":
      return cronNext(from, w.expr, s.tz);
  }
  return undefined;
}

export function daily(from: number, at: string, days: readonly number[], tz: string): number | undefined {
  const m = cronTime.exec(at);
  const timeZone = givenZone(tz);
  if (!m || !timeZone) return undefined;
  // Cron reads only 0 to 7 (7 is Sunday again); anything else is no cron.
  if (days.some((d) => d < 0 || d > 7)) return undefined;
  const cron = EffectCron.make({ minutes: [Number(m[2])], hours: [Number(m[1])], days: [], months: [], weekdays: days.map((d) => d % 7), tz: timeZone });
  return nextOf(cron, from);
}

/** A zone that is none is read as UTC. */
function clock(at: number, tz: string): string {
  const w = DateTime.toParts(DateTime.makeZonedUnsafe(at, { timeZone: givenZone(tz) ?? DateTime.zoneMakeOffset(0) }));
  const two = (n: number) => String(n).padStart(2, "0");
  return `${w.month}/${w.day} ${two(w.hour)}:${two(w.minute)}`;
}

export function whenText(when: CronWhen, tz: string): string {
  switch (when.kind) {
    case "once":
      return t("server.cron.when.once", { clock: clock(when.at, tz) });
    case "every":
      return when.minutes % 60 === 0 ? t("server.cron.when.hours", { n: when.minutes / 60 }) : t("server.cron.when.minutes", { n: when.minutes });
    case "daily":
      return t("server.cron.when.daily", { time: when.time });
    case "weekly": {
      const days = [...new Set(when.days)].sort((a, b) => a - b);
      return t("server.cron.when.weekly", { days: list(days.map((d) => (d >= 0 && d < 7 ? weekday(d) : String(d)))), time: when.time });
    }
    case "cron":
      return cronText(when.expr);
  }
  return "";
}

export function nextText(s: Cron): string {
  const next = nextRun(s);
  if (next !== undefined) return clock(next, s.tz);
  if (s.enabled) return t("server.cron.next.never");
  if (s.pending) return t("server.cron.next.pending");
  if (s.when.kind === "once" && s.lastRun !== undefined) return t("server.cron.next.done");
  return t("server.cron.next.off");
}

/** The fields as sets; the day fields are both due (and) when either starts with *, else either one is. */
interface CronSpec {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly days: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly weekdays: ReadonlySet<number>;
  readonly and: boolean;
}

/** The bounds of the five fields; server.cron.expr.fields names them, in this order. */
const cronFields = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 7 },
] as const;

/** Go's strconv.Atoi: an optional sign and ASCII digits, within 64 bits. */
function atoi(s: string): number | undefined {
  if (!/^[+-]?\d+$/.test(s)) return undefined;
  const n = Number(s);
  return Math.abs(n) <= 9.223372036854776e18 ? n : undefined;
}

/** Go's strings.Fields: split on Unicode white space, as Go's unicode.IsSpace has it. */
export const fields = (s: string) => s.split(/[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/).filter((f) => f !== "");

function cronField(field: string, i: number): Set<number> | string {
  const { min: lo, max: hi } = cronFields[i]!;
  const bad = t("server.cron.expr.badField", { name: t(`server.cron.expr.fields.${i as 0 | 1 | 2 | 3 | 4}`), field });
  const bits = new Set<number>();
  for (const item of field.split(",")) {
    const slash = item.indexOf("/");
    const span = slash < 0 ? item : item.slice(0, slash);
    let step = 1;
    if (slash >= 0) {
      const n = atoi(item.slice(slash + 1));
      if (n === undefined || n < 1) return bad;
      step = n;
    }
    let from: number = lo;
    let to: number = hi;
    if (span !== "*") {
      const dash = span.indexOf("-");
      const x = atoi(dash < 0 ? span : span.slice(0, dash));
      if (x === undefined) return bad;
      from = to = x;
      if (dash >= 0) {
        const y = atoi(span.slice(dash + 1));
        if (y === undefined) return bad;
        to = y;
      } else if (slash >= 0) to = hi;
    }
    if (from < lo || to > hi || from > to) return bad;
    for (let v = from; v <= to; v += step) bits.add(v);
  }
  return bits;
}

export function parseCron(expr: string): CronSpec | string {
  const f = fields(expr);
  if (f.length !== 5) return t("server.cron.expr.fiveFields");
  const bits: Set<number>[] = [];
  for (let i = 0; i < 5; i++) {
    const b = cronField(f[i]!, i);
    if (typeof b === "string") return b;
    bits.push(b);
  }
  const dow = bits[4]!;
  if (dow.delete(7)) dow.add(0);
  return { minutes: bits[0]!, hours: bits[1]!, days: bits[2]!, months: bits[3]!, weekdays: dow, and: f[2]!.startsWith("*") || f[4]!.startsWith("*") };
}

function cronNext(from: number, expr: string, tz: string): number | undefined {
  const spec = parseCron(expr);
  const timeZone = givenZone(tz);
  if (typeof spec === "string" || !timeZone) return undefined;
  return nextOf(EffectCron.make({ ...spec, tz: timeZone }), from);
}

/** The common shapes in words, the rest as the expression itself. */
export function cronText(expr: string): string {
  const f = fields(expr);
  if (typeof parseCron(expr) === "string") return t("server.cron.when.cron", { expr });
  const mi = atoi(f[0]!);
  const h = atoi(f[1]!);
  const clock = mi !== undefined && h !== undefined ? String(100 + h).slice(1) + ":" + String(100 + mi).slice(1) : "";
  if (clock !== "" && f[2] === "*" && f[3] === "*") {
    switch (f[4]) {
      case "*":
        return t("server.cron.when.daily", { time: clock });
      case "1-5":
        return t("server.cron.when.weekdays", { time: clock });
      case "0,6":
      case "6,0":
      case "6,7":
      case "6-7":
        return t("server.cron.when.weekend", { time: clock });
      case undefined:
        break;
    }
    const days: number[] = [];
    for (const d of f[4]!.split(",")) {
      const n = atoi(d);
      if (n === undefined) return t("server.cron.when.cron", { expr });
      days.push(n % 7);
    }
    const sorted = [...new Set(days)].sort((a, b) => a - b);
    return t("server.cron.when.weekly", { days: list(sorted.map(weekday)), time: clock });
  }
  if (clock !== "" && f[3] === "*" && f[4] === "*") {
    const d = atoi(f[2]!);
    return d !== undefined ? t("server.cron.when.monthly", { day: d, time: clock }) : t("server.cron.when.cron", { expr });
  }
  if (mi !== undefined && f[1] === "*" && f[2] === "*" && f[3] === "*" && f[4] === "*") return t("server.cron.when.hourly", { minute: mi });
  return t("server.cron.when.cron", { expr });
}
