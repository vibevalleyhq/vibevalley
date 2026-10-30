// What the chat keeps in memory of what it wrote: every channel, every participant, how far the owner has read in
// each channel. The database stays the record: chat.ts writes there first and tells the model the same change right
// after, each update here doing what its query does (the comments name it); a transaction that fails reloads the model,
// since the changes told inside it are gone from the database. Only the chat writes these tables, one change at a time.

import { compareText, or } from "@/base/order.ts";

import type * as qc from "../../db/generated/channel.sql.ts";
import type * as qp from "../../db/generated/channel_participant.sql.ts";

export type ChannelRow = qc.AllChannelsResult;
export type ParticipantRow = qp.ParticipantsResult;

const subjectKey = (kind: string, id: string) => kind + ":" + id;

export class ChatModel {
  private byId = new Map<string, ChannelRow>();
  private threadByRoot = new Map<string, string>();
  private threadBySubject = new Map<string, string>();
  private people = new Map<string, ParticipantRow>();
  private ownerRead = new Map<string, number>();

  load(channels: readonly ChannelRow[], participants: readonly ParticipantRow[], ownerRead: readonly { channel_id: string; read_number: number }[]) {
    this.byId.clear();
    this.threadByRoot.clear();
    this.threadBySubject.clear();
    this.people.clear();
    this.ownerRead.clear();
    for (const c of channels) this.created(c);
    for (const p of participants) this.people.set(p.id, { ...p });
    for (const r of ownerRead) this.ownerRead.set(r.channel_id, r.read_number);
  }

  channel(id: string): ChannelRow | undefined {
    return this.byId.get(id);
  }

  /** The thread under a message: there is one at most. */
  threadOfRoot(root: string): string | undefined {
    return this.threadByRoot.get(root);
  }

  /** A subject's newest thread, as ids sort by when they were made. */
  threadOfSubject(kind: string, id: string): string | undefined {
    return this.threadBySubject.get(subjectKey(kind, id));
  }

  channelByName(name: string): ChannelRow | undefined {
    for (const c of this.byId.values()) if (c.name === name && c.type === "channel") return c;
    return undefined;
  }

  /** The channels of a type in the sidebar's order: the default first, then by place, then as they were made. */
  channels(type: "channel" | "direct" = "channel"): ChannelRow[] {
    const all = [...this.byId.values()].filter((c) => c.type === type);
    const place = (c: ChannelRow) => c.position ?? Number.MAX_SAFE_INTEGER;
    return all.toSorted((a, b) => (a.is_default ? -1 : b.is_default ? 1 : or(place(a) - place(b), compareText(a.id, b.id))));
  }

  threadsOf(channel: string): ChannelRow[] {
    return [...this.byId.values()].filter((c) => c.parent_id === channel);
  }

  /** CreateChannel, CreateDirect, CreateThread. */
  created(row: ChannelRow) {
    this.byId.set(row.id, { ...row });
    if (row.root_id !== null) this.threadByRoot.set(row.root_id, row.id);
    if (row.subject_kind !== null && row.subject_id !== null) {
      const key = subjectKey(row.subject_kind, row.subject_id);
      const held = this.threadBySubject.get(key);
      if (held === undefined || held < row.id) this.threadBySubject.set(key, row.id);
    }
  }

  /** UpdateChannel. */
  channelUpdated(id: string, description: string | null, project: string | null) {
    const c = this.byId.get(id);
    if (c && c.type !== "thread") this.byId.set(id, { ...c, description, project });
  }

  /** RenameChannel, SetCategory, PlaceChannel, SetArchived, SetNotify. */
  patched(id: string, change: Partial<Pick<ChannelRow, "name" | "category" | "position" | "archived_at" | "notify" | "orchestrator">>) {
    const c = this.byId.get(id);
    if (c) this.byId.set(id, { ...c, ...change });
  }

  /** DeleteThreadsOf, DeleteChannel: the channel and its threads. */
  removed(id: string) {
    for (const c of [...this.byId.values()])
      if (c.id === id || c.parent_id === id) {
        this.byId.delete(c.id);
        this.ownerRead.delete(c.id);
        if (c.root_id !== null) this.threadByRoot.delete(c.root_id);
        if (c.subject_kind !== null && c.subject_id !== null && this.threadBySubject.get(subjectKey(c.subject_kind, c.subject_id)) === c.id)
          this.threadBySubject.delete(subjectKey(c.subject_kind, c.subject_id));
      }
  }

  /** MarkUnread for the owner: it moves back too. */
  ownerReadBack(channel: string, number: number) {
    this.ownerRead.set(channel, number);
  }

  /** ClearDefault, MakeDefault. */
  defaultMoved(from: string, to: string) {
    const a = this.byId.get(from);
    const b = this.byId.get(to);
    if (a) this.byId.set(from, { ...a, is_default: false });
    if (b) this.byId.set(to, { ...b, is_default: true });
  }

  /** TouchChannel. */
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

  /** UpsertParticipant: one already there keeps its kind and when it joined, and is back. */
  joined(p: Omit<ParticipantRow, "left_at">) {
    const held = this.people.get(p.id);
    this.people.set(p.id, held ? { ...held, name: p.name, agent_id: p.agent_id, runtime: p.runtime, left_at: null } : { ...p, left_at: null });
  }

  /** ParticipantLeft. */
  left(id: string, at: number) {
    const p = this.people.get(id);
    if (p && p.left_at === null) this.people.set(id, { ...p, left_at: at });
  }

  /** ReadCursor for the owner. */
  ownerReadIn(channel: string): number | undefined {
    return this.ownerRead.get(channel);
  }

  /** SetReadCursor for the owner: it only moves on. */
  ownerReadTo(channel: string, number: number) {
    this.ownerRead.set(channel, Math.max(this.ownerRead.get(channel) ?? number, number));
  }
}
