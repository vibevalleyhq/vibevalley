// What the agent reminded itself to do later, in reminders.json in its home. One missed while the agent was away runs once
// when it is back, not once per miss. Cron is in the machine's time zone.

import type { Tool } from "../loop/agent.ts";
import { Cron, Result, Schema } from "effect";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { schemaTool } from "./tool.ts";
import { reminders as reminderWords } from "./prompts.ts";

export interface Reminder {
  readonly id: string;
  readonly name: string;
  readonly message: string;
  /** One of: a cron expression, a moment (ISO), every so many minutes. */
  readonly cron?: string;
  readonly at?: string;
  readonly everyMinutes?: number;
  readonly created: string;
  readonly lastRun?: string;
}

const ReminderSchema: Schema.Codec<Reminder> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  message: Schema.String,
  cron: Schema.optionalKey(Schema.String),
  at: Schema.optionalKey(Schema.String),
  everyMinutes: Schema.optionalKey(Schema.Finite),
  created: Schema.String,
  lastRun: Schema.optionalKey(Schema.String),
});

const parseDate = (text: string) => {
  const d = new Date(text.trim());
  return Number.isNaN(d.getTime()) ? undefined : d;
};

export function parseCron(expr: string): Cron.Cron {
  const parsed = Cron.parse(expr);
  if (Result.isFailure(parsed)) throw new Error(reminderWords.badCron(parsed.failure.message));
  return parsed.success;
}

export function nextRun(reminder: Reminder): Date | undefined {
  const from = parseDate(reminder.lastRun || reminder.created) ?? new Date(0);
  if (reminder.at) return reminder.lastRun ? undefined : parseDate(reminder.at);
  if (reminder.everyMinutes) return new Date(from.getTime() + reminder.everyMinutes * 60_000);
  if (reminder.cron) {
    try {
      // Effect's Cron starts at the second after from.
      return Cron.next(parseCron(reminder.cron), from);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export const dueReminders = (reminders: readonly Reminder[], now: Date) =>
  reminders.filter((j) => {
    const next = nextRun(j);
    return next !== undefined && next.getTime() <= now.getTime();
  });

const pad = (n: number) => String(n).padStart(2, "0");
/** toLocaleString('zh-CN', { hour12: false }). */
const localeTime = (t: Date) => `${t.getFullYear()}/${t.getMonth() + 1}/${t.getDate()} ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;

export function describeReminder(j: Reminder): string {
  const when = j.at
    ? localeTime(parseDate(j.at) ?? new Date(0)) + reminderWords.onceNote
    : j.everyMinutes
      ? reminderWords.everyNote(j.everyMinutes)
      : "cron " + j.cron;
  const next = nextRun(j);
  return reminderWords.line(j.id, j.name, when, next ? localeTime(next) : undefined, j.message);
}

export const dueMessage = (j: Reminder) => reminderWords.due(j.id, j.name, j.message);

export class Reminders {
  readonly tools: Tool[];
  private readonly file: string;

  constructor(
    private readonly home: string,
    /** The brain's clock: when a reminder is due. */
    private readonly now: () => number,
  ) {
    this.file = join(home, "reminders.json");
    this.tools = this.makeTools();
  }

  private load(): Reminder[] {
    if (!existsSync(this.file)) return [];
    return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.mutable(Schema.Array(ReminderSchema))))(readFileSync(this.file, "utf8"));
  }

  private store(reminders: readonly Reminder[]) {
    mkdirSync(this.home, { recursive: true });
    writeFileSync(this.file + ".tmp", JSON.stringify(reminders));
    renameSync(this.file + ".tmp", this.file);
  }

  /** What came due, each claimed in the file first, so it comes due at most once. Throws when it cannot claim them. */
  tick(now = new Date(this.now())): string[] {
    const reminders = this.load();
    const due = dueReminders(reminders, now);
    const isDue = new Set(due.map((j) => j.id));
    this.store(reminders.flatMap((j) => (!isDue.has(j.id) ? [j] : j.at ? [] : [{ ...j, lastRun: now.toISOString() }])));
    return due.map(dueMessage);
  }

  private makeTools(): Tool[] {
    const add = schemaTool({
      name: "reminder",
      description: reminderWords.reminderDescription,
      parameters: Schema.Struct({
        name: Schema.String,
        message: Schema.String,
        at: Schema.optionalKey(Schema.String),
        every_minutes: Schema.optionalKey(Schema.Number),
        cron: Schema.optionalKey(Schema.String),
      }),
      run: (p) => {
        if ([p.at, p.every_minutes, p.cron].filter((x) => x !== undefined && x !== null).length !== 1) throw new Error(reminderWords.oneOfThree);
        let at: Date | undefined;
        if (p.at != null) {
          at = parseDate(p.at);
          if (!at) throw new Error(reminderWords.badAt(p.at));
        }
        if (p.every_minutes != null && !(p.every_minutes >= 1)) throw new Error(reminderWords.badEveryMinutes);
        if (p.cron != null) parseCron(p.cron);
        const now = new Date(this.now());
        const reminder: Reminder = {
          id: "reminder-" + now.getTime().toString(36),
          name: p.name,
          message: p.message,
          ...(p.cron != null ? { cron: p.cron } : {}),
          ...(at ? { at: at.toISOString() } : {}),
          ...(p.every_minutes != null ? { everyMinutes: p.every_minutes } : {}),
          created: now.toISOString(),
        };
        this.store([...this.load(), reminder]);
        return reminderWords.set + describeReminder(reminder);
      },
    });
    const list = schemaTool({
      name: "list_reminders",
      description: reminderWords.listDescription,
      parameters: Schema.Struct({}),
      run: () => {
        const reminders = this.load();
        return reminders.length === 0 ? reminderWords.none : reminders.map(describeReminder).join("\n");
      },
    });
    const cancel = schemaTool({
      name: "cancel_reminder",
      description: reminderWords.cancelDescription,
      parameters: Schema.Struct({ id: Schema.String }),
      run: (p) => {
        const reminders = this.load();
        const j = reminders.find((x) => x.id === p.id);
        if (!j) throw new Error(reminderWords.notFound(p.id));
        this.store(reminders.filter((x) => x !== j));
        return reminderWords.canceled(j.name);
      },
    });
    return [add, list, cancel];
  }
}
