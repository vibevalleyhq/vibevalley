import { z } from "zod";

import { Hub, Semaphore, type Subscription, TaskGroup } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { BizCode, Inconsistent, lookIn, missing, refuseIn } from "#/base/errors.ts";
import { jsonOf, valueOf } from "#/base/json.ts";
import type { Core } from "#/core/core.ts";
import type { ServerConfig } from "#/infra/config.ts";
import type { Db } from "#/infra/db.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Agent } from "#/modules/agent/agent.ts";
import type { Session, SessionNews } from "#/modules/session/session.ts";
import { defaultID, topPlace, unreadOf } from "#db/channel.sql.ts";
import { membersOf } from "#db/channel_member.sql.ts";
import * as qd from "#db/mailbox_delivery.sql.ts";
import * as qr from "#db/mailbox_trigger.sql.ts";

import { Reach, WakeBreaker } from "./brakes.ts";
import { Deliveries, type DeliveryRow, type DeliveryDraft } from "./deliveries.ts";
import {
  type ChannelEnvelopeRow,
  type ChannelRouteResult,
  type Envelope,
  type ChannelHearers,
  type Handed,
  channelType,
  targetOf,
  summaryChannels,
  type UnreadRow,
  orchestratorIn,
} from "./envelope.ts";
import {
  inputOf,
  orchestratorSource,
  deliveryScope,
  type InputContext,
  type SourceEvent,
  type TriggerInput,
  type TriggerResource,
  type KnownGitHubEvent,
} from "./payload.ts";
import { wakeInput } from "./prompts.ts";
import { makePump } from "./pump.ts";
import { channelRecipients, waitsForHuman } from "./routing.ts";
import * as S from "./schema.ts";
import type { Trigger } from "./shapes.ts";
import { triggerJournal } from "./triggers.ts";
import { makeWorkMailbox, type OutboundDelivery } from "./work.ts";

const refused = refuseIn(BizCode.ChannelRefused);

export type { SourceEvent };

export interface InsertDelivery {
  readonly session: string;
  readonly row: DeliveryDraft;
}

const RoutePosition = z.object({ scope: z.string(), position: z.number().int() });
const readRouteReceipt = valueOf(RoutePosition.extend({ from_user: z.boolean() }), "mailbox.routeReceipt");
const readUserRoutes = valueOf(z.array(RoutePosition), "mailbox.userRoutes");
const readTrigger = jsonOf(S.Trigger);

export interface QueuedInput {
  readonly issue: string;
  readonly trigger: Trigger;
}

export interface TalkRow {
  readonly row: ChannelEnvelopeRow;
  readonly context: InputContext;
}

export type Arrival =
  | { readonly _tag: "Trigger"; readonly trigger: Trigger; readonly to?: ChannelHearers | { readonly session: string } }
  | {
      readonly _tag: "Hire";
      readonly agent: T.Agent;
      readonly brief: string;
      /** Empty for a direct conversation. */
      readonly where: string;
      readonly options: Omit<SendOptions, "hiring" | "envelopeIds">;
      readonly envelopes: { readonly _tag: "Talk"; readonly rows: readonly TalkRow[] } | { readonly _tag: "Queued"; readonly triggers: readonly Trigger[] };
      /** Runs inside the session hire transaction before the session is visible. */
      readonly hiring: (session: T.Session, launch: string, at: number) => Promise<void>;
    };

type SendOptions = Parameters<Session["hire"]>[3];

export type TriggerArrival = Extract<Arrival, { readonly _tag: "Trigger" }>;
export type HireArrival = Extract<Arrival, { readonly _tag: "Hire" }>;

export interface HiredReceipt {
  readonly hired: T.Session;
  readonly evicted?: string;
}

export type Withdrawal =
  | { readonly _tag: "Session"; readonly session: string; readonly why: string }
  | { readonly _tag: "Envelope"; readonly envelope: string }
  /** Runs in its own transaction, outside writeLock. */
  | { readonly _tag: "Issue"; readonly issue: string; readonly at: number };

export type DeliveryNews =
  | { readonly _tag: "Consumed"; readonly session: string; readonly envelope: string }
  | { readonly _tag: "Braked"; readonly session: string; readonly failed: number }
  | Handed;

export interface Mailbox {
  readonly record: (event: SourceEvent) => Promise<Trigger | undefined>;
  readonly accept: (event: SourceEvent) => Promise<Trigger | undefined>;
  readonly recordTrigger: (input: TriggerInput) => Promise<Trigger>;
  readonly readTrigger: (id: string) => Promise<TriggerResource | undefined>;
  readonly knownGitHubEvents: (repo: string, pr: number) => Promise<readonly KnownGitHubEvent[]>;
  readonly replayCronTriggers: (consume: (trigger: Trigger, data: unknown) => Promise<void>) => Promise<void>;
  readonly unreadSummary: (participant: string, channel: string) => Promise<UnreadRow[]>;
  readonly triggersOf: (issue: string) => Promise<readonly Trigger[]>;
  /** Dispatches first, then routed order. */
  readonly queuedTriggers: () => Promise<readonly QueuedInput[]>;
  readonly isRouted: (trigger: string) => Promise<boolean>;
  /** A trigger's refusals are ApiErrors; a hire's is HireRefused. */
  readonly receive: {
    (arrival: TriggerArrival): Promise<ChannelRouteResult>;
    (arrival: HireArrival): Promise<HiredReceipt>;
  };
  readonly subscribe: (issue: string, threads: readonly string[]) => Promise<void>;
  readonly ownerOf: (trigger: string) => Promise<string | undefined>;
  readonly deliveriesOf: (session: string) => readonly DeliveryRow[];
  readonly orchestratorDigest: (agent: string) => Promise<Envelope[]>;
  /** At startup, after the modules below it started: restores the open deliveries, routes what was left, wakes who waits. */
  readonly start: () => Promise<void>;
  readonly restore: () => Promise<void>;
  readonly replay: () => Promise<void>;
  /** What the mailbox tells, subscribed before it returns. */
  readonly news: () => Subscription<DeliveryNews>;
  readonly handBack: (session: string, envelope: string) => Promise<void>;
  readonly withdraw: (what: Withdrawal) => Promise<void>;
  readonly waitingOn: (envelope: string) => Promise<number>;
  readonly decline: (session: string, envelope: string, reason: string) => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface MailboxDeps {
  readonly db: Db;
  readonly clock: Time;
  readonly log: Logger;
  readonly config: ServerConfig;
  readonly core: Core;
  readonly agent: Agent;
  readonly session: Session;
}

export async function makeMailbox(deps: MailboxDeps): Promise<Mailbox> {
  const { db, core, config, clock, session: sessions, agent: agents } = deps;
  const log = deps.log.child("mailbox");
  const journal = triggerJournal({ db, log });
  const tasks = new TaskGroup({ name: "mailbox", onError: (task, e) => log.error(`${task} failed:`, e) });
  const issueOf = (id: string) => core.state().issues.find((issue) => issue.id === id);
  const defaultChannelOf = async () => (await defaultID(db.sql))?.id ?? "";
  const orchestratorInChannel = async (channel: string) => {
    const top = await topPlace(db.sql, { id: channel });
    const rows = top === undefined || top.type === "direct" ? [] : await membersOf(db.sql, { channel_id: top.id });
    return orchestratorIn({ top, members: rows.map((m) => m.participant_id), isOrchestrator: agents.isOrchestrator });
  };
  const unreadSummary = async (participant: string, channel: string): Promise<UnreadRow[]> =>
    (await unreadOf(db.sql, { participant, channel })).slice(0, summaryChannels).map((row) => ({
      target: targetOf({ type: channelType(row.type), ...(row.root_number !== null ? { rootNumber: row.root_number } : {}) }, row.channel_name || ""),
      unread: row.unread ?? 0,
      mentionsYou: row.mentions_you === true,
      ...(row.latest_sender_name ? { latest: row.latest_sender_name } : {}),
    }));
  const deliveryUnread = async (who: string) => {
    const h = sessions.sessionOf(who);
    const channel = h?.channel ?? (await defaultChannelOf());
    return unreadSummary(who, channel);
  };
  const open = new Deliveries();
  const reach = new Reach();
  const received = (row: qr.MarkRoutedResult) => {
    const receipt = readRouteReceipt(row);
    if (receipt.from_user) reach.userSpoke(receipt.scope, receipt.position);
  };
  const stored = (session: string, row: DeliveryRow) => {
    open.inserted(session, row);
    if (row.payload.trigger.actor.kind === "user" && row.envelope_id !== row.payload.trigger.id) reach.userSpoke(row.scope, row.position);
    reach.delivered({
      scope: row.scope,
      position: row.position,
      session,
      senderKind: row.payload.trigger.actor.kind,
      wakes: row.wakes,
      held: row.held_by !== null,
      at: row.created_at,
    });
  };
  const breaker = new WakeBreaker();
  const newsHub = new Hub<DeliveryNews>();
  const routeLock = new Semaphore(1);
  const routeLocked = <A>(work: () => Promise<A>) => routeLock.with(work);
  const pumpLock = new Semaphore(1);
  const pumpLocked = <A>(work: () => Promise<A>) => pumpLock.with(work);
  const writeLock = new Semaphore(1);
  // A write, once begun, runs to its end: none is handed a signal.
  const writtenLocked = <A>(work: () => Promise<A>) => writeLock.with(work);
  /** One pending timer per key: a later() for a key already waiting is dropped. The key is free again once it fires. */
  const timers = new Map<string, () => void>();
  let closed = false;
  const later = (key: string, ms: number, work: () => Promise<void>) => {
    if (closed || timers.has(key)) return;
    timers.set(
      key,
      clock.after(ms, () => {
        timers.delete(key);
        if (closed) return;
        tasks.run(`mailbox: ${key}`, () =>
          bestEffort(log, `mailbox: ${key}`, () =>
            pumpLocked(async () => {
              if (!closed) await work();
            }),
          ),
        );
      }),
    );
  };
  const work = makeWorkMailbox(
    { db, clock, session: sessions, agent: agents },
    {
      writtenLocked,
      received,
      stored,
      defaultChannel: defaultChannelOf,
      open,
      reach,
      breaker,
      dispatch: (session) => later(`trigger:${session}`, 0, () => pump.kick(session)),
      issueOf,
      orchestratorIn: orchestratorInChannel,
    },
  );
  const flushIssue = (issue: string, human?: boolean) => routeLocked(() => work.flush(issue, human));
  const restore = () =>
    writtenLocked(async () => {
      const snapshot = await db.tx(async () => {
        await qd.rollbackAll(db.sql);
        return {
          rows: await qd.allOpenDeliveries(db.sql),
          scopes: await qd.agentWakesByScope(db.sql),
          sessions: await qd.lastAgentWakes(db.sql),
          users: await qd.lastUserRoutes(db.sql),
        };
      });
      open.load(snapshot.rows);
      reach.load(
        snapshot.scopes,
        snapshot.sessions.filter((row) => sessions.isReachable(row.session_id)),
        readUserRoutes(snapshot.users),
      );
    });

  // Routing is one at a time and, once begun, runs to its end.
  const route = (trigger: Trigger, to?: ChannelHearers | { readonly session: string }): Promise<ChannelRouteResult> =>
    routeLocked(async () => {
      const audience: readonly OutboundDelivery[] | undefined =
        to === undefined
          ? undefined
          : "row" in to
            ? channelRecipients(trigger, to)
            : [
                {
                  trigger,
                  session: to.session,
                  role: agents.isOrchestrator(to.session) ? ("orchestrator" as const) : ("worker" as const),
                  commit: async () => {},
                  event: trigger.actor.kind === "user" ? ("conversation" as const) : ("mention" as const),
                },
              ];
      const result = await work.receive(trigger, audience);
      if (!(await work.isRouted(trigger.id))) {
        const at = clock.now();
        const routed = await qr.markRouted(db.sql, {
          envelope_id: trigger.id,
          scope: deliveryScope(trigger.replyChannel ?? (await defaultChannelOf())),
          routed_at: at,
        });
        if (routed === undefined) throw new Inconsistent(`trigger ${trigger.id} was routed before it was recorded`);
        received(routed);
      }
      return result ?? { heldNotice: "" };
    });

  const hire = async (arrival: HireArrival): Promise<HiredReceipt> => {
    const room = await sessions.makeRoom(arrival.agent.runtime, arrival.where);
    const envelopes = arrival.envelopes;
    const { session } = await sessions.hire(arrival.agent, arrival.brief, arrival.where, {
      ...arrival.options,
      ...(envelopes._tag === "Talk" ? { envelopeIds: envelopes.rows.map((envelope) => envelope.row.envelope_id) } : {}),
      hiring: async (s, launch) => {
        const at = clock.now();
        await arrival.hiring(s, launch, at);
        switch (envelopes._tag) {
          case "Talk":
            return work.registerTalk(s.id, launch, at, envelopes.rows);
          case "Queued":
            if (envelopes.triggers.length > 0) await work.registerInitialInputs(s, launch, envelopes.triggers);
            return;
        }
      },
    });
    // Kick the pump in case messages arrived in the conversation while hiring was in flight.
    if (envelopes._tag === "Talk") later(`kick:${session.id}`, 0, () => pump.kick(session.id));
    return { hired: session, ...(room.evicted ? { evicted: room.evicted } : {}) };
  };

  const dropSession = (session: string, why: string) =>
    db.tx(async () => {
      await qd.dropOpen(db.sql, { session_id: session, dropped_why: why });
      await db.afterCommit(() => {
        open.dropped(session);
        reach.left(session);
        breaker.reset(session);
      });
    });
  const record = async (event: SourceEvent) => {
    if (event.selfEcho === true) return undefined;
    return journal.recordTrigger(event);
  };
  const accept = async (event: SourceEvent) => {
    const trigger = await record(event);
    if (trigger) await api.receive({ _tag: "Trigger", trigger });
    return trigger;
  };
  function receive(arrival: TriggerArrival): Promise<ChannelRouteResult>;
  function receive(arrival: HireArrival): Promise<HiredReceipt>;
  function receive(arrival: Arrival): Promise<ChannelRouteResult | HiredReceipt> {
    switch (arrival._tag) {
      case "Trigger":
        return route(arrival.trigger, arrival.to);
      case "Hire":
        return hire(arrival);
    }
  }
  const replay = async () => {
    let after = 0;
    while (true) {
      const rows = await qr.unroutedTriggers(db.sql, { after });
      const last = rows.at(-1);
      if (!last) return;
      for (const row of rows)
        await bestEffort(log, `mailbox: replay ${row.id}`, () => api.receive({ _tag: "Trigger", trigger: readTrigger(row.trigger_json) }));
      after = last.seq;
    }
  };
  const handBack = (session: string, envelope: string) =>
    writtenLocked(() =>
      db.tx(async () => {
        await qd.rollbackOne(db.sql, { session_id: session, envelope_id: envelope });
        await db.afterCommit(() => open.handedBackOne(session, envelope));
      }),
    );

  const handToHost = async (recipient: string, messages: readonly Envelope[], primary: DeliveryRow) => {
    const meta = primary.payload.trigger.meta;
    const source = orchestratorSource(primary.payload.trigger.source);
    newsHub.publish({
      _tag: "Handed",
      agent: recipient,
      channel: primary.channel_id ?? (await defaultChannelOf()),
      type: primary.payload.channelType,
      target: inputOf(primary).target,
      messages: [...messages],
      ...(source ? { source } : {}),
      ...(meta.issue ? { issue: meta.issue } : {}),
      ...(meta.trigger ? { by: meta.trigger } : {}),
    });
  };
  const pump = makePump<Envelope>(
    { session: sessions, clock, log },
    {
      pending: (session) => open.of(session),
      dropSession: (session, why) => writtenLocked(() => dropSession(session, why)),
      handBack,
      hand: work.hand,
      consume: (session, envelope, at) =>
        writtenLocked(() =>
          db.tx(async () => {
            await qd.consumeDelivery(db.sql, { session_id: session, envelope_id: envelope, consumed_at: at });
            await db.afterCommit(() => open.remove(session, envelope));
          }),
        ),
      returnHanded: (session) =>
        writtenLocked(() =>
          db.tx(async () => {
            const rows = await qd.rollbackHanded(db.sql, { session_id: session });
            await db.afterCommit(() => open.handedBack(session));
            return rows.map((row) => row.envelope_id);
          }),
        ),
      breakerSpoke: (session) => breaker.spoke(session),
      breakerFailed: (session) => breaker.failed(session),
      breakerOpen: (session) => breaker.isOpen(session),

      readyInputs: (recipient, rows) => {
        const current = sessions.sessionOf(recipient)?.issue;
        const itemOf = (row: DeliveryRow) => {
          const id = row.payload.trigger.meta.issue;
          return issueOf(id ?? current ?? "");
        };
        const answered = new Set(
          rows
            .filter((row) => row.payload.trigger.actor.kind === "user" && row.state === "pending")
            .flatMap((row) => {
              const issue = itemOf(row);
              return issue && issue.status !== "done" && issue.status !== "canceled" ? [issue.id] : [];
            }),
        );
        return rows.filter((row) => {
          const issue = itemOf(row);
          return (
            !issue ||
            (issue.status !== "done" &&
              issue.status !== "canceled" &&
              (!waitsForHuman(issue) || row.payload.trigger.actor.kind === "user" || answered.has(issue.id)))
          );
        });
      },
      closed: () => closed,
      isHosted: agents.isHosted,
      message: (row) => inputOf(row),
      wakeInput: async (recipient, _rows, messages) => {
        const all = await deliveryUnread(recipient);
        return wakeInput(
          [...messages],
          all.filter((other) => !messages.some((message) => message.target === other.target)),
        );
      },
      handToHost,
      consumedMessages: async (recipient, messages) => {
        for (const message of messages) newsHub.publish({ _tag: "Consumed", session: recipient, envelope: message });
      },
      breakerNotice: async (recipient, failed) => newsHub.publish({ _tag: "Braked", session: recipient, failed }),
      later,
      noticeBatchMs: config.chat.noticeBatchMs,
      retryWakeMs: config.chat.retryWakeMs,
    },
  );

  const onNews = (news: SessionNews): Promise<void> => {
    switch (news._tag) {
      case "Consumed":
        return bestEffort(log, `mailbox: input consumed by ${news.session}`, () => pumpLocked(() => pump.consumed(news)));
      case "Returned":
        return bestEffort(log, `mailbox: input returned by ${news.session}`, () => pumpLocked(() => pump.returned(news)));
      case "Spoke":
      case "Ended":
      case "HandedOff":
      case "Settling":
      case "Closed":
      case "Compacting":
        return bestEffort(log, `mailbox: ${news.id} ${news._tag}`, () => pumpLocked(() => pump.activity(news)));
      default:
        return Promise.resolve();
    }
  };
  const sessionNews = sessions.news();
  tasks.run("session news", async (signal) => {
    try {
      for (let r = await sessionNews.next(signal); r.done !== true; r = await sessionNews.next(signal)) await onNews(r.value);
    } finally {
      sessionNews.close();
    }
  });

  const bindIssue = (issue: T.Issue) =>
    work.subscribe(issue.id, [`issue:${issue.id}`, ...(issue.repo && issue.pullRequest ? [`github:${issue.repo}#${issue.pullRequest.number}`] : [])]);
  const onFact = (fact: T.ServerEvent) =>
    bestEffort(log, "mailbox: issue routing", async () => {
      if (fact.type === "issueChanged") {
        await bindIssue(fact.issue);
        if (fact.issue.status === "done" || fact.issue.status === "canceled") {
          await flushIssue(fact.issue.id);
        } else later(`issue:${fact.issue.id}`, 0, () => bestEffort(log, `mailbox: inputs of ${fact.issue.id}`, () => flushIssue(fact.issue.id)));
      } else if (fact.type === "issueRemoved") {
        return;
      } else if (fact.type === "sessionChanged" && fact.session.issue && issueOf(fact.session.issue) !== undefined) {
        const issue = fact.session.issue;
        later(`issue:${issue}`, 0, () => bestEffort(log, `mailbox: inputs of ${issue}`, () => flushIssue(issue)));
      } else if (
        fact.type === "channelChanged" &&
        fact.channel.subjectKind === "issue" &&
        fact.channel.subjectId &&
        issueOf(fact.channel.subjectId) !== undefined
      ) {
        await work.subscribe(fact.channel.subjectId, [`channel:${fact.channel.id}`]);
      }
    });

  const { changes } = core.transitions();
  tasks.run("issue routing", async (signal) => {
    try {
      for (let r = await changes.next(signal); r.done !== true; r = await changes.next(signal)) await onFact(r.value.fact);
    } finally {
      changes.close();
    }
  });

  const api: Mailbox = {
    ...journal,
    record,
    accept,
    unreadSummary,
    isRouted: work.isRouted,
    triggersOf: work.issueInputs,
    queuedTriggers: work.queuedInputs,
    receive,
    subscribe: (issue, threads) => work.subscribe(issue, threads),
    ownerOf: work.ownerOf,
    deliveriesOf: (session) => open.of(session),
    orchestratorDigest: async (agent) =>
      open
        .of(agent)
        .filter((row) => !(row.wakes && row.held_by === null))
        .map((row) => inputOf(row)),
    start: async () => {
      await restore();
      await replay();
      for (const issue of core.state().issues)
        await bestEffort(log, `mailbox: restore issue ${issue.id}`, async () => {
          await bindIssue(issue);
          await flushIssue(issue.id);
        });
      for (const session of sessions.hired()) await pumpLocked(() => pump.kick(session.id));
    },
    restore,
    replay,
    news: () => newsHub.subscribe(),
    handBack,
    withdraw: async (what) => {
      switch (what._tag) {
        case "Session":
          return writtenLocked(() => dropSession(what.session, what.why));
        case "Envelope":
          return writtenLocked(() =>
            db.tx(async () => {
              const rows = await qd.dropOpenOf(db.sql, { message_id: what.envelope });
              await db.afterCommit(() => {
                for (const row of rows) open.remove(row.session_id, what.envelope);
              });
            }),
          );
        case "Issue":
          return work.retireDispatches(what.issue, what.at);
      }
    },
    waitingOn: async (envelope) => (await qd.waitingOn(db.sql, { message_id: envelope })).length,
    decline: async (session, envelope, reason) => {
      const why = reason.trim();
      if (!why) throw refused(t("server.issue.noTitle"));
      if (await routeLocked(() => work.decline(session, envelope, why))) return;
      throw missing(t("server.issue.issueRef", { ref: envelope }), [lookIn.issue]);
    },
    close: async () => {
      closed = true;
      for (const cancel of timers.values()) cancel();
      timers.clear();
      await tasks.close();
      newsHub.end();
    },
  };

  tasks.run("replay", async (signal) => {
    while (true) {
      await clock.sleep(config.chat.retryWakeMs, signal);
      await replay();
    }
  });
  return api;
}
