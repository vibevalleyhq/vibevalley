import { Clock, Context, Deferred, Effect, FiberMap, FiberSet, Layer, PubSub, type Scope, Semaphore, Schema, Stream } from "effect";
import type { SqlError } from "effect/sql";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import type { Trigger } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { Agent } from "@/agent/agent.ts";
import { newId } from "@/base/ids.ts";
import { Channel } from "@/channel/chat.ts";
import {
  channelType,
  type ChannelEnvelopeRow,
  type ChannelRouteFact,
  type ChannelRouteResult,
  metaOf,
  type OrchestratorNews,
  senderKind,
} from "@/channel/contracts.ts";
import { wakeInput } from "@/channel/prompts.ts";
import type { InboxMessage } from "@/channel/wake.ts";
import { Core } from "@/core/core.ts";
import { type ApiError, refused, missing, lookIn } from "@/errors.ts";
import { ServerConfig } from "@/infra/config.ts";
import { causeMessage, Db } from "@/infra/db.ts";
import { bestEffort } from "@/infra/log.ts";
import { waitsForHuman } from "@/issue/followup.ts";
import { Issue, type QueuedInput } from "@/issue/issue.ts";
import { Caller } from "@/session/host.ts";
import { NotRecorded, Session } from "@/session/session.ts";

import * as qm from "../../db/generated/channel_message.sql.ts";
import * as qr from "../../db/generated/ingress_trigger.sql.ts";
import * as qd from "../../db/generated/mailbox_delivery.sql.ts";
import * as qi from "../../db/generated/mailbox_issue.sql.ts";
import { agentWakeCooldownMs, brakes, type Delivery, type HeldDelivery, hopLimit, hopLimitText } from "./brakes.ts";
import { WakeBreaker } from "./breaker.ts";
import { Deliveries, type DeliveryRow, type DeliveryDraft } from "./deliveries.ts";
import { inputOf, inputContext, triggerPayload, deliveryScope } from "./payload.ts";
import { makePump } from "./pump.ts";
import { Reach } from "./reach.ts";
import { whoHears } from "./routing.ts";
import { type Urgency, type UrgencyInput, triggerEvent, urgencyOf } from "./urgency.ts";
import { makeWorkMailbox, type Transfer } from "./work.ts";

export interface InsertDelivery {
  readonly session: string;
  readonly row: DeliveryDraft;
}

const RoutePosition = Schema.Struct({ scope: Schema.String, position: Schema.Int });
const readRouteReceipt = Schema.decodeUnknownSync(Schema.Struct({ ...RoutePosition.fields, from_owner: Schema.Boolean }));
const readOwnerRoutes = Schema.decodeUnknownSync(Schema.Array(RoutePosition));

export interface HearChannel {
  readonly envelope: Trigger;
  readonly row: ChannelEnvelopeRow;
  readonly audience: ChannelRouteFact["audience"];
  readonly addressed?: Delivery;
  readonly roles: Readonly<Record<string, T.AgentRole>>;
  readonly kinds: Readonly<Record<string, T.ActorKind>>;
  readonly outcome?: T.Outcome;
}

const eventOf = (input: HearChannel, delivery: Delivery): UrgencyInput["event"] => {
  if (input.row.kind === "report") return input.outcome === "failed" || input.outcome === "interrupted" ? "report_attention" : "report_progress";
  if (input.row.sender_kind === "owner") return "conversation";
  switch (delivery.reason) {
    case "mention":
    case "everyone":
      return "mention";
    default:
      return "ambient";
  }
};

const orchestratorSource = (source: ChannelRouteFact["purpose"]): OrchestratorNews["source"] => {
  switch (source) {
    case "issue":
    case "cron":
    case "patrol":
      return source;
    case "connector":
    case "voice":
    case "github":
    case undefined:
      return undefined;
  }
};

export class Mailbox extends Context.Service<
  Mailbox,
  {
    readonly queuedInputs: Effect.Effect<readonly QueuedInput[]>;
    readonly registerInitialInputs: (session: T.Session, launch: string, inputs: readonly T.Trigger[]) => Effect.Effect<void, NotRecorded>;
    readonly registered: (trigger: string) => Effect.Effect<boolean>;
    readonly receive: (trigger: T.Trigger) => Effect.Effect<void, ApiError>;
    readonly subscribe: (issue: string, threads: readonly string[]) => Effect.Effect<void, ApiError>;
    readonly flushIssue: (issue: string, human?: boolean) => Effect.Effect<void, ApiError>;
    readonly ownerOf: (trigger: string) => Effect.Effect<string | undefined>;
    readonly urgency: (input: UrgencyInput) => Urgency;
    readonly pending: (session: string) => readonly DeliveryRow[];
    readonly forOrchestrator: Effect.Effect<Stream.Stream<OrchestratorNews>, never, Scope.Scope>;
    readonly orchestratorDigest: (agent: string) => Effect.Effect<InboxMessage[]>;
    /** Opens a process-local response route. latest ends the previous interactive API/phone route. */
    readonly openResponse: (latest: boolean) => { readonly id: string; readonly caller: Caller };
    readonly takeResponse: (id: string) => Caller | undefined;
    readonly dropResponse: (id: string) => void;
    readonly start: Effect.Effect<void>;
    readonly restore: Effect.Effect<void>;
    readonly insert: (input: InsertDelivery) => Effect.Effect<void, SqlError.SqlError | Schema.SchemaError>;
    readonly routeChannel: (input: HearChannel) => Effect.Effect<ChannelRouteResult>;
    readonly hearChannel: (input: HearChannel) => Effect.Effect<readonly HeldDelivery[], SqlError.SqlError | Schema.SchemaError>;
    readonly unroutedChannel: Effect.Effect<readonly ChannelEnvelopeRow[]>;
    readonly hand: (session: string, envelope: string, launch: string, at: number) => Effect.Effect<void, SqlError.SqlError | Schema.SchemaError>;
    readonly consume: (session: string, envelope: string, at: number) => Effect.Effect<void>;
    readonly returnHanded: (session: string) => Effect.Effect<readonly string[]>;
    readonly returnOne: (session: string, envelope: string) => Effect.Effect<void>;
    readonly dropSession: (session: string, why: string) => Effect.Effect<void>;
    readonly dropEnvelope: (envelope: string) => Effect.Effect<readonly string[]>;
    readonly waitingOn: (envelope: string) => Effect.Effect<number>;
    readonly deliveryChannel: (session: string, envelope: string) => Effect.Effect<string | undefined>;
    readonly returnInput: (session: string, envelope: string, reason: string) => Effect.Effect<void, ApiError>;
    readonly sessionLeft: (session: string) => void;
    readonly breakerSpoke: (session: string) => void;
    readonly breakerFailed: (session: string) => { readonly count: number; readonly tripped: boolean };
    readonly breakerReset: (session: string) => void;
    readonly breakerOpen: (session: string) => boolean;
  }
>()("vibevalley/Mailbox") {
  static readonly layer = Layer.effect(
    Mailbox,
    Effect.gen(function* () {
      const db = yield* Db;
      const channel = yield* Channel;
      const core = yield* Core;
      const issues = yield* Issue;
      const sessions = yield* Session;
      const agents = yield* Agent;
      const config = yield* ServerConfig;
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
      const responses = new Map<string, Caller>();
      let latestResponse = "";
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
              if (!closed) void forkHere(pumpLocked(Effect.suspend(() => (closed ? Effect.void : effect()))).pipe(bestEffort(`mailbox: ${key}`)));
            }),
            ms,
          ),
          { onlyIfMissing: true },
        );
      const writeDelivery = (input: InsertDelivery) =>
        qd.insertDelivery({
          session_id: input.session,
          envelope_id: input.row.envelope_id,
          scope: input.row.scope,
          channel_id: input.row.channel_id || null,
          message_id: input.row.message_id,
          source: input.row.source,
          urgency: input.row.urgency,
          reason: input.row.reason,
          wakes: input.row.wakes,
          held_by: input.row.held_by,
          payload_json: JSON.stringify(input.row.payload),
          created_at: input.row.created_at,
        });
      const markRoute = (input: InsertDelivery) =>
        qr
          .markRouted({
            envelope_id: input.row.payload.trigger.id,
            scope: input.row.scope,
            routed_at: input.row.created_at,
          })
          .pipe(Effect.catchTag("NoSuchElementError", Effect.die));
      const insert = Effect.fn("Mailbox.insert")(function* (input: InsertDelivery) {
        const inserted = yield* db.attemptTx(
          Effect.gen(function* () {
            const rows = yield* writeDelivery(input);
            const receipt = yield* markRoute(input);
            return { rows, receipt };
          }),
        );
        received(inserted.receipt);
        for (const row of inserted.rows) stored(input.session, { ...input.row, position: row.position });
      }, writtenLocked);
      const forward = Effect.fn("Mailbox.forward")(function* (input: Transfer) {
        const { trigger } = input;
        const at = yield* Clock.currentTimeMillis;
        const profile = agents.agent(input.session);
        if (profile?.role === "orchestrator" && !sessions.sessionOf(input.session))
          yield* sessions
            .register({ id: profile.id, agent: profile.id, name: profile.name, role: profile.role, runtime: profile.runtime, brief: profile.duty })
            .pipe(Effect.mapError((error) => refused(error.message)));
        const destination = trigger.replyChannel ?? sessions.sessionOf(input.session)?.channel ?? channel.defaultChannel();
        const scope = deliveryScope(destination, input.issue);
        const event = triggerEvent(trigger);
        const urgency =
          input.urgency ?? urgencyOf({ source: trigger.source, actor: trigger.actor.kind, recipient: profile?.role ?? "worker", event, canSteer: true });
        const delivery = brakes([{ recipient: input.session, reason: "addressed", wakes: urgency !== "digest" }], {
          fromKind: senderKind(trigger.actor.kind),
          orchestrators: agents.orchestrators().map((agent) => agent.id),
          hops: reach.hops(scope),
          cooling: at - reach.lastWake(input.session) < agentWakeCooldownMs ? [input.session] : [],
          broken: breaker.tripped(),
        })[0]!;
        const row: DeliveryDraft = {
          envelope_id: input.deliveryId ?? trigger.id,
          scope,
          message_id: typeof trigger.meta.channelMessageId === "string" ? trigger.meta.channelMessageId : null,
          channel_id: destination,
          source: trigger.source,
          urgency,
          reason: "addressed",
          wakes: delivery.wakes,
          held_by: delivery.heldBy ?? null,
          state: "pending",
          launch: null,
          created_at: at,
          payload: triggerPayload(trigger, input.issue, input.note),
        };
        const inserted = yield* db.inTx(
          Effect.gen(function* () {
            if (input.prepare && !(yield* input.prepare)) return undefined;
            if (input.previous) yield* db.run(qd.dropReassigned({ session_id: input.previous, envelope_id: trigger.id }));
            const added = yield* db.run(writeDelivery({ session: input.session, row }));
            yield* input.commit;
            const receipt = yield* db.run(markRoute({ session: input.session, row }));
            return { added, receipt };
          }),
        );
        if (inserted === undefined) return;
        received(inserted.receipt);
        if (input.previous) open.remove(input.previous, trigger.id);
        for (const added of inserted.added) {
          stored(input.session, { ...row, position: added.position });
          if (trigger.actor.kind === "owner") breaker.reset(input.session);
        }
      }, writtenLocked);
      const work = yield* makeWorkMailbox(
        forward,
        (session) => later(`trigger:${session}`, 0, () => pump.kick(session)),
        (receipt) => writtenLocked(Effect.sync(() => received(receipt))),
      );
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
      const registerInitialInputs = Effect.fn("Mailbox.registerInitialInputs")(function* (session: T.Session, launch: string, inputs: readonly T.Trigger[]) {
        const at = yield* Clock.currentTimeMillis;
        const rows: DeliveryDraft[] = inputs.map((trigger) => ({
          envelope_id: trigger.id,
          scope: deliveryScope(trigger.replyChannel ?? session.channel ?? channel.defaultChannel(), session.issue),
          message_id: null,
          channel_id: trigger.replyChannel ?? session.channel ?? channel.defaultChannel(),
          source: trigger.source,
          urgency: "queue",
          reason: "initial",
          wakes: true,
          held_by: null,
          state: "handed",
          launch,
          created_at: at,
          payload: triggerPayload(trigger, session.issue),
        }));
        const committed = yield* db
          .attemptTx(
            Effect.forEach(rows, (row) =>
              Effect.gen(function* () {
                if (session.issue) yield* qi.holdIssueTrigger({ trigger_id: row.envelope_id, issue_id: session.issue, created_at: at });
                const added = yield* writeDelivery({ session: session.id, row });
                yield* qd.markHanded({ session_id: session.id, envelope_id: row.envelope_id, launch, handed_at: at });
                if (session.issue) yield* qi.forwardIssueInput({ trigger_id: row.envelope_id, session_id: session.id });
                const receipt = yield* markRoute({ session: session.id, row });
                return { added, receipt, row };
              }),
            ),
          )
          .pipe(Effect.mapError((cause) => new NotRecorded({ message: causeMessage(cause), cause })));
        for (const entry of committed) received(entry.receipt);
        for (const entry of committed) for (const added of entry.added) stored(session.id, { ...entry.row, position: added.position });
      }, writtenLocked);

      const api = Mailbox.of({
        registered: work.registered,
        queuedInputs: work.queuedInputs,
        registerInitialInputs,
        receive: Effect.fnUntraced(
          function* (trigger: T.Trigger) {
            return yield* work.receive(trigger);
          },
          (effect) => routeLocked(Effect.uninterruptible(effect)),
        ),
        subscribe: work.subscribe,
        ownerOf: work.ownerOf,
        flushIssue: Effect.fnUntraced(function* (issue: string, human?: boolean) {
          return yield* work.flush(issue, human);
        }, routeLocked),
        urgency: urgencyOf,
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
        openResponse: (latest) => {
          if (latest && latestResponse) {
            responses.get(latestResponse)?.end();
            responses.delete(latestResponse);
          }
          const id = newId();
          const caller = new Caller();
          responses.set(id, caller);
          if (latest) latestResponse = id;
          return { id, caller };
        },
        takeResponse: (id) => responses.get(id),
        dropResponse: (id) => {
          responses.get(id)?.end();
          responses.delete(id);
          if (latestResponse === id) latestResponse = "";
        },
        start: Effect.suspend(() => start),
        restore,
        insert,
        unroutedChannel: db.run(qm.unroutedChannelMessages()),
        routeChannel: Effect.fn("Mailbox.routeChannel")(
          function* (input) {
            if (input.row.subject_kind === "issue" && input.audience.fromKind === "owner") {
              yield* Effect.orDie(work.receive(input.envelope));
              return { heldNotice: "", received: [] };
            }
            const deliveries = yield* Effect.orDie(api.hearChannel(input));
            if (input.audience.fromKind === "owner") for (const delivery of deliveries) if (delivery.wakes) breaker.reset(delivery.recipient);
            const received: { session: string; envelope: string }[] = [];
            yield* Effect.forEach(
              new Set([...deliveries.filter((delivery) => delivery.heldBy === undefined).map((delivery) => delivery.recipient)]),
              (recipient) => Effect.sync(() => later(`route:${input.row.envelope_id}:${recipient}`, 0, () => pump.kick(recipient))),
              { discard: true },
            );
            return { heldNotice: deliveries.some((delivery) => delivery.heldBy === "hop_limit") ? hopLimitText(hopLimit) : "", received };
          },
          Effect.uninterruptible,
          routeLocked,
        ),
        hearChannel: Effect.fn("Mailbox.hearChannel")(function* (input) {
          const at = yield* Clock.currentTimeMillis;
          const candidates = (input.addressed ? [input.addressed] : whoHears(input.audience)).filter(
            (delivery) =>
              input.row.subject_kind !== "issue" ||
              input.audience.fromKind !== "owner" ||
              delivery.recipient === input.audience.threadOwner ||
              input.addressed !== undefined,
          );
          const meta = metaOf(input.row.meta);
          const scope = deliveryScope(input.row.channel_id, input.row.subject_kind === "issue" ? (input.row.subject_id ?? undefined) : meta.issue);
          const deliveries = brakes(candidates, {
            fromKind: input.audience.fromKind,
            orchestrators: input.audience.orchestrators,
            hops: reach.hops(scope),
            cooling: input.audience.sessions.filter((session) => at - reach.lastWake(session) < agentWakeCooldownMs),
            broken: breaker.tripped(),
          });
          const entries = deliveries.map((delivery): InsertDelivery & { readonly delivery: HeldDelivery } => {
            const event = eventOf(input, delivery);
            const urgency = urgencyOf({
              source: input.envelope.source,
              actor: input.audience.fromKind,
              recipient: input.roles[delivery.recipient] ?? "worker",
              event,
              canSteer: true,
            });
            return {
              delivery,
              session: delivery.recipient,
              row: {
                envelope_id: input.row.envelope_id,
                scope,
                message_id: input.row.envelope_id,
                channel_id: input.row.channel_id,
                source: input.envelope.source,
                urgency,
                reason: delivery.reason,
                wakes: delivery.wakes,
                held_by: delivery.heldBy ?? null,
                state: "pending",
                launch: null,
                created_at: at,
                payload: {
                  trigger: input.envelope,
                  context: inputContext(channel.deliveryMessage(input.row)),
                  channelType: channelType(input.row.channel_type),
                },
              },
            };
          });
          const committed = yield* db.attemptTx(
            Effect.gen(function* () {
              const added = yield* Effect.forEach(entries, (entry) =>
                Effect.map(writeDelivery(entry), (rows) => rows.map((row) => ({ ...entry, row: { ...entry.row, position: row.position } }))),
              );
              const receipt = yield* qr
                .markRouted({ envelope_id: input.row.envelope_id, scope, routed_at: at })
                .pipe(Effect.catchTag("NoSuchElementError", Effect.die));
              return { entries: added.flat(), receipt };
            }),
          );
          received(committed.receipt);
          for (const entry of committed.entries) stored(entry.session, entry.row);
          return committed.entries.map((entry) => entry.delivery);
        }, writtenLocked),
        hand: Effect.fn("Mailbox.hand")(function* (session, envelope, launch, at) {
          yield* db.attempt(qd.markHanded({ session_id: session, envelope_id: envelope, launch, handed_at: at }));
          open.handed(session, envelope, launch);
        }, writtenLocked),
        consume: Effect.fn("Mailbox.consume")(function* (session, envelope, at) {
          yield* db.run(qd.consumeDelivery({ session_id: session, envelope_id: envelope, consumed_at: at }));
          open.remove(session, envelope);
        }, writtenLocked),
        returnHanded: Effect.fn("Mailbox.returnHanded")(function* (session) {
          const rows = yield* db.run(qd.rollbackHanded({ session_id: session }));
          open.handedBack(session);
          return rows.map((row) => row.envelope_id);
        }, writtenLocked),
        returnOne: Effect.fn("Mailbox.returnOne")(function* (session, envelope) {
          yield* db.run(qd.rollbackOne({ session_id: session, envelope_id: envelope }));
          open.handedBackOne(session, envelope);
        }, writtenLocked),
        dropSession: Effect.fn("Mailbox.dropSession")(function* (session, why) {
          yield* db.run(qd.dropOpen({ session_id: session, dropped_why: why }));
          open.dropped(session);
        }, writtenLocked),
        dropEnvelope: Effect.fn("Mailbox.dropEnvelope")(function* (envelope) {
          const rows = yield* db.run(qd.dropOpenOf({ message_id: envelope }));
          for (const row of rows) open.remove(row.session_id, envelope);
          return rows.map((row) => row.session_id);
        }, writtenLocked),
        waitingOn: Effect.fn("Mailbox.waitingOn")(function* (envelope) {
          return (yield* db.run(qd.waitingOn({ message_id: envelope }))).length;
        }),
        deliveryChannel: Effect.fn("Mailbox.deliveryChannel")(function* (session, envelope) {
          return (yield* db.one(qd.deliveryChannel({ session_id: session, envelope_id: envelope })))?.channel_id ?? undefined;
        }),
        returnInput: Effect.fn("Mailbox.returnInput")(function* (session, envelope, reason) {
          const why = reason.trim();
          if (!why) return yield* Effect.fail(refused(t("server.issue.noTitle")));
          if (yield* routeLocked(work.returnInput(session, envelope, why))) return;
          return yield* Effect.fail(missing(t("server.issue.issueRef", { ref: envelope }), [lookIn.issue]));
        }),
        sessionLeft: (session) => reach.left(session),
        breakerSpoke: (session) => breaker.spoke(session),
        breakerFailed: (session) => breaker.failed(session),
        breakerReset: (session) => breaker.reset(session),
        breakerOpen: (session) => breaker.isOpen(session),
      });

      const publishOrchestrator = (recipient: string, messages: readonly InboxMessage[], primary: DeliveryRow) =>
        Effect.sync(() => {
          const meta = metaOf(JSON.stringify(primary.payload.trigger.meta));
          const source = orchestratorSource(meta.ingressSource);
          PubSub.publishUnsafe(orchestratorHub, {
            agent: recipient,
            channel: primary.channel_id ?? channel.defaultChannel(),
            type: primary.payload.channelType,
            target: inputOf(primary).target,
            messages: [...messages],
            ...(source ? { source } : {}),
            ...(meta.issue ? { issue: meta.issue } : {}),
            ...(meta.trigger ? { by: meta.trigger } : {}),
          });
        });
      const pump = makePump<InboxMessage>(sessions, api, {
        readyInputs: (recipient, rows) => {
          const current = sessions.sessionOf(recipient)?.issue;
          const all = new Map<string, T.Issue>(issues.onBoard().map((issue) => [issue.id, issue]));
          const issueOf = (row: DeliveryRow) => {
            const id = row.payload.trigger.meta.issue;
            return all.get(typeof id === "string" ? id : (current ?? ""));
          };
          const answered = new Set(
            rows
              .filter((row) => row.payload.trigger.actor.kind === "owner" && row.state === "pending")
              .flatMap((row) => {
                const issue = issueOf(row);
                return issue && issue.status !== "done" && issue.status !== "canceled" ? [issue.id] : [];
              }),
          );
          return rows.filter((row) => {
            const issue = issueOf(row);
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
          Effect.map(channel.deliveryUnread(recipient), (all) =>
            wakeInput(
              [...messages],
              all.filter((other) => !messages.some((message) => message.target === other.target)),
            ),
          ),
        publishOrchestrator,
        consumedMessages: (recipient, messages) => Effect.forEach(messages, (id) => channel.deliveryReceived(recipient, id), { discard: true }),
        breakerNotice: (recipient, failed) =>
          Effect.gen(function* () {
            const where = (yield* channel.threadOfSession(recipient)) ?? channel.defaultChannel();
            const name = sessions.sessionOf(recipient)?.name ?? recipient;
            yield* channel.notice(where, t("server.channel.breaker", { name, failed }), "wake_breaker");
          }),
        later,
        noticeBatchMs: config.chat.noticeBatchMs,
        retryWakeMs: config.chat.retryWakeMs,
      });

      const port = {
        restore: api.restore,
        registerTalk: (session: string, launch: string, at: number, rows: readonly ChannelEnvelopeRow[]) =>
          Effect.orDie(
            Effect.forEach(
              rows,
              (row) =>
                Effect.gen(function* () {
                  const recorded = yield* db.one(qr.triggerById({ id: row.envelope_id }));
                  if (!recorded) return yield* Effect.die(new Error("Private message trigger is missing"));
                  const trigger = yield* Schema.decodeEffect(Schema.fromJsonString(S.Trigger))(recorded.trigger_json);
                  const urgency = urgencyOf({ source: trigger.source, actor: "owner", recipient: "worker", event: "conversation", canSteer: true });
                  return yield* Effect.andThen(
                    api.insert({
                      session,
                      row: {
                        envelope_id: row.envelope_id,
                        scope: deliveryScope(row.channel_id, row.subject_kind === "issue" ? (row.subject_id ?? undefined) : undefined),
                        message_id: row.envelope_id,
                        channel_id: row.channel_id,
                        source: trigger.source,
                        urgency,
                        reason: "direct",
                        wakes: true,
                        held_by: null,
                        state: "pending",
                        launch: null,
                        created_at: at,
                        payload: {
                          trigger,
                          context: inputContext(channel.deliveryMessage(row)),
                          channelType: channelType(row.channel_type),
                        },
                      },
                    }),
                    api.hand(session, row.envelope_id, launch, at),
                  );
                }),
              { discard: true },
            ),
          ),
        dropSession: (session: string) =>
          Effect.andThen(
            api.dropSession(session, "left"),
            Effect.sync(() => {
              reach.left(session);
              breaker.reset(session);
            }),
          ),
        kick: (session: string) => Effect.sync(() => later(`kick:${session}`, 0, () => pump.kick(session))),
        dropEnvelope: api.dropEnvelope,
        waitingOn: api.waitingOn,
        deliverDirect: (session: string, text: string, replyChannel: string | undefined, byOwner: boolean) =>
          Effect.asVoid(
            sessions.deliver(session, text, {
              trigger: { kind: "comment", ...(replyChannel ? { channel: replyChannel } : {}) },
              envelopeIds: [],
              byOwnerComment: byOwner,
            }),
          ),
      };

      yield* Effect.forkScoped(
        Stream.runForEach(yield* channel.delivery, (call) =>
          Effect.gen(function* () {
            switch (call.kind) {
              case "restore":
                yield* port.restore;
                yield* Deferred.succeed(call.reply, undefined);
                break;
              case "registerTalk":
                yield* port.registerTalk(call.session, call.launch, call.at, call.rows);
                yield* Deferred.succeed(call.reply, undefined);
                break;
              case "dropSession":
                yield* port.dropSession(call.session);
                yield* Deferred.succeed(call.reply, undefined);
                break;
              case "kick":
                yield* port.kick(call.session);
                yield* Deferred.succeed(call.reply, undefined);
                break;
              case "dropEnvelope":
                yield* Deferred.succeed(call.reply, yield* port.dropEnvelope(call.envelope));
                break;
              case "waitingOn":
                yield* Deferred.succeed(call.reply, yield* port.waitingOn(call.envelope));
                break;
              case "deliverDirect":
                yield* port.deliverDirect(call.session, call.text, call.channel, call.byOwner);
                yield* Deferred.succeed(call.reply, undefined);
                break;
            }
          }),
        ),
      );

      yield* Effect.forkScoped(
        Stream.runForEach(yield* sessions.launches, (activity) =>
          pumpLocked(pump.activity(activity)).pipe(bestEffort(`mailbox: ${activity.id} ${activity.kind}`)),
        ),
      );
      yield* Effect.forkScoped(
        Stream.runForEach(yield* sessions.inputsConsumed, (input) =>
          pumpLocked(pump.consumed(input)).pipe(bestEffort(`mailbox: input consumed by ${input.session}`)),
        ),
      );
      yield* Effect.forkScoped(
        Stream.runForEach(yield* sessions.inputsReturned, (input) =>
          pumpLocked(pump.returned(input)).pipe(bestEffort(`mailbox: input returned by ${input.session}`)),
        ),
      );

      const bindIssue = (issue: T.Issue) =>
        work.subscribe(issue.id, [`issue:${issue.id}`, ...(issue.project && issue.pullRequest ? [`github:${issue.project}#${issue.pullRequest.number}`] : [])]);
      yield* Effect.forkScoped(
        Stream.runForEach(yield* core.subscribe, (fact) =>
          Effect.gen(function* () {
            if (fact.type === "issue") {
              yield* bindIssue(fact.issue);
              if (fact.issue.status === "done" || fact.issue.status === "canceled") {
                yield* api.flushIssue(fact.issue.id);
              } else later(`issue:${fact.issue.id}`, 0, () => api.flushIssue(fact.issue.id).pipe(bestEffort(`mailbox: inputs of ${fact.issue.id}`)));
            } else if (fact.type === "session" && fact.session.issue && issues.onBoard().some((item) => item.id === fact.session.issue)) {
              const issue = fact.session.issue;
              later(`issue:${issue}`, 0, () => api.flushIssue(issue).pipe(bestEffort(`mailbox: inputs of ${issue}`)));
            } else if (
              fact.type === "channel" &&
              fact.channel.subjectKind === "issue" &&
              fact.channel.subjectId &&
              issues.onBoard().some((item) => item.id === fact.channel.subjectId)
            ) {
              yield* work.subscribe(fact.channel.subjectId, [`channel:${fact.channel.id}`]);
            }
          }).pipe(bestEffort("mailbox: issue routing")),
        ),
      );

      start = Effect.gen(function* () {
        yield* api.restore;
        yield* Effect.forEach(
          yield* issues.list(),
          (issue) =>
            Effect.gen(function* () {
              yield* bindIssue(issue);
              yield* api.flushIssue(issue.id);
            }).pipe(bestEffort(`mailbox: restore issue ${issue.id}`)),
          { discard: true },
        );
        while (true) {
          const rows = yield* api.unroutedChannel;
          if (rows.length === 0) break;
          yield* Effect.forEach(rows, channel.replayDelivery, { discard: true });
        }
        yield* Effect.forEach(sessions.presentSessions(), (session) => pumpLocked(pump.kick(session.id)), { discard: true });
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closed = true;
          for (const caller of responses.values()) caller.end();
          responses.clear();
          latestResponse = "";
        }),
      );
      return api;
    }),
  );
}

export const start = Layer.effectDiscard(Effect.flatMap(Mailbox, (mailbox) => mailbox.start));
