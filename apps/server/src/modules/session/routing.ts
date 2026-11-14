import type * as T from "@vibevalley/protocol";

import type { DeliveryDraft } from "./deliveries.ts";
import type { Delivery, DeliveryEvent, Urgency } from "./envelope.ts";
import { deliveryScope, triggerPayload } from "./payload.ts";
import type { Trigger, TriggerSource } from "./shapes.ts";

function triggerEvent(trigger: Pick<Trigger, "actor" | "source" | "meta" | "addressed">): DeliveryEvent {
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

/** The row a routed trigger is written as for one session, pending: it answers in the trigger's reply channel, else the
 * session's (channel); its urgency is the one given, else what the session's role makes of the event; it wakes the
 * session as the watch heard it, else unless it is a digest. */
export function deliveryDraftOf(
  trigger: Trigger,
  input: Delivery,
  at: { readonly channel: string; readonly role: T.AgentRole; readonly at: number },
): DeliveryDraft {
  const destination = trigger.replyChannel ?? at.channel;
  const urgency =
    input.urgency ??
    urgencyOf({ source: trigger.source, actor: trigger.actor.kind, recipient: at.role, event: input.event ?? triggerEvent(trigger), canSteer: true });
  const heard = input.heard ?? { reason: "addressed" as const, wakes: urgency !== "digest" };
  return {
    envelope_id: input.id ?? trigger.id,
    scope: deliveryScope(destination, input.issue),
    message_id: trigger.meta.channelMessageId ?? null,
    channel_id: destination,
    source: trigger.source,
    urgency,
    reason: heard.reason,
    wakes: heard.wakes,
    held_by: heard.heldBy ?? null,
    state: "pending",
    launch: null,
    created_at: at.at,
    payload: triggerPayload(trigger, input.issue, input.note),
  };
}
