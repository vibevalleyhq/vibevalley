import { everyone, ownerId } from "@vibevalley/protocol";

import type { ChannelAudience } from "@/base/chat.ts";

import type { Delivery, DeliveryReason } from "./brakes.ts";

/** Who hears a message before wake brakes are applied. */
export function whoHears(input: ChannelAudience): Delivery[] {
  const deliveries: Delivery[] = [];
  if (input.kind === "notice" || input.kind === "dispatch" || input.fromKind === "system" || input.spoken === true) return deliveries;
  const present = input.present ?? input.sessions;
  const add = (recipient: string, reason: DeliveryReason, wakes: boolean) => {
    if (recipient === input.from || deliveries.some((delivery) => delivery.recipient === recipient)) return;
    if (!input.orchestrators.includes(recipient) && !present.includes(recipient)) return;
    deliveries.push({ recipient, reason, wakes });
  };

  if (input.channel.type === "direct") {
    const peer = input.channel.peer ?? "";
    const recipient = input.orchestrators.includes(peer) ? peer : (input.threadOwner ?? "");
    if (input.fromKind === "owner" && recipient) add(recipient, "direct", true);
    return deliveries;
  }
  if (input.kind === "report") {
    add(input.orchestrator, "addressed", input.outcome === "failed");
    return deliveries;
  }
  for (const mention of input.mentions) {
    if (mention === everyone) {
      if (input.fromKind === "owner") for (const session of input.sessions) add(session, "everyone", true);
    } else if (mention !== ownerId) add(mention, "mention", true);
  }
  const thread = input.channel.type === "thread";
  const threadOwner = thread ? (input.threadOwner ?? "") : "";
  if (input.fromKind === "owner") {
    if (threadOwner) add(threadOwner, "own_thread", true);
    if (thread) for (const follower of input.followers) add(follower, "follower", true);
    else {
      if (!input.mentions.some((mention) => mention !== ownerId)) add(input.orchestrator, "addressed", true);
      for (const session of input.sessions) add(session, "channel", false);
    }
  } else if (threadOwner) add(threadOwner, "own_thread", true);
  return deliveries;
}
