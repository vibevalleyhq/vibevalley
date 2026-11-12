import { compareText, or } from "#/base/order.ts";
import type * as qc from "#db/channel.sql.ts";
import type * as qp from "#db/channel_participant.sql.ts";

export type ChannelRow = qc.AllChannelsResult;
type ParticipantRow = qp.ParticipantsResult;

const subjectKey = (kind: string, id: string) => kind + ":" + id;

export class Members {
  private members = new Map<string, Set<string>>();

  load(follows: readonly { channel_id: string; participant_id: string }[]) {
    this.members.clear();
    for (const f of follows) this.memberAdded(f.channel_id, f.participant_id);
  }

  memberAdded(channel: string, participant: string) {
    const held = this.members.get(channel);
    if (held) held.add(participant);
    else this.members.set(channel, new Set([participant]));
  }

  memberRemoved(channel: string, participant: string) {
    const held = this.members.get(channel);
    if (held?.delete(participant) === true && held.size === 0) this.members.delete(channel);
  }

  channelRemoved(channel: string) {
    this.members.delete(channel);
  }

  left(participant: string) {
    for (const [channel, held] of this.members) if (held.delete(participant) && held.size === 0) this.members.delete(channel);
  }

  membersOf(channel: string): string[] {
    return [...(this.members.get(channel) ?? [])].toSorted();
  }
}

export class ChatModel {
  private byId = new Map<string, ChannelRow>();
  private threadByRoot = new Map<string, string>();
  private threadBySubject = new Map<string, string>();
  private people = new Map<string, ParticipantRow>();
  private userRead = new Map<string, number>();
  private members = new Members();
  readonly lastRead = new Map<string, string>();
  private publishedLast = new Map<string, number>();

  load(
    channels: readonly ChannelRow[],
    participants: readonly ParticipantRow[],
    userRead: readonly { channel_id: string; read_number: number }[],
    follows?: readonly { channel_id: string; participant_id: string }[],
  ) {
    this.byId.clear();
    this.threadByRoot.clear();
    this.threadBySubject.clear();
    this.people.clear();
    this.userRead.clear();
    for (const c of channels) this.created(c);
    for (const p of participants) this.people.set(p.id, { ...p });
    for (const r of userRead) this.userRead.set(r.channel_id, r.read_number);
    if (follows) this.members.load(follows);
  }

  channel(id: string): ChannelRow | undefined {
    return this.byId.get(id);
  }

  threadOfRoot(root: string): string | undefined {
    return this.threadByRoot.get(root);
  }

  /** Relies on lexicographically monotonic thread ids to retain the newest thread per subject. */
  threadOfSubject(kind: string, id: string): string | undefined {
    return this.threadBySubject.get(subjectKey(kind, id));
  }

  defaultChannel(): ChannelRow | undefined {
    for (const c of this.byId.values()) if (c.is_default) return c;
    return undefined;
  }

  defaultId(): string {
    return this.defaultChannel()?.id ?? "";
  }

  /** Direct rooms fall back to `defaultChannel()` because they have no parent channel. */
  topChannel(id: string): ChannelRow | undefined {
    const row = this.byId.get(id);
    if (!row || row.type === "direct") return this.defaultChannel();
    return (row.type === "thread" && row.parent_id ? this.byId.get(row.parent_id) : row) ?? this.defaultChannel();
  }

  channelByName(name: string): ChannelRow | undefined {
    for (const c of this.byId.values()) if (c.name === name && c.type === "channel") return c;
    return undefined;
  }

  channels(type: "channel" | "direct" = "channel"): ChannelRow[] {
    const all = [...this.byId.values()].filter((c) => c.type === type);
    const place = (c: ChannelRow) => c.position ?? Number.MAX_SAFE_INTEGER;
    return all.toSorted((a, b) => (a.is_default ? -1 : b.is_default ? 1 : or(place(a) - place(b), compareText(a.id, b.id))));
  }

  threadsOf(channel: string): ChannelRow[] {
    return [...this.byId.values()].filter((c) => c.parent_id === channel);
  }

  created(row: ChannelRow) {
    this.byId.set(row.id, { ...row });
    if (row.root_id !== null) this.threadByRoot.set(row.root_id, row.id);
    if (row.subject_kind !== null && row.subject_id !== null) {
      const key = subjectKey(row.subject_kind, row.subject_id);
      const held = this.threadBySubject.get(key);
      if (held === undefined || held < row.id) this.threadBySubject.set(key, row.id);
    }
  }

  channelUpdated(id: string, description: string | null, repo: string | null) {
    const c = this.byId.get(id);
    if (c && c.type !== "thread") this.byId.set(id, { ...c, description, repo });
  }

  patched(id: string, change: Partial<Pick<ChannelRow, "name" | "category" | "position" | "archived_at" | "notify">>) {
    const c = this.byId.get(id);
    if (c) this.byId.set(id, { ...c, ...change });
  }

  removed(id: string) {
    for (const c of [...this.byId.values()])
      if (c.id === id || c.parent_id === id) {
        this.byId.delete(c.id);
        this.userRead.delete(c.id);
        this.publishedLast.delete(c.id);
        this.members.channelRemoved(c.id);
        if (c.root_id !== null) this.threadByRoot.delete(c.root_id);
        if (c.subject_kind !== null && c.subject_id !== null && this.threadBySubject.get(subjectKey(c.subject_kind, c.subject_id)) === c.id)
          this.threadBySubject.delete(subjectKey(c.subject_kind, c.subject_id));
      }
  }

  /** Unlike `userReadTo`, `markUnread` moves the read cursor backward. */
  userReadBack(channel: string, number: number) {
    this.userRead.set(channel, number);
  }

  defaultMoved(from: string, to: string) {
    const a = this.byId.get(from);
    const b = this.byId.get(to);
    if (a) this.byId.set(from, { ...a, is_default: false });
    if (b) this.byId.set(to, { ...b, is_default: true });
  }

  touched(id: string, number: number) {
    const c = this.byId.get(id);
    if (c)
      this.byId.set(id, {
        ...c,
        last_number: Math.max(c.last_number ?? 0, number),
        reply_count: c.reply_count + (c.type === "thread" ? 1 : 0),
      });
  }

  participants(): ParticipantRow[] {
    return [...this.people.values()];
  }

  participant(id: string): ParticipantRow | undefined {
    return this.people.get(id);
  }

  /** Preserves original `kind` and `joined_at` when an existing participant rejoins. */
  joined(p: Omit<ParticipantRow, "left_at">) {
    const held = this.people.get(p.id);
    // A home of none keeps the one it had, as the upsert does.
    const home_id = p.home_id ?? held?.home_id ?? null;
    this.people.set(
      p.id,
      held ? { ...held, role: p.role, name: p.name, agent_id: p.agent_id, runtime: p.runtime, home_id, left_at: null } : { ...p, home_id, left_at: null },
    );
  }

  left(id: string, at: number) {
    this.members.left(id);
    this.lastRead.delete(id);
    const p = this.people.get(id);
    if (p && p.left_at === null) this.people.set(id, { ...p, left_at: at });
  }

  memberAdded(channel: string, participant: string) {
    this.members.memberAdded(channel, participant);
  }

  memberRemoved(channel: string, participant: string) {
    this.members.memberRemoved(channel, participant);
  }

  membersOf(channel: string): string[] {
    return this.members.membersOf(channel);
  }

  publishedNumber(channel: string): number | undefined {
    return this.publishedLast.get(channel);
  }

  notePublished(channel: string, number: number) {
    this.publishedLast.set(channel, Math.max(this.publishedLast.get(channel) ?? 0, number));
  }

  userReadIn(channel: string): number | undefined {
    return this.userRead.get(channel);
  }

  userReadTo(channel: string, number: number) {
    this.userRead.set(channel, Math.max(this.userRead.get(channel) ?? number, number));
  }
}
