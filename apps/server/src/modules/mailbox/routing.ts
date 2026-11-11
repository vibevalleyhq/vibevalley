import { Effect } from "effect";

import type * as T from "@vibevalley/protocol";
import { everyone, userId } from "@vibevalley/protocol";

import type { Recipient, DeliveryReason } from "./brakes.ts";
import type { ChannelAudience, ChannelHearers } from "./envelope.ts";
import type { Trigger, TriggerSource } from "./shapes.ts";
import type { OutboundDelivery } from "./work.ts";

/** The issue holds its mailbox until the user answers: it asks, is stuck, or waits for the user's verdict. */
export const waitsForHuman = (issue: Pick<T.Issue, "stage">) =>
  issue.stage.state === "asking" || issue.stage.state === "stuck" || issue.stage.state === "reviewing";

/** Who hears a message before wake brakes are applied. */
export function whoHears(input: ChannelAudience): Recipient[] {
  const deliveries: Recipient[] = [];
  if (input.kind === "notice" || input.kind === "dispatch" || input.actor.kind === "system" || input.spoken === true) return deliveries;
  const present = input.present ?? input.sessions;
  const add = (recipient: string, reason: DeliveryReason, wakes: boolean) => {
    if (recipient === input.from || deliveries.some((delivery) => delivery.recipient === recipient)) return;
    if (!input.orchestrators.includes(recipient) && !present.includes(recipient)) return;
    deliveries.push({ recipient, reason, wakes });
  };

  if (input.channel.type === "direct") {
    const peer = input.channel.peer ?? "";
    const recipient = input.orchestrators.includes(peer) ? peer : (input.threadOwner ?? "");
    if (input.actor.kind === "user" && recipient) add(recipient, "direct", true);
    return deliveries;
  }
  if (input.kind === "report") {
    for (const member of input.channelMembers) add(member, "addressed", input.outcome === "failed");
    return deliveries;
  }
  for (const mention of input.mentions) {
    if (mention === everyone) {
      if (input.actor.kind === "user") for (const session of input.sessions) add(session, "everyone", true);
    } else if (mention !== userId) add(mention, "mention", true);
  }
  const thread = input.channel.type === "thread";
  const threadOwner = thread ? (input.threadOwner ?? "") : "";
  if (input.actor.kind === "user") {
    if (threadOwner) add(threadOwner, "own_thread", true);
    if (thread) for (const member of input.members) add(member, "member", true);
    else {
      if (!input.mentions.some((mention) => mention !== userId)) for (const member of input.channelMembers) add(member, "addressed", true);
      for (const session of input.sessions) add(session, "channel", false);
    }
  } else if (threadOwner) add(threadOwner, "own_thread", true);
  return deliveries;
}

export function channelRecipients(trigger: Trigger, input: ChannelHearers): OutboundDelivery[] {
  const candidates = input.addressed ? [{ recipient: input.addressed, reason: "addressed" as const, wakes: true }] : whoHears(input.audience);
  return candidates.map((delivery) => ({
    trigger,
    session: delivery.recipient,
    delivery,
    role: input.roles[delivery.recipient] ?? "worker",
    commit: Effect.void,
    event:
      input.row.kind === "report"
        ? input.outcome === "failed" || input.outcome === "interrupted"
          ? "report_attention"
          : "report_progress"
        : input.row.sender_kind === "user"
          ? "conversation"
          : delivery.reason === "mention" || delivery.reason === "everyone"
            ? "mention"
            : "ambient",
  }));
}

const UrgencyValues = ["interrupt", "steer", "queue", "digest"] as const;
export type Urgency = (typeof UrgencyValues)[number];

export type DeliveryEvent = "stop" | "conversation" | "mention" | "assignment" | "review" | "ci_failed" | "report_attention" | "report_progress" | "ambient";

export function triggerEvent(trigger: Pick<Trigger, "actor" | "source" | "meta" | "addressed">): DeliveryEvent {
  if (trigger.actor.kind === "user") return "conversation";
  switch (trigger.source) {
    case "github":
      if (trigger.meta.kind !== "ci") return "review";
      return trigger.meta.failed === true ? "ci_failed" : "report_progress";
    case "cron":
    case "workbench":
      return "assignment";
    case "channel":
    case "connector":
    case "voice":
      return trigger.addressed === "mention" ? "mention" : "ambient";
    case "patrol":
      return "ambient";
  }
}

interface UrgencyInput {
  readonly source: TriggerSource;
  readonly actor: T.ActorKind;
  readonly recipient: T.AgentRole;
  readonly event: DeliveryEvent;
  readonly canSteer: boolean;
  readonly busyWithChildren?: boolean;
}

export function urgencyOf(input: UrgencyInput): Urgency {
  let urgency: Urgency;
  switch (input.event) {
    case "stop":
      urgency = input.recipient === "orchestrator" && input.busyWithChildren === true ? "steer" : "interrupt";
      break;
    case "conversation":
      urgency = "steer";
      break;
    case "mention":
      urgency = input.recipient === "worker" ? "steer" : "queue";
      break;
    case "assignment":
    case "review":
    case "report_attention":
      urgency = "queue";
      break;
    case "ci_failed":
      urgency = input.recipient === "worker" ? "queue" : "digest";
      break;
    case "report_progress":
    case "ambient":
      urgency = "digest";
      break;
  }
  return urgency === "steer" && !input.canSteer ? "queue" : urgency;
}
