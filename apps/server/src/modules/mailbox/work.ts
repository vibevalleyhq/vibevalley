import { z } from "zod";

import type { Clock } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { assignedAgentOf, latestSessionIdOf } from "@vibevalley/protocol/rules";

import { BizCode, Inconsistent, lookIn, missing, refuseIn } from "#/base/errors.ts";
import { jsonOf, jsonText } from "#/base/json.ts";
import { type Db, SqlError, causeMessage } from "#/infra/db.ts";
import type { Agent } from "#/modules/agent/agent.ts";
import { NotRecorded, type Session } from "#/modules/session/session.ts";
import { issueExists } from "#db/issue.sql.ts";
import * as qd from "#db/mailbox_delivery.sql.ts";
import * as qi from "#db/mailbox_issue.sql.ts";
import * as qs from "#db/mailbox_subscription.sql.ts";
import * as qr from "#db/mailbox_trigger.sql.ts";

import { agentWakeCooldownMs, brakes, hopLimit, hopLimitText, type Recipient, type Reach, type WakeBreaker } from "./brakes.ts";
import type { Deliveries, DeliveryDraft, DeliveryRow } from "./deliveries.ts";
import { channelType, type ChannelRouteResult } from "./envelope.ts";
import type { InsertDelivery, TalkRow } from "./mailbox.ts";
import { readPayload, deliveryScope, triggerPayload } from "./payload.ts";
import { handbackWords, releasedInputWords } from "./prompts.ts";
import { waitsForHuman, type DeliveryEvent, type Urgency, triggerEvent, urgencyOf } from "./routing.ts";
import * as S from "./schema.ts";
import type { Trigger } from "./shapes.ts";

const refused = refuseIn(BizCode.ChannelRefused);

export interface OutboundDelivery {
  readonly urgency?: Urgency;
  readonly delivery?: Recipient;
  readonly event?: DeliveryEvent;
  readonly role?: T.AgentRole;
  readonly deliveryId?: string;
  readonly note?: string;
  /** Read inside the routing transaction: false leaves this one out. */
  readonly prepare?: () => Promise<boolean>;
  readonly trigger: Trigger;
  readonly session: string;
  readonly issue?: string;
  readonly previous?: string;
  /** Written inside the routing transaction, with the delivery. */
  readonly commit: () => Promise<void>;
}

interface WorkOptions {
  readonly writtenLocked: <A>(work: () => Promise<A>) => Promise<A>;
  readonly received: (receipt: qr.MarkRoutedResult) => void;
  readonly stored: (session: string, row: DeliveryRow) => void;
  readonly defaultChannel: () => Promise<string>;
  readonly open: Deliveries;
  readonly reach: Reach;
  readonly breaker: WakeBreaker;
  readonly dispatch: (session: string) => void;
  readonly issueOf: (id: string) => T.Issue | undefined;
  /** The orchestrator in a channel (envelope.ts orchestratorIn): who what names no one there goes to. */
  readonly orchestratorIn: (channel: string) => Promise<string>;
}

const readTrigger = jsonOf(S.Trigger, "mailbox.trigger_json");

export interface WorkDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly session: Session;
  readonly agent: Agent;
}

/** A write that could not be kept, as NotRecorded: what a session's start stops on and reports. */
const notRecorded = (e: unknown): unknown => (e instanceof SqlError || e instanceof z.ZodError ? new NotRecorded(causeMessage(e), { cause: e }) : e);

export function makeWorkMailbox(deps: WorkDeps, options: WorkOptions) {
  const { db, clock, session: sessions, agent: agents } = deps;
  const { writtenLocked, received, stored, defaultChannel, open, reach, breaker, dispatch, issueOf, orchestratorIn } = options;

  const writeDelivery = (input: InsertDelivery) =>
    qd.insertDelivery(db.sql, {
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
      payload_json: jsonText(input.row.payload),
      created_at: input.row.created_at,
    });
  const markRoute = async (input: InsertDelivery) => {
    const receipt = await qr.markRouted(db.sql, {
      envelope_id: input.row.payload.trigger.id,
      scope: input.row.scope,
      routed_at: input.row.created_at,
    });
    if (receipt === undefined) throw new Inconsistent(`trigger ${input.row.payload.trigger.id} was routed before it was recorded`);
    return receipt;
  };

  const forward = (inputs: readonly OutboundDelivery[]): Promise<ChannelRouteResult> =>
    writtenLocked(async () => {
      const at = clock.now();
      const drafts = [];
      for (const input of inputs) {
        const { trigger } = input;
        const destination = trigger.replyChannel ?? sessions.sessionOf(input.session)?.channel ?? (await defaultChannel());
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
        drafts.push({
          input,
          destination,
          scope,
          urgency,
          candidate: input.delivery ?? { recipient: input.session, reason: "addressed" as const, wakes: urgency !== "digest" },
        });
      }
      const entries = [...Map.groupBy(drafts, (draft) => draft.scope).values()].flatMap((group) => {
        const first = group[0];
        if (!first) return [];
        const deliveries = brakes(
          group.map((draft) => draft.candidate),
          {
            actor: first.input.trigger.actor,
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
      await db.tx(async () => {
        const committed: ({ input: OutboundDelivery; row: DeliveryDraft; added: qd.InsertDeliveryResult[]; receipt: qr.MarkRoutedResult } | undefined)[] = [];
        for (const { input, row } of entries) {
          if (input.prepare && !(await input.prepare())) {
            committed.push(undefined);
            continue;
          }
          if (input.previous) await qd.dropReassigned(db.sql, { session_id: input.previous, envelope_id: input.trigger.id });
          const added = await writeDelivery({ session: input.session, row });
          await input.commit();
          const receipt = await markRoute({ session: input.session, row });
          committed.push({ input, row, added, receipt });
        }
        await db.afterCommit(() => {
          for (const entry of committed) {
            if (!entry) continue;
            received(entry.receipt);
            if (entry.input.previous) open.remove(entry.input.previous, entry.input.trigger.id);
            for (const added of entry.added) stored(entry.input.session, { ...entry.row, position: added.position });
            if (entry.input.trigger.actor.kind === "user" && entry.row.wakes) breaker.reset(entry.input.session);
          }
        });
      });
      return { heldNotice: entries.some(({ row }) => row.held_by === "hop_limit") ? hopLimitText(hopLimit) : "" };
    });

  const registerInitialInputs = (session: T.Session, launch: string, inputs: readonly Trigger[]): Promise<void> =>
    writtenLocked(async () => {
      const at = clock.now();
      const fallback = await defaultChannel();
      const destination = (trigger: Trigger) => trigger.replyChannel ?? session.channel ?? fallback;
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
      try {
        await db.tx(async () => {
          const committed: { added: qd.InsertDeliveryResult[]; receipt: qr.MarkRoutedResult; row: DeliveryDraft }[] = [];
          for (const row of rows) {
            if (session.issue) await qi.holdIssueTrigger(db.sql, { trigger_id: row.envelope_id, issue_id: session.issue, created_at: at });
            const added = await writeDelivery({ session: session.id, row });
            await qd.markHanded(db.sql, { session_id: session.id, envelope_id: row.envelope_id, launch, handed_at: at });
            if (session.issue) await qi.forwardIssueInput(db.sql, { trigger_id: row.envelope_id, session_id: session.id });
            const receipt = await markRoute({ session: session.id, row });
            committed.push({ added, receipt, row });
          }
          await db.afterCommit(() => {
            for (const entry of committed) received(entry.receipt);
            for (const entry of committed) for (const added of entry.added) stored(session.id, { ...entry.row, position: added.position });
          });
        });
      } catch (e) {
        throw notRecorded(e);
      }
    });

  const hand = (session: string, envelope: string, launch: string, at: number): Promise<void> =>
    writtenLocked(() =>
      db.tx(async () => {
        await qd.markHanded(db.sql, { session_id: session, envelope_id: envelope, launch, handed_at: at });
        await db.afterCommit(() => open.handed(session, envelope, launch));
      }),
    );

  const registerTalk = (session: string, launch: string, at: number, rows: readonly TalkRow[]): Promise<void> =>
    writtenLocked(async () => {
      const prepared: DeliveryDraft[] = [];
      for (const talk of rows) {
        const recorded = await qr.triggerById(db.sql, { id: talk.row.envelope_id });
        if (!recorded) throw new Inconsistent(`talk ${talk.row.envelope_id} has no recorded trigger`);
        let trigger: Trigger;
        try {
          trigger = readTrigger(recorded.trigger_json);
        } catch (e) {
          throw new NotRecorded(causeMessage(e), { cause: e });
        }
        const urgency = urgencyOf({ source: trigger.source, actor: "user", recipient: "worker", event: "conversation", canSteer: true });
        prepared.push({
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
        });
      }
      try {
        await db.tx(async () => {
          const committed: { added: qd.InsertDeliveryResult[]; receipt: qr.MarkRoutedResult; row: DeliveryDraft }[] = [];
          for (const row of prepared) {
            const added = await writeDelivery({ session, row });
            await qd.markHanded(db.sql, { session_id: session, envelope_id: row.envelope_id, launch, handed_at: at });
            const receipt = await markRoute({ session, row });
            committed.push({ row, added, receipt });
          }
          await db.afterCommit(() => {
            for (const entry of committed) {
              received(entry.receipt);
              for (const added of entry.added) stored(session, { ...entry.row, position: added.position });
            }
          });
        });
      } catch (e) {
        throw notRecorded(e);
      }
    });

  const subscribe = async (issue: string, threads: readonly string[]): Promise<void> => {
    if (!issueOf(issue)) throw missing(t("server.issue.issueRef", { ref: issue }), [lookIn.issue]);
    await db.tx(async () => {
      for (const thread of new Set(threads)) {
        const owned = await qs.subscribeIssue(db.sql, { issue_id: issue, thread_key: thread });
        if (owned.length === 0) throw refused(t("server.mailbox.subscriptionTaken", { thread }));
      }
    });
  };

  const retire = async (issue: T.Issue, trigger: Trigger, session: string | null, reason: string, unreadOnly: boolean): Promise<void> => {
    const addressed = trigger.meta.ingressRecipient;
    const recipient =
      addressed !== undefined && agents.isOrchestrator(addressed) ? addressed : await orchestratorIn(trigger.replyChannel ?? (await defaultChannel()));
    await forward([
      {
        trigger,
        session: recipient,
        deliveryId: `returned:${issue.id}:${trigger.id}`,
        urgency: "queue",
        ...(session ? { previous: session } : {}),
        note: unreadOnly
          ? releasedInputWords(recipient, issue.number, trigger.card.readUri)
          : handbackWords(recipient, issue.number, reason, trigger.card.readUri),
        prepare: async () => {
          const current = await qi.existingIssueInput(db.sql, { trigger_id: trigger.id });
          if (!current || current.state === "returned") return false;
          if (unreadOnly && session) {
            const receipt = await qd.deliveryReceipt(db.sql, { session_id: session, envelope_id: trigger.id });
            if (receipt?.state === "consumed") return false;
          }
          return true;
        },
        commit: async () => {
          await qi.returnIssueInput(db.sql, { trigger_id: trigger.id, reason });
        },
      },
    ]);
    dispatch(recipient);
  };

  const flush = async (id: string, human: boolean = false): Promise<void> => {
    const issue = issueOf(id);
    if (!issue) return;
    if (issue.status === "backlog") return;
    const assigned = assignedAgentOf(issue);
    const worker = latestSessionIdOf(issue);
    const recipient = assigned && agents.isOrchestrator(assigned) ? assigned : worker && sessions.isReachable(worker) ? worker : undefined;
    const closing = issue.status === "done" || (issue.status === "canceled" && issue.canceled !== "lost");
    const inputs = await qi.pendingIssueInputs(db.sql, { issue_id: id, recipient: recipient ?? null, closing });
    if (closing) {
      for (const input of inputs) {
        const trigger = readTrigger(input.trigger_json);
        if (trigger.actor.kind === "user") await retire(issue, trigger, input.session_id, "closed", true);
        else await qi.returnIssueInput(db.sql, { trigger_id: trigger.id, reason: "closed" });
      }
      return;
    }
    let forwarded = false;
    for (const input of inputs) {
      const trigger = readTrigger(input.trigger_json);
      const reason =
        trigger.meta.botRound !== undefined && trigger.meta.botRound > issue.mandate.maxBotReviewRounds && !human
          ? "budget"
          : !recipient
            ? "session"
            : waitsForHuman(issue) && trigger.actor.kind !== "user" && !human
              ? "human"
              : undefined;
      if (reason) {
        await qi.holdIssueInput(db.sql, { trigger_id: trigger.id, reason });
        continue;
      }
      if (!recipient) continue;
      await forward([
        {
          trigger,
          session: recipient,
          issue: id,
          ...(input.session_id && input.session_id !== recipient ? { previous: input.session_id } : {}),
          prepare: async () => {
            if (input.session_id === null) return true;
            const receipt = await qd.deliveryReceipt(db.sql, { session_id: input.session_id, envelope_id: trigger.id });
            return (
              receipt === undefined ||
              receipt.state === "pending" ||
              receipt.state === "handed" ||
              (receipt.state === "dropped" && (receipt.dropped_why === "left" || receipt.dropped_why === "reassigned"))
            );
          },
          commit: async () => {
            await qi.forwardIssueInput(db.sql, { trigger_id: trigger.id, session_id: recipient });
          },
        },
      ]);
      forwarded = true;
    }
    if (forwarded && recipient) dispatch(recipient);
  };

  const isRouted = async (trigger: string): Promise<boolean> => (await qr.isRouted(db.sql, { envelope_id: trigger }))?.routed === true;

  const receive = async (trigger: Trigger, audience?: readonly OutboundDelivery[]): Promise<ChannelRouteResult | undefined> => {
    const existing = await qi.existingIssueInput(db.sql, { trigger_id: trigger.id });
    if (existing) {
      if (existing.state === "held") await flush(existing.issue_id);
      return;
    }
    if (!audience && (await isRouted(trigger.id))) return;
    const threads = audience && trigger.actor.kind !== "user" ? [] : trigger.threads;
    const matches = await qs.subscribedIssues(db.sql, { keys: [...threads] });
    const ids = new Set(matches.map((row) => row.issue_id));
    for (const thread of threads.filter((thread) => thread.startsWith("issue:"))) {
      const id = thread.slice(6);
      const issue = issueOf(id);
      if (issue) ids.add(issue.id);
      else if (await issueExists(db.sql, { id })) ids.add(id);
    }
    if (ids.size > 1) throw refused(t("server.mailbox.ambiguous"));
    const issue = ids.values().next().value;
    if (issue) {
      const at = clock.now();
      const receipt = await db.tx(async () => {
        await qi.holdIssueTrigger(db.sql, { issue_id: issue, trigger_id: trigger.id, created_at: at });
        if (trigger.meta.dispatch === true) await qi.supersedeDispatch(db.sql, { issue_id: issue, trigger_id: trigger.id });
        const routed = await qr.markRouted(db.sql, {
          envelope_id: trigger.id,
          routed_at: at,
          scope: deliveryScope(trigger.replyChannel ?? (await defaultChannel()), issue),
        });
        if (routed === undefined) throw new Inconsistent(`trigger ${trigger.id} was routed before it was recorded`);
        return routed;
      });
      await writtenLocked(async () => received(receipt));
      await flush(issue, trigger.actor.kind === "user");
      return;
    }
    if (audience) {
      const result = await forward(audience);
      for (const input of audience) dispatch(input.session);
      return result;
    }
    const addressed = trigger.meta.ingressRecipient;
    const recipient =
      addressed !== undefined && agents.isOrchestrator(addressed) ? addressed : await orchestratorIn(trigger.replyChannel ?? (await defaultChannel()));
    await forward([{ trigger, session: recipient, commit: async () => {} }]);
    dispatch(recipient);
    return undefined;
  };

  const decline = async (session: string, delivery: string, reason: string): Promise<boolean> => {
    const payload = await qd.deliveryPayload(db.sql, { session_id: session, envelope_id: delivery });
    if (!payload) return false;
    const source = await qr.triggerById(db.sql, { id: readPayload(payload.payload_json).trigger.id });
    if (!source) return false;
    const trigger = readTrigger(source.trigger_json);
    const input = await qi.existingIssueInput(db.sql, { trigger_id: trigger.id });
    if (!input) return false;
    if (input.session_id !== session) throw refused(t("server.mailbox.notOwned"));
    const issue = issueOf(input.issue_id);
    if (!issue) return false;
    if (input.state !== "returned") await retire(issue, trigger, session, reason, false);
    return true;
  };
  const queuedInputs = async () => (await qi.queuedInputs(db.sql)).map((row) => ({ issue: row.issue_id, trigger: readTrigger(row.trigger_json) }));
  const issueInputs = async (issue: string) => (await qi.issueInputs(db.sql, { issue_id: issue })).map((row) => readTrigger(row.trigger_json));
  const retireDispatches = async (issue: string, at: number): Promise<void> => {
    await qr.retireIssueDispatches(db.sql, { issue_id: issue, at });
    await qi.retireQueuedDispatches(db.sql, { issue_id: issue });
  };
  const ownerOf = async (trigger: string) => (await qi.existingIssueInput(db.sql, { trigger_id: trigger }))?.issue_id;
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
}
