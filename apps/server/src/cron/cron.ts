// Cron: the owner's and the orchestrator's, kept in the cron table and in the core state.
// Every tick what is due runs once, however many runs it missed while the server was off, says so in its channel, and
// is published for the orchestrator, who does it.

import { Clock, Context, Effect, Layer, PubSub, Schedule, Schema, type Scope, Semaphore, Stream } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { Agent } from "@/agent/agent.ts";
import type { Actor } from "@/base/actor.ts";
import { ServerConfig } from "@/base/config.ts";
import { Db } from "@/base/db.ts";
import { newId } from "@/base/ids.ts";
import { jsonOrNone } from "@/base/json.ts";
import { scopedPubSub } from "@/base/pubsub.ts";
import { Channel } from "@/channel/chat.ts";
import { Core } from "@/core/core.ts";
import { messageOf, type ApiError, missing, refused, lookIn } from "@/errors.ts";

import * as q from "../../db/generated/cron.sql.ts";
import { afterRun, dueCrons, dueText, isMissed, needsOK, cronProblem } from "./due.ts";
import { whenText } from "./when.ts";

export interface Due {
  readonly cron: T.Cron;
  readonly missed: boolean;
}

export class Cron extends Context.Service<
  Cron,
  {
    readonly list: () => T.Cron[];
    /** by is who asks, and on whose word (needsOK). */
    readonly add: (req: T.CronRequest, by: Actor) => Effect.Effect<T.Cron, ApiError>;
    /** Turned on is the owner's yes. */
    readonly setEnabled: (id: string, enabled: boolean) => Effect.Effect<T.Cron, ApiError>;
    readonly remove: (id: string) => Effect.Effect<T.Cron, ApiError>;
    /** What remove would do, refused as it would be; nothing changes. */
    readonly previewRemove: (id: string) => Effect.Effect<T.Preview, ApiError>;
    readonly tick: Effect.Effect<void>;
    /** What comes due from now on, subscribed before it returns. */
    readonly due: Effect.Effect<Stream.Stream<Due>, never, Scope.Scope>;
  }
>()("vibevalley/Cron") {
  static readonly layer = Layer.effect(
    Cron,
    Effect.suspend(() => make),
  );
}

/** $TZ when it names a zone, else the system's. */
function localZone(): string {
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

const make = Effect.gen(function* () {
  const core = yield* Core;
  const store = yield* Agent;
  const chat = yield* Channel;
  const { run: db, attempt } = yield* Db;
  // Read in callbacks too: the Clock the service was built with (a test turns it by hand).
  const clock = yield* Clock.Clock;
  const now = () => clock.currentTimeMillisUnsafe();
  // The ticker, the tools and the pages all change the list.
  const lock = yield* Semaphore.make(1);
  const dueHub = yield* scopedPubSub<Due>();

  for (const row of yield* db(q.crons())) {
    const when = jsonOrNone(S.CronWhen)(row.spec);
    // A cron whose time or owner this code cannot read any more is left out.
    if (!when || !Schema.is(S.ActorKind)(row.set_by)) continue;
    const s: T.Cron = {
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
      ...(row.last_run != null && row.last_run !== 0 ? { lastRun: row.last_run } : {}),
      by: row.set_by,
      pending: row.pending,
    };
    yield* core.apply({ type: "cron", cron: s });
  }

  const find = (id: string) => {
    const s = core.state().crons.find((x) => x.id === id);
    return s ? Effect.succeed(s) : Effect.fail(missing(t("server.cron.noCron", { id }), [lookIn.cron]));
  };

  const ran = (id: string, at: number, enabled: boolean) => db(q.cronRan({ last_run: at, enabled, id }));

  const tick = lock.withPermits(1)(
    Effect.gen(function* () {
      const at = now();
      for (const s of dueCrons(core.state().crons, at)) {
        const missed = isMissed(s, at);
        const after = afterRun(s, at);
        const written = yield* Effect.result(attempt(q.cronRan({ last_run: at, enabled: after.enabled, id: after.id })));
        if (written._tag === "Failure") {
          const failure = written.failure;
          yield* Effect.logWarning(`vibevalley: cron ${s.id}'s run was not kept: ${messageOf(failure)}`);
          continue;
        }
        yield* core.apply({ type: "cron", cron: after });
        yield* chat.notice(s.channel, dueText(s, missed), "cron");
        PubSub.publishUnsafe(dueHub, { cron: after, missed });
      }
    }),
  );

  const shape = Cron.of({
    list: () => [...core.state().crons],
    add: Effect.fn("Cron.add")(function* (req, by) {
      const at = now();
      const problem = cronProblem(req, at);
      if (problem) return yield* Effect.fail(refused(problem));
      const want = req.channel ?? chat.defaultChannel();
      const channel = (yield* chat.channels()).find((c) => c.id === want);
      if (!channel) return yield* Effect.fail(refused(t("server.cron.noChannel", { name: want }), [lookIn.channel]));
      const named = (req.agent ?? "").trim();
      const agents = store.agents();
      const agent = named ? (agents.find((a) => a.id === named) ?? agents.find((a) => a.name === named)) : undefined;
      if (named && !agent) return yield* Effect.fail(refused(t("server.cron.noProfile", { name: req.agent ?? "" }), [lookIn.agent]));
      const project = (req.project ?? "").trim();
      if (agent && !project && !channel.project) return yield* Effect.fail(refused(t("server.cron.noProject", { channel: channel.name })));
      const tz = req.tz ?? localZone();
      const pending = needsOK(req, by);
      const s: T.Cron = {
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
        pending,
      };
      yield* db(
        q.addCron({
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
      yield* core.apply({ type: "cron", cron: s });
      return s;
    }, lock.withPermits(1)),
    setEnabled: Effect.fn("Cron.setEnabled")(function* (id, enabled) {
      const was = yield* find(id);
      // Turned on is the owner's yes (only the owner may: cron.update); the queries clear pending the same way.
      let s: T.Cron = { ...was, enabled, pending: was.pending && !enabled };
      // Switched back on: it counts from now, not from runs it skipped while off.
      if (enabled && !was.enabled && was.when.kind !== "once") {
        const at = now();
        s = { ...s, lastRun: at };
        yield* ran(id, at, enabled);
      } else yield* db(q.enableCron({ enabled, id }));
      yield* core.apply({ type: "cron", cron: s });
      return s;
    }, lock.withPermits(1)),
    remove: Effect.fn("Cron.remove")(function* (id) {
      const was = yield* find(id);
      yield* db(q.removeCron({ id }));
      yield* core.apply({ type: "cronGone", id });
      return was;
    }, lock.withPermits(1)),
    previewRemove: Effect.fn("Cron.previewRemove")(function* (id) {
      const was = yield* find(id);
      return { does: [t("server.cron.removeWhen", { name: was.name, when: whenText(was.when, was.tz) })] };
    }),
    tick,
    due: Effect.map(PubSub.subscribe(dueHub), Stream.fromSubscription),
  });
  return shape;
});

/** Ticks once every service is built, so what the first tick finds due reaches the orchestrator (once ready). */
export const start = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const crons = yield* Cron;
    const every = Math.max(config.cron.tickMs, 1);
    yield* Effect.forkScoped(crons.tick.pipe(Effect.repeat(Schedule.spaced(every))));
  }),
);
