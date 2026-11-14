import type * as T from "@vibevalley/protocol";
import { everyone, userId } from "@vibevalley/protocol";

import type { DeliveryEvent, DeliveryReason } from "#/modules/session/envelope.ts";

import type { Recipient } from "./brakes.ts";

/** What the watch knows of a message's place and people when it works out who hears it. */
export interface ChannelAudience {
  readonly from: string;
  readonly actor: T.Actor;
  readonly kind: T.MessageKind;
  readonly mentions: readonly string[];
  readonly channel: Pick<T.Channel, "type" | "peer">;
  readonly orchestrator: string;
  readonly channelMembers: readonly string[];
  readonly orchestrators: readonly string[];
  readonly threadOwner?: string;
  readonly sessions: readonly string[];
  readonly present?: readonly string[] | null;
  readonly members: readonly string[];
  readonly outcome?: T.Outcome;
  readonly spoken?: boolean;
}

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

/** What a delivery of a message is to the one who hears it: a report's, the user's words, a name called, or what is said around. */
export function eventOf(audience: Pick<ChannelAudience, "kind" | "actor" | "outcome">, reason: DeliveryReason): DeliveryEvent {
  if (audience.kind === "report") return audience.outcome === "failed" || audience.outcome === "interrupted" ? "report_attention" : "report_progress";
  if (audience.actor.kind === "user") return "conversation";
  return reason === "mention" || reason === "everyone" ? "mention" : "ambient";
}
