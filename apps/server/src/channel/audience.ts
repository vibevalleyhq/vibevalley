// Kept in memory beside the chat's model (model.ts): the chat tells it each follow as it writes it, and reloads it with
// the model when a transaction fails.

export class Follows {
  private follows = new Map<string, Set<string>>();

  load(follows: readonly { channel_id: string; participant_id: string }[]) {
    this.follows.clear();
    for (const f of follows) this.followed(f.channel_id, f.participant_id);
  }

  /** Follow: following again is following. */
  followed(channel: string, participant: string) {
    const held = this.follows.get(channel);
    if (held) held.add(participant);
    else this.follows.set(channel, new Set([participant]));
  }

  /** A Session that left follows nothing. */
  left(participant: string) {
    for (const [channel, held] of this.follows) if (held.delete(participant) && held.size === 0) this.follows.delete(channel);
  }

  /** By id. */
  followers(channel: string): string[] {
    return [...(this.follows.get(channel) ?? [])].toSorted();
  }
}
