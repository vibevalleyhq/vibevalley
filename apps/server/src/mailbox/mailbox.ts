import { join } from "node:path";

import { Clock, Context, Effect, FiberMap, FiberSet, Layer, PubSub, type Scope, Semaphore, Schema, Stream } from "effect";
import type { SqlError } from "effect/sql";

import { t } from "@vibevalley/i18n";
import { defaultOrchestrator } from "@vibevalley/protocol";
import type * as T from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { Agent } from "@/agent/agent.ts";
import {
  type ChannelAudience,
  type ChannelEnvelopeRow,
  type ChannelRouteResult,
  channelType,
  type InboxMessage,
  inboxMore,
  type Meta,
  metaOf,
  type OrchestratorNews,
  senderKind,
  summaryChannels,
  targetOf,
  type UnreadRow,
} from "@/base/chat.ts";
import { newId } from "@/base/ids.ts";
import { Core } from "@/core/core.ts";
import { type ApiError, refused, missing, lookIn } from "@/errors.ts";
import { ServerConfig } from "@/infra/config.ts";
import { causeMessage, Db } from "@/infra/db.ts";
import { bestEffort } from "@/infra/log.ts";
import { Caller } from "@/session/host.ts";
import { NotRecorded, Session } from "@/session/session.ts";

import * as qc from "../../db/generated/channel.sql.ts";
import * as qm from "../../db/generated/channel_message.sql.ts";
import * as qr from "../../db/generated/ingress_trigger.sql.ts";
import * as qd from "../../db/generated/mailbox_delivery.sql.ts";
import * as qi from "../../db/generated/mailbox_issue.sql.ts";
import { agentWakeCooldownMs, brakes, type Delivery, type HeldDelivery, hopLimit, hopLimitText } from "./brakes.ts";
import { WakeBreaker } from "./breaker.ts";
import { Deliveries, type DeliveryRow, type DeliveryDraft } from "./deliveries.ts";
import { waitsForHuman } from "./issue.ts";
import { inputOf, inputContext, triggerPayload, deliveryScope, type InputContext } from "./payload.ts";
import { wakeInput } from "./prompts.ts";
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

export interface QueuedInput {
  readonly issue: string;
  readonly trigger: T.Trigger;
}

/** What Collaboration hands Mailbox with a message it committed: who hears it and how it is answered. */
export interface ChannelMail {
  readonly row: ChannelEnvelopeRow;
  readonly audience: ChannelAudience;
  readonly addressed?: Delivery;
  readonly roles: Readonly<Record<string, T.AgentRole>>;
  readonly kinds: Readonly<Record<string, T.ActorKind>>;
  readonly outcome?: T.Outcome;
}

/** A message already said in a direct channel, with what the reader sees of it, for the talk's first request. */
export interface TalkRow {
  readonly row: ChannelEnvelopeRow;
  readonly context: InputContext;
}

const eventOf = (input: ChannelMail, delivery: Delivery): UrgencyInput["event"] => {
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

const orchestratorSource = (source: NonNullable<Meta["ingressSource"]> | undefined): OrchestratorNews["source"] => {
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
    readonly receive: (trigger: T.Trigger, mail?: ChannelMail) => Effect.Effect<ChannelRouteResult, ApiError>;
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
    /** A direct conversation's first request: its recent messages, already written, are handed with it. */
    readonly registerTalk: (session: string, launch: string, at: number, rows: readonly TalkRow[]) => Effect.Effect<void>;
    /** What a message's 👀 reaction is for, as the pump sees each input consumed. */
    readonly consumed: Effect.Effect<Stream.Stream<{ readonly session: string; readonly message: string }>, never, Scope.Scope>;
    /** A session that failed every wake: Channel writes the notice where it talks. */
    readonly breakerNotices: Effect.Effect<Stream.Stream<{ readonly session: string; readonly failed: number }>, never, Scope.Scope>;
    readonly kick: (session: string) => Effect.Effect<void>;
    readonly hand: (session: string, envelope: string, launch: string, at: number) => Effect.Effect<void, SqlError.SqlError | Schema.SchemaError>;
    readonly consume: (session: string, envelope: string, at: number) => Effect.Effect<void>;
    readonly returnHanded: (session: string) => Effect.Effect<readonly string[]>;
    readonly returnOne: (session: string, envelope: string) => Effect.Effect<void>;
    readonly dropSession: (session: string, why: string) => Effect.Effect<void>;
    readonly dropEnvelope: (envelope: string) => Effect.Effect<readonly string[]>;
    readonly waitingOn: (envelope: string) => Effect.Effect<number>;
    readonly deliveryChannel: (session: string, envelope: string) => Effect.Effect<string | undefined>;
    readonly returnInput: (session: string, envelope: string, reason: string) => Effect.Effect<void, ApiError>;
    /** A session given words outside its thread. */
    readonly deliverDirect: (session: string, text: string, replyChannel: string | undefined, byOwner: boolean) => Effect.Effect<void>;
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
      const core = yield* Core;
      const sessions = yield* Session;
      const agents = yield* Agent;
      const config = yield* ServerConfig;
      /** The issues Mailbox holds inputs for, from the facts it already gets; seeded from the core when it starts. */
      const board = new Map<string, T.Issue>();
      const filesAt = (id: string) => join(config.home, "attachments", id);
      const targetOfRow = (type: string, rootNumber: number | null, name: string | null, channelNameOf: string | null) => {
        const ch = { type: channelType(type), ...(rootNumber !== null ? { rootNumber } : {}), ...(name !== null ? { name } : {}) };
        return targetOf(ch, channelNameOf ?? "");
      };
      const asInbox = (r: ChannelEnvelopeRow): InboxMessage => ({
        id: r.envelope_id,
        number: r.number,
        target: targetOfRow(r.channel_type, r.root_number, null, r.channel_name || null),
        from: r.sender_id,
        fromKind: senderKind(r.sender_kind),
        name: r.name,
        text: r.body,
        ...inboxMore(r, filesAt),
      });
      const defaultChannelOf = Effect.gen(function* () {
        return (yield* db.one(qc.defaultID()))?.id ?? "";
      });
      const orchestratorOf = (channel: string): Effect.Effect<string> =>
        Effect.gen(function* () {
          const row = yield* db.one(qc.channelForRouting({ id: channel }));
          if (!row) return defaultOrchestrator;
          if (row.type === "thread") return row.parent_id ? yield* orchestratorOf(row.parent_id) : defaultOrchestrator;
          const own = row.type === "direct" ? row.peer_id : row.orchestrator;
          return own && agents.isOrchestrator(own) ? own : defaultOrchestrator;
        });
      const deliveryUnread = Effect.fn("Mailbox.deliveryUnread")(function* (who: string) {
        const h = sessions.sessionOf(who);
        const channel = h?.channel ?? (yield* defaultChannelOf);
        const rows = yield* db.run(qc.inboxOf({ participant: who, channel }));
        const out: UnreadRow[] = [];
        yield* Effect.forEach(
          rows.slice(0, summaryChannels),
          (r) =>
            Effect.gen(function* () {
              const latest = yield* db.one(qm.messageByNumber({ channel_id: r.id, number: r.latest ?? 0 }));
              out.push({
                target: targetOfRow(r.type, r.root_number, null, r.channel_name || null),
                unread: r.unread ?? 0,
                mentionsYou: !(r.mentions_you !== true),
                ...(latest ? { latest: latest.sender_name } : {}),
              });
            }),
          { discard: true },
        );
        return out;
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
      const consumedHub = yield* PubSub.unbounded<{ readonly session: string; readonly message: string }>();
      const breakerHub = yield* PubSub.unbounded<{ readonly session: string; readonly failed: number }>();
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
        const destination = trigger.replyChannel ?? sessions.sessionOf(input.session)?.channel ?? (yield* defaultChannelOf);
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
      const work = yield* makeWorkMailbox({
        forward,
        dispatch: (session) => later(`trigger:${session}`, 0, () => pump.kick(session)),
        received: (receipt) => writtenLocked(Effect.sync(() => received(receipt))),
        issueOf: (id) => board.get(id),
        defaultChannel: defaultChannelOf,
        orchestratorOf,
      });
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
        const fallback = yield* defaultChannelOf;
        const destination = (trigger: T.Trigger) => trigger.replyChannel ?? session.channel ?? fallback;
        const rows: DeliveryDraft[] = inputs.map((trigger) => ({
          envelope_id: trigger.id,
          scope: deliveryScope(destination(trigger), session.issue),
          message_id: null,
          channel_id: destination(trigger),
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

      /** A message said in a channel: every recipient the chat's audience names gets its own delivery. */
      const hear = Effect.fn("Mailbox.hear")(function* (trigger: T.Trigger, input: ChannelMail) {
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
            source: trigger.source,
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
              source: trigger.source,
              urgency,
              reason: delivery.reason,
              wakes: delivery.wakes,
              held_by: delivery.heldBy ?? null,
              state: "pending",
              launch: null,
              created_at: at,
              payload: {
                trigger,
                context: inputContext(asInbox(input.row)),
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
        if (input.audience.fromKind === "owner") for (const delivery of deliveries) if (delivery.wakes) breaker.reset(delivery.recipient);
        const acceptedRoutes: { session: string; envelope: string }[] = [];
        yield* Effect.forEach(
          new Set(deliveries.filter((delivery) => delivery.heldBy === undefined).map((delivery) => delivery.recipient)),
          (recipient) => Effect.sync(() => later(`route:${input.row.envelope_id}:${recipient}`, 0, () => pump.kick(recipient))),
          { discard: true },
        );
        return { heldNotice: deliveries.some((delivery) => delivery.heldBy === "hop_limit") ? hopLimitText(hopLimit) : "", received: acceptedRoutes };
      }, writtenLocked);

      /** One way in: a channel message fans out to its audience; everything else enters the issue pool. */
      const route = Effect.fn("Mailbox.receive")(function* (trigger: T.Trigger, mail?: ChannelMail) {
        if (mail) {
          if (mail.row.subject_kind === "issue" && mail.audience.fromKind === "owner") {
            yield* Effect.orDie(work.receive(trigger));
            return { heldNotice: "", received: [] };
          }
          return yield* hear(trigger, mail).pipe(Effect.orDie);
        }
        yield* work.receive(trigger);
        return { heldNotice: "", received: [] };
      });

      const api = Mailbox.of({
        registered: work.registered,
        queuedInputs: work.queuedInputs,
        registerInitialInputs,
        receive: Effect.fnUntraced(
          function* (trigger: T.Trigger, mail?: ChannelMail) {
            return yield* route(trigger, mail);
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
        registerTalk: Effect.fn("Mailbox.registerTalk")(function* (session, launch, at, rows) {
          yield* Effect.forEach(
            rows,
            (talk) =>
              Effect.gen(function* () {
                const recorded = yield* db.one(qr.triggerById({ id: talk.row.envelope_id }));
                if (!recorded) return yield* Effect.die(new Error("Private message trigger is missing"));
                const trigger = yield* Schema.decodeEffect(Schema.fromJsonString(S.Trigger))(recorded.trigger_json);
                const urgency = urgencyOf({ source: trigger.source, actor: "owner", recipient: "worker", event: "conversation", canSteer: true });
                yield* Effect.andThen(
                  api.insert({
                    session,
                    row: {
                      envelope_id: talk.row.envelope_id,
                      scope: deliveryScope(talk.row.channel_id, talk.row.subject_kind === "issue" ? (talk.row.subject_id ?? undefined) : undefined),
                      message_id: talk.row.envelope_id,
                      channel_id: talk.row.channel_id,
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
                        context: talk.context,
                        channelType: channelType(talk.row.channel_type),
                      },
                    },
                  }),
                  api.hand(session, talk.row.envelope_id, launch, at),
                );
              }),
            { discard: true },
          ).pipe(Effect.orDie);
        }),
        consumed: Effect.map(PubSub.subscribe(consumedHub), Stream.fromSubscription),
        breakerNotices: Effect.map(PubSub.subscribe(breakerHub), Stream.fromSubscription),
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
          reach.left(session);
          breaker.reset(session);
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
        Effect.gen(function* () {
          const meta = metaOf(JSON.stringify(primary.payload.trigger.meta));
          const source = orchestratorSource(meta.ingressSource);
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
      const pump = makePump<InboxMessage>(sessions, api, {
        readyInputs: (recipient, rows) => {
          const current = sessions.sessionOf(recipient)?.issue;
          const itemOf = (row: DeliveryRow) => {
            const id = row.payload.trigger.meta.issue;
            return board.get(typeof id === "string" ? id : (current ?? ""));
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
            for (const message of messages) PubSub.publishUnsafe(consumedHub, { session: recipient, message });
          }),
        breakerNotice: (recipient, failed) => Effect.sync(() => PubSub.publishUnsafe(breakerHub, { session: recipient, failed })),
        later,
        noticeBatchMs: config.chat.noticeBatchMs,
        retryWakeMs: config.chat.retryWakeMs,
      });

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
      const onFact = (fact: T.SideEvent) =>
        Effect.gen(function* () {
          if (fact.type === "issue") {
            board.set(fact.issue.id, fact.issue);
            yield* bindIssue(fact.issue);
            if (fact.issue.status === "done" || fact.issue.status === "canceled") {
              yield* api.flushIssue(fact.issue.id);
            } else later(`issue:${fact.issue.id}`, 0, () => api.flushIssue(fact.issue.id).pipe(bestEffort(`mailbox: inputs of ${fact.issue.id}`)));
          } else if (fact.type === "issueGone") {
            board.delete(fact.id);
          } else if (fact.type === "session" && fact.session.issue && board.has(fact.session.issue)) {
            const issue = fact.session.issue;
            later(`issue:${issue}`, 0, () => api.flushIssue(issue).pipe(bestEffort(`mailbox: inputs of ${issue}`)));
          } else if (fact.type === "channel" && fact.channel.subjectKind === "issue" && fact.channel.subjectId && board.has(fact.channel.subjectId)) {
            yield* work.subscribe(fact.channel.subjectId, [`channel:${fact.channel.id}`]);
          }
        }).pipe(bestEffort("mailbox: issue routing"));

      const [initial, transitions] = yield* core.transitions;
      for (const issue of initial.issues) board.set(issue.id, issue);
      yield* Effect.forkScoped(Stream.runForEach(transitions, ({ fact }) => onFact(fact)));

      start = Effect.gen(function* () {
        const [initial] = yield* Effect.scoped(core.transitions);
        for (const issue of initial.issues) board.set(issue.id, issue);
        yield* api.restore;
        yield* Effect.forEach(
          [...board.values()],
          (issue) =>
            Effect.gen(function* () {
              yield* bindIssue(issue);
              yield* api.flushIssue(issue.id);
            }).pipe(bestEffort(`mailbox: restore issue ${issue.id}`)),
          { discard: true },
        );
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
