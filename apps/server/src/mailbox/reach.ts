import type * as T from "@vibevalley/protocol";

const isAgent = (kind: T.ActorKind) => kind === "session" || kind === "orchestrator";

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
    if (!input.wakes || input.held || !isAgent(input.senderKind)) return;
    this.lastWakeOf.set(input.session, Math.max(this.lastWakeOf.get(input.session) ?? 0, input.at));
    if (input.position > (this.ownerLast.get(input.scope) ?? 0)) this.hopsIn.set(input.scope, this.hops(input.scope) + 1);
  }

  left(session: string) {
    this.lastWakeOf.delete(session);
  }
}

export interface ReachDelivery {
  readonly scope: string;
  readonly position: number;
  readonly session: string;
  readonly senderKind: T.ActorKind;
  readonly wakes: boolean;
  readonly held: boolean;
  readonly at: number;
}
