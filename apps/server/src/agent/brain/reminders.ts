// What the agent reminded itself to do later, in reminders.json in its home. One missed while the agent was away runs once
// when it is back, not once per miss. Cron is in the machine's time zone.

import type { Tool } from "../loop/agent.ts";
import { Cron, Result, Schema } from "effect";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jsonOf } from "../../base/json.ts";
import { schemaTool } from "./tool.ts";
import type { Time } from "../../base/time.ts";
import type { CallbackLog } from "../../base/log.ts";

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
  if (Result.isFailure(parsed)) throw new Error(`cron 写得不对（${parsed.failure.message}）：五段，分 时 日 月 周，比如 0 9 * * 1-5 是工作日早上九点。`);
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
  const when = j.at ? localeTime(parseDate(j.at) ?? new Date(0)) + " 一次" : j.everyMinutes ? `每 ${j.everyMinutes} 分钟` : "cron " + j.cron;
  const next = nextRun(j);
  return "- " + j.id + "「" + j.name + "」" + when + "；下次 " + (next ? localeTime(next) : "（不会再跑）") + "\n  " + j.message;
}

export const dueMessage = (j: Reminder) => "【提醒「" + j.name + "」到点了（" + j.id + "）】\n" + j.message;

export class Reminders {
  readonly tools: Tool[];
  private readonly file: string;

  constructor(
    private readonly home: string,
    private readonly wake: (text: string) => void,
    /** The brain's Time: when a reminder is due. */
    private readonly time: Time,
    private readonly log: CallbackLog,
  ) {
    this.file = join(home, "reminders.json");
    this.tools = this.makeTools();
  }

  private load(): Reminder[] {
    if (!existsSync(this.file)) return [];
    return jsonOf(Schema.mutable(Schema.Array(ReminderSchema)))(readFileSync(this.file, "utf8"));
  }

  private store(reminders: readonly Reminder[]) {
    mkdirSync(this.home, { recursive: true });
    writeFileSync(this.file + ".tmp", JSON.stringify(reminders));
    renameSync(this.file + ".tmp", this.file);
  }

  /** At most once each. */
  tick(now = new Date(this.time.now())) {
    let due: Reminder[];
    try {
      const reminders = this.load();
      due = dueReminders(reminders, now);
      const isDue = new Set(due.map((j) => j.id));
      this.store(reminders.flatMap((j) => (!isDue.has(j.id) ? [j] : j.at ? [] : [{ ...j, lastRun: now.toISOString() }])));
    } catch (e) {
      this.log.error("agent: cannot claim due reminders:", e);
      return;
    }
    for (const j of due) this.wake(dueMessage(j));
  }

  private makeTools(): Tool[] {
    const add = schemaTool({
      name: "reminder",
      description:
        "定一个以后要做的事：到点时你会收到 message，像有人对你说的一样，然后去做。三选一：at（某个时刻，ISO 时间，比如 2026-10-13T09:00:00+08:00）、every_minutes（每隔几分钟）、cron（五段：分 时 日 月 周，本机时区）。message 写清楚到时候要做什么、做完告诉谁。",
      parameters: Schema.Struct({
        name: Schema.String,
        message: Schema.String,
        at: Schema.optionalKey(Schema.String),
        every_minutes: Schema.optionalKey(Schema.Number),
        cron: Schema.optionalKey(Schema.String),
      }),
      run: (p) => {
        if ([p.at, p.every_minutes, p.cron].filter((x) => x !== undefined && x !== null).length !== 1)
          throw new Error("at、every_minutes、cron 要正好给一个。");
        let at: Date | undefined;
        if (p.at != null) {
          at = parseDate(p.at);
          if (!at) throw new Error(`at 不是一个时间：${p.at}。用 ISO 格式，带时区。`);
        }
        if (p.every_minutes != null && !(p.every_minutes >= 1)) throw new Error("every_minutes 至少是 1。");
        if (p.cron != null) parseCron(p.cron);
        const now = new Date(this.time.now());
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
        return "定好了：\n" + describeReminder(reminder);
      },
    });
    const list = schemaTool({
      name: "list_reminders",
      description: "列出定好的事。",
      parameters: Schema.Struct({}),
      run: () => {
        const reminders = this.load();
        return reminders.length === 0 ? "没有定好的事。" : reminders.map(describeReminder).join("\n");
      },
    });
    const cancel = schemaTool({
      name: "cancel_reminder",
      description: "取消一件定好的事（id 从 list_reminders 看）。",
      parameters: Schema.Struct({ id: Schema.String }),
      run: (p) => {
        const reminders = this.load();
        const j = reminders.find((x) => x.id === p.id);
        if (!j) throw new Error(`没有 ${p.id}：先 list_reminders 看看。`);
        this.store(reminders.filter((x) => x !== j));
        return "取消了「" + j.name + "」。";
      },
    });
    return [add, list, cancel];
  }
}
