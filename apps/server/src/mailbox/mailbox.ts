import { Clock, Context, Effect, FiberMap, FiberSet, Layer, PubSub, type Scope, Semaphore, Schema, Stream, Schedule } from "effect";

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
  type ChannelEnvelopeRow,
  type ChannelRouteResult,
  type Envelope,
  type ChannelHearers,
  type Handed,
  senderKind,
  channelType,
  targetOf,
  summaryChannels,
  type UnreadRow,
} from "#/mailbox/envelope.ts";
import { type NotRecorded, Session } from "#/session/session.ts";
import { defaultID, orchestratorForChannel, unreadOf } from "#db/channel.sql.ts";
import * as qd from "#db/mailbox_delivery.sql.ts";
import * as qr from "#db/mailbox_trigger.sql.ts";

import { Reach, WakeBreaker } from "./brakes.ts";
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

export interface QueuedInput {
  readonly issue: string;
  readonly trigger: T.Trigger;
}

/** A message already said in a direct channel, with what the reader sees of it, for the talk's first request. */
export interface TalkRow {
  readonly row: ChannelEnvelopeRow;
  readonly context: InputContext;
}

/** What comes to the door: a recorded trigger, for those its threads reach, the hearers of a channel message, or one
 * session told straight; or the owner's first words in a direct conversation with a profile that has no session yet. */
export type Arrival =
  | { readonly _tag: "Trigger"; readonly trigger: T.Trigger; readonly to?: ChannelHearers | { readonly session: string } }
  | {
      readonly _tag: "Hire";
      readonly agent: T.Agent;
      readonly brief: string;
      /** The repo or workdir it works in; empty for a direct conversation. */
      readonly where: string;
      /** How it is sent (its issue or channel, what its first run is for, its branch); the door adds the rest. */
      readonly options: Omit<SendOptions, "hiring" | "envelopeIds">;
      /** What is handed with its first request: a conversation's recent messages, or an issue's queued triggers. */
      readonly envelopes: { readonly _tag: "Talk"; readonly rows: readonly TalkRow[] } | { readonly _tag: "Queued"; readonly triggers: readonly T.Trigger[] };
      /** The caller's own rows, written with the session before anyone can see it. */
      readonly hiring: (session: T.Session, launch: string, at: number) => Effect.Effect<void, NotRecorded>;
    };

type SendOptions = Parameters<Session["Service"]["hire"]>[3];

/** What the door did: a held notice for a channel; for a hire, the session hired or why none was, and who was
 * sent home to make room. */
export interface Received extends ChannelRouteResult {
  readonly hired?: T.Session;
  readonly refused?: string;
  readonly evicted?: string;
  /** A refused hire left work behind: its issue identity must be kept. */
  readonly retainedWork?: true;
}

/** What can be taken back before it is handed: everything for a session that left, or one deleted message. */
export type Withdrawal =
  | { readonly _tag: "Session"; readonly session: string; readonly why: string }
  | { readonly _tag: "Envelope"; readonly envelope: string }
  /** An issue's dispatches up to at, once it is closed or handed on: its own transaction, not the write lock. */
  | { readonly _tag: "Issue"; readonly issue: string; readonly at: number };

/** What happened to deliveries: a message taken into a model (its 👀), a session that failed every wake, or what came
 * for an orchestrator in one conversation, handed to it. */
export type DeliveryNews =
  | { readonly _tag: "Consumed"; readonly session: string; readonly envelope: string }
  | { readonly _tag: "Braked"; readonly session: string; readonly failed: number }
  | Handed;

export class Mailbox extends Context.Service<
  Mailbox,
  {
    readonly recordTrigger: (input: TriggerInput) => Effect.Effect<T.Trigger, ApiError>;
    readonly readTrigger: (id: string) => Effect.Effect<TriggerResource | undefined, Schema.SchemaError>;
    readonly knownGitHubEvents: (repo: string, pr: number) => Effect.Effect<readonly KnownGitHubEvent[]>;
    readonly replayCronTriggers: (consume: (trigger: T.Trigger, data: unknown) => Effect.Effect<void, ApiError | Schema.SchemaError>) => Effect.Effect<void>;
    readonly unreadSummary: (participant: string, channel: string) => Effect.Effect<UnreadRow[]>;
    /** The triggers waiting in the issues' pool for one issue, in routed order. */
    readonly triggersOf: (issue: string) => Effect.Effect<readonly T.Trigger[]>;
    /** The triggers of every queued, open issue: dispatches first, then in routed order. */
    readonly queuedTriggers: Effect.Effect<readonly QueuedInput[]>;
    readonly isRouted: (trigger: string) => Effect.Effect<boolean>;
    readonly receive: (arrival: Arrival) => Effect.Effect<Received, ApiError>;
    readonly subscribe: (issue: string, threads: readonly string[]) => Effect.Effect<void, ApiError>;
    readonly ownerOf: (trigger: string) => Effect.Effect<string | undefined>;
    readonly deliveriesOf: (session: string) => readonly DeliveryRow[];
    readonly orchestratorDigest: (agent: string) => Effect.Effect<Envelope[]>;
    readonly start: Effect.Effect<void>;
    readonly restore: Effect.Effect<void>;
    readonly replay: Effect.Effect<void>;
    readonly news: Effect.Effect<Stream.Stream<DeliveryNews>, never, Scope.Scope>;
    readonly handBack: (session: string, envelope: string) => Effect.Effect<void>;
    readonly withdraw: (what: Withdrawal) => Effect.Effect<void>;
    readonly waitingOn: (envelope: string) => Effect.Effect<number>;
    readonly decline: (session: string, envelope: string, reason: string) => Effect.Effect<void, ApiError>;
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
        Effect.map(db.run(unreadOf({ participant, channel })), (rows) =>
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
      const newsHub = yield* PubSub.unbounded<DeliveryNews>();
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
      const route = Effect.fn("Mailbox.receive")(function* (trigger: T.Trigger, to?: ChannelHearers | { readonly session: string }) {
        const audience =
          to === undefined
            ? undefined
            : "row" in to
              ? channelRecipients(trigger, to)
              : [
                  {
                    trigger,
                    session: to.session,
                    role: agents.isOrchestrator(to.session) ? ("orchestrator" as const) : ("worker" as const),
                    commit: Effect.void,
                    event: trigger.actor.kind === "owner" ? ("conversation" as const) : ("mention" as const),
                  },
                ];
        const result = yield* work.receive(trigger, audience);
        if (!(yield* work.isRouted(trigger.id))) {
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

      const hire = Effect.fn("Mailbox.hire")(function* (arrival: Extract<Arrival, { readonly _tag: "Hire" }>): Effect.fn.Return<Received> {
        const room = yield* sessions.makeRoom(arrival.agent.runtime, arrival.where);
        if ("refused" in room) return { heldNotice: "", refused: room.refused };
        const envelopes = arrival.envelopes;
        const hired = yield* sessions.hire(arrival.agent, arrival.brief, arrival.where, {
          ...arrival.options,
          ...(envelopes._tag === "Talk" ? { envelopeIds: envelopes.rows.map((envelope) => envelope.row.envelope_id) } : {}),
          hiring: (session, launch) =>
            Effect.gen(function* () {
              const at = yield* Clock.currentTimeMillis;
              yield* arrival.hiring(session, launch, at);
              switch (envelopes._tag) {
                case "Talk":
                  return yield* work.registerTalk(session.id, launch, at, envelopes.rows);
                case "Queued":
                  if (envelopes.triggers.length > 0) yield* work.registerInitialInputs(session, launch, envelopes.triggers);
                  return;
              }
            }),
        });
        const session = hired.session;
        if (session === undefined) return { heldNotice: "", refused: hired.refused ?? "", ...(hired.retainedWork ? { retainedWork: true as const } : {}) };
        // A conversation's later messages may have come while it was hired: the pump looks for them now.
        if (envelopes._tag === "Talk") yield* Effect.sync(() => later(`kick:${session.id}`, 0, () => pump.kick(session.id)));
        return { heldNotice: "", hired: session, ...(room.evicted ? { evicted: room.evicted } : {}) };
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
        isRouted: work.isRouted,
        triggersOf: work.issueInputs,
        queuedTriggers: work.queuedInputs,
        receive: Effect.fnUntraced(function* (arrival: Arrival) {
          switch (arrival._tag) {
            case "Trigger":
              return yield* routeLocked(Effect.uninterruptible(route(arrival.trigger, arrival.to)));
            case "Hire":
              return yield* hire(arrival);
          }
        }),
        subscribe: Effect.fnUntraced(function* (issue: string, threads: readonly string[]) {
          return yield* work.subscribe(issue, threads);
        }),
        ownerOf: work.ownerOf,
        deliveriesOf: (session) => open.of(session),
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
                Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(S.Trigger))(row.trigger_json), (trigger) =>
                  api.receive({ _tag: "Trigger", trigger }),
                ).pipe(bestEffort(`mailbox: replay ${row.id}`)),
              { discard: true },
            );
            after = last.seq;
          }
        }),
        news: Effect.map(PubSub.subscribe(newsHub), Stream.fromSubscription),
        handBack: Effect.fn("Mailbox.handBack")(function* (session, envelope) {
          yield* db.run(qd.rollbackOne({ session_id: session, envelope_id: envelope }));
          open.handedBackOne(session, envelope);
        }, writtenLocked),
        withdraw: Effect.fn("Mailbox.withdraw")(function* (what) {
          switch (what._tag) {
            case "Session":
              return yield* writtenLocked(dropSession(what.session, what.why));
            case "Envelope":
              return yield* writtenLocked(
                Effect.gen(function* () {
                  const rows = yield* db.run(qd.dropOpenOf({ message_id: what.envelope }));
                  for (const row of rows) open.remove(row.session_id, what.envelope);
                }),
              );
            case "Issue":
              return yield* work.retireDispatches(what.issue, what.at);
          }
        }),
        waitingOn: Effect.fn("Mailbox.waitingOn")(function* (envelope) {
          return (yield* db.run(qd.waitingOn({ message_id: envelope }))).length;
        }),
        decline: Effect.fn("Mailbox.decline")(function* (session, envelope, reason) {
          const why = reason.trim();
          if (!why) return yield* Effect.fail(refused(t("server.issue.noTitle")));
          if (yield* routeLocked(work.decline(session, envelope, why))) return;
          return yield* Effect.fail(missing(t("server.issue.issueRef", { ref: envelope }), [lookIn.issue]));
        }),
      });

      const publishOrchestrator = (recipient: string, messages: readonly Envelope[], primary: DeliveryRow) =>
        Effect.gen(function* () {
          const meta = primary.payload.trigger.meta;
          const source = orchestratorSource(primary.payload.trigger.source);
          PubSub.publishUnsafe(newsHub, {
            _tag: "Handed",
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
      const pump = makePump<Envelope>(sessions, {
        pending: api.deliveriesOf,
        dropSession: (session, why) => writtenLocked(dropSession(session, why)),
        handBack: api.handBack,
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
            for (const message of messages) PubSub.publishUnsafe(newsHub, { _tag: "Consumed", session: recipient, envelope: message });
          }),
        breakerNotice: (recipient, failed) => Effect.sync(() => PubSub.publishUnsafe(newsHub, { _tag: "Braked", session: recipient, failed })),
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
