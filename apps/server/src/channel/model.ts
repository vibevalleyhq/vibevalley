// What the chat keeps in memory of what it wrote: every conversation, every participant, how far the owner has read in
// each conversation. The database stays the record: chat.ts writes there first and tells the model the same change right
// after, each update here doing what its query does (the comments name it); a transaction that fails reloads the model,
// since the changes told inside it are gone from the database. Only the chat writes these tables, one change at a time.

import type * as qc from "../../db/generated/channel_conversation.sql.ts";
import type * as qp from "../../db/generated/channel_participant.sql.ts";

export type ConvRow = qc.AllConversationsResult;
export type ParticipantRow = qp.ParticipantsResult;

const subjectKey = (kind: string, id: string) => kind + ":" + id;

export class ChatModel {
  private conversations = new Map<string, ConvRow>();
  private threadByParent = new Map<string, string>();
  private threadBySubject = new Map<string, string>();
  private people = new Map<string, ParticipantRow>();
  private ownerRead = new Map<string, number>();

  load(conversations: readonly ConvRow[], participants: readonly ParticipantRow[], ownerRead: readonly { conversation_id: string; read_number: number }[]) {
    this.conversations.clear();
    this.threadByParent.clear();
    this.threadBySubject.clear();
    this.people.clear();
    this.ownerRead.clear();
    for (const c of conversations) this.created(c);
    for (const p of participants) this.people.set(p.id, { ...p });
    for (const r of ownerRead) this.ownerRead.set(r.conversation_id, r.read_number);
  }

  conversation(id: string): ConvRow | undefined {
    return this.conversations.get(id);
  }

  /** The thread under a message: there is one at most. */
  threadOfParent(parent: string): string | undefined {
    return this.threadByParent.get(parent);
  }

  /** A subject's newest thread, as ids sort by when they were made. */
  threadOfSubject(kind: string, id: string): string | undefined {
    return this.threadBySubject.get(subjectKey(kind, id));
  }

  /** A channel, 田头 among them, by its name. */
  channelByName(name: string): ConvRow | undefined {
    for (const c of this.conversations.values()) if (c.name === name && c.kind !== "thread") return c;
    return undefined;
  }

  /** 田头 first, then the channels as they were made. */
  channels(): ConvRow[] {
    const all = [...this.conversations.values()].filter((c) => c.kind !== "thread");
    return all.sort((a, b) => (a.kind === "general" ? -1 : b.kind === "general" ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** CreateGeneral, CreateChannel, CreateThread. */
  created(row: ConvRow) {
    this.conversations.set(row.id, { ...row });
    if (row.parent_id !== null) this.threadByParent.set(row.parent_id, row.id);
    if (row.subject_kind !== null && row.subject_id !== null) {
      const key = subjectKey(row.subject_kind, row.subject_id);
      const held = this.threadBySubject.get(key);
      if (held === undefined || held < row.id) this.threadBySubject.set(key, row.id);
    }
  }

  /** UpdateChannel. */
  channelUpdated(id: string, description: string | null, project: string | null) {
    const c = this.conversations.get(id);
    if (c && c.kind !== "thread") this.conversations.set(id, { ...c, description, project });
  }

  /** TouchConversation. */
  touched(id: string, number: number) {
    const c = this.conversations.get(id);
    if (c)
      this.conversations.set(id, {
        ...c,
        last_number: Math.max(c.last_number ?? 0, number),
        reply_count: c.reply_count + (c.kind === "thread" ? 1 : 0),
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
  ownerReadIn(conversation: string): number | undefined {
    return this.ownerRead.get(conversation);
  }

  /** SetReadCursor for the owner: it only moves on. */
  ownerReadTo(conversation: string, number: number) {
    this.ownerRead.set(conversation, Math.max(this.ownerRead.get(conversation) ?? number, number));
  }
}
