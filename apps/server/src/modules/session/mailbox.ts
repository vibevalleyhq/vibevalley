import { z } from "zod";

import { Hub, Semaphore, type Subscription, TaskGroup } from "@vibevalley/async";
import type * as T from "@vibevalley/protocol";

import { Inconsistent } from "#/base/errors.ts";
import { jsonOf } from "#/base/json.ts";
import type { ServerConfig } from "#/infra/config.ts";
import type { Db } from "#/infra/db.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Agent } from "#/modules/agent/agent.ts";
import * as qd from "#db/session_delivery.sql.ts";
import * as qr from "#db/session_trigger.sql.ts";

import { Deliveries, type DeliveryRow, type DeliveryDraft } from "./deliveries.ts";
import {
  type AgentWakes,
  type ChannelEnvelopeRow,
  type ChatView,
  type Delivery,
  type Envelope,
  type Handed,
  type Readiness,
  type WaitingInput,
} from "./envelope.ts";
import type { Lifecycle, SessionNews } from "./lifecycle.ts";
import { inputOf, orchestratorSource, deliveryScope, type InputContext, type SourceEvent, type TriggerInput, type TriggerResource } from "./payload.ts";
import { wakeInput } from "./prompts.ts";
import { makePump } from "./pump.ts";
import * as S from "./schema.ts";
import type { Trigger } from "./shapes.ts";
import { triggerJournal } from "./triggers.ts";
import { makeWorkMailbox } from "./work.ts";

export type { SourceEvent };

export interface InsertDelivery {
  readonly session: string;
  readonly row: DeliveryDraft;
}

const readTrigger = jsonOf(S.Trigger);
const readSource = jsonOf(z.object({ text: z.string(), data: z.unknown() }));

export interface TalkRow {
  readonly row: ChannelEnvelopeRow;
  readonly context: InputContext;
}

/** A helper to hire: the profile, its brief and where it works, and the inputs it starts with. */
export interface HireArrival {
  readonly agent: T.Agent;
  readonly brief: string;
  /** Empty for a direct conversation. */
  readonly where: string;
  readonly options: Omit<SendOptions, "hiring" | "envelopeIds">;
  readonly envelopes: { readonly _tag: "Talk"; readonly rows: readonly TalkRow[] } | { readonly _tag: "Queued"; readonly triggers: readonly Trigger[] };
  /** Runs inside the session hire transaction before the session is visible. */
  readonly hiring: (session: T.Session, launch: string, at: number) => Promise<void>;
}

type SendOptions = Parameters<Lifecycle["hire"]>[3];

export interface HiredReceipt {
  readonly hired: T.Session;
  readonly evicted?: string;
}

export type DeliveryNews =
  | { readonly _tag: "Consumed"; readonly session: string; readonly envelope: string }
  /** A wake that ended before the session said a word, its inputs handed back: what the wake breaker counts. */
  | { readonly _tag: "EmptyWake"; readonly session: string }
  | Handed;

export interface Mailbox {
  readonly recordTrigger: (input: TriggerInput) => Promise<Trigger>;
  readonly readTrigger: (id: string) => Promise<TriggerResource | undefined>;
  /** Each trigger recorded and not routed but the chat's (the watch reads those again), in order, with its source's data. */
  readonly unrouted: (consume: (trigger: Trigger, data: unknown) => Promise<void>) => Promise<void>;
  readonly isRouted: (trigger: string) => Promise<boolean>;
  /** A recorded trigger delivered to each of to, then kept as routed (where scope says when it went to no one). */
  readonly route: (trigger: Trigger, to: readonly Delivery[], scope?: string) => Promise<void>;
  /** A helper hired with its first inputs; throws HireRefused. */
  readonly hireWith: (arrival: HireArrival) => Promise<HiredReceipt>;
  readonly deliveriesOf: (session: string) => readonly DeliveryRow[];
  readonly orchestratorDigest: (agent: string) => Promise<Envelope[]>;
  /** At startup, after the modules below it started: restores the open deliveries and wakes who waits. */
  readonly boot: () => Promise<void>;
  readonly restore: () => Promise<void>;
  /** What the mailbox tells, subscribed before it returns. */
  readonly news: () => Subscription<DeliveryNews>;
  readonly handBack: (session: string, envelope: string) => Promise<void>;
  /** A channel message's envelope taken back from every delivery that still waits on it. */
  readonly withdrawEnvelope: (envelope: string) => Promise<void>;
  /** A session's open deliveries dropped: it left. */
  readonly withdrawDeliveries: (session: string, why: string) => Promise<void>;
  /** The chat the mailbox reads its places from, told by the layer above it; until then, an empty one. */
  readonly useChat: (view: ChatView) => void;
  /** Which waiting inputs may be handed now, told by the layer above it; until then, all. */
  readonly useReadiness: (ready: Readiness) => void;
  /** A session's pending inputs kept from waking it (held) or let wake it again: the wake breaker's, decided above. */
  readonly holdWakes: (session: string, held: boolean) => Promise<void>;
  /** What agents' words woke since the user last spoke, as kept: where the brakes start from at startup. */
  readonly agentWakes: () => Promise<AgentWakes>;
  readonly waitingOn: (envelope: string) => Promise<number>;
  readonly close: () => Promise<void>;
}

export interface MailboxDeps {
  readonly db: Db;
  readonly clock: Time;
  readonly log: Logger;
  readonly config: ServerConfig;
  readonly agent: Agent;
  readonly session: Lifecycle;
}

export async function makeMailbox(deps: MailboxDeps): Promise<Mailbox> {
  const { db, config, clock, session: sessions, agent: agents } = deps;
  const log = deps.log.child("mailbox");
  const journal = triggerJournal({ db });
  const tasks = new TaskGroup({ name: "mailbox", onError: (task, e) => log.error(`${task} failed:`, e) });
  let readiness: Readiness = (inputs) => inputs.map(() => true);
  let chat: ChatView = { defaultChannel: () => "", unreadOf: async () => [] };
  const defaultChannelOf = async () => chat.defaultChannel();
  const deliveryUnread = async (who: string) => {
    const h = sessions.sessionOf(who);
    return chat.unreadOf(who, h?.channel ?? chat.defaultChannel());
  };
  const open = new Deliveries();
  const stored = (session: string, row: DeliveryRow) => open.inserted(session, row);
  /** The sessions the wake breaker holds: their inputs wait until it lets them go. */
  const braked = new Set<string>();
  const newsHub = new Hub<DeliveryNews>();
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
  const work = makeWorkMailbox({ db, clock, session: sessions, agent: agents }, { writtenLocked, stored, defaultChannel: defaultChannelOf, open });
  const dispatch = (session: string) => later(`trigger:${session}`, 0, () => pump.kick(session));
  const restore = () =>
    writtenLocked(async () => {
      const rows = await db.tx(async () => {
        await qd.rollbackAll(db.sql);
        return qd.allOpenDeliveries(db.sql);
      });
      open.load(rows);
    });

  const route = async (trigger: Trigger, to: readonly Delivery[], scope?: string): Promise<void> => {
    await work.forward(trigger, to);
    for (const input of to) dispatch(input.session);
    if (await work.isRouted(trigger.id)) return;
    const routed = await qr.markRouted(db.sql, {
      envelope_id: trigger.id,
      scope: scope ?? deliveryScope(trigger.replyChannel ?? (await defaultChannelOf())),
      routed_at: clock.now(),
    });
    if (routed === undefined) throw new Inconsistent(`trigger ${trigger.id} was routed before it was recorded`);
  };

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
        braked.delete(session);
      });
    });
  const unrouted = async (consume: (trigger: Trigger, data: unknown) => Promise<void>) => {
    let after = 0;
    while (true) {
      const rows = await qr.unroutedTriggers(db.sql, { after });
      const last = rows.at(-1);
      if (!last) return;
      for (const row of rows)
        await bestEffort(log, `mailbox: replay ${row.id}`, () => consume(readTrigger(row.trigger_json), readSource(row.payload_json).data));
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
      emptyWake: (session) => newsHub.publish({ _tag: "EmptyWake", session }),
      braked: (session) => braked.has(session),

      readyInputs: (recipient, rows) => {
        const current = sessions.sessionOf(recipient)?.issue;
        const inputs = rows.map((row): WaitingInput => {
          const issue = row.payload.trigger.meta.issue ?? current;
          return { ...(issue ? { issue } : {}), fromUser: row.payload.trigger.actor.kind === "user", pending: row.state === "pending" };
        });
        const ready = readiness(inputs);
        return rows.filter((_, i) => ready[i] === true);
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

  const api: Mailbox = {
    ...journal,
    unrouted,
    isRouted: work.isRouted,
    route,
    hireWith: hire,
    deliveriesOf: (session) => open.of(session),
    orchestratorDigest: async (agent) =>
      open
        .of(agent)
        .filter((row) => !(row.wakes && row.held_by === null))
        .map((row) => inputOf(row)),
    boot: async () => {
      await restore();
      for (const session of sessions.hired()) await pumpLocked(() => pump.kick(session.id));
    },
    restore,
    news: () => newsHub.subscribe(),
    handBack,
    withdrawDeliveries: (session, why) => writtenLocked(() => dropSession(session, why)),
    withdrawEnvelope: (envelope) =>
      writtenLocked(() =>
        db.tx(async () => {
          const rows = await qd.dropOpenOf(db.sql, { message_id: envelope });
          await db.afterCommit(() => {
            for (const row of rows) open.remove(row.session_id, envelope);
          });
        }),
      ),
    useChat: (view) => {
      chat = view;
    },
    useReadiness: (ready) => {
      readiness = ready;
    },
    holdWakes: async (session, held) => {
      if (held) braked.add(session);
      else if (braked.delete(session)) await pumpLocked(() => pump.kick(session));
    },
    agentWakes: async () => {
      const [scopes, last] = await Promise.all([qd.agentWakesByScope(db.sql), qd.lastAgentWakes(db.sql)]);
      return {
        scopes: scopes.map((row) => ({ scope: row.scope, n: row.n ?? 0 })),
        sessions: last.filter((row) => sessions.isReachable(row.session_id)).map((row) => ({ session: row.session_id, at: row.at ?? 0 })),
      };
    },
    waitingOn: async (envelope) => (await qd.waitingOn(db.sql, { message_id: envelope })).length,
    close: async () => {
      closed = true;
      for (const cancel of timers.values()) cancel();
      timers.clear();
      await tasks.close();
      newsHub.end();
    },
  };

  return api;
}
