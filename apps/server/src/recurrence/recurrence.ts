// Recurrences: the owner's and the orchestrator's, kept in the recurrence table and in the core state.
// Every tick what is due runs once, however many runs it missed while the server was off, says so in its channel, and
// is published for the orchestrator, who does it.

import { recurrenceWording } from "./words.ts";
import type { Preview, Recurrence, RecurrenceRequest } from "@vibevalley/protocol";
import type { Actor } from "../base/actor.ts";
import * as S from "@vibevalley/protocol/schema";
import { afterRun, dueRecurrences, dueText, isMissed, needsOK, recurrenceProblem } from "./rules.ts";
import { Clock, Context, Effect, Layer, PubSub, Schedule, Schema, type Scope, Semaphore, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { Agents } from "../agent/agent.ts";
import { Settings } from "../base/config.ts";
import { Db } from "../base/db.ts";
import { newId } from "../base/ids.ts";
import { jsonOrNone } from "../base/json.ts";
import { Channels } from "../channel/chat.ts";
import { Core } from "../core/core.ts";
import { type ApiError, missing, refused, lookIn } from "../errors.ts";
import * as q from "../../db/generated/recurrence.sql.ts";

export interface Due {
  readonly recurrence: Recurrence;
  readonly missed: boolean;
}

export interface RecurrenceShape {
  readonly list: () => Recurrence[];
  /** by is who asks, and on whose word (needsOK). */
  readonly add: (req: RecurrenceRequest, by: Actor) => Effect.Effect<Recurrence, ApiError>;
  /** Turned on is the owner's yes. */
  readonly setEnabled: (id: string, enabled: boolean) => Effect.Effect<Recurrence, ApiError>;
  readonly remove: (id: string) => Effect.Effect<Recurrence, ApiError>;
  /** What remove would do, refused as it would be; nothing changes. */
  readonly previewRemove: (id: string) => Effect.Effect<Preview, ApiError>;
  readonly tick: Effect.Effect<void>;
  /** What comes due from now on, subscribed before it returns. */
  readonly due: Effect.Effect<Stream.Stream<Due>, never, Scope.Scope>;
}

export class Recurrences extends Context.Service<Recurrences, RecurrenceShape>()("vibevalley/Recurrence") {}

/** $TZ when it names a zone, else the system's. */
export function localZone(): string {
  const tz = process.env.TZ;
  if (tz) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
      return tz;
    } catch {
      // Not a zone: the system's.
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export const make = Effect.gen(function* () {
  const core = yield* Core;
  const store = yield* Agents;
  const chat = yield* Channels;
  const sql = yield* SqlClient.SqlClient;
  const { run: db } = yield* Db;
  // Read in callbacks too: the Clock the service was built with (a test turns it by hand).
  const clock = yield* Clock.Clock;
  const now = () => clock.currentTimeMillisUnsafe();
  // The ticker, the tools and the pages all change the list.
  const lock = yield* Semaphore.make(1);
  const dueHub = yield* PubSub.unbounded<Due>();

  for (const row of yield* db(q.recurrences())) {
    const when = jsonOrNone(S.RecurrenceWhen)(row.spec);
    // A recurrence whose time or owner this code cannot read any more is left out.
    if (!when || !Schema.is(S.ActorKind)(row.set_by)) continue;
    const s: Recurrence = {
      id: row.id,
      name: row.name,
      text: row.body,
      channel: row.channel_id,
      ...(row.agent ? { agent: row.agent } : {}),
      ...(row.project ? { project: row.project } : {}),
      when,
      tz: row.tz,
      enabled: row.enabled,
      created: row.created_at,
      ...(row.last_run ? { lastRun: row.last_run } : {}),
      by: row.set_by,
      ...(row.pending ? { pending: true } : {}),
    };
    yield* core.apply({ type: "recurrence", recurrence: s });
  }

  const find = (id: string) => {
    const s = (core.state().recurrences ?? []).find((x) => x.id === id);
    return s ? Effect.succeed(s) : Effect.fail(missing(recurrenceWording().noRecurrence(id), [lookIn.recurrence]));
  };

  const ran = (id: string, at: number, enabled: boolean) => db(q.recurrenceRan({ last_run: at, enabled, id }));

  const tick = lock.withPermits(1)(
    Effect.gen(function* () {
      const at = now();
      for (const s of dueRecurrences(core.state().recurrences ?? [], at)) {
        const missed = isMissed(s, at);
        const after = afterRun(s, at);
        const written = yield* Effect.result(
          Effect.provideService(q.recurrenceRan({ last_run: at, enabled: after.enabled, id: after.id }), SqlClient.SqlClient, sql),
        );
        if (written._tag === "Failure") {
          const failure = written.failure;
          yield* Effect.logWarning(`vibevalley: recurrence ${s.id}'s run was not kept: ${failure instanceof Error ? failure.message : String(failure)}`);
          continue;
        }
        yield* core.apply({ type: "recurrence", recurrence: after });
        yield* chat.notice(s.channel, dueText(s, missed), "recurrence");
        PubSub.publishUnsafe(dueHub, { recurrence: after, missed });
      }
    }),
  );

  const shape: RecurrenceShape = {
    list: () => [...(core.state().recurrences ?? [])],
    add: Effect.fn("Recurrences.add")(function* (req, by) {
      const at = now();
      const problem = recurrenceProblem(req, at);
      if (problem) return yield* Effect.fail(refused(problem));
      const want = req.channel ?? chat.defaultChannel();
      const channel = (yield* chat.channels()).find((c) => c.id === want);
      if (!channel) return yield* Effect.fail(refused(recurrenceWording().noChannel(want), [lookIn.channel]));
      const named = (req.agent ?? "").trim();
      const agents = store.agents();
      const agent = named ? (agents.find((a) => a.id === named) ?? agents.find((a) => a.name === named)) : undefined;
      if (named && !agent) return yield* Effect.fail(refused(recurrenceWording().noProfile(req.agent ?? ""), [lookIn.agent]));
      const project = (req.project ?? "").trim();
      if (agent && !project && !channel.project) return yield* Effect.fail(refused(recurrenceWording().noProject(channel.name)));
      const tz = req.tz ?? localZone();
      const pending = needsOK(req, by);
      const s: Recurrence = {
        id: newId(),
        name: req.name.trim(),
        text: req.text.trim(),
        channel: channel.id,
        ...(agent ? { agent: agent.id } : {}),
        ...(project ? { project } : {}),
        when: req.when,
        tz,
        // Counted from now, by the same clock that ticks.
        enabled: !pending,
        created: at,
        by: by.kind,
        ...(pending ? { pending: true } : {}),
      };
      yield* db(
        q.addRecurrence({
          id: s.id,
          name: s.name,
          body: s.text,
          channel_id: s.channel,
          agent: s.agent ?? null,
          project: s.project ?? null,
          spec: JSON.stringify(s.when),
          tz,
          set_by: by.kind,
          pending,
          created_at: at,
        }),
      );
      yield* core.apply({ type: "recurrence", recurrence: s });
      return s;
    }, lock.withPermits(1)),
    setEnabled: Effect.fn("Recurrences.setEnabled")(function* (id, enabled) {
      const was = yield* find(id);
      // Turned on is the owner's yes (only the owner may: recurrence.update); the queries clear pending the same way.
      const { pending: _, ...rest } = was;
      let s: Recurrence = { ...rest, enabled, ...(was.pending && !enabled ? { pending: true } : {}) };
      // Switched back on: it counts from now, not from runs it skipped while off.
      if (enabled && !was.enabled && was.when.kind !== "once") {
        const at = now();
        s = { ...s, lastRun: at };
        yield* ran(id, at, enabled);
      } else yield* db(q.enableRecurrence({ enabled, id }));
      yield* core.apply({ type: "recurrence", recurrence: s });
      return s;
    }, lock.withPermits(1)),
    remove: Effect.fn("Recurrences.remove")(function* (id) {
      const was = yield* find(id);
      yield* db(q.removeRecurrence({ id }));
      yield* core.apply({ type: "recurrenceGone", id });
      return was;
    }, lock.withPermits(1)),
    previewRemove: (id) =>
      Effect.map(find(id), (was) => ({
        does: [recurrenceWording().remove(was.name, was.whenText ?? "")],
      })),
    tick,
    due: Effect.map(PubSub.subscribe(dueHub), Stream.fromSubscription),
  };
  return shape;
});

export const layer = Layer.effect(Recurrences, make);

/** Ticks once every service is built, so what the first tick finds due reaches the orchestrator (once ready). */
export const start = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* Settings;
    const recurrences = yield* Recurrences;
    const every = Math.max(config.recurrence.tickMs, 1);
    yield* Effect.forkScoped(recurrences.tick.pipe(Effect.repeat(Schedule.spaced(every))));
  }),
);
