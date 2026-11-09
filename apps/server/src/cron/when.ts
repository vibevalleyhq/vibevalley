import { Cron as EffectCron, DateTime, Option } from "effect";
// When a cron runs and how it is said. The next run is the first matching minute strictly after the last run.

import { list, t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { actsForOwner, type Actor } from "#/base/actor.ts";
const weekdayKeys = ["0", "1", "2", "3", "4", "5", "6"] as const;
/** A day of the week by its number, Sunday 0. */
const weekday = (d: number) => t(`server.cron.weekdays.${weekdayKeys[d] ?? "0"}`);
const minEveryMinutes = 1;

const cronTime = /^([01]?\d|2[0-3]):([0-5]\d)$/u;

const givenOffset = /^(?:GMT)?([+-])([01]\d|2[0-3])(?::?([0-5]\d))?$/u;

const fixed = (sign: string, hours: string, minutes: string | undefined) =>
  DateTime.zoneMakeOffset((sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes ?? 0)) * 60_000);

const named = (tz: string) => (tz === "" || tz === "Local" ? undefined : Option.getOrUndefined(DateTime.zoneMakeNamed(tz)));

/** One parser for accepted, scheduled and displayed zones: IANA or a fixed offset, optionally prefixed with GMT. */
export function givenZone(tz: string): DateTime.TimeZone | undefined {
  const m = givenOffset.exec(tz);
  if (m?.[1] && m[2]) return fixed(m[1], m[2], m[3]);
  return tz.startsWith("+") || tz.startsWith("-") ? undefined : named(tz);
}

/** The first run of the cron strictly after from. */
function nextOf(cron: EffectCron.Cron, from: number): number | undefined {
  try {
    return EffectCron.next(cron, from).getTime();
  } catch {
    return undefined;
  }
}

export function nextRun(s: T.Cron): number | undefined {
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
}

function daily(from: number, at: string, days: readonly number[], tz: string): number | undefined {
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

export function whenText(when: T.CronWhen, tz: string): string {
  switch (when.kind) {
    case "once":
      return t("server.cron.when.once", { clock: clock(when.at, tz) });
    case "every":
      return when.minutes % 60 === 0 ? t("server.cron.when.hours", { n: when.minutes / 60 }) : t("server.cron.when.minutes", { n: when.minutes });
    case "daily":
      return t("server.cron.when.daily", { time: when.time });
    case "weekly": {
      const days = [...new Set(when.days)].toSorted((a, b) => a - b);
      return t("server.cron.when.weekly", { days: list(days.map((d) => (d >= 0 && d < 7 ? weekday(d) : String(d)))), time: when.time });
    }
    case "cron":
      return cronText(when.expr);
  }
}

export function nextText(s: T.Cron): string {
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
  { min: 0, max: 59, key: "0" },
  { min: 0, max: 23, key: "1" },
  { min: 1, max: 31, key: "2" },
  { min: 1, max: 12, key: "3" },
  { min: 0, max: 7, key: "4" },
] as const;

/** Go's strconv.Atoi: an optional sign and ASCII digits, within 64 bits. */
function atoi(s: string): number | undefined {
  if (!/^[+-]?\d+$/u.test(s)) return undefined;
  const n = Number(s);
  return Math.abs(n) <= 9.223372036854776e18 ? n : undefined;
}

/** Go's strings.Fields: split on Unicode white space, as Go's unicode.IsSpace has it. */
const fields = (s: string) => s.split(/[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u).filter((f) => f !== "");

function cronField(field: string, spec: (typeof cronFields)[number]): Set<number> | string {
  const { min: lo, max: hi, key } = spec;
  const bad = t("server.cron.expr.badField", { name: t(`server.cron.expr.fields.${key}`), field });
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

function parseCron(expr: string): CronSpec | string {
  const [f0, f1, f2, f3, f4, ...rest] = fields(expr);
  if (f0 === undefined || f1 === undefined || f2 === undefined || f3 === undefined || f4 === undefined || rest.length > 0)
    return t("server.cron.expr.fiveFields");
  const b0 = cronField(f0, cronFields[0]);
  if (typeof b0 === "string") return b0;
  const b1 = cronField(f1, cronFields[1]);
  if (typeof b1 === "string") return b1;
  const b2 = cronField(f2, cronFields[2]);
  if (typeof b2 === "string") return b2;
  const b3 = cronField(f3, cronFields[3]);
  if (typeof b3 === "string") return b3;
  const dow = cronField(f4, cronFields[4]);
  if (typeof dow === "string") return dow;
  if (dow.delete(7)) dow.add(0);
  return { minutes: b0, hours: b1, days: b2, months: b3, weekdays: dow, and: f2.startsWith("*") || f4.startsWith("*") };
}

function cronNext(from: number, expr: string, tz: string): number | undefined {
  const spec = parseCron(expr);
  const timeZone = givenZone(tz);
  if (typeof spec === "string" || !timeZone) return undefined;
  return nextOf(EffectCron.make({ ...spec, tz: timeZone }), from);
}

/** The common shapes in words, the rest as the expression itself. */
function cronText(expr: string): string {
  const [f0 = "", f1 = "", f2 = "", f3 = "", f4 = ""] = fields(expr);
  if (typeof parseCron(expr) === "string") return t("server.cron.when.cron", { expr });
  const mi = atoi(f0);
  const h = atoi(f1);
  const clock = mi !== undefined && h !== undefined ? String(100 + h).slice(1) + ":" + String(100 + mi).slice(1) : "";
  if (clock !== "" && f2 === "*" && f3 === "*") {
    switch (f4) {
      case "*":
        return t("server.cron.when.daily", { time: clock });
      case "1-5":
        return t("server.cron.when.weekdays", { time: clock });
      case "0,6":
      case "6,0":
      case "6,7":
      case "6-7":
        return t("server.cron.when.weekend", { time: clock });
      case "":
        break;
    }
    const days: number[] = [];
    for (const d of f4.split(",")) {
      const n = atoi(d);
      if (n === undefined) return t("server.cron.when.cron", { expr });
      days.push(n % 7);
    }
    const sorted = [...new Set(days)].toSorted((a, b) => a - b);
    return t("server.cron.when.weekly", { days: list(sorted.map(weekday)), time: clock });
  }
  if (clock !== "" && f3 === "*" && f4 === "*") {
    const d = atoi(f2);
    return d !== undefined ? t("server.cron.when.monthly", { day: d, time: clock }) : t("server.cron.when.cron", { expr });
  }
  if (mi !== undefined && f1 === "*" && f2 === "*" && f3 === "*" && f4 === "*") return t("server.cron.when.hourly", { minute: mi });
  return t("server.cron.when.cron", { expr });
}

/** A run later than this after it was due was missed (the server was off), and says so. */
const missedAfterMs = 5 * 60_000;

/** Each once, however many runs it missed. */
export const dueCrons = (all: readonly T.Cron[], now: number) =>
  all.filter((s) => {
    const next = nextRun(s);
    return next !== undefined && next <= now;
  });

export const isMissed = (s: T.Cron, now: number) => now - (nextRun(s) ?? now) > missedAfterMs;

/** A one-off runs once: then it is off. */
export const afterRun = (s: T.Cron, now: number): T.Cron => ({ ...s, lastRun: now, enabled: s.when.kind === "once" ? false : s.enabled });

/** Whether a cron waits for the owner's yes before it can come due. One set on the owner's word never waits. */
export function needsOK(req: T.CronRequest, by: Actor): boolean {
  return !actsForOwner(by) && (req.when.kind !== "once" || (req.agent ?? "").trim() !== "");
}

export function cronProblem(req: T.CronRequest, now: number): string {
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
      const days = w.days;
      return days.length > 0 && !days.some((d) => !Number.isInteger(d) || d < 0 || d > 6) ? "" : t("server.cron.problem.days");
    }
    case "cron":
      return exprProblem(w.expr, now, req.tz);
  }
}

export function dueText(s: T.Cron, missed: boolean): string {
  return t("server.cron.due", { name: s.name, missed, text: s.text });
}

// Five fields, minute, hour, day of month, month and day of week, each a comma list of *, n or a-b, any with /step.

function exprProblem(expr: string, now: number, tz: string | undefined): string {
  const spec = parseCron(expr);
  if (typeof spec === "string") return spec;
  const timeZone = tz === undefined ? DateTime.zoneMakeLocal() : (givenZone(tz) ?? DateTime.zoneMakeLocal());
  return nextOf(EffectCron.make({ ...spec, tz: timeZone }), now) === undefined ? t("server.cron.expr.never", { expr }) : "";
}
