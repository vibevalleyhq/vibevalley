import { Clock, Effect, Schema } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { assignedAgentOf, latestSessionIdOf } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";

import { Agent } from "@/agent/agent.ts";
import { Channel } from "@/channel/chat.ts";
import { type ApiError, refused } from "@/errors.ts";
import { Db } from "@/infra/db.ts";
import { waitsForHuman } from "@/issue/followup.ts";
import { Issue } from "@/issue/issue.ts";
import { Session } from "@/session/session.ts";

import * as qr from "../../db/generated/ingress_trigger.sql.ts";
import * as qd from "../../db/generated/mailbox_delivery.sql.ts";
import * as qi from "../../db/generated/mailbox_issue.sql.ts";
import * as qs from "../../db/generated/mailbox_subscription.sql.ts";
import { readPayload, deliveryScope } from "./payload.ts";
import { handbackWords, releasedInputWords } from "./prompts.ts";
import type { Urgency } from "./urgency.ts";

export interface Transfer {
  readonly urgency?: Urgency;
  readonly deliveryId?: string;
  readonly note?: string;
  readonly prepare?: Effect.Effect<boolean>;
  readonly trigger: T.Trigger;
  readonly session: string;
  readonly issue?: string;
  readonly previous?: string;
  readonly commit: Effect.Effect<void>;
}

const readTrigger = Schema.decodeUnknownSync(Schema.fromJsonString(S.Trigger));

export const makeWorkMailbox = (
  forward: (input: Transfer) => Effect.Effect<void, ApiError>,
  dispatch: (session: string) => void,
  received: (receipt: qr.MarkRoutedResult) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const issues = yield* Issue;
    const sessions = yield* Session;
    const agents = yield* Agent;
    const chat = yield* Channel;

    const subscribe = Effect.fn("Mailbox.subscribe")(function* (issue: string, threads: readonly string[]) {
      yield* issues.get(issue);
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
        typeof addressed === "string" && agents.isOrchestrator(addressed) ? addressed : chat.orchestratorOf(trigger.replyChannel ?? chat.defaultChannel());
      yield* forward({
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
      });
      dispatch(recipient);
    });

    const flush = Effect.fn("Mailbox.flushIssue")(function* (id: string, human: boolean = false) {
      const issue = yield* issues.get(id);
      const inputs = yield* db.run(qi.issueInputs({ issue_id: id }));
      if (issue.status === "backlog") {
        yield* db.run(qi.retireQueuedDispatches({ issue_id: id }));
        return;
      }
      if (issue.status === "done" || (issue.status === "canceled" && issue.canceled !== "lost")) {
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
      const assigned = assignedAgentOf(issue);
      const worker = latestSessionIdOf(issue);
      const recipient = assigned && agents.isOrchestrator(assigned) ? assigned : worker && sessions.present(worker) ? worker : undefined;
      let forwarded = false;
      yield* Effect.forEach(
        inputs,
        (input) =>
          Effect.gen(function* () {
            const trigger = readTrigger(input.trigger_json);
            if (input.state === "forwarded" && input.session_id !== null) {
              if (!recipient || input.session_id === recipient) return;
              const receipt = yield* db.one(qd.deliveryReceipt({ session_id: input.session_id, envelope_id: trigger.id }));
              if (receipt?.state === "consumed" || (receipt?.state === "dropped" && receipt.dropped_why !== "left" && receipt.dropped_why !== "reassigned"))
                return;
            }
            const reason =
              trigger.actor.kind === "bot" && typeof trigger.meta.botRound === "number" && trigger.meta.botRound > issue.mandate.maxBotReviewRounds && !human
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
            yield* forward({
              trigger,
              session: recipient,
              issue: id,
              ...(input.session_id && input.session_id !== recipient ? { previous: input.session_id } : {}),
              commit: db.run(qi.forwardIssueInput({ trigger_id: trigger.id, session_id: recipient })),
            });
            forwarded = true;
          }),
        { discard: true },
      );
      if (forwarded && recipient) dispatch(recipient);
    });

    const registered = Effect.fn("Mailbox.registered")(function* (trigger: string) {
      return (yield* db.run(qr.isRouted({ envelope_id: trigger }))).routed;
    });

    const receive = Effect.fn("Mailbox.receive")(function* (trigger: T.Trigger): Effect.fn.Return<void, ApiError> {
      const existing = yield* db.one(qi.existingIssueInput({ trigger_id: trigger.id }));
      if (existing) {
        if (existing.state === "held") yield* flush(existing.issue_id);
        return;
      }
      if (yield* registered(trigger.id)) return;
      const matches = yield* db.run(qs.subscribedIssues({ keys: [...trigger.threads] }));
      const ids = new Set(matches.map((row) => row.issue_id));
      yield* Effect.forEach(
        trigger.threads.filter((thread) => thread.startsWith("issue:")),
        (thread) =>
          Effect.gen(function* () {
            const issue = yield* Effect.option(issues.get(thread.slice(6)));
            if (issue._tag === "Some") ids.add(issue.value.id);
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
                scope: deliveryScope(trigger.replyChannel ?? chat.defaultChannel(), issue),
              }),
            );
          }),
        );
        yield* received(receipt);
        yield* flush(issue, trigger.actor.kind === "owner");
        return;
      }
      const addressed = trigger.meta.ingressRecipient;
      const recipient =
        typeof addressed === "string" && agents.isOrchestrator(addressed) ? addressed : chat.orchestratorOf(trigger.replyChannel ?? chat.defaultChannel());
      yield* forward({ trigger, session: recipient, commit: Effect.void });
      dispatch(recipient);
    });

    const returnInput = Effect.fn("Mailbox.returnOwnedInput")(function* (session: string, delivery: string, reason: string) {
      const payload = yield* db.one(qd.deliveryPayload({ session_id: session, envelope_id: delivery }));
      if (!payload) return false;
      const trigger = readPayload(payload.payload_json).trigger;
      const input = yield* db.one(qi.existingIssueInput({ trigger_id: trigger.id }));
      if (!input) return false;
      if (input.session_id !== session) return yield* Effect.fail(refused(t("server.mailbox.notOwned")));
      if (input.state !== "returned") yield* retire(yield* issues.get(input.issue_id), trigger, session, reason, false);
      return true;
    });
    const initial = Effect.fn("Mailbox.initialInputs")(function* (issue: string | undefined, explicit: readonly T.Trigger[]) {
      if (!issue) return explicit;
      const inputs = yield* db.run(qi.issueInputs({ issue_id: issue }));
      if (inputs.length === 0) return explicit;
      const item = yield* issues.get(issue);
      const accepted = new Map<string, T.Trigger>();
      const consumed = new Set<string>();
      const human = explicit.some((trigger) => trigger.actor.kind === "owner");
      yield* Effect.forEach(
        inputs,
        (input) =>
          Effect.gen(function* () {
            if (input.session_id !== null) {
              const receipt = yield* db.one(qd.deliveryReceipt({ session_id: input.session_id, envelope_id: input.trigger_id }));
              if (receipt?.state === "consumed") {
                consumed.add(input.trigger_id);
                return;
              }
            }
            const trigger = readTrigger(input.trigger_json);
            if (trigger.meta.dispatch === true && item.queuedAt === undefined) return;
            if (trigger.actor.kind === "bot" && typeof trigger.meta.botRound === "number" && trigger.meta.botRound > item.mandate.maxBotReviewRounds && !human)
              return;
            accepted.set(trigger.id, trigger);
          }),
        { discard: true },
      );
      for (const trigger of explicit) if (!consumed.has(trigger.id)) accepted.set(trigger.id, trigger);
      return [...accepted.values()];
    });
    const queuedInputs = Effect.map(db.run(qi.queuedInputs()), (rows) => rows.map((row) => ({ issue: row.issue_id, trigger: readTrigger(row.trigger_json) })));
    const ownerOf = Effect.fn("Mailbox.ownerOf")(function* (trigger: string) {
      return (yield* db.one(qi.existingIssueInput({ trigger_id: trigger })))?.issue_id;
    });
    return { subscribe, receive, flush, ownerOf, returnInput, registered, initial, queuedInputs };
  });
