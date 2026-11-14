// The brakes every automatic wake passes: the watch runs each delivery it routes through brakes() (hop limit, cooldown,
// the wake breaker), and the session it holds stays held (Session.holdWakes) until the user speaks to it by name or it
// leaves. The user's own words pass all three and start the hop count over.
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import type { DeliveryReason, HeldBy } from "#/modules/session/envelope.ts";

/** How many times agents' words may wake someone in one place before the user speaks there again. */
export const hopLimit = 4;
/** A session woken by an agent's words is not woken by another's within this; an orchestrator always is. */
const agentWakeCooldownMs = 60_000;
/** How many wakes running may end without a word before the session is held. */
export const wakeBreaker = 3;

export const hopLimitText = (limit: number) => t("server.channel.hopLimit", { limit });

export interface Recipient {
  readonly recipient: string;
  readonly reason: DeliveryReason;
  readonly wakes: boolean;
}

export interface BrakeInput {
  readonly actor: T.Actor;
  readonly orchestrators: readonly string[];
  /** The wakes by agents' words in the place since the user last spoke there. */
  readonly hops: number;
  /** The recipients still cooling down from the last agent's words that woke them. */
  readonly cooling: readonly string[];
  /** The recipients the wake breaker holds. */
  readonly broken: readonly string[];
}

export interface Braked extends Recipient {
  readonly heldBy?: HeldBy;
}

/** Agent-to-agent wake brakes, in priority order; each wake let through counts a hop. The user's words pass all three. */
export function brakes(deliveries: readonly Recipient[], input: BrakeInput): Braked[] {
  const out: Braked[] = [];
  const byAgent = input.actor.kind === "agent";
  let hops = input.hops;
  for (const delivery of deliveries) {
    let heldBy: HeldBy | undefined;
    if (delivery.wakes && byAgent && hops >= hopLimit) heldBy = "hop_limit";
    else if (delivery.wakes && byAgent && !input.orchestrators.includes(delivery.recipient) && input.cooling.includes(delivery.recipient)) heldBy = "cooldown";
    else if (delivery.wakes && input.actor.kind !== "user" && input.broken.includes(delivery.recipient)) heldBy = "wake_breaker";
    if (delivery.wakes && byAgent && heldBy === undefined) hops++;
    out.push({ ...delivery, ...(heldBy === undefined ? {} : { heldBy }) });
  }
  return out;
}

/** The wake breaker: a session whose wakes end wakeBreaker times running before it says a word is held until the user
 * speaks to it by name or it leaves. */
export class WakeBreaker {
  private readonly failures = new Map<string, number>();
  private readonly open = new Set<string>();

  private readonly limit: number;
  constructor(limit: number = wakeBreaker) {
    this.limit = limit;
  }

  /** A wake ended without a word. The count, and whether this one tripped the breaker. */
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

  /** Spoken to by name, or gone: woken again. True when it was held. */
  reset(id: string): boolean {
    this.failures.delete(id);
    return this.open.delete(id);
  }

  /** Every tripped one, for the brakes. */
  tripped(): string[] {
    return [...this.open].toSorted();
  }
}

/** The hops per place and each session's last wake by agents' words, kept as the watch routes. */
export class Reach {
  private readonly hopsIn = new Map<string, number>();
  private readonly lastWakeOf = new Map<string, number>();

  /** What the deliveries kept (Session.agentWakes), at startup. */
  load(scopes: readonly { readonly scope: string; readonly n: number }[], sessions: readonly { readonly session: string; readonly at: number }[]) {
    this.hopsIn.clear();
    this.lastWakeOf.clear();
    for (const s of scopes) this.hopsIn.set(s.scope, s.n);
    for (const s of sessions) this.lastWakeOf.set(s.session, s.at);
  }

  /** The user spoke in the place: the hops start over. */
  userSpoke(scope: string) {
    this.hopsIn.delete(scope);
  }

  hops(scope: string): number {
    return this.hopsIn.get(scope) ?? 0;
  }

  /** The sessions among `of` an agent's words woke within the cooldown before `at`. */
  cooling(of: readonly string[], at: number): string[] {
    return of.filter((session) => {
      const last = this.lastWakeOf.get(session);
      return last !== undefined && at - last < agentWakeCooldownMs;
    });
  }

  /** An agent's words in the place woke the session. */
  woke(scope: string, session: string, at: number) {
    this.lastWakeOf.set(session, Math.max(this.lastWakeOf.get(session) ?? 0, at));
    this.hopsIn.set(scope, this.hops(scope) + 1);
  }

  left(session: string) {
    this.lastWakeOf.delete(session);
  }
}
