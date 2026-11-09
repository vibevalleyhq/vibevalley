import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

export type DeliveryReason = "mention" | "everyone" | "own_thread" | "member" | "channel" | "direct" | "addressed";
type HeldBy = "hop_limit" | "cooldown" | "wake_breaker";

export interface Recipient {
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

interface HeldRecipient extends Recipient {
  readonly heldBy?: HeldBy;
}

/** Agent-to-agent wake brakes, in priority order. Human messages bypass all three. */
export function brakes(deliveries: readonly Recipient[], input: BrakeInput): HeldRecipient[] {
  const out: HeldRecipient[] = [];
  const byAgent = input.fromKind === "agent";
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

// The wake breaker: a helper whose launches fail wakeBreaker times running, each before it says a word, is not woken again until someone speaks to it by name or it leaves.
export class WakeBreaker {
  private readonly failures = new Map<string, number>();
  private readonly open = new Set<string>();

  private readonly limit: number;
  constructor(limit: number = wakeBreaker) {
    this.limit = limit;
  }

  /** A launch ended without a word. The count, and whether this one tripped the breaker. */
  failed(id: string): { readonly count: number; readonly tripped: boolean } {
    const count = (this.failures.get(id) ?? 0) + 1;
    this.failures.set(id, count);
    if (count < this.limit || this.open.has(id)) return { count, tripped: false };
    this.open.add(id);
    return { count, tripped: true };
  }

  /** It said something: the failures before do not count. */
  spoke(id: string) {
    this.failures.delete(id);
  }

  /** Spoken to by name, or gone: woken again. */
  reset(id: string) {
    this.open.delete(id);
    this.failures.delete(id);
  }

  isOpen(id: string) {
    return this.open.has(id);
  }

  /** Every tripped one, for the audience. */
  tripped(): string[] {
    return [...this.open].toSorted();
  }
}

export class Reach {
  private readonly hopsIn = new Map<string, number>();
  private readonly ownerLast = new Map<string, number>();
  private readonly lastWakeOf = new Map<string, number>();

  load(
    hops: readonly { scope: string; n: number | null }[],
    lastWakes: readonly { session_id: string; at: number | null }[],
    ownerLast: readonly { scope: string; position: number | null }[],
  ) {
    this.hopsIn.clear();
    this.ownerLast.clear();
    this.lastWakeOf.clear();
    for (const hop of hops) this.hopsIn.set(hop.scope, hop.n ?? 0);
    for (const owner of ownerLast) if (owner.position !== null) this.ownerLast.set(owner.scope, owner.position);
    for (const wake of lastWakes) this.lastWakeOf.set(wake.session_id, wake.at ?? 0);
  }

  ownerSpoke(scope: string, position: number) {
    if (position <= (this.ownerLast.get(scope) ?? 0)) return;
    this.hopsIn.delete(scope);
    this.ownerLast.set(scope, position);
  }

  hops(scope: string): number {
    return this.hopsIn.get(scope) ?? 0;
  }

  lastWake(session: string): number {
    return this.lastWakeOf.get(session) ?? 0;
  }

  delivered(input: ReachDelivery) {
    if (!input.wakes || input.held || input.senderKind !== "agent") return;
    this.lastWakeOf.set(input.session, Math.max(this.lastWakeOf.get(input.session) ?? 0, input.at));
    if (input.position > (this.ownerLast.get(input.scope) ?? 0)) this.hopsIn.set(input.scope, this.hops(input.scope) + 1);
  }

  left(session: string) {
    this.lastWakeOf.delete(session);
  }
}

interface ReachDelivery {
  readonly scope: string;
  readonly position: number;
  readonly session: string;
  readonly senderKind: T.ActorKind;
  readonly wakes: boolean;
  readonly held: boolean;
  readonly at: number;
}
