import type * as T from "@vibevalley/protocol";
import type { TriggerActorKind, TriggerSource } from "@vibevalley/protocol";

export const UrgencyValues = ["interrupt", "steer", "queue", "digest"] as const;
export type Urgency = (typeof UrgencyValues)[number];

export type DeliveryEvent = "stop" | "conversation" | "mention" | "assignment" | "review" | "ci_failed" | "report_attention" | "report_progress" | "ambient";

export function triggerEvent(trigger: Pick<T.Trigger, "actor" | "source" | "meta" | "addressed">): DeliveryEvent {
  if (trigger.actor.kind === "owner") return "conversation";
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

export interface UrgencyInput {
  readonly source: TriggerSource;
  readonly actor: TriggerActorKind;
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
