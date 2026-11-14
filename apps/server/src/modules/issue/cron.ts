import { Hub, Semaphore, type Subscription, TaskGroup } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { userId } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import type { Actor } from "#/base/actor.ts";
import { ApiError, BizCode, lookIn, messageOf, missing, refuseIn } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import { jsonOrNone, jsonText } from "#/base/json.ts";
import type { Core } from "#/core/core.ts";
import type { ServerConfig } from "#/infra/config.ts";
import { type Db, SqlError } from "#/infra/db.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Agent } from "#/modules/agent/agent.ts";
import type { Channel } from "#/modules/channel/channel.ts";
import type { Session } from "#/modules/session/session.ts";
import type { Trigger } from "#/modules/session/shapes.ts";
import * as q from "#db/issue_cron.sql.ts";

import type { Intake } from "./intake.ts";
import { afterRun, cronProblem, dueCrons, dueText, givenZone, isMissed, needsOK, whenText } from "./when.ts";

const refused = refuseIn(BizCode.CronRefused);

export interface Due {
  readonly id: string;
  readonly cron: T.Cron;
  readonly missed: boolean;
}

/** The crons: each one, when it comes due, is a trigger for the one issue it keeps. */
export interface IssueCron {
  readonly list: () => T.Cron[];
  /** by is who asks, and on whose word (needsOK). */
  readonly add: (req: T.CronRequest, by: Actor) => Promise<T.Cron>;
  /** Turned on is the user's yes. */
  readonly setEnabled: (id: string, enabled: boolean) => Promise<T.Cron>;
  readonly remove: (id: string) => Promise<T.Cron>;
  /** What remove would do, refused as it would be; nothing changes. */
  readonly previewRemove: (id: string) => Promise<T.Preview>;
  readonly tick: () => Promise<void>;
  /** What comes due from now on, subscribed before it returns. */
  readonly due: () => Subscription<Due>;
  /** Ticks once every service is built, so what the first tick finds due reaches the orchestrator (once ready). */
  readonly boot: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface CronDeps {
  readonly config: ServerConfig;
  readonly clock: Time;
  readonly log: Logger;
  readonly db: Db;
  readonly core: Core;
  readonly agent: Agent;
  readonly channel: Channel;
  readonly session: Session;
  /** Where a due cron's trigger goes: the pool of the issue it made, whose thread it subscribes. */
  readonly intake: Pick<Intake, "route" | "subscribe" | "ownerOf">;
  /** The issue a due cron's trigger goes to: the one it made last, reopened, or a new one. */
  readonly scheduled: (due: Due, input: Trigger) => Promise<T.Issue>;
}

/** $TZ when it names a zone, else the system's. */
const localZone = (): string => {
  const tz = process.env["TZ"] ?? "";
  return tz && givenZone(tz) ? tz : Intl.DateTimeFormat().resolvedOptions().timeZone;
};

const whenOf = jsonOrNone(S.CronWhen);

export async function issueCron(deps: CronDeps): Promise<IssueCron> {
  const { core, agent: store, channel: chat, scheduled, session: sessions, intake, db, clock, config } = deps;
  const log = deps.log.child("cron");
  const tasks = new TaskGroup({ name: "cron", onError: (task, e) => log.error(`${task} failed:`, e) });
  const now = () => clock.now();
  // The ticker, the tools and the pages all change the list.
  const lock = new Semaphore(1);
  const dueHub = new Hub<Due>();

  for (const row of await q.crons(db.sql)) {
    const when = whenOf(row.spec);
    // A cron whose time or setter this code cannot read any more is left out.
    const by = S.ActorKind.safeParse(row.set_by);
    if (!when || !by.success) continue;
    const s: T.Cron = {
      id: row.id,
      name: row.name,
      text: row.body,
      channel: row.channel_id,
      ...(row.agent ? { agent: row.agent } : {}),
      ...(row.repo ? { repo: row.repo } : {}),
      when,
      tz: row.tz,
      enabled: row.enabled,
      created: row.created_at,
      ...(row.last_run != null && row.last_run !== 0 ? { lastRun: row.last_run } : {}),
      by: by.data,
      pending: row.pending,
    };
    core.apply({ type: "cronChanged", cron: s });
  }

  const find = (id: string): T.Cron => {
    const s = core.state().crons.find((x) => x.id === id);
    if (!s) throw missing(t("server.cron.noCron", { id }), [lookIn.cron]);
    return s;
  };

  const ran = (id: string, at: number, enabled: boolean) => q.cronRan(db.sql, { last_run: at, enabled, id });

  const recordDue = (due: Due) => {
    const s = due.cron;
    const thread = `cron:${s.id}`;
    return sessions.recordTrigger({
      source: "cron",
      key: due.id,
      actor: { kind: "system", id: s.id },
      text: dueText(s, due.missed),
      threads: [thread],
      addressed: "thread_owner",
      replyChannel: s.channel,
      meta: { cron: s.id, trigger: { kind: "cron", cron: s.id, ...(due.missed ? { missed: true } : {}) } },
      at: s.lastRun ?? s.created,
      data: s,
    });
  };

  const handle = (due: Due, trigger: Trigger) =>
    bestEffort(log, `cron occurrence ${due.id}`, async () => {
      const s = due.cron;
      const thread = `cron:${s.id}`;
      if (!(await sessions.isRouted(trigger.id))) {
        const issue = await scheduled(due, trigger);
        await intake.subscribe(issue.id, [thread]);
        await intake.route(trigger);
      } else {
        const issue = await intake.ownerOf(trigger.id);
        if (issue) await intake.subscribe(issue, [thread]);
      }
    });

  const replay = () =>
    sessions.unrouted(async (trigger, data) => {
      if (trigger.source !== "cron") return;
      const cron = S.Cron.parse(data);
      const by = trigger.meta.trigger;
      await handle({ id: trigger.id, cron, missed: by?.kind === "cron" && by.missed === true }, trigger);
    });

  const tick = () =>
    lock.with(async () => {
      await replay();
      const at = now();
      for (const s of dueCrons(core.state().crons, at)) {
        const missed = isMissed(s, at);
        const after = afterRun(s, at);
        const occurrence = { id: newId(), cron: after, missed };
        let trigger: Trigger;
        try {
          trigger = await db.tx(async () => {
            await q.cronRan(db.sql, { last_run: at, enabled: after.enabled, id: after.id });
            return recordDue(occurrence);
          });
        } catch (e) {
          // A run that is not kept is said, and the next due cron goes on; this one is due again at the next tick.
          if (!(e instanceof SqlError || e instanceof ApiError)) throw e;
          log.warn(`vibevalley: cron ${s.id}'s run was not kept: ${messageOf(e)}`);
          continue;
        }
        core.apply({ type: "cronChanged", cron: after });
        dueHub.publish(occurrence);
        await handle(occurrence, trigger);
      }
    });

  return {
    list: () => [...core.state().crons],
    add: (req, by) =>
      lock.with(async () => {
        const at = now();
        const problem = cronProblem(req, at);
        if (problem) throw refused(problem);
        // A channel as the user names it (general, #general) as well as by id.
        const want = req.channel === undefined ? chat.defaultChannel() : await chat.placeOf(userId, req.channel);
        const channel = (await chat.channels()).find((c) => c.id === want);
        if (!channel) throw refused(t("server.cron.noChannel", { name: want }), [lookIn.channel]);
        const named = (req.agent ?? "").trim();
        const agents = store.agents();
        const agent = named ? (agents.find((a) => a.id === named) ?? agents.find((a) => a.name === named)) : undefined;
        if (named && !agent) throw refused(t("server.cron.noProfile", { name: req.agent ?? "" }), [lookIn.agent]);
        const repo = (req.repo ?? "").trim();
        if (agent && !repo && !channel.repo) throw refused(t("server.cron.noRepo", { channel: channel.name }));
        const tz = req.tz ?? localZone();
        const pending = needsOK(req, by);
        const s: T.Cron = {
          id: newId(),
          name: req.name.trim(),
          text: req.text.trim(),
          channel: channel.id,
          ...(agent ? { agent: agent.id } : {}),
          ...(repo ? { repo } : {}),
          when: req.when,
          tz,
          // Counted from now, by the same clock that ticks.
          enabled: !pending,
          created: at,
          by: by.kind,
          pending,
        };
        await q.addCron(db.sql, {
          id: s.id,
          name: s.name,
          body: s.text,
          channel_id: s.channel,
          agent: s.agent ?? null,
          repo: s.repo ?? null,
          spec: jsonText(s.when),
          tz,
          set_by: by.kind,
          pending,
          created_at: at,
        });
        core.apply({ type: "cronChanged", cron: s });
        return s;
      }),
    setEnabled: (id, enabled) =>
      lock.with(async () => {
        const was = find(id);
        // Turned on is the user's yes (only the user may: cron.update); the queries clear pending the same way.
        let s: T.Cron = { ...was, enabled, pending: was.pending && !enabled };
        // Switched back on: it counts from now, not from runs it skipped while off.
        if (enabled && !was.enabled && was.when.kind !== "once") {
          const at = now();
          s = { ...s, lastRun: at };
          await ran(id, at, enabled);
        } else await q.enableCron(db.sql, { enabled, id });
        core.apply({ type: "cronChanged", cron: s });
        return s;
      }),
    remove: (id) =>
      lock.with(async () => {
        const was = find(id);
        await q.removeCron(db.sql, { id });
        core.apply({ type: "cronRemoved", id });
        return was;
      }),
    previewRemove: async (id) => {
      const was = find(id);
      return { does: [t("server.cron.removeWhen", { name: was.name, when: whenText(was.when, was.tz) })] };
    },
    tick,
    due: () => dueHub.subscribe(),
    boot: async () => {
      const every = Math.max(config.cron.tickMs, 1);
      tasks.run("tick", async (signal) => {
        while (true) {
          await tick();
          await clock.sleep(every, signal);
        }
      });
    },
    close: async () => {
      await tasks.close();
      dueHub.end();
    },
  };
}
