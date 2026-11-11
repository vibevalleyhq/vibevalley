import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { Clock, Cron, DateTime, Effect, FiberHandle, type FileSystem, Option, Predicate, Result, Schema, type Scope } from "effect";

import { reminders as reminderWords } from "../base/prompts.ts";
import { AgentFailed, agentFailed, ToolFailed, toolFailed } from "../core/errors.ts";
import type { Tool } from "../core/loop.ts";
import { schemaEffectTool } from "../core/tool.ts";
import { agentFsOf } from "../infra/fs.ts";

const ReminderSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  message: Schema.String,
  /** One of: a cron expression, a moment (ISO), every so many minutes. */
  cron: Schema.optionalKey(Schema.String),
  at: Schema.optionalKey(Schema.String),
  everyMinutes: Schema.optionalKey(Schema.Finite),
  created: Schema.String,
  lastRun: Schema.optionalKey(Schema.String),
});
export type Reminder = typeof ReminderSchema.Type;

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
const encodeReminderList = Schema.encodeEffect(ReminderList);

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
  if ([p.at, p.every_minutes, p.cron].filter((x) => x !== undefined && x !== null).length !== 1) return ToolFailed.make({ message: reminderWords.oneOfThree });
  let at: Date | undefined;
  if (p.at != null) {
    at = parseDate(p.at);
    if (!at) return ToolFailed.make({ message: reminderWords.badAt(p.at) });
  }
  if (p.every_minutes != null && !(p.every_minutes >= 1)) return ToolFailed.make({ message: reminderWords.badEveryMinutes });
  if (p.cron != null) {
    const parsed = parseCron(p.cron);
    if (Result.isFailure(parsed)) return ToolFailed.make({ message: parsed.failure });
  }
  const made = DateTime.toDateUtc(DateTime.makeUnsafe(nowMs));
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
  /** What is due at now, each stored as run (or gone, once) before it is said, so it comes due at most once. */
  readonly claimDue: (now: Date) => Effect.Effect<string[], AgentFailed>;
}

/** The reminders in home: read once, then held. a fiber of the scope sleeps until the next is due and hands what came due to wake. */
export const makeReminders = (
  home: string,
  wake: (due: string[]) => Effect.Effect<void>,
  fs?: FileSystem.FileSystem,
): Effect.Effect<Reminders, never, Scope.Scope> =>
  Effect.gen(function* () {
    const io = agentFsOf(fs);
    const clock = yield* Clock.Clock;
    const file = join(home, "reminders.json");
    const read = yield* io.readTextIfExists(file).pipe(
      Effect.map((text) => (text === undefined ? Result.succeed<Reminder[]>([]) : Result.mapError(Schema.decodeResult(ReminderList)(text), (e) => e.message))),
      Effect.catchTag("AgentFailed", (e) => Effect.succeed(Result.fail(e.message))),
    );
    let list: Reminder[] = Result.isSuccess(read) ? read.success : [];
    const unreadable = Result.isFailure(read) ? read.failure : undefined;
    const heldAgent = (): Effect.Effect<Reminder[], AgentFailed> =>
      unreadable !== undefined ? Effect.fail(AgentFailed.make({ message: unreadable })) : Effect.succeed(list);
    const heldTool = (): Effect.Effect<Reminder[], ToolFailed> =>
      unreadable !== undefined ? Effect.fail(ToolFailed.make({ message: unreadable })) : Effect.succeed(list);

    const store = (next: Reminder[]): Effect.Effect<void, AgentFailed> =>
      Effect.gen(function* () {
        const encoded = yield* Effect.mapError(encodeReminderList(next), agentFailed);
        yield* io.makeDir(home);
        yield* io.writeText(file + ".tmp", encoded);
        yield* io.rename(file + ".tmp", file);
        list = next;
      });

    const claimDue = (at: Date): Effect.Effect<string[], AgentFailed> =>
      Effect.gen(function* () {
        const reminders = yield* heldAgent();
        const due = dueReminders(reminders, at);
        if (due.length === 0) return [];
        yield* store(afterClaim(reminders, due, at));
        return due.map(dueMessage);
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
      const waitMs = Math.max(0, next - clock.currentTimeMillisUnsafe());
      start(
        Effect.gen(function* () {
          yield* Effect.sleep(waitMs);
          const wokeAt = yield* Clock.currentTimeMillis;
          const due = yield* claimDue(DateTime.toDateUtc(DateTime.makeUnsafe(wokeAt)));
          yield* wake(due);
          arm();
        }).pipe(
          Effect.catch((e) =>
            Effect.gen(function* () {
              yield* Effect.logError("agent: cannot claim due reminders:", e);
              yield* Effect.sleep(retryClaimMs);
              arm();
            }),
          ),
        ),
      );
    };
    arm();

    const add = schemaEffectTool({
      name: "reminder",
      description: reminderWords.reminderDescription,
      parameters: Schema.Struct({
        name: Schema.String,
        message: Schema.String,
        at: Schema.optionalKey(Schema.String),
        every_minutes: Schema.optionalKey(Schema.Finite),
        cron: Schema.optionalKey(Schema.String),
      }),
      run: (p) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const built = buildReminder(p, now);
          if (Predicate.isTagged(built, "ToolFailed")) return yield* built;
          const reminders = yield* heldTool();
          yield* Effect.mapError(store([...reminders, built]), toolFailed);
          arm();
          return reminderWords.set + describeReminder(built);
        }),
    });
    const listTool = schemaEffectTool({
      name: "list_reminders",
      description: reminderWords.listDescription,
      parameters: Schema.Struct({}),
      run: () => Effect.map(heldTool(), (reminders) => (reminders.length === 0 ? reminderWords.none : reminders.map(describeReminder).join("\n"))),
    });
    const cancel = schemaEffectTool({
      name: "cancel_reminder",
      description: reminderWords.cancelDescription,
      parameters: Schema.Struct({ id: Schema.String }),
      run: (p) =>
        Effect.gen(function* () {
          const reminders = yield* heldTool();
          const j = reminders.find((x) => x.id === p.id);
          if (!j) return yield* ToolFailed.make({ message: reminderWords.notFound(p.id) });
          yield* Effect.mapError(store(reminders.filter((x) => x !== j)), toolFailed);
          arm();
          return reminderWords.canceled(j.name);
        }),
    });
    return { tools: [add, listTool, cancel], claimDue } satisfies Reminders;
  });
