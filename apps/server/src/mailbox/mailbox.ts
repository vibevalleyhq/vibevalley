import { Clock, Context, Effect, FiberMap, FiberSet, Layer, PubSub, type Scope, Semaphore, Schema, Stream, Schedule } from "effect";
import type { SqlError } from "effect/sql";

import { t } from "@vibevalley/i18n";
import { defaultOrchestrator } from "@vibevalley/protocol";
import type * as T from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { Agent } from "#/agent/agent.ts";
import { type ApiError, refused, missing, lookIn } from "#/base/errors.ts";
import { Core } from "#/core/core.ts";
import { ServerConfig } from "#/infra/config.ts";
import { Db } from "#/infra/db.ts";
import { bestEffort } from "#/infra/log.ts";
import {
  type ChannelAudience,
  type ChannelEnvelopeRow,
  type ChannelRouteResult,
  type InboxMessage,
  type OrchestratorNews,
  senderKind,
  channelType,
  targetOf,
  summaryChannels,
  type UnreadRow,
} from "#/mailbox/envelope.ts";
import { type NotRecorded, Session } from "#/session/session.ts";
import { defaultID, orchestratorForChannel, inboxOf } from "#db/channel.sql.ts";
import * as qd from "#db/mailbox_delivery.sql.ts";
import * as qr from "#db/mailbox_trigger.sql.ts";

import { type Recipient, Reach, WakeBreaker } from "./brakes.ts";
import { Deliveries, type DeliveryRow, type DeliveryDraft } from "./deliveries.ts";
import { inputOf, orchestratorSource, deliveryScope, type InputContext, type TriggerInput, type TriggerResource, type KnownGitHubEvent } from "./payload.ts";
import { wakeInput } from "./prompts.ts";
import { makePump } from "./pump.ts";
import { channelRecipients, waitsForHuman } from "./routing.ts";
import { triggerJournal } from "./triggers.ts";
import { makeWorkMailbox } from "./work.ts";

export interface InsertDelivery {
  readonly session: string;
  readonly row: DeliveryDraft;
}

const RoutePosition = Schema.Struct({ scope: Schema.String, position: Schema.Int });
const readRouteReceipt = Schema.decodeUnknownSync(Schema.Struct({ ...RoutePosition.fields, from_owner: Schema.Boolean }));
const readOwnerRoutes = Schema.decodeUnknownSync(Schema.Array(RoutePosition));

interface QueuedInput {
  readonly issue: string;
  readonly trigger: T.Trigger;
}

/** What Collaboration hands Mailbox with a message it committed: who hears it and how it is answered. */
export interface ChannelMail {
  readonly row: ChannelEnvelopeRow;
  readonly audience: ChannelAudience;
  readonly addressed?: Recipient;
  readonly roles: Readonly<Record<string, T.AgentRole>>;
  readonly outcome?: T.Outcome;
}

/** A message already said in a direct channel, with what the reader sees of it, for the talk's first request. */
export interface TalkRow {
  readonly row: ChannelEnvelopeRow;
  readonly context: InputContext;
}

/** What can be taken back before it is handed: everything for a session that left, or one deleted message. */
export type Withdrawal =
  | { readonly _tag: "Session"; readonly session: string; readonly why: string }
  | { readonly _tag: "Envelope"; readonly envelope: string };

/** What happened to deliveries: a message taken into a model (its 👀), or a session that failed every wake. */
export type DeliveryChange =
  | { readonly _tag: "Consumed"; readonly session: string; readonly message: string }
  | { readonly _tag: "Braked"; readonly session: string; readonly failed: number };

export class Mailbox extends Context.Service<
  Mailbox,
  {
    readonly recordTrigger: (input: TriggerInput) => Effect.Effect<T.Trigger, ApiError>;
    readonly recordChannelTrigger: (trigger: T.Trigger, text: string, channel: string) => Effect.Effect<T.Trigger, ApiError>;
    readonly readTrigger: (id: string) => Effect.Effect<TriggerResource | undefined, Schema.SchemaError>;
    readonly knownGitHubEvents: (repo: string, pr: number) => Effect.Effect<readonly KnownGitHubEvent[]>;
    readonly replayCronTriggers: (consume: (trigger: T.Trigger, data: unknown) => Effect.Effect<void, ApiError | Schema.SchemaError>) => Effect.Effect<void>;
    readonly unreadSummary: (participant: string, channel: string) => Effect.Effect<UnreadRow[]>;
    readonly queuedInputs: Effect.Effect<readonly QueuedInput[]>;
    readonly issueInputs: (issue: string) => Effect.Effect<readonly T.Trigger[]>;
    readonly retireDispatches: (issue: string, at: number) => Effect.Effect<void>;
    readonly registerInitialInputs: (session: T.Session, launch: string, inputs: readonly T.Trigger[]) => Effect.Effect<void, NotRecorded>;
    readonly registered: (trigger: string) => Effect.Effect<boolean>;
    readonly receive: (trigger: T.Trigger, mail?: ChannelMail) => Effect.Effect<ChannelRouteResult, ApiError>;
    readonly subscribe: (issue: string, threads: readonly string[]) => Effect.Effect<void, ApiError>;
    readonly ownerOf: (trigger: string) => Effect.Effect<string | undefined>;
    readonly pending: (session: string) => readonly DeliveryRow[];
    readonly forOrchestrator: Effect.Effect<Stream.Stream<OrchestratorNews>, never, Scope.Scope>;
    readonly orchestratorDigest: (agent: string) => Effect.Effect<InboxMessage[]>;
    readonly start: Effect.Effect<void>;
    readonly restore: Effect.Effect<void>;
    readonly replay: Effect.Effect<void>;
    readonly insert: (input: InsertDelivery) => Effect.Effect<void, SqlError.SqlError | Schema.SchemaError>;
    /** A direct conversation's first request: its recent messages, already written, are handed with it. */
    readonly registerTalk: (session: string, launch: string, at: number, rows: readonly TalkRow[]) => Effect.Effect<void, NotRecorded>;
    readonly changes: Effect.Effect<Stream.Stream<DeliveryChange>, never, Scope.Scope>;
    readonly kick: (session: string) => Effect.Effect<void>;
    readonly returnOne: (session: string, envelope: string) => Effect.Effect<void>;
    readonly withdraw: (what: Withdrawal) => Effect.Effect<void>;
    readonly waitingOn: (envelope: string) => Effect.Effect<number>;
    readonly returnInput: (session: string, envelope: string, reason: string) => Effect.Effect<void, ApiError>;
    readonly deliverDirect: (session: string, text: string, replyChannel: string | undefined, byOwner: boolean) => Effect.Effect<void>;
  }
>()("@vibevalley/server/mailbox/mailbox") {
  static readonly layer = Layer.effect(
    Mailbox,
    Effect.gen(function* () {
      const db = yield* Db;
      const journal = yield* triggerJournal;
      const core = yield* Core;
      const sessions = yield* Session;
      const agents = yield* Agent;
      const config = yield* ServerConfig;
      const issueOf = (id: string) => core.state().issues.find((issue) => issue.id === id);
      const defaultChannelOf = Effect.gen(function* () {
        return (yield* db.one(defaultID()))?.id ?? "";
      });
      const orchestratorOf = (channel: string): Effect.Effect<string> =>
        Effect.gen(function* () {
          const own = (yield* db.one(orchestratorForChannel({ id: channel })))?.agent;
          return own && agents.isOrchestrator(own) ? own : defaultOrchestrator;
        });
      const unreadSummary = Effect.fn("Mailbox.unreadSummary")((participant: string, channel: string): Effect.Effect<UnreadRow[]> =>
        Effect.map(db.run(inboxOf({ participant, channel })), (rows) =>
          rows.slice(0, summaryChannels).map((row) => ({
            target: targetOf({ type: channelType(row.type), ...(row.root_number !== null ? { rootNumber: row.root_number } : {}) }, row.channel_name || ""),
            unread: row.unread ?? 0,
            mentionsYou: row.mentions_you === true,
            ...(row.latest_sender_name ? { latest: row.latest_sender_name } : {}),
          })),
        ),
      );
      const deliveryUnread = Effect.fn("Mailbox.deliveryUnread")(function* (who: string) {
        const h = sessions.sessionOf(who);
        const channel = h?.channel ?? (yield* defaultChannelOf);
        return yield* unreadSummary(who, channel);
      });
      const open = new Deliveries();
      const reach = new Reach();
      const received = (row: qr.MarkRoutedResult) => {
        const receipt = readRouteReceipt(row);
        if (receipt.from_owner) reach.ownerSpoke(receipt.scope, receipt.position);
      };
      const stored = (session: string, row: DeliveryRow) => {
        open.inserted(session, row);
        if (row.payload.trigger.actor.kind === "owner" && row.envelope_id !== row.payload.trigger.id) reach.ownerSpoke(row.scope, row.position);
        reach.delivered({
          scope: row.scope,
          position: row.position,
          session,
          senderKind: senderKind(row.payload.trigger.actor.kind),
          wakes: row.wakes,
          held: row.held_by !== null,
          at: row.created_at,
        });
      };
      const breaker = new WakeBreaker();
      const orchestratorHub = yield* PubSub.unbounded<OrchestratorNews>();
      const changesHub = yield* PubSub.unbounded<DeliveryChange>();
      const routeLock = yield* Semaphore.make(1);
      const routeLocked = <A, E>(effect: Effect.Effect<A, E>) => routeLock.withPermits(1)(effect);
      const pumpLock = yield* Semaphore.make(1);
      const pumpLocked = <A, E>(effect: Effect.Effect<A, E>) => pumpLock.withPermits(1)(effect);
      const writeLock = yield* Semaphore.make(1);
      const writtenLocked = <A, E>(effect: Effect.Effect<A, E>) => writeLock.withPermits(1)(Effect.uninterruptible(effect));
      const timers = yield* FiberMap.make<string>();
      const runTimer = yield* FiberMap.runtime(timers)();
      const forkHere = yield* FiberSet.makeRuntime();
      let closed = false;
      const later = (key: string, ms: number, effect: () => Effect.Effect<void>) =>
        void runTimer(
          key,
          Effect.delay(
            Effect.sync(() => {
              if (!closed) void Effect.suspend(() => (closed ? Effect.void : effect())).pipe(pumpLocked, bestEffort(`mailbox: ${key}`), forkHere);
            }),
            ms,
          ),
          { onlyIfMissing: true },
        );
      const work = yield* makeWorkMailbox({
        writtenLocked,
        received,
        stored,
        defaultChannel: defaultChannelOf,
        open,
        reach,
        breaker,
        dispatch: (session) => later(`trigger:${session}`, 0, () => pump.kick(session)),
        issueOf,
        orchestratorOf,
      });
      const flushIssue = (issue: string, human?: boolean) => routeLocked(work.flush(issue, human));
      const restore = writtenLocked(
        Effect.gen(function* () {
          const snapshot = yield* db.inTx(
            Effect.gen(function* () {
              yield* db.run(qd.rollbackAll());
              return yield* Effect.all({
                rows: db.run(qd.allOpenDeliveries()),
                scopes: db.run(qd.agentWakesByScope()),
                sessions: db.run(qd.lastAgentWakes()),
                owners: db.run(qd.lastOwnerRoutes()),
              });
            }),
          );
          open.load(snapshot.rows);
          reach.load(
            snapshot.scopes,
            snapshot.sessions.filter((row) => sessions.present(row.session_id)),
            readOwnerRoutes(snapshot.owners),
          );
        }),
      );

      let start: Effect.Effect<void> = Effect.void;
      const route = Effect.fn("Mailbox.receive")(function* (trigger: T.Trigger, mail?: ChannelMail) {
        const audience = mail ? channelRecipients(trigger, mail) : undefined;
        const result = yield* work.receive(trigger, audience);
        if (!(yield* work.registered(trigger.id))) {
          const at = yield* Clock.currentTimeMillis;
          const markRouted2 = yield* db.run(
            qr.markRouted({
              envelope_id: trigger.id,
              scope: deliveryScope(trigger.replyChannel ?? (yield* defaultChannelOf)),
              routed_at: at,
            }),
          );
          received(markRouted2);
        }
        return result ?? { heldNotice: "" };
      });

      const dropSession = (session: string, why: string) =>
        Effect.gen(function* () {
          yield* db.run(qd.dropOpen({ session_id: session, dropped_why: why }));
          open.dropped(session);
          reach.left(session);
          breaker.reset(session);
        });
      const api = Mailbox.of({
        ...journal,
        unreadSummary,
        registered: work.registered,
        queuedInputs: work.queuedInputs,
        issueInputs: work.issueInputs,
        retireDispatches: work.retireDispatches,
        registerInitialInputs: work.registerInitialInputs,
        receive: Effect.fnUntraced(
          function* (trigger: T.Trigger, mail?: ChannelMail) {
            return yield* route(trigger, mail);
          },
          (effect) => routeLocked(Effect.uninterruptible(effect)),
        ),
        subscribe: Effect.fnUntraced(function* (issue: string, threads: readonly string[]) {
          return yield* work.subscribe(issue, threads);
        }),
        ownerOf: work.ownerOf,
        pending: (session) => open.of(session),
        forOrchestrator: Effect.map(PubSub.subscribe(orchestratorHub), Stream.fromSubscription),
        orchestratorDigest: Effect.fn("Mailbox.orchestratorDigest")((agent) =>
          Effect.sync(() =>
            open
              .of(agent)
              .filter((row) => !(row.wakes && row.held_by === null))
              .map((row) => inputOf(row)),
          ),
        ),
        start: Effect.suspend(() => start),
        restore,
        replay: Effect.gen(function* () {
          let after = 0;
          while (true) {
            const rows = yield* db.run(qr.unroutedTriggers({ after }));
            const last = rows.at(-1);
            if (!last) return;
            yield* Effect.forEach(
              rows,
              (row) =>
                Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(S.Trigger))(row.trigger_json), api.receive).pipe(
                  bestEffort(`mailbox: replay ${row.id}`),
                ),
              { discard: true },
            );
            after = last.seq;
          }
        }),
        insert: work.insert,
        registerTalk: work.registerTalk,
        changes: Effect.map(PubSub.subscribe(changesHub), Stream.fromSubscription),
        kick: Effect.fn("Mailbox.kick")(function* (session) {
          yield* Effect.sync(() => later(`kick:${session}`, 0, () => pump.kick(session)));
        }),
        deliverDirect: Effect.fn("Mailbox.deliverDirect")(function* (session, text, replyChannel, byOwner) {
          yield* sessions.deliver(session, text, {
            trigger: { kind: "comment", ...(replyChannel ? { channel: replyChannel } : {}) },
            envelopeIds: [],
            byOwnerComment: byOwner,
          });
        }),
        returnOne: Effect.fn("Mailbox.returnOne")(function* (session, envelope) {
          yield* db.run(qd.rollbackOne({ session_id: session, envelope_id: envelope }));
          open.handedBackOne(session, envelope);
        }, writtenLocked),
        withdraw: Effect.fn("Mailbox.withdraw")(function* (what) {
          switch (what._tag) {
            case "Session":
              return yield* dropSession(what.session, what.why);
            case "Envelope": {
              const rows = yield* db.run(qd.dropOpenOf({ message_id: what.envelope }));
              for (const row of rows) open.remove(row.session_id, what.envelope);
              return;
            }
          }
        }, writtenLocked),
        waitingOn: Effect.fn("Mailbox.waitingOn")(function* (envelope) {
          return (yield* db.run(qd.waitingOn({ message_id: envelope }))).length;
        }),
        returnInput: Effect.fn("Mailbox.returnInput")(function* (session, envelope, reason) {
          const why = reason.trim();
          if (!why) return yield* Effect.fail(refused(t("server.issue.noTitle")));
          if (yield* routeLocked(work.returnInput(session, envelope, why))) return;
          return yield* Effect.fail(missing(t("server.issue.issueRef", { ref: envelope }), [lookIn.issue]));
        }),
      });

      const publishOrchestrator = (recipient: string, messages: readonly InboxMessage[], primary: DeliveryRow) =>
        Effect.gen(function* () {
          const meta = primary.payload.trigger.meta;
          const source = orchestratorSource(primary.payload.trigger.source);
          PubSub.publishUnsafe(orchestratorHub, {
            agent: recipient,
            channel: primary.channel_id ?? (yield* defaultChannelOf),
            type: primary.payload.channelType,
            target: inputOf(primary).target,
            messages: [...messages],
            ...(source ? { source } : {}),
            ...(meta.issue ? { issue: meta.issue } : {}),
            ...(meta.trigger ? { by: meta.trigger } : {}),
          });
        });
      const pump = makePump<InboxMessage>(sessions, {
        pending: api.pending,
        dropSession: (session, why) => writtenLocked(dropSession(session, why)),
        returnOne: api.returnOne,
        hand: work.hand,
        consume: Effect.fn("Mailbox.consume")(function* (session, envelope, at) {
          yield* db.run(qd.consumeDelivery({ session_id: session, envelope_id: envelope, consumed_at: at }));
          open.remove(session, envelope);
        }, writtenLocked),
        returnHanded: Effect.fn("Mailbox.returnHanded")(function* (session) {
          const rows = yield* db.run(qd.rollbackHanded({ session_id: session }));
          open.handedBack(session);
          return rows.map((row) => row.envelope_id);
        }, writtenLocked),
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
              .filter((row) => row.payload.trigger.actor.kind === "owner" && row.state === "pending")
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
                (!waitsForHuman(issue) || row.payload.trigger.actor.kind === "owner" || answered.has(issue.id)))
            );
          });
        },
        closed: () => closed,
        isOrchestrator: agents.isOrchestrator,
        message: (row) => inputOf(row),
        wakeInput: (recipient, _rows, messages) =>
          Effect.map(deliveryUnread(recipient), (all) =>
            wakeInput(
              [...messages],
              all.filter((other) => !messages.some((message) => message.target === other.target)),
            ),
          ),
        publishOrchestrator,
        consumedMessages: (recipient, messages) =>
          Effect.sync(() => {
            for (const message of messages) PubSub.publishUnsafe(changesHub, { _tag: "Consumed", session: recipient, message });
          }),
        breakerNotice: (recipient, failed) => Effect.sync(() => PubSub.publishUnsafe(changesHub, { _tag: "Braked", session: recipient, failed })),
        later,
        noticeBatchMs: config.chat.noticeBatchMs,
        retryWakeMs: config.chat.retryWakeMs,
      });

      const launches2 = yield* sessions.launches;
      yield* Effect.forkScoped(
        Stream.runForEach(launches2, (activity) => pumpLocked(pump.activity(activity)).pipe(bestEffort(`mailbox: ${activity.id} ${activity.kind}`))),
      );
      const inputsConsumed2 = yield* sessions.inputsConsumed;
      yield* Effect.forkScoped(
        Stream.runForEach(inputsConsumed2, (input) => pumpLocked(pump.consumed(input)).pipe(bestEffort(`mailbox: input consumed by ${input.session}`))),
      );
      const inputsReturned2 = yield* sessions.inputsReturned;
      yield* Effect.forkScoped(
        Stream.runForEach(inputsReturned2, (input) => pumpLocked(pump.returned(input)).pipe(bestEffort(`mailbox: input returned by ${input.session}`))),
      );

      const bindIssue = (issue: T.Issue) =>
        work.subscribe(issue.id, [`issue:${issue.id}`, ...(issue.repo && issue.pullRequest ? [`github:${issue.repo}#${issue.pullRequest.number}`] : [])]);
      const onFact = (fact: T.ServerEvent) =>
        Effect.gen(function* () {
          if (fact.type === "issueChanged") {
            yield* bindIssue(fact.issue);
            if (fact.issue.status === "done" || fact.issue.status === "canceled") {
              yield* flushIssue(fact.issue.id);
            } else later(`issue:${fact.issue.id}`, 0, () => flushIssue(fact.issue.id).pipe(bestEffort(`mailbox: inputs of ${fact.issue.id}`)));
          } else if (fact.type === "issueRemoved") {
            return;
          } else if (fact.type === "sessionChanged" && fact.session.issue && issueOf(fact.session.issue) !== undefined) {
            const issue = fact.session.issue;
            later(`issue:${issue}`, 0, () => flushIssue(issue).pipe(bestEffort(`mailbox: inputs of ${issue}`)));
          } else if (
            fact.type === "channelChanged" &&
            fact.channel.subjectKind === "issue" &&
            fact.channel.subjectId &&
            issueOf(fact.channel.subjectId) !== undefined
          ) {
            yield* work.subscribe(fact.channel.subjectId, [`channel:${fact.channel.id}`]);
          }
        }).pipe(bestEffort("mailbox: issue routing"));

      const [, transitions] = yield* core.transitions;
      yield* Effect.forkScoped(Stream.runForEach(transitions, ({ fact }) => onFact(fact)));

      start = Effect.gen(function* () {
        yield* api.restore;
        yield* api.replay;
        yield* Effect.forEach(
          core.state().issues,
          (issue) =>
            Effect.gen(function* () {
              yield* bindIssue(issue);
              yield* flushIssue(issue.id);
            }).pipe(bestEffort(`mailbox: restore issue ${issue.id}`)),
          { discard: true },
        );
        yield* Effect.forEach(sessions.presentSessions(), (session) => pumpLocked(pump.kick(session.id)), { discard: true });
      });
      yield* Effect.forkScoped(api.replay.pipe(Effect.repeat(Schedule.spaced(config.chat.retryWakeMs)), Effect.delay(config.chat.retryWakeMs)));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closed = true;
        }),
      );
      return api;
    }),
  );
}

export const start = Layer.effectDiscard(Effect.flatMap(Mailbox, (mailbox) => mailbox.start));
