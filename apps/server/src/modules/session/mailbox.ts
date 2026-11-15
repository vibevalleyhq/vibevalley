import { z } from "zod";

import { Hub, Semaphore, type Subscription, TaskGroup } from "@vibevalley/async";
import type * as T from "@vibevalley/protocol";
import { isBusy } from "@vibevalley/protocol/rules";
import { sessionId } from "@vibevalley/protocol/schema";

import { BizCode, Inconsistent, refuseIn } from "#/base/errors.ts";
import { jsonOf, jsonText } from "#/base/json.ts";
import type { ServerConfig } from "#/infra/config.ts";
import { causeMessage, type Db, SqlError } from "#/infra/db.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import { keyedLater, type Time } from "#/infra/time.ts";
import type { ProfileStore } from "#/modules/agent/agent.ts";
import * as qd from "#db/session_delivery.sql.ts";
import * as qr from "#db/session_trigger.sql.ts";

import { Deliveries, type DeliveryRow, type DeliveryDraft } from "./deliveries.ts";
import { type AgentWakes, type ChatView, type Delivery, type Envelope, type Handed, type Readiness, type WaitingInput } from "./envelope.ts";
import type { Lifecycle, SessionNews } from "./lifecycle.ts";
import { inputOf, orchestratorSource, deliveryScope, type SourceEvent, type TriggerInput, type TriggerResource, triggerOf } from "./payload.ts";
import { wakeInput } from "./prompts.ts";
import * as S from "./schema.ts";
import type { ChannelType, Trigger } from "./shapes.ts";
import { type Consumed, type Delivered, DeliveryRefused, type LaunchActivity, type Returned } from "./signals.ts";
import { makeWorkMailbox } from "./work.ts";

export type { SourceEvent };

export interface InsertDelivery {
  readonly session: T.SessionId;
  readonly row: DeliveryDraft;
}

const refused = refuseIn(BizCode.ChannelRefused);
const readTrigger = jsonOf(S.Trigger);
const readSource = jsonOf(z.object({ text: z.string(), data: z.unknown() }));

export interface TalkOrder {
  readonly envelope: Envelope;
  readonly channel: string;
  readonly channelType: ChannelType;
  readonly issue?: string;
}

/** A helper to hire: the profile, its brief and where it works, and the inputs it starts with. */
export interface HireArrival {
  readonly agent: T.Agent;
  readonly brief: string;
  /** Empty for a direct conversation. */
  readonly where: string;
  readonly options: Omit<SendOptions, "hiring" | "envelopeIds">;
  readonly envelopes:
    | { readonly _tag: "Talk"; readonly rows: readonly TalkOrder[] }
    | { readonly _tag: "Queued"; readonly triggers: readonly Trigger[]; readonly issue?: T.IssueId };
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
  readonly withdrawEnvelope: (envelope: T.MessageId) => Promise<void>;
  /** The chat the mailbox reads its places from, told once before boot by the layer above it; until then, an empty one. */
  readonly useChat: (view: ChatView) => void;
  /** Which waiting inputs may be handed now, told once before boot by the layer above it; until then, all. */
  readonly useReadiness: (ready: Readiness) => void;
  /** A session's pending inputs kept from waking it (held) or let wake it again: the wake breaker's, decided above. */
  readonly holdWakes: (session: string, held: boolean) => Promise<void>;
  /** What agents' words woke since the user last spoke, as kept: where the brakes start from at startup. */
  readonly agentWakes: () => Promise<AgentWakes>;
  readonly waitingOn: (envelope: T.MessageId) => Promise<number>;
  readonly close: () => Promise<void>;
}

export interface MailboxDeps {
  readonly db: Db;
  readonly clock: Time;
  readonly log: Logger;
  readonly config: ServerConfig;
  readonly agent: ProfileStore;
  readonly session: Lifecycle;
}

export async function makeMailbox(deps: MailboxDeps): Promise<Mailbox> {
  const { db, config, clock, session: sessions, agent: agents } = deps;
  const log = deps.log.child("mailbox");
  const tasks = new TaskGroup({ name: "mailbox", onError: (task, e) => log.error(`${task} failed:`, e) });
  const allReady: Readiness = (inputs) => inputs.map(() => true);
  const emptyChat: ChatView = { defaultChannel: () => "", unreadOf: async () => [] };
  let stage: "wiring" | "booted" = "wiring";
  let readiness: Readiness | undefined;
  let chat: ChatView | undefined;
  const currentChat = () => chat ?? emptyChat;
  const defaultChannelOf = async () => currentChat().defaultChannel();
  const deliveryUnread = async (who: string) => {
    const h = sessions.sessionOf(who);
    const view = currentChat();
    return view.unreadOf(who, h?.channel ?? view.defaultChannel());
  };
  const open = new Deliveries();
  const stored = (session: string, row: DeliveryRow) => open.inserted(session, row);
  /** The sessions the wake breaker holds: their inputs wait until it lets them go. */
  const braked = new Set<string>();
  const holds = new Map<string, Set<"compacting">>();
  const held = (session: string) => (holds.get(session)?.size ?? 0) > 0;
  const hold = (session: string, reason: "compacting", on: boolean) => {
    const reasons = holds.get(session) ?? new Set();
    if (on) {
      reasons.add(reason);
      holds.set(session, reasons);
    } else {
      reasons.delete(reason);
      if (reasons.size === 0) holds.delete(session);
    }
  };
  const newsHub = new Hub<DeliveryNews>();
  const pumpLock = new Semaphore(1);
  const pumpLocked = <A>(work: () => Promise<A>) => pumpLock.with(work);
  const writeLock = new Semaphore(1);
  // A write, once begun, runs to its end: none is handed a signal.
  const writtenLocked = <A>(work: () => Promise<A>) => writeLock.with(work);
  const timers = keyedLater(clock);
  const later = (key: string, ms: number, work: () => Promise<void>) =>
    timers.schedule(key, ms, () => {
      tasks.run(`mailbox: ${key}`, () =>
        bestEffort(log, `mailbox: ${key}`, () =>
          pumpLocked(async () => {
            if (!timers.isClosed()) await work();
          }),
        ),
      );
    });
  const work = makeWorkMailbox({ db, clock, session: sessions, agent: agents }, { writtenLocked, stored, defaultChannel: defaultChannelOf, open });
  const dispatch = (session: string) => later(`trigger:${session}`, 0, () => kick(session));

  const readTriggerRecord = async (id: string): Promise<TriggerResource | undefined> => {
    const row = await qr.triggerById(db.sql, { id });
    return row ? { trigger: readTrigger(row.trigger_json), payload: readSource(row.payload_json) } : undefined;
  };

  // No routing or background task here: the source cursor and this record must share the caller's transaction.
  const keepTrigger = async (trigger: Trigger, key: string, payload: TriggerResource["payload"]): Promise<Trigger> => {
    try {
      await qr.recordTrigger(db.sql, {
        id: trigger.id,
        source: trigger.source,
        source_key: key,
        occurred_at: trigger.at,
        trigger_json: jsonText(S.Trigger.parse(trigger)),
        payload_json: jsonText(payload),
      });
      const saved = await qr.triggerById(db.sql, { id: trigger.id });
      if (saved === undefined) throw new Inconsistent(`trigger ${trigger.id} was not kept`);
      return readTrigger(saved.trigger_json);
    } catch (e) {
      // What the caller is told: the database's failure, or a trigger that does not fit its shape.
      if (e instanceof SqlError || e instanceof z.ZodError || e instanceof SyntaxError) throw refused(causeMessage(e));
      throw e;
    }
  };

  const recordTrigger = (input: TriggerInput) => keepTrigger(triggerOf(input), input.key, { text: input.text, data: input.data ?? null });

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
      ...(envelopes._tag === "Talk" ? { envelopeIds: envelopes.rows.map((order) => order.envelope.id) } : {}),
      hiring: async (s, launch) => {
        const at = clock.now();
        await arrival.hiring(s, launch, at);
        switch (envelopes._tag) {
          case "Talk":
            return work.registerTalk(s.id, launch, at, envelopes.rows);
          case "Queued":
            if (envelopes.triggers.length > 0) await work.registerInitialInputs(s, launch, envelopes.triggers, envelopes.issue);
            return;
        }
      },
    });
    // Kick the pump in case messages arrived in the conversation while hiring was in flight.
    if (envelopes._tag === "Talk") later(`kick:${session.id}`, 0, () => kick(session.id));
    return { hired: session, ...(room.evicted ? { evicted: room.evicted } : {}) };
  };

  const dropSession = (session: T.SessionId, why: string) =>
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
  const handBack = (rawSession: string, envelope: string) => {
    const session = sessionId(rawSession);
    return writtenLocked(() =>
      db.tx(async () => {
        await qd.rollbackOne(db.sql, { session_id: session, envelope_id: envelope });
        await db.afterCommit(() => open.handedBackOne(session, envelope));
      }),
    );
  };

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
  const consumeDelivery = (rawSession: string, envelope: string, at: number) => {
    const session = sessionId(rawSession);
    return writtenLocked(() =>
      db.tx(async () => {
        await qd.consumeDelivery(db.sql, { session_id: session, envelope_id: envelope, consumed_at: at });
        await db.afterCommit(() => open.remove(session, envelope));
      }),
    );
  };

  const returnHanded = (rawSession: string) => {
    const session = sessionId(rawSession);
    return writtenLocked(() =>
      db.tx(async () => {
        const rows = await qd.rollbackHanded(db.sql, { session_id: session });
        await db.afterCommit(() => open.handedBack(session));
        return rows.map((row) => row.envelope_id);
      }),
    );
  };

  const readyInputs = (recipient: string, rows: readonly DeliveryRow[]) => {
    const current = sessions.sessionOf(recipient)?.scope;
    const inputs = rows.map((row): WaitingInput => {
      const issue = row.payload.trigger.meta.issue;
      return {
        ...(issue ? { issue } : {}),
        ...(current ? { sessionScope: current } : {}),
        fromUser: row.payload.trigger.actor.kind === "user",
        pending: row.state === "pending",
      };
    });
    const ready = (readiness ?? allReady)(inputs);
    return rows.filter((_, i) => ready[i] === true);
  };

  const wakeText = async (recipient: string, messages: readonly Envelope[]) => {
    const all = await deliveryUnread(recipient);
    return wakeInput(
      [...messages],
      all.filter((other) => !messages.some((message) => message.target === other.target)),
    );
  };

  /** What came of handing rows to recipient; refused says why it was not woken. */
  const deliver = async (recipient: string, text: string, rows: readonly DeliveryRow[]): Promise<Delivered | { readonly refused: string }> => {
    const first = rows.findLast((row) => row.payload.trigger.actor.kind === "user") ?? rows.find((row) => row.wakes && row.held_by === null) ?? rows[0];
    if (!first) return { refused: "empty" };
    try {
      return await sessions.deliver(recipient, text, {
        trigger:
          first.payload.trigger.meta.trigger !== undefined
            ? { ...first.payload.trigger.meta.trigger, message: first.envelope_id }
            : { kind: "comment", message: first.envelope_id, ...(first.channel_id ? { channel: first.channel_id } : {}) },
        envelopeIds: rows.map((row) => row.envelope_id),
        byUserComment: rows.some((row) => row.payload.trigger.actor.kind === "user"),
      });
    } catch (e) {
      if (e instanceof DeliveryRefused) return { refused: e.reason };
      throw e;
    }
  };

  const kick = async (recipient: string): Promise<void> => {
    const rows = readyInputs(recipient, open.of(recipient));
    if (held(recipient)) return;
    const waking = rows.filter((row) => row.wakes && row.held_by === null && row.state === "pending");
    if (agents.isHosted(recipient)) {
      const now = clock.now();
      for (const [scope, allowed] of Map.groupBy(waking, (row) => row.scope)) {
        const grouped = rows.filter((row) => row.scope === scope && row.state === "pending");
        const primary = allowed.findLast((row) => row.payload.trigger.actor.kind === "user") ?? allowed[0];
        if (!primary) continue;
        const messages = grouped.map(inputOf);
        for (const row of grouped) await work.hand(recipient, row.envelope_id, `orchestrator:${row.envelope_id}`, now);
        await handToHost(recipient, messages, primary);
      }
      return;
    }
    const session = sessions.sessionOf(recipient);
    if (!session) return writtenLocked(() => dropSession(sessionId(recipient), "left"));
    if (isBusy(session)) {
      if (rows.some((row) => row.state === "pending" && row.held_by === null)) later(`notice:${recipient}`, config.chat.noticeBatchMs, () => notify(recipient));
      return;
    }
    if (waking.length === 0 || braked.has(recipient)) return;
    const batch = rows.filter((row) => row.state === "pending");
    const messages = batch.map(inputOf);
    const input = await wakeText(recipient, messages);
    const delivered = await deliver(recipient, input, batch);
    if ("refused" in delivered) {
      log.info(`mailbox: ${recipient} not woken: ${delivered.refused}`);
      return;
    }
    const now = clock.now();
    for (const row of batch) await work.hand(recipient, row.envelope_id, delivered.launch, now);
  };

  const notify = async (recipient: string): Promise<void> => {
    if (held(recipient)) return;
    const session = sessions.sessionOf(recipient);
    if (!session) return;
    if (!isBusy(session)) return kick(recipient);
    const rows = readyInputs(recipient, open.of(recipient)).filter((row) => row.state === "pending" && row.urgency !== "queue");
    if (!rows.some((row) => row.urgency === "steer" && row.held_by === null)) return;
    const input = await wakeText(recipient, rows.map(inputOf));
    const delivered = await deliver(recipient, input, rows);
    if ("refused" in delivered) return;
    const now = clock.now();
    for (const row of rows) await work.hand(recipient, row.envelope_id, delivered.launch, now);
  };

  const activity = async (event: LaunchActivity): Promise<void> => {
    if (timers.isClosed()) return;
    switch (event._tag) {
      case "Spoke":
      case "Settling":
        return;
      case "HandedOff":
      case "Ended": {
        const rolled = await returnHanded(event.id);
        if (rolled.length > 0) {
          if (!event.spoke) newsHub.publish({ _tag: "EmptyWake", session: event.id });
          later(`wake:${event.id}`, config.chat.retryWakeMs, () => kick(event.id));
          return;
        }
        return kick(event.id);
      }
      case "Closed":
        await returnHanded(event.id);
        return;
      case "Compacting":
        hold(event.id, "compacting", event.on);
        if (!event.on && !held(event.id)) await kick(event.id);
        return;
    }
  };

  const consumed = async (input: Consumed): Promise<void> => {
    const now = clock.now();
    const accepted = new Set(input.envelopeIds);
    const messages = open.of(input.session).flatMap((row) => (accepted.has(row.envelope_id) && row.message_id !== null ? [row.message_id] : []));
    for (const id of input.envelopeIds) await consumeDelivery(input.session, id, now);
    for (const message of messages) newsHub.publish({ _tag: "Consumed", session: input.session, envelope: message });
  };

  const returned = async (input: Returned): Promise<void> => {
    for (const id of input.envelopeIds) await handBack(input.session, id);
  };

  const onNews = (news: SessionNews): Promise<void> => {
    switch (news._tag) {
      case "Consumed":
        return bestEffort(log, `mailbox: input consumed by ${news.session}`, () => pumpLocked(() => consumed(news)));
      case "Returned":
        return bestEffort(log, `mailbox: input returned by ${news.session}`, () => pumpLocked(() => returned(news)));
      case "Left":
        // What was for it goes with it: a session that left takes no more inputs.
        return bestEffort(log, `mailbox: ${news.left.id} left`, () => writtenLocked(() => dropSession(news.left.id, "left")));
      case "Spoke":
      case "Ended":
      case "HandedOff":
      case "Settling":
      case "Closed":
      case "Compacting":
        return bestEffort(log, `mailbox: ${news.id} ${news._tag}`, () => pumpLocked(() => activity(news)));
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
    readTrigger: readTriggerRecord,
    recordTrigger,
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
      stage = "booted";
      await restore();
      for (const session of sessions.hired()) await pumpLocked(() => kick(session.id));
    },
    restore,
    news: () => newsHub.subscribe(),
    handBack,
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
      if (stage === "booted") throw new Inconsistent("Session.useChat cannot be called after boot");
      if (chat !== undefined) throw new Inconsistent("Session.useChat cannot be called more than once");
      chat = view;
    },
    useReadiness: (ready) => {
      if (stage === "booted") throw new Inconsistent("Session.useReadiness cannot be called after boot");
      if (readiness !== undefined) throw new Inconsistent("Session.useReadiness cannot be called more than once");
      readiness = ready;
    },
    holdWakes: async (session, heldOn) => {
      const changed = await writtenLocked(async () => {
        if (heldOn) {
          braked.add(session);
          return false;
        }
        return braked.delete(session);
      });
      if (changed) await pumpLocked(() => kick(session));
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
      timers.close();
      await tasks.close();
      newsHub.end();
    },
  };

  return api;
}
