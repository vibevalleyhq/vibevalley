import { Clock, Effect, Schema } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { assignedAgentOf, latestSessionIdOf } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";

import { Agent } from "#/agent/agent.ts";
import { type ApiError, Inconsistent, missing, lookIn, refused } from "#/base/errors.ts";
import { jsonText } from "#/base/json.ts";
import { Db, causeMessage } from "#/infra/db.ts";
import { channelType, actorKindOf, type ChannelRouteResult } from "#/mailbox/envelope.ts";
import { NotRecorded, Session } from "#/session/session.ts";
import { issueExists } from "#db/issue.sql.ts";
import * as qd from "#db/mailbox_delivery.sql.ts";
import * as qi from "#db/mailbox_issue.sql.ts";
import * as qs from "#db/mailbox_subscription.sql.ts";
import * as qr from "#db/mailbox_trigger.sql.ts";

import { agentWakeCooldownMs, brakes, hopLimit, hopLimitText, type Recipient, type Reach, type WakeBreaker } from "./brakes.ts";
import type { Deliveries, DeliveryDraft, DeliveryRow } from "./deliveries.ts";
import type { InsertDelivery, TalkRow } from "./mailbox.ts";
import { readPayload, deliveryScope, triggerPayload } from "./payload.ts";
import { handbackWords, releasedInputWords } from "./prompts.ts";
import { waitsForHuman, type DeliveryEvent, type Urgency, triggerEvent, urgencyOf } from "./routing.ts";

export interface OutboundDelivery {
  readonly urgency?: Urgency;
  readonly delivery?: Recipient;
  readonly event?: DeliveryEvent;
  readonly role?: T.AgentRole;
  readonly deliveryId?: string;
  readonly note?: string;
  readonly prepare?: Effect.Effect<boolean>;
  readonly trigger: T.Trigger;
  readonly session: string;
  readonly issue?: string;
  readonly previous?: string;
  readonly commit: Effect.Effect<void>;
}

interface WorkOptions {
  readonly writtenLocked: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>;
  readonly received: (receipt: qr.MarkRoutedResult) => void;
  readonly stored: (session: string, row: DeliveryRow) => void;
  readonly defaultChannel: Effect.Effect<string>;
  readonly open: Deliveries;
  readonly reach: Reach;
  readonly breaker: WakeBreaker;
  readonly dispatch: (session: string) => void;
  readonly issueOf: (id: string) => T.Issue | undefined;
  /** The orchestrator in a channel (envelope.ts orchestratorIn): who what names no one there goes to. */
  readonly orchestratorIn: (channel: string) => Effect.Effect<string>;
}

const readTrigger = Schema.decodeUnknownSync(Schema.fromJsonString(S.Trigger));

export const makeWorkMailbox = (options: WorkOptions) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const sessions = yield* Session;
    const agents = yield* Agent;
    const { writtenLocked, received, stored, defaultChannel, open, reach, breaker, dispatch, issueOf, orchestratorIn } = options;

    const writeDelivery = (input: InsertDelivery) =>
      Effect.flatMap(jsonText(input.row.payload), (payloadJson) =>
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
          payload_json: payloadJson,
          created_at: input.row.created_at,
        }),
      );
    const markRoute = (input: InsertDelivery) =>
      qr
        .markRouted({
          envelope_id: input.row.payload.trigger.id,
          scope: input.row.scope,
          routed_at: input.row.created_at,
        })
        .pipe(Effect.catchTag("NoSuchElementError", Effect.die));

    const forward = Effect.fn("Mailbox.forward")(function* (inputs: readonly OutboundDelivery[]): Effect.fn.Return<ChannelRouteResult, ApiError> {
      const at = yield* Clock.currentTimeMillis;
      const drafts = yield* Effect.forEach(inputs, (input) =>
        Effect.gen(function* () {
          const { trigger } = input;
          const destination = trigger.replyChannel ?? sessions.sessionOf(input.session)?.channel ?? (yield* defaultChannel);
          const scope = deliveryScope(destination, input.issue);
          const urgency =
            input.urgency ??
            urgencyOf({
              source: trigger.source,
              actor: trigger.actor.kind,
              recipient: input.role ?? agents.agent(input.session)?.role ?? "worker",
              event: input.event ?? triggerEvent(trigger),
              canSteer: true,
            });
          return {
            input,
            destination,
            scope,
            urgency,
            candidate: input.delivery ?? { recipient: input.session, reason: "addressed" as const, wakes: urgency !== "digest" },
          };
        }),
      );
      const entries = [...Map.groupBy(drafts, (draft) => draft.scope).values()].flatMap((group) => {
        const first = group[0];
        if (!first) return [];
        const deliveries = brakes(
          group.map((draft) => draft.candidate),
          {
            fromKind: actorKindOf(first.input.trigger.actor.kind),
            orchestrators: agents.orchestrators().map((agent) => agent.id),
            hops: reach.hops(first.scope),
            cooling: group.filter((draft) => at - reach.lastWake(draft.input.session) < agentWakeCooldownMs).map((draft) => draft.input.session),
            broken: breaker.tripped(),
          },
        );
        return group.flatMap(({ input, scope, destination, urgency }, index) => {
          const { trigger } = input;
          const delivery = deliveries[index];
          if (!delivery) return [];
          const row: DeliveryDraft = {
            envelope_id: input.deliveryId ?? trigger.id,
            scope,
            message_id: trigger.meta.channelMessageId ?? null,
            channel_id: destination,
            source: trigger.source,
            urgency,
            reason: delivery.reason,
            wakes: delivery.wakes,
            held_by: delivery.heldBy ?? null,
            state: "pending",
            launch: null,
            created_at: at,
            payload: triggerPayload(trigger, input.issue, input.note),
          };
          return [{ input, row }];
        });
      });
      const committed = yield* db.inTx(
        Effect.forEach(entries, ({ input, row }) =>
          Effect.gen(function* () {
            if (input.prepare && !(yield* input.prepare)) return undefined;
            if (input.previous) yield* db.run(qd.dropReassigned({ session_id: input.previous, envelope_id: input.trigger.id }));
            const added = yield* db.run(writeDelivery({ session: input.session, row }));
            yield* input.commit;
            const receipt = yield* db.run(markRoute({ session: input.session, row }));
            return { input, row, added, receipt };
          }),
        ),
      );
      for (const entry of committed) {
        if (!entry) continue;
        received(entry.receipt);
        if (entry.input.previous) open.remove(entry.input.previous, entry.input.trigger.id);
        for (const added of entry.added) stored(entry.input.session, { ...entry.row, position: added.position });
        if (entry.input.trigger.actor.kind === "owner" && entry.row.wakes) breaker.reset(entry.input.session);
      }
      return { heldNotice: entries.some(({ row }) => row.held_by === "hop_limit") ? hopLimitText(hopLimit) : "" };
    }, writtenLocked);

    const registerInitialInputs = Effect.fn("Mailbox.registerInitialInputs")(function* (session: T.Session, launch: string, inputs: readonly T.Trigger[]) {
      const at = yield* Clock.currentTimeMillis;
      const fallback = yield* defaultChannel;
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
        .pipe(Effect.mapError((cause) => NotRecorded.make({ message: causeMessage(cause), cause })));
      for (const entry of committed) received(entry.receipt);
      for (const entry of committed) for (const added of entry.added) stored(session.id, { ...entry.row, position: added.position });
    }, writtenLocked);

    const hand = Effect.fn("Mailbox.hand")(function* (session: string, envelope: string, launch: string, at: number) {
      yield* db.run(qd.markHanded({ session_id: session, envelope_id: envelope, launch, handed_at: at }));
      open.handed(session, envelope, launch);
    }, writtenLocked);

    const registerTalk = Effect.fn("Mailbox.registerTalk")(function* (session: string, launch: string, at: number, rows: readonly TalkRow[]) {
      const prepared = yield* Effect.forEach(rows, (talk) =>
        Effect.gen(function* () {
          const recorded = yield* db.one(qr.triggerById({ id: talk.row.envelope_id }));
          if (!recorded) return yield* Effect.die(Inconsistent.make({ message: `talk ${talk.row.envelope_id} has no recorded trigger` }));
          const trigger = yield* Schema.decodeEffect(Schema.fromJsonString(S.Trigger))(recorded.trigger_json).pipe(
            Effect.mapError((cause) => NotRecorded.make({ message: causeMessage(cause), cause })),
          );
          const urgency = urgencyOf({ source: trigger.source, actor: "owner", recipient: "worker", event: "conversation", canSteer: true });
          const row: DeliveryDraft = {
            envelope_id: talk.row.envelope_id,
            scope: deliveryScope(talk.row.channel_id, talk.row.subject_kind === "issue" ? (talk.row.subject_id ?? undefined) : undefined),
            message_id: talk.row.envelope_id,
            channel_id: talk.row.channel_id,
            source: trigger.source,
            urgency,
            reason: "direct",
            wakes: true,
            held_by: null,
            state: "handed",
            launch,
            created_at: at,
            payload: {
              trigger,
              context: talk.context,
              channelType: channelType(talk.row.channel_type),
            },
          };
          return row;
        }),
      );
      const committed = yield* db
        .attemptTx(
          Effect.forEach(prepared, (row) =>
            Effect.gen(function* () {
              const added = yield* writeDelivery({ session, row });
              yield* qd.markHanded({ session_id: session, envelope_id: row.envelope_id, launch, handed_at: at });
              const receipt = yield* markRoute({ session, row });
              return { row, added, receipt };
            }),
          ),
        )
        .pipe(Effect.mapError((cause) => NotRecorded.make({ message: causeMessage(cause), cause })));
      for (const entry of committed) {
        received(entry.receipt);
        for (const added of entry.added) stored(session, { ...entry.row, position: added.position });
      }
    }, writtenLocked);

    const subscribe = Effect.fn("Mailbox.subscribe")(function* (issue: string, threads: readonly string[]) {
      if (!issueOf(issue)) return yield* Effect.fail(missing(t("server.issue.issueRef", { ref: issue }), [lookIn.issue]));
      yield* db.inTx(
        Effect.forEach(
          new Set(threads),
          (thread) =>
            Effect.gen(function* () {
              const owned = yield* db.run(qs.subscribeIssue({ issue_id: issue, thread_key: thread }));
              if (owned.length === 0) return yield* Effect.fail(refused(t("server.mailbox.subscriptionTaken", { thread })));
            }),
          { discard: true },
        ),
      );
    });

    const retire = Effect.fn("Mailbox.returnIssueInput")(function* (
      issue: T.Issue,
      trigger: T.Trigger,
      session: string | null,
      reason: string,
      unreadOnly: boolean,
    ) {
      const addressed = trigger.meta.ingressRecipient;
      const recipient =
        addressed !== undefined && agents.isOrchestrator(addressed) ? addressed : yield* orchestratorIn(trigger.replyChannel ?? (yield* defaultChannel));
      yield* forward([
        {
          trigger,
          session: recipient,
          deliveryId: `returned:${issue.id}:${trigger.id}`,
          urgency: "queue",
          ...(session ? { previous: session } : {}),
          note: unreadOnly
            ? releasedInputWords(recipient, issue.number, trigger.card.readUri)
            : handbackWords(recipient, issue.number, reason, trigger.card.readUri),
          prepare: Effect.gen(function* () {
            const current = yield* db.one(qi.existingIssueInput({ trigger_id: trigger.id }));
            if (!current || current.state === "returned") return false;
            if (unreadOnly && session) {
              const receipt = yield* db.one(qd.deliveryReceipt({ session_id: session, envelope_id: trigger.id }));
              if (receipt?.state === "consumed") return false;
            }
            return true;
          }),
          commit: db.run(qi.returnIssueInput({ trigger_id: trigger.id, reason })),
        },
      ]);
      dispatch(recipient);
    });

    const flush = Effect.fn("Mailbox.flushIssue")(function* (id: string, human: boolean = false) {
      const issue = issueOf(id);
      if (!issue) return;
      if (issue.status === "backlog") return;
      const assigned = assignedAgentOf(issue);
      const worker = latestSessionIdOf(issue);
      const recipient = assigned && agents.isOrchestrator(assigned) ? assigned : worker && sessions.isReachable(worker) ? worker : undefined;
      const closing = issue.status === "done" || (issue.status === "canceled" && issue.canceled !== "lost");
      const inputs = yield* db.run(qi.pendingIssueInputs({ issue_id: id, recipient: recipient ?? null, closing }));
      if (closing) {
        yield* Effect.forEach(
          inputs,
          (input) =>
            Effect.gen(function* () {
              const trigger = readTrigger(input.trigger_json);
              if (trigger.actor.kind === "owner") yield* retire(issue, trigger, input.session_id, "closed", true);
              else yield* db.run(qi.returnIssueInput({ trigger_id: trigger.id, reason: "closed" }));
            }),
          { discard: true },
        );
        return;
      }
      let forwarded = false;
      yield* Effect.forEach(
        inputs,
        (input) =>
          Effect.gen(function* () {
            const trigger = readTrigger(input.trigger_json);
            const reason =
              trigger.actor.kind === "bot" && trigger.meta.botRound !== undefined && trigger.meta.botRound > issue.mandate.maxBotReviewRounds && !human
                ? "budget"
                : !recipient
                  ? "session"
                  : waitsForHuman(issue) && trigger.actor.kind !== "owner" && !human
                    ? "human"
                    : undefined;
            if (reason) {
              yield* db.run(qi.holdIssueInput({ trigger_id: trigger.id, reason }));
              return;
            }
            if (!recipient) return;
            yield* forward([
              {
                trigger,
                session: recipient,
                issue: id,
                ...(input.session_id && input.session_id !== recipient ? { previous: input.session_id } : {}),
                prepare: Effect.gen(function* () {
                  if (input.session_id === null) return true;
                  const receipt = yield* db.one(qd.deliveryReceipt({ session_id: input.session_id, envelope_id: trigger.id }));
                  return (
                    receipt === undefined ||
                    receipt.state === "pending" ||
                    receipt.state === "handed" ||
                    (receipt.state === "dropped" && (receipt.dropped_why === "left" || receipt.dropped_why === "reassigned"))
                  );
                }),
                commit: db.run(qi.forwardIssueInput({ trigger_id: trigger.id, session_id: recipient })),
              },
            ]);
            forwarded = true;
          }),
        { discard: true },
      );
      if (forwarded && recipient) dispatch(recipient);
    });

    const isRouted = Effect.fn("Mailbox.isRouted")(function* (trigger: string) {
      return (yield* db.run(qr.isRouted({ envelope_id: trigger }))).routed;
    });

    const receive = Effect.fn("Mailbox.receive")(function* (
      trigger: T.Trigger,
      audience?: readonly OutboundDelivery[],
    ): Effect.fn.Return<ChannelRouteResult | undefined, ApiError> {
      const existing = yield* db.one(qi.existingIssueInput({ trigger_id: trigger.id }));
      if (existing) {
        if (existing.state === "held") yield* flush(existing.issue_id);
        return;
      }
      if (!audience && (yield* isRouted(trigger.id))) return;
      const threads = audience && trigger.actor.kind !== "owner" ? [] : trigger.threads;
      const matches = yield* db.run(qs.subscribedIssues({ keys: [...threads] }));
      const ids = new Set(matches.map((row) => row.issue_id));
      yield* Effect.forEach(
        threads.filter((thread) => thread.startsWith("issue:")),
        (thread) =>
          Effect.gen(function* () {
            const id = thread.slice(6);
            const issue = issueOf(id);
            if (issue) ids.add(issue.id);
            else if (yield* db.one(issueExists({ id }))) ids.add(id);
          }),
        { discard: true },
      );
      if (ids.size > 1) return yield* Effect.fail(refused(t("server.mailbox.ambiguous")));
      const issue = ids.values().next().value;
      if (issue) {
        const at = yield* Clock.currentTimeMillis;
        const receipt = yield* db.inTx(
          Effect.gen(function* () {
            yield* db.run(qi.holdIssueTrigger({ issue_id: issue, trigger_id: trigger.id, created_at: at }));
            if (trigger.meta.dispatch === true) yield* db.run(qi.supersedeDispatch({ issue_id: issue, trigger_id: trigger.id }));
            return yield* db.run(
              qr.markRouted({
                envelope_id: trigger.id,
                routed_at: at,
                scope: deliveryScope(trigger.replyChannel ?? (yield* defaultChannel), issue),
              }),
            );
          }),
        );
        yield* writtenLocked(Effect.sync(() => received(receipt)));
        yield* flush(issue, trigger.actor.kind === "owner");
        return;
      }
      if (audience) {
        const result = yield* forward(audience);
        for (const input of audience) dispatch(input.session);
        return result;
      }
      const addressed = trigger.meta.ingressRecipient;
      const recipient =
        addressed !== undefined && agents.isOrchestrator(addressed) ? addressed : yield* orchestratorIn(trigger.replyChannel ?? (yield* defaultChannel));
      yield* forward([{ trigger, session: recipient, commit: Effect.void }]);
      dispatch(recipient);
      return undefined;
    });

    const decline = Effect.fn("Mailbox.returnOwnedInput")(function* (session: string, delivery: string, reason: string) {
      const payload = yield* db.one(qd.deliveryPayload({ session_id: session, envelope_id: delivery }));
      if (!payload) return false;
      const source = yield* db.one(qr.triggerById({ id: readPayload(payload.payload_json).trigger.id }));
      if (!source) return false;
      const trigger = readTrigger(source.trigger_json);
      const input = yield* db.one(qi.existingIssueInput({ trigger_id: trigger.id }));
      if (!input) return false;
      if (input.session_id !== session) return yield* Effect.fail(refused(t("server.mailbox.notOwned")));
      const issue = issueOf(input.issue_id);
      if (!issue) return false;
      if (input.state !== "returned") yield* retire(issue, trigger, session, reason, false);
      return true;
    });
    const queuedInputs = Effect.map(db.run(qi.queuedInputs()), (rows) => rows.map((row) => ({ issue: row.issue_id, trigger: readTrigger(row.trigger_json) })));
    const issueInputs = (issue: string) => Effect.map(db.run(qi.issueInputs({ issue_id: issue })), (rows) => rows.map((row) => readTrigger(row.trigger_json)));
    const retireDispatches = (issue: string, at: number) =>
      Effect.all([db.run(qr.retireIssueDispatches({ issue_id: issue, at })), db.run(qi.retireQueuedDispatches({ issue_id: issue }))], { discard: true });
    const ownerOf = Effect.fn("Mailbox.ownerOf")(function* (trigger: string) {
      return (yield* db.one(qi.existingIssueInput({ trigger_id: trigger })))?.issue_id;
    });
    return {
      subscribe,
      receive,
      flush,
      ownerOf,
      decline,
      isRouted,
      queuedInputs,
      issueInputs,
      retireDispatches,
      forward,
      registerInitialInputs,
      registerTalk,
      hand,
    };
  });
