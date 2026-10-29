import { t } from "@vibevalley/i18n";
import { type Channel, everyone, ownerId, type MessageKind, type Outcome, type ActorKind } from "@vibevalley/protocol";
// Kept in memory beside the chat's model (model.ts): the chat tells it each follow and delivery as it writes them, and
// reloads it with the model when a transaction fails.

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

export type DeliveryReason = "mention" | "everyone" | "own_thread" | "follower" | "channel" | "direct" | "dispatch" | "addressed" | "graph";

export type HeldBy = "hop_limit" | "cooldown" | "wake_breaker";

export interface Delivery {
  readonly recipient: string;
  readonly reason: DeliveryReason;
  readonly wakes: boolean;
  readonly heldBy?: HeldBy;
}

export interface AudienceInput {
  readonly from: string;
  readonly fromKind: ActorKind;
  readonly kind: MessageKind;
  readonly mentions: readonly string[];
  readonly channel: Pick<Channel, "type" | "peer">;
  /** The place's orchestrator, by its profile id: the one the owner's words there go to when they name no one else. */
  readonly orchestrator: string;
  /** Every orchestrator's profile id: each is always there to be named, and none cools down. */
  readonly orchestrators: readonly string[];
  /** In a thread, the session its words are for: the one working the thread's issue now, "" when none is. */
  readonly threadOwner?: string;
  readonly sessions: readonly string[];
  /** sessions when undefined. */
  readonly present?: readonly string[] | null;
  readonly followers: readonly string[];
  readonly hops: number;
  readonly cooling: readonly string[];
  readonly broken: readonly string[];
  readonly outcome?: Outcome;
  readonly forTask?: boolean;
  readonly spoken?: boolean;
}

/** Who hears a message: in a direct channel the owner's words wake the peer and no one else hears anything; elsewhere
 * who is named first (the strongest reason wins), then the thread's owner and followers, or the channel's. */
export function chatAudience(i: AudienceInput): Delivery[] {
  const out: Delivery[] = [];
  if (i.kind === "notice" || i.kind === "dispatch" || i.fromKind === "system" || i.spoken) return out;
  const byAgent = i.fromKind === "session" || i.fromKind === "orchestrator";
  const present = i.present ?? i.sessions;
  let hops = i.hops;
  const add = (recipient: string, reason: DeliveryReason, wakes: boolean) => {
    if (recipient === i.from || out.some((d) => d.recipient === recipient)) return;
    if (!i.orchestrators.includes(recipient) && !present.includes(recipient)) return;
    let heldBy: HeldBy | undefined;
    if (wakes && byAgent && hops >= hopLimit) heldBy = "hop_limit";
    else if (wakes && byAgent && !i.orchestrators.includes(recipient) && i.cooling.includes(recipient)) heldBy = "cooldown";
    else if (wakes && i.fromKind !== "owner" && i.broken.includes(recipient)) heldBy = "wake_breaker";
    if (wakes && byAgent && !heldBy) hops++;
    out.push({ recipient, reason, wakes, ...(heldBy ? { heldBy } : {}) });
  };

  // With an orchestrator, the owner's words go to it; with a helper profile, to the session talking for it now (none
  // between its rounds: the talk's issue hears the words and sends one).
  if (i.channel.type === "direct") {
    const peer = i.channel.peer ?? "";
    const to = i.orchestrators.includes(peer) ? peer : (i.threadOwner ?? "");
    if (i.fromKind === "owner" && to) add(to, "direct", true);
    return out;
  }
  if (i.kind === "report") {
    if (!i.forTask) add(i.orchestrator, "addressed", i.outcome === "failed");
    return out;
  }
  const mentions = i.mentions;
  for (const m of mentions) {
    if (m === everyone) {
      if (i.fromKind === "owner") for (const h of i.sessions) add(h, "everyone", true);
    } else if (m !== ownerId) add(m, "mention", true);
  }
  const thread = i.channel.type === "thread";
  const owner = thread ? (i.threadOwner ?? "") : "";
  if (i.fromKind === "owner") {
    if (owner) add(owner, "own_thread", true);
    if (thread) for (const f of i.followers) add(f, "follower", true);
    else {
      if (!mentions.some((m) => m !== ownerId)) add(i.orchestrator, "addressed", true);
      for (const h of i.sessions) add(h, "channel", false);
    }
  } else if (owner) add(owner, "own_thread", true);
  return out;
}

export const hopLimitText = (limit: number) => t("server.channel.hopLimit", { limit });

/** Counted since the person last spoke in the channel. */
export const hopLimit = 4;

export const agentWakeCooldownMs = 60_000;

/** Past this, only the person wakes the session. */
export const wakeBreaker = 3;
