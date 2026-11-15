import { Semaphore } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { defaultOrchestrator, userId } from "@vibevalley/protocol";

import { newId } from "#/base/ids.ts";
import { compareText, or } from "#/base/order.ts";
import type { Db } from "#/infra/db.ts";
import type { Time } from "#/infra/time.ts";
import * as qc from "#db/channel.sql.ts";
import * as qmb from "#db/channel_member.sql.ts";
import * as qm from "#db/channel_message.sql.ts";
import * as qp from "#db/channel_participant.sql.ts";
import * as qr from "#db/channel_read_cursor.sql.ts";

export type ChannelRow = qc.AllChannelsResult;
type ParticipantRow = qp.ParticipantsResult;

export interface ThreadSubject {
  readonly kind: NonNullable<T.Channel["subjectKind"]>;
  readonly id: string;
  readonly owner: string;
}

/** An agent seated to speak in the chat: an orchestrator (a profile speaking as itself, no `agent`), or a helper speaking
 * for the profile `agent` (a session, a profile's seat in its direct channel). */
export interface Seat {
  readonly id: string;
  readonly name: string;
  readonly agent?: string;
  /** The place an empty target means for it; none keeps the one it had. */
  readonly home?: string;
}

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

class ChatModel {
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
    this.people.set(p.id, held ? { ...held, name: p.name, agent_id: p.agent_id, home_id, left_at: null } : { ...p, home_id, left_at: null });
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

/** The channel a new farm opens with. */
const firstChannelName = "general";

const emptyChannelRow = (base: Pick<ChannelRow, "id" | "type" | "is_default" | "created_at"> & Partial<ChannelRow>): ChannelRow => ({
  root_id: null,
  root_number: null,
  subject_kind: null,
  subject_id: null,
  last_number: null,
  reply_count: 0,
  name: null,
  description: null,
  repo: null,
  parent_id: null,
  peer_id: null,
  revision: 0,
  category: null,
  position: null,
  archived_at: null,
  notify: "all",
  ...base,
});

export interface ChannelStoreDeps {
  readonly db: Db;
  readonly clock: Time;
}

/** Owns `ChatModel`, serialization (`locked`), and `db.afterCommit` synchronization so the database and in-memory state never drift. */
export async function makeChannelStore(deps: ChannelStoreDeps) {
  const { db, clock } = deps;
  const model = new ChatModel();
  const lock = new Semaphore(1);
  /** Not reentrant: work under it never takes it again. */
  const locked = <A>(work: () => Promise<A>): Promise<A> => lock.with(work);

  const addMember = async (channel: string, participant: string, reason: qmb.AddMemberParams["reason"], from: number) => {
    await qmb.addMember(db.sql, { channel_id: channel, participant_id: participant, reason, from_number: from });
    await db.afterCommit(() => model.memberAdded(channel, participant));
  };

  const upsertParticipant = async (joined: qp.UpsertParticipantParams) => {
    await qp.upsertParticipant(db.sql, joined);
    await db.afterCommit(() => model.joined(joined));
  };

  /** An agent's seat as it goes now; one already so (and there) is left as it is. */
  const seat = async (p: Seat) => {
    const held = model.participant(p.id);
    const agent = p.agent ?? null;
    if (held?.kind === "agent" && held.name === p.name && held.agent_id === agent && held.left_at === null && (p.home ?? held.home_id) === held.home_id) return;
    await upsertParticipant({ id: p.id, kind: "agent", name: p.name, agent_id: agent, home_id: p.home ?? null, joined_at: clock.now() });
  };

  for (const [id, kind, name] of [
    [userId, "user", t("server.channel.name.user")],
    ["system", "system", "VibeValley"],
  ] as const)
    await qp.upsertParticipant(db.sql, { id, kind, name, agent_id: null, home_id: null, joined_at: clock.now() });
  // The default channel's member from its first day: seated under the orchestrator's word until the layers above seat it
  // under its profile's name.
  await qp.addParticipant(db.sql, { id: defaultOrchestrator, kind: "agent", name: t("server.channel.name.orchestrator"), joined_at: clock.now() });
  if ((await qc.defaultID(db.sql)) === undefined) {
    const id = newId();
    await qc.createChannel(db.sql, { id, is_default: true, name: firstChannelName, description: null, repo: null, created_at: clock.now() });
    await qmb.addMember(db.sql, { channel_id: id, participant_id: defaultOrchestrator, reason: "manual", from_number: 0 });
  }

  await db.tx(async () => {
    const channels = await qc.allChannels(db.sql);
    const participants = await qp.participants(db.sql);
    const cursors = await qr.readCursorsOf(db.sql, { participant_id: userId });
    const follows = await qmb.allMembers(db.sql);
    model.load(channels, participants, cursors, follows);
  });

  const setRead = async (who: string, channel: string, upto: number, now: number) => {
    await qr.setReadCursor(db.sql, { participant_id: who, channel_id: channel, read_number: upto, updated_at: now });
    if (who === userId) await db.afterCommit(() => model.userReadTo(channel, upto));
  };

  const threadFor = async (root: { id: T.MessageId; number: number; channel: string }, subject: ThreadSubject) => {
    const existing = model.threadOfRoot(root.id);
    if (existing !== undefined && existing !== "") return existing;
    const id = newId();
    const created_at = clock.now();
    const thread = {
      id,
      root_id: root.id,
      root_number: root.number,
      subject_kind: subject.kind,
      subject_id: subject.id || null,
      parent_id: root.channel,
    };
    await qc.createThread(db.sql, { ...thread, created_at });
    await db.afterCommit(() => model.created(emptyChannelRow({ ...thread, type: "thread", is_default: false, created_at })));
    if (subject.owner !== undefined && subject.owner !== "") await addMember(id, subject.owner, "user", root.number);
    return id;
  };

  return {
    locked,
    tx: db.tx,
    channel: (id: string) => model.channel(id),
    channelByName: (name: string) => model.channelByName(name),
    channels: (type: "channel" | "direct" = "channel") => model.channels(type),
    threadsOf: (channel: string) => model.threadsOf(channel),
    threadOfRoot: (root: string) => model.threadOfRoot(root),
    threadOfSubject: (kind: string, id: string) => model.threadOfSubject(kind, id),
    defaultChannel: () => model.defaultChannel(),
    defaultId: () => model.defaultId(),
    topChannel: (id: string) => model.topChannel(id),
    participant: (id: string) => model.participant(id),
    participants: () => model.participants(),
    membersOf: (channel: string) => model.membersOf(channel),
    userReadIn: (channel: string) => model.userReadIn(channel),
    publishedNumber: (channel: string) => model.publishedNumber(channel),
    notePublished: (channel: string, number: number) => model.notePublished(channel, number),
    lastReadOf: (who: string) => model.lastRead.get(who) ?? "",
    rememberReadTarget: (who: string, target: string, keepParticipant: (id: string) => boolean) => {
      for (const participant of model.lastRead.keys()) if (!keepParticipant(participant)) model.lastRead.delete(participant);
      model.lastRead.set(who, target);
    },
    seat,
    markParticipantLeft: (id: string, at: number) =>
      db.tx(async () => {
        await qp.participantLeft(db.sql, { left_at: at, id });
        await qmb.removeFromAll(db.sql, { at, participant_id: id });
        await db.afterCommit(() => model.left(id, at));
      }),
    addMember,
    joinDefault: (channel: string) => addMember(channel, defaultOrchestrator, "manual", 0),
    setRead,
    markUnread: async (channel: string, upto: number, now: number) => {
      await qr.markUnread(db.sql, { channel_id: channel, read_number: upto, updated_at: now });
      await db.afterCommit(() => model.userReadBack(channel, upto));
    },
    touchChannel: async (id: string, number: number) => {
      await qc.touchChannel(db.sql, { number, id });
      await db.afterCommit(() => model.touched(id, number));
    },
    threadFor,
    createChannel: (params: {
      readonly id: string;
      readonly name: string;
      readonly description: string | null;
      readonly repo: string | null;
      readonly created_at: number;
    }) =>
      db.tx(async () => {
        await qc.createChannel(db.sql, { ...params, is_default: false });
        await db.afterCommit(() =>
          model.created(
            emptyChannelRow({
              id: params.id,
              type: "channel",
              is_default: false,
              created_at: params.created_at,
              name: params.name,
              description: params.description,
              repo: params.repo,
            }),
          ),
        );
        await addMember(params.id, defaultOrchestrator, "manual", 0);
      }),
    openDirectRow: async (peer: string) => {
      const had = model.channels("direct").find((c) => c.peer_id === peer);
      if (had !== undefined) return { id: had.id, created: false } as const;
      const id = newId();
      const created_at = clock.now();
      await qc.createDirect(db.sql, { id, peer_id: peer, created_at });
      await db.afterCommit(() => model.created(emptyChannelRow({ id, type: "direct", is_default: false, peer_id: peer, created_at })));
      return { id, created: true } as const;
    },
    updateChannelRow: (params: {
      readonly row: ChannelRow;
      readonly name: string | null;
      readonly description: string | null;
      readonly repo: string | null;
      readonly category: string | null;
      readonly joining: readonly string[];
      readonly leaving: readonly string[];
      readonly order: readonly string[] | undefined;
    }) => {
      const { row, name, description, repo, category, joining, leaving, order } = params;
      return db.tx(async () => {
        if (row.type === "channel") await qc.updateChannel(db.sql, { description, repo, id: row.id });
        if (name !== row.name) await qc.renameChannel(db.sql, { name, id: row.id });
        if (category !== row.category) await qc.setCategory(db.sql, { category, id: row.id });
        for (const m of joining) await addMember(row.id, m, "manual", 0);
        const at = clock.now();
        for (const m of leaving) {
          await qmb.removeMember(db.sql, { channel_id: row.id, participant_id: m, at });
          await db.afterCommit(() => model.memberRemoved(row.id, m));
        }
        for (const [position, each] of (order ?? []).entries()) await qc.placeChannel(db.sql, { position, id: each });
        await db.afterCommit(() => {
          if (row.type === "channel") model.channelUpdated(row.id, description, repo);
          model.patched(row.id, { name, category });
          for (const [position, each] of (order ?? []).entries()) model.patched(each, { position });
        });
      });
    },
    setArchived: async (id: string, archived_at: number | null) => {
      await qc.setArchived(db.sql, { archived_at, id });
      await db.afterCommit(() => model.patched(id, { archived_at }));
    },
    setNotify: async (id: string, notify: T.Notify) => {
      await qc.setNotify(db.sql, { notify, id });
      await db.afterCommit(() => model.patched(id, { notify }));
    },
    makeDefault: (from: string, to: string) =>
      db.tx(async () => {
        await qc.clearDefault(db.sql);
        await qc.makeDefault(db.sql, { id: to });
        await db.afterCommit(() => model.defaultMoved(from, to));
      }),
    deleteChannel: (id: string, goneTargets: ReadonlySet<string>) =>
      db.tx(async () => {
        await qm.deleteThreadMessagesIn(db.sql, { id });
        await qmb.deleteMembersIn(db.sql, { id });
        await qr.deleteCursorsIn(db.sql, { id });
        await qc.deleteThreadsOf(db.sql, { id });
        await qm.deleteMessagesIn(db.sql, { id });
        await qc.deleteChannel(db.sql, { id });
        await db.afterCommit(() => {
          model.removed(id);
          for (const [who, target] of model.lastRead) if (goneTargets.has(target)) model.lastRead.delete(who);
        });
      }),
  };
}

export type ChannelStore = Awaited<ReturnType<typeof makeChannelStore>>;
