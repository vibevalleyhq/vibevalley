import { Semaphore } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { defaultOrchestrator, userId } from "@vibevalley/protocol";

import { newId } from "#/base/ids.ts";
import { causeMessage, type Db, SqlError } from "#/infra/db.ts";
import type { Time } from "#/infra/time.ts";
import type { Agent } from "#/modules/agent/agent.ts";
import { NotRecorded } from "#/modules/session/session.ts";
import * as qc from "#db/channel.sql.ts";
import * as qmb from "#db/channel_member.sql.ts";
import * as qm from "#db/channel_message.sql.ts";
import * as qp from "#db/channel_participant.sql.ts";
import * as qr from "#db/channel_read_cursor.sql.ts";

import type { ThreadSubject } from "./contracts.ts";
import { ChatModel, type ChannelRow } from "./rooms.ts";

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
  readonly agent: Agent;
  readonly db: Db;
  readonly clock: Time;
}

/** Owns `ChatModel`, serialization (`locked`), and `db.afterCommit` synchronization so the database and in-memory state never drift. */
export async function makeChannelStore(deps: ChannelStoreDeps) {
  const { agent: agents, db, clock } = deps;
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

  /** As upsertParticipant, a failed write told as NotRecorded: the hire it is part of stops and says so. */
  const attemptParticipant = async (joined: qp.UpsertParticipantParams) => {
    try {
      await qp.upsertParticipant(db.sql, joined);
    } catch (e) {
      if (e instanceof SqlError) throw new NotRecorded(causeMessage(e), { cause: e });
      throw e;
    }
    await db.afterCommit(() => model.joined(joined));
  };

  /** Ensures an orchestrator participant row matches its current profile name. */
  const seat = async (id: string) => {
    const agent = agents.agent(id);
    const name = agent?.name.trim() || t("server.channel.name.orchestrator");
    if (model.participant(id)?.name === name && model.participant(id)?.role === "orchestrator") return;
    await upsertParticipant({ id, kind: "agent", role: "orchestrator", name, agent_id: null, runtime: null, joined_at: clock.now() });
  };

  for (const [id, kind, name] of [
    [userId, "user", t("server.channel.name.user")],
    ["system", "system", "VibeValley"],
  ] as const)
    await qp.upsertParticipant(db.sql, { id, kind, role: null, name, agent_id: null, runtime: null, joined_at: clock.now() });
  const initialOrchestrators = agents.orchestrators().map((a) => a.id);
  for (const id of initialOrchestrators) {
    const agent = agents.agent(id);
    const name = agent?.name.trim() || t("server.channel.name.orchestrator");
    await qp.upsertParticipant(db.sql, { id, kind: "agent", role: "orchestrator", name, agent_id: null, runtime: null, joined_at: clock.now() });
  }
  if ((await qc.defaultID(db.sql)) === undefined) {
    const id = newId();
    await qc.createChannel(db.sql, { id, is_default: true, name: firstChannelName, description: null, repo: null, created_at: clock.now() });
    await qmb.addMember(db.sql, { channel_id: id, participant_id: defaultOrchestrator, reason: "manual", from_number: 0 });
  }
  for (const id of initialOrchestrators) await qc.createDirect(db.sql, { id: newId(), peer_id: id, created_at: clock.now() });

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

  const threadFor = async (root: { id: string; number: number; channel: string }, subject: ThreadSubject) => {
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
    upsertParticipant,
    attemptParticipant,
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
        for (const m of joining) {
          await seat(m);
          await addMember(row.id, m, "manual", 0);
        }
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
