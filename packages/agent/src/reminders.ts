// What the agent reminded itself to do later, in reminders.json in its home. One missed while the agent was away runs once
// when it is back, not once per miss. Cron is in the machine's time zone. The list is held in memory and written when it
// changes; a fiber sleeps until the next one is due.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Cron, Effect, FiberHandle, Option, Result, Schema, type Scope } from "effect";

import { agentFailed, type AgentFailed } from "./core/errors.ts";
import type { Tool } from "./core/loop.ts";
import { schemaTool } from "./core/tool.ts";
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

/** The expression as Effect's Cron, or why it is not one, in the model's words. */
export const parseCron = (expr: string): Result.Result<Cron.Cron, string> => Result.mapError(Cron.parse(expr), (e) => reminderWords.badCron(e.message));

export function nextRun(reminder: Reminder): Date | undefined {
  const from = parseDate(reminder.lastRun || reminder.created) ?? new Date(0);
  if (reminder.at) return reminder.lastRun ? undefined : parseDate(reminder.at);
  if (reminder.everyMinutes != null && reminder.everyMinutes !== 0) return new Date(from.getTime() + reminder.everyMinutes * 60_000);
  // Effect's Cron starts at the second after from; one that does not parse never comes due.
  if (reminder.cron) return Option.getOrUndefined(Result.getSuccess(Result.map(parseCron(reminder.cron), (c) => Cron.next(c, from))));
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

const ReminderList = Schema.fromJsonString(Schema.mutable(Schema.Array(ReminderSchema)));

/** How long a claim that could not be stored waits to be tried again. */
const retryClaimMs = 20_000;

export interface Reminders {
  readonly tools: Tool[];
  /** What is due at now, each stored as run (or gone, once) before it is said, so it comes due at most once. */
  readonly claimDue: (now: Date) => Effect.Effect<string[], AgentFailed>;
}

/**
 * The reminders in home: read once, then held; a fiber of the scope sleeps until the next is due and hands what came due
 * to wake. What came due while the agent was away is due at once. A file that does not read is left as it is: nothing
 * runs and the tools refuse, until the owner mends it.
 */
export const makeReminders = (home: string, now: () => number, wake: (due: string[]) => Effect.Effect<void>): Effect.Effect<Reminders, never, Scope.Scope> =>
  Effect.gen(function* () {
    const file = join(home, "reminders.json");
    const read = yield* Effect.promise(() =>
      readFile(file, "utf8").then(
        (text) => Result.mapError(Schema.decodeResult(ReminderList)(text), (e) => e.message),
        (e: unknown) => (e instanceof Error && "code" in e && e.code === "ENOENT" ? Result.succeed<Reminder[]>([]) : Result.fail(String(e))),
      ),
    );
    let list: Reminder[] = Result.isSuccess(read) ? read.success : [];
    const unreadable = Result.isFailure(read) ? read.failure : undefined;
    const held = () => {
      if (unreadable !== undefined) throw new Error(unreadable);
      return list;
    };
    const store = async (next: Reminder[]) => {
      await mkdir(home, { recursive: true });
      await writeFile(file + ".tmp", JSON.stringify(next));
      await rename(file + ".tmp", file);
      list = next;
    };

    const claimDue = (at: Date) =>
      Effect.tryPromise({
        try: async () => {
          const reminders = held();
          const due = dueReminders(reminders, at);
          if (due.length === 0) return [];
          const isDue = new Set(due.map((j) => j.id));
          await store(reminders.flatMap((j) => (!isDue.has(j.id) ? [j] : j.at ? [] : [{ ...j, lastRun: at.toISOString() }])));
          return due.map(dueMessage);
        },
        catch: agentFailed,
      });

    // One sleeping fiber: armed again whenever the list changes or one comes due.
    const waiting = yield* FiberHandle.make();
    const start = yield* FiberHandle.runtime(waiting)();
    const arm = (): void => {
      if (unreadable !== undefined) return;
      const next = list
        .map(nextRun)
        .reduce<number | undefined>((soonest, d) => (d && (soonest === undefined || d.getTime() < soonest) ? d.getTime() : soonest), undefined);
      if (next === undefined) return void start(Effect.void);
      start(
        Effect.sleep(Math.max(0, next - now())).pipe(
          Effect.andThen(Effect.suspend(() => claimDue(new Date(now())))),
          Effect.flatMap(wake),
          Effect.andThen(Effect.sync(arm)),
          Effect.catch((e) =>
            Effect.logError("agent: cannot claim due reminders:", e).pipe(Effect.andThen(Effect.sleep(retryClaimMs)), Effect.andThen(Effect.sync(arm))),
          ),
        ),
      );
    };
    arm();

    const add = schemaTool({
      name: "reminder",
      description: reminderWords.reminderDescription,
      parameters: Schema.Struct({
        name: Schema.String,
        message: Schema.String,
        at: Schema.optionalKey(Schema.String),
        every_minutes: Schema.optionalKey(Schema.Finite),
        cron: Schema.optionalKey(Schema.String),
      }),
      run: async (p) => {
        if ([p.at, p.every_minutes, p.cron].filter((x) => x !== undefined && x !== null).length !== 1) throw new Error(reminderWords.oneOfThree);
        let at: Date | undefined;
        if (p.at != null) {
          at = parseDate(p.at);
          if (!at) throw new Error(reminderWords.badAt(p.at));
        }
        if (p.every_minutes != null && !(p.every_minutes >= 1)) throw new Error(reminderWords.badEveryMinutes);
        if (p.cron != null) {
          const parsed = parseCron(p.cron);
          if (Result.isFailure(parsed)) throw new Error(parsed.failure);
        }
        const made = new Date(now());
        const reminder: Reminder = {
          id: "reminder-" + made.getTime().toString(36),
          name: p.name,
          message: p.message,
          ...(p.cron != null ? { cron: p.cron } : {}),
          ...(at ? { at: at.toISOString() } : {}),
          ...(p.every_minutes != null ? { everyMinutes: p.every_minutes } : {}),
          created: made.toISOString(),
        };
        await store([...held(), reminder]);
        arm();
        return reminderWords.set + describeReminder(reminder);
      },
    });
    const listTool = schemaTool({
      name: "list_reminders",
      description: reminderWords.listDescription,
      parameters: Schema.Struct({}),
      run: () => {
        const reminders = held();
        return reminders.length === 0 ? reminderWords.none : reminders.map(describeReminder).join("\n");
      },
    });
    const cancel = schemaTool({
      name: "cancel_reminder",
      description: reminderWords.cancelDescription,
      parameters: Schema.Struct({ id: Schema.String }),
      run: async (p) => {
        const reminders = held();
        const j = reminders.find((x) => x.id === p.id);
        if (!j) throw new Error(reminderWords.notFound(p.id));
        await store(reminders.filter((x) => x !== j));
        arm();
        return reminderWords.canceled(j.name);
      },
    });
    return { tools: [add, listTool, cancel], claimDue } satisfies Reminders;
  });
