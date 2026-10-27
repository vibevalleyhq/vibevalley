// What deciding who hears a message needs, kept in memory beside the chat's model (model.ts): who follows each thread,
// how many times agents have woken agents in each channel since the owner last spoke there, and when each
// participant was last woken by an agent. The chat tells it each follow and delivery as it writes them, and reloads it
// with the model when a transaction fails.

const agentLike = (kind: string) => kind === "session" || kind === "orchestrator";

export class Audience {
  private follows = new Map<string, Set<string>>();
  private hopsIn = new Map<string, number>();
  private ownerLast = new Map<string, string>();
  private lastWakeOf = new Map<string, number>();

  load(
    follows: readonly { channel_id: string; participant_id: string }[],
    hops: readonly { channel_id: string; n: number | null }[],
    lastWakes: readonly { recipient_id: string; at: number | null }[],
    ownerLast: readonly { channel_id: string; id: string | null }[],
  ) {
    this.follows.clear();
    this.hopsIn.clear();
    this.ownerLast.clear();
    this.lastWakeOf.clear();
    for (const f of follows) this.followed(f.channel_id, f.participant_id);
    for (const h of hops) this.hopsIn.set(h.channel_id, h.n ?? 0);
    for (const o of ownerLast) if (o.id !== null) this.ownerLast.set(o.channel_id, o.id);
    for (const w of lastWakes) this.lastWakeOf.set(w.recipient_id, w.at ?? 0);
  }

  /** Follow: following again is following. */
  followed(channel: string, participant: string) {
    const held = this.follows.get(channel);
    if (held) held.add(participant);
    else this.follows.set(channel, new Set([participant]));
  }

  /** By id. */
  followers(channel: string): string[] {
    return [...(this.follows.get(channel) ?? [])].sort();
  }

  /** The owner's words start the count of agents waking agents there again: only what is said
   * after them counts, a message streamed from before them included. */
  ownerSpoke(channel: string, message: string) {
    this.hopsIn.delete(channel);
    this.ownerLast.set(channel, message);
  }

  /** Agents waking agents here since the owner last spoke (AgentWakesByChannel). */
  hops(channel: string): number {
    return this.hopsIn.get(channel) ?? 0;
  }

  /** When an agent last woke it (LastAgentWakes); 0 when none. */
  lastWake(recipient: string): number {
    return this.lastWakeOf.get(recipient) ?? 0;
  }

  /** InsertDelivery: an agent's or the orchestrator's message that wakes its recipient, held by nothing, counts. */
  delivered(d: { channel: string; message: string; recipient: string; senderKind: string; recipientKind: string; wakes: boolean; held: boolean; at: number }) {
    if (!d.wakes || d.held || !agentLike(d.senderKind)) return;
    this.lastWakeOf.set(d.recipient, Math.max(this.lastWakeOf.get(d.recipient) ?? 0, d.at));
    if (agentLike(d.recipientKind) && d.message > (this.ownerLast.get(d.channel) ?? "")) this.hopsIn.set(d.channel, this.hops(d.channel) + 1);
  }
}
