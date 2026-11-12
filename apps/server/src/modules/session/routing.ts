import type * as T from "@vibevalley/protocol";

import type { DeliveryEvent } from "./envelope.ts";
import type { Trigger, TriggerSource } from "./shapes.ts";

/** The issue holds its mailbox until the user answers: it asks, is stuck, or waits for the user's verdict. */
export const waitsForHuman = (issue: Pick<T.Issue, "stage">) =>
  issue.stage.state === "asking" || issue.stage.state === "stuck" || issue.stage.state === "reviewing";

/** Why an input for an issue stays held in its pool: past the issue's bot review rounds, no one to take it, or the
 * issue waits on the user; the user's own words (human) pass the first and the last. Undefined: it goes on now. */
export const holdReasonOf = (
  trigger: Pick<Trigger, "meta" | "actor">,
  issue: Pick<T.Issue, "stage" | "mandate">,
  recipient: string | undefined,
  human: boolean,
): "budget" | "session" | "human" | undefined =>
  trigger.meta.botRound !== undefined && trigger.meta.botRound > issue.mandate.maxBotReviewRounds && !human
    ? "budget"
    : !recipient
      ? "session"
      : waitsForHuman(issue) && trigger.actor.kind !== "user" && !human
        ? "human"
        : undefined;

const UrgencyValues = ["interrupt", "steer", "queue", "digest"] as const;
export type Urgency = (typeof UrgencyValues)[number];

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
