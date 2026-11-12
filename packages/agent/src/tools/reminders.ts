import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { z } from "zod";

import { type Clock, systemClock, TaskGroup } from "@vibevalley/async";

import { type Cron, nextCron, parseCronExpression } from "../base/cron.ts";
import { reminders as reminderWords } from "../base/prompts.ts";
import { AgentFailed, messageOf, ToolFailed, toolFailed } from "../core/errors.ts";
import type { Tool } from "../core/loop.ts";
import { schemaTool } from "../core/tool.ts";
import { type AgentFs, agentFsOf } from "../infra/fs.ts";
import { type AgentLog, consoleLog } from "../infra/log.ts";

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

const ReminderSchema = z.object({
  id: z.string(),
  name: z.string(),
  message: z.string(),
  cron: z.exactOptional(z.string()),
  at: z.exactOptional(z.string()),
  everyMinutes: z.exactOptional(z.number()),
  created: z.string(),
  lastRun: z.exactOptional(z.string()),
}) satisfies z.ZodType<Reminder>;

const parseDate = (text: string) => {
  const d = new Date(text.trim());
  return Number.isNaN(d.getTime()) ? undefined : d;
};

/** The expression as a Cron, or why it is not one, in the model's words. */
export function parseCron(expr: string): { readonly ok: true; readonly cron: Cron } | { readonly ok: false; readonly problem: string } {
  const parsed = parseCronExpression(expr);
  return parsed.ok ? parsed : { ok: false, problem: reminderWords.badCron(parsed.problem) };
}

export function nextRun(reminder: Reminder): Date | undefined {
  const from = parseDate(reminder.lastRun || reminder.created) ?? new Date(0);
  if (reminder.at) return reminder.lastRun ? undefined : parseDate(reminder.at);
  if (reminder.everyMinutes != null && reminder.everyMinutes !== 0) return new Date(from.getTime() + reminder.everyMinutes * 60_000);
  // A cron starts at the second after from; one that does not parse never comes due.
  if (reminder.cron) {
    const parsed = parseCron(reminder.cron);
    return parsed.ok ? nextCron(parsed.cron, from) : undefined;
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
    : j.everyMinutes != null && j.everyMinutes !== 0
      ? reminderWords.everyNote(j.everyMinutes)
      : "cron " + j.cron;
  const next = nextRun(j);
  return reminderWords.line(j.id, j.name, when, next ? localeTime(next) : undefined, j.message);
}

const dueMessage = (j: Reminder) => reminderWords.due(j.id, j.name, j.message);

const ReminderList = z.array(ReminderSchema);

function buildReminder(
  p: {
    readonly name: string;
    readonly message: string;
    readonly at?: string;
    readonly every_minutes?: number;
    readonly cron?: string;
  },
  nowMs: number,
): Reminder | ToolFailed {
  if ([p.at, p.every_minutes, p.cron].filter((x) => x !== undefined && x !== null).length !== 1) return new ToolFailed(reminderWords.oneOfThree);
  let at: Date | undefined;
  if (p.at != null) {
    at = parseDate(p.at);
    if (!at) return new ToolFailed(reminderWords.badAt(p.at));
  }
  if (p.every_minutes != null && !(p.every_minutes >= 1)) return new ToolFailed(reminderWords.badEveryMinutes);
  if (p.cron != null) {
    const parsed = parseCron(p.cron);
    if (!parsed.ok) return new ToolFailed(parsed.problem);
  }
  const made = new Date(nowMs);
  return {
    id: "reminder-" + randomUUID(),
    name: p.name,
    message: p.message,
    ...(p.cron != null ? { cron: p.cron } : {}),
    ...(at ? { at: at.toISOString() } : {}),
    ...(p.every_minutes != null ? { everyMinutes: p.every_minutes } : {}),
    created: made.toISOString(),
  };
}

const afterClaim = (reminders: readonly Reminder[], due: readonly Reminder[], at: Date): Reminder[] => {
  const isDue = new Set(due.map((j) => j.id));
  const stamp = at.toISOString();
  return reminders.flatMap((j) => (!isDue.has(j.id) ? [j] : j.at ? [] : [{ ...j, lastRun: stamp }]));
};

/** How long a claim that could not be stored waits to be tried again. */
const retryClaimMs = 20_000;

interface Reminders {
  readonly tools: Tool[];
  /** What is due at now, each stored as run (or gone, once) before it is said, so it comes due at most once. Throws an
   * AgentFailed when the list cannot be read or the claim not stored. */
  readonly claimDue: (now: Date) => Promise<string[]>;
  /** No more wakes. */
  readonly close: () => Promise<void>;
}

export interface RemindersOptions {
  readonly fs?: AgentFs;
  /** When reminders come due, and when one was made. Default: the system clock. */
  readonly clock?: Clock;
  readonly log?: AgentLog;
}

/** The reminders in home: read once, then held. One background task sleeps until the next is due and hands what came due
 * to wake. */
export async function makeReminders(home: string, wake: (due: string[]) => void | Promise<void>, options: RemindersOptions = {}): Promise<Reminders> {
  const io = agentFsOf(options.fs);
  const clock = options.clock ?? systemClock;
  const log = options.log ?? consoleLog;
  const tasks = new TaskGroup({ name: "reminders", onError: (task, e) => log.error(`agent: reminders ${task} failed:`, e) });
  const file = join(home, "reminders.json");
  let list: Reminder[] = [];
  let unreadable: string | undefined;
  try {
    const text = await io.readTextIfExists(file);
    if (text !== undefined) unreadable = readList(text, (read) => (list = read));
  } catch (e) {
    if (!(e instanceof AgentFailed)) throw e;
    unreadable = e.message;
  }
  const heldAgent = (): Reminder[] => {
    if (unreadable !== undefined) throw new AgentFailed(unreadable);
    return list;
  };
  const heldTool = (): Reminder[] => {
    if (unreadable !== undefined) throw new ToolFailed(unreadable);
    return list;
  };

  const store = async (next: Reminder[]): Promise<void> => {
    const encoded = JSON.stringify(next);
    await io.makeDir(home);
    await io.writeText(file + ".tmp", encoded);
    await io.rename(file + ".tmp", file);
    list = next;
  };

  const claimDue = async (at: Date): Promise<string[]> => {
    const reminders = heldAgent();
    const due = dueReminders(reminders, at);
    if (due.length === 0) return [];
    await store(afterClaim(reminders, due, at));
    return due.map(dueMessage);
  };

  // One sleeping task: armed again whenever the list changes or one comes due.
  const arm = (): void => {
    if (unreadable !== undefined) return;
    const next = list
      .map(nextRun)
      .reduce<number | undefined>((soonest, d) => (d && (soonest === undefined || d.getTime() < soonest) ? d.getTime() : soonest), undefined);
    if (next === undefined) {
      tasks.keyed("wait", async () => undefined);
      return;
    }
    tasks.keyed("wait", async (signal) => {
      try {
        // Until the moment itself: the task starts once the one it replaces has ended.
        await clock.sleep(Math.max(0, next - clock.now()), signal);
        const due = await claimDue(new Date(clock.now()));
        await wake(due);
      } catch (e) {
        if (signal.aborted) throw e;
        log.error("agent: cannot claim due reminders:", e);
        await clock.sleep(retryClaimMs, signal);
      }
      arm();
    });
  };
  arm();

  const add = schemaTool({
    name: "reminder",
    description: reminderWords.reminderDescription,
    parameters: z.object({
      name: z.string(),
      message: z.string(),
      at: z.exactOptional(z.string()),
      every_minutes: z.exactOptional(z.number()),
      cron: z.exactOptional(z.string()),
    }),
    run: async (p) => {
      const built = buildReminder(p, clock.now());
      if (built instanceof ToolFailed) throw built;
      const reminders = heldTool();
      try {
        await store([...reminders, built]);
      } catch (e) {
        throw toolFailed(e);
      }
      arm();
      return reminderWords.set + describeReminder(built);
    },
  });
  const listTool = schemaTool({
    name: "list_reminders",
    description: reminderWords.listDescription,
    parameters: z.object({}),
    run: async () => {
      const reminders = heldTool();
      return reminders.length === 0 ? reminderWords.none : reminders.map(describeReminder).join("\n");
    },
  });
  const cancel = schemaTool({
    name: "cancel_reminder",
    description: reminderWords.cancelDescription,
    parameters: z.object({ id: z.string() }),
    run: async (p) => {
      const reminders = heldTool();
      const j = reminders.find((x) => x.id === p.id);
      if (!j) throw new ToolFailed(reminderWords.notFound(p.id));
      try {
        await store(reminders.filter((x) => x !== j));
      } catch (e) {
        throw toolFailed(e);
      }
      arm();
      return reminderWords.canceled(j.name);
    },
  });
  return { tools: [add, listTool, cancel], claimDue, close: () => tasks.close() };
}

/** The file's list handed to keep; what is wrong with it when it is not JSON or not a list of reminders. */
function readList(text: string, keep: (list: Reminder[]) => void): string | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return messageOf(e);
  }
  const parsed = ReminderList.safeParse(data);
  if (!parsed.success) return parsed.error.message;
  keep(parsed.data);
  return undefined;
}
