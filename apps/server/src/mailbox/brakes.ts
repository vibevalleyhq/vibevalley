import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

export type DeliveryReason = "mention" | "everyone" | "own_thread" | "follower" | "channel" | "direct" | "addressed";
export type HeldBy = "hop_limit" | "cooldown" | "wake_breaker";

export interface Delivery {
  readonly recipient: string;
  readonly reason: DeliveryReason;
  readonly wakes: boolean;
}

export interface BrakeInput {
  readonly fromKind: T.ActorKind;
  readonly orchestrators: readonly string[];
  readonly hops: number;
  readonly cooling: readonly string[];
  readonly broken: readonly string[];
}

export interface HeldDelivery extends Delivery {
  readonly heldBy?: HeldBy;
}

/** Agent-to-agent wake brakes, in priority order. Human messages bypass all three. */
export function brakes(deliveries: readonly Delivery[], input: BrakeInput): HeldDelivery[] {
  const out: HeldDelivery[] = [];
  const byAgent = input.fromKind === "session" || input.fromKind === "orchestrator";
  let hops = input.hops;
  for (const delivery of deliveries) {
    let heldBy: HeldBy | undefined;
    if (delivery.wakes && byAgent && hops >= hopLimit) heldBy = "hop_limit";
    else if (delivery.wakes && byAgent && !input.orchestrators.includes(delivery.recipient) && input.cooling.includes(delivery.recipient)) heldBy = "cooldown";
    else if (delivery.wakes && input.fromKind !== "owner" && input.broken.includes(delivery.recipient)) heldBy = "wake_breaker";
    if (delivery.wakes && byAgent && heldBy === undefined) hops++;
    out.push({ ...delivery, ...(heldBy === undefined ? {} : { heldBy }) });
  }
  return out;
}

export const hopLimitText = (limit: number) => t("server.channel.hopLimit", { limit });
export const hopLimit = 4;
export const agentWakeCooldownMs = 60_000;
export const wakeBreaker = 3;
