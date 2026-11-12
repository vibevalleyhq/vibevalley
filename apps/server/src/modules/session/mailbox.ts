import { Hub, Semaphore, type Subscription, TaskGroup } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { defaultOrchestrator } from "@vibevalley/protocol";

import { BizCode, Inconsistent, lookIn, missing, refuseIn } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import { jsonOf } from "#/base/json.ts";
import type { Core } from "#/core/core.ts";
import type { ServerConfig } from "#/infra/config.ts";
import type { Db } from "#/infra/db.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Agent } from "#/modules/agent/agent.ts";
import * as qd from "#db/session_delivery.sql.ts";
import * as qr from "#db/session_trigger.sql.ts";

import { Deliveries, type DeliveryRow, type DeliveryDraft } from "./deliveries.ts";
import { type AgentWakes, type ChannelEnvelopeRow, type ChatView, type Envelope, type Handed, type Hearer, type IssueView } from "./envelope.ts";
import type { Lifecycle, SessionNews } from "./lifecycle.ts";
import { inputOf, orchestratorSource, deliveryScope, type InputContext, type SourceEvent, type TriggerInput, type TriggerResource } from "./payload.ts";
import { wakeInput } from "./prompts.ts";
import { makePump } from "./pump.ts";
import { waitsForHuman } from "./routing.ts";
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

const readTrigger = jsonOf(S.Trigger);

export interface QueuedInput {
  readonly issue: string;
  readonly trigger: Trigger;
}

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

/** What an issue's next helper is to be told when it is sent: the issue's words, or the ones it was started with. */
export interface Dispatch {
  readonly issue: string;
  /** The profile that is to take it. */
  readonly agent: string;
  readonly text: string;
  /** Where its helper answers. */
  readonly channel: string;
  readonly by: T.RunTrigger;
  readonly at: number;
}

export type DeliveryNews =
  | { readonly _tag: "Consumed"; readonly session: string; readonly envelope: string }
  /** A wake that ended before the session said a word, its inputs handed back: what the wake breaker counts. */
  | { readonly _tag: "EmptyWake"; readonly session: string }
  | Handed;

export interface Mailbox {
  readonly record: (event: SourceEvent) => Promise<Trigger | undefined>;
  readonly accept: (event: SourceEvent) => Promise<Trigger | undefined>;
  readonly recordTrigger: (input: TriggerInput) => Promise<Trigger>;
  /** A dispatch held for the issue's next helper: recorded in the caller's transaction, routed once it commits. */
  readonly queueDispatch: (dispatch: Dispatch) => Promise<void>;
  readonly readTrigger: (id: string) => Promise<TriggerResource | undefined>;
  readonly replayCronTriggers: (consume: (trigger: Trigger, data: unknown) => Promise<void>) => Promise<void>;
  readonly triggersOf: (issue: string) => Promise<readonly Trigger[]>;
  /** Dispatches first, then routed order. */
  readonly queuedTriggers: () => Promise<readonly QueuedInput[]>;
  readonly isRouted: (trigger: string) => Promise<boolean>;
  /** A recorded trigger routed to who hears it (hearers when given, as the layer above braked them); refusals are ApiErrors. */
  readonly route: (trigger: Trigger, hearers?: readonly Hearer[]) => Promise<void>;
  /** A helper hired with its first inputs; throws HireRefused. */
  readonly hireWith: (arrival: HireArrival) => Promise<HiredReceipt>;
  readonly subscribe: (issue: string, threads: readonly string[]) => Promise<void>;
  readonly ownerOf: (trigger: string) => Promise<string | undefined>;
  readonly deliveriesOf: (session: string) => readonly DeliveryRow[];
  readonly orchestratorDigest: (agent: string) => Promise<Envelope[]>;
  /** At startup, after the modules below it started: restores the open deliveries, routes what was left, wakes who waits. */
  readonly boot: () => Promise<void>;
  readonly restore: () => Promise<void>;
  readonly replay: () => Promise<void>;
  /** What the mailbox tells, subscribed before it returns. */
  readonly news: () => Subscription<DeliveryNews>;
  readonly handBack: (session: string, envelope: string) => Promise<void>;
  /** A channel message's envelope taken back from every delivery that still waits on it. */
  readonly withdrawEnvelope: (envelope: string) => Promise<void>;
  /** A session's open deliveries dropped: it left. */
  readonly withdrawDeliveries: (session: string, why: string) => Promise<void>;
  /** An issue's dispatches recorded before `at` taken back; in its own transaction, outside writeLock. */
  readonly withdrawDispatches: (issue: string, at: number) => Promise<void>;
  /** The chat the mailbox reads its places from, told by the layer above it; until then, an empty one. */
  readonly useChat: (view: ChatView) => void;
  /** The issues the mailbox reads, told by the layer above it; until then, none. */
  readonly useIssues: (view: IssueView) => void;
  /** A session's pending inputs kept from waking it (held) or let wake it again: the wake breaker's, decided above. */
  readonly holdWakes: (session: string, held: boolean) => Promise<void>;
  /** What agents' words woke since the user last spoke, as kept: where the brakes start from at startup. */
  readonly agentWakes: () => Promise<AgentWakes>;
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
  readonly session: Lifecycle;
}

export async function makeMailbox(deps: MailboxDeps): Promise<Mailbox> {
  const { db, core, config, clock, session: sessions, agent: agents } = deps;
  const log = deps.log.child("mailbox");
  const journal = triggerJournal({ db, log });
  const tasks = new TaskGroup({ name: "mailbox", onError: (task, e) => log.error(`${task} failed:`, e) });
  let issueView: IssueView = { issues: () => [], exists: async () => false };
  const issueOf = (id: string) => issueView.issues().find((issue) => issue.id === id);
  let chat: ChatView = { defaultChannel: () => "", orchestratorIn: () => defaultOrchestrator, unreadOf: async () => [] };
  const defaultChannelOf = async () => chat.defaultChannel();
  const orchestratorInChannel = async (channel: string) => chat.orchestratorIn(channel);
  const deliveryUnread = async (who: string) => {
    const h = sessions.sessionOf(who);
    return chat.unreadOf(who, h?.channel ?? chat.defaultChannel());
  };
  const open = new Deliveries();
  const stored = (session: string, row: DeliveryRow) => open.inserted(session, row);
  /** The sessions the wake breaker holds: their inputs wait until it lets them go. */
  const braked = new Set<string>();
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
      stored,
      defaultChannel: defaultChannelOf,
      open,
      dispatch: (session) => later(`trigger:${session}`, 0, () => pump.kick(session)),
      issueOf,
      issueKept: (id) => issueView.exists(id),
      orchestratorIn: orchestratorInChannel,
    },
  );
  const flushIssue = (issue: string, human?: boolean) => routeLocked(() => work.flush(issue, human));
  const restore = () =>
    writtenLocked(async () => {
      const rows = await db.tx(async () => {
        await qd.rollbackAll(db.sql);
        return qd.allOpenDeliveries(db.sql);
      });
      open.load(rows);
    });

  // Routing is one at a time and, once begun, runs to its end.
  const route = (trigger: Trigger, hearers?: readonly Hearer[]): Promise<void> =>
    routeLocked(async () => {
      const audience: readonly OutboundDelivery[] | undefined = hearers?.map((h) => ({
        trigger,
        session: h.session,
        delivery: { reason: h.reason, wakes: h.wakes, ...(h.heldBy ? { heldBy: h.heldBy } : {}) },
        role: h.role,
        event: h.event,
        commit: async () => {},
      }));
      await work.receive(trigger, audience);
      if (!(await work.isRouted(trigger.id))) {
        const routed = await qr.markRouted(db.sql, {
          envelope_id: trigger.id,
          scope: deliveryScope(trigger.replyChannel ?? (await defaultChannelOf())),
          routed_at: clock.now(),
        });
        if (routed === undefined) throw new Inconsistent(`trigger ${trigger.id} was routed before it was recorded`);
      }
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
        braked.delete(session);
      });
    });
  const record = async (event: SourceEvent) => {
    if (event.selfEcho === true) return undefined;
    return journal.recordTrigger(event);
  };
  const accept = async (event: SourceEvent) => {
    const trigger = await record(event);
    if (trigger) await route(trigger);
    return trigger;
  };
  const replay = async () => {
    let after = 0;
    while (true) {
      const rows = await qr.unroutedTriggers(db.sql, { after });
      const last = rows.at(-1);
      if (!last) return;
      for (const row of rows) await bestEffort(log, `mailbox: replay ${row.id}`, () => route(readTrigger(row.trigger_json)));
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

  const queueDispatch = async (d: Dispatch) => {
    const trigger = await journal.recordTrigger({
      source: "workbench",
      key: newId(),
      actor: { kind: "system", id: "system" },
      text: d.text,
      threads: [`issue:${d.issue}`],
      addressed: "thread_owner",
      replyChannel: d.channel,
      meta: { ingressRecipient: d.agent, issue: d.issue, trigger: d.by, dispatch: true },
      at: d.at,
    });
    await db.afterCommit(() => bestEffort(log, `issue: route ${trigger.id}`, () => route(trigger)));
  };

  const api: Mailbox = {
    ...journal,
    record,
    queueDispatch,
    accept,
    isRouted: work.isRouted,
    triggersOf: work.issueInputs,
    queuedTriggers: work.queuedInputs,
    route,
    hireWith: hire,
    subscribe: (issue, threads) => work.subscribe(issue, threads),
    ownerOf: work.ownerOf,
    deliveriesOf: (session) => open.of(session),
    orchestratorDigest: async (agent) =>
      open
        .of(agent)
        .filter((row) => !(row.wakes && row.held_by === null))
        .map((row) => inputOf(row)),
    boot: async () => {
      await restore();
      await replay();
      for (const issue of issueView.issues())
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
    withdrawDispatches: (issue, at) => work.retireDispatches(issue, at),
    useChat: (view) => {
      chat = view;
    },
    useIssues: (view) => {
      issueView = view;
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
