import { Array as Arr, Clock, Effect, Option, Semaphore } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { defaultOrchestrator, userId } from "@vibevalley/protocol";

import { newId } from "#/base/ids.ts";
import { Db } from "#/infra/db.ts";
import { Agent } from "#/modules/agent/agent.ts";
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

/** Owns `ChatModel`, serialization (`locked`), and `db.afterCommit` synchronization so SQLite and in-memory state never drift. */
export const makeChannelStore = Effect.gen(function* () {
  const agents = yield* Agent;
  const db = yield* Db;
  const model = new ChatModel();
  const lock = yield* Semaphore.make(1);
  const locked = <A, E>(effect: Effect.Effect<A, E>) => lock.withPermits(1)(effect);

  const addMember = (channel: string, participant: string, reason: qmb.AddMemberParams["reason"], from: number) =>
    Effect.andThen(
      db.run(qmb.addMember({ channel_id: channel, participant_id: participant, reason, from_number: from })),
      db.afterCommit(Effect.sync(() => model.memberAdded(channel, participant))),
    );

  const upsertParticipant = (joined: qp.UpsertParticipantParams) =>
    Effect.andThen(db.run(qp.upsertParticipant(joined)), db.afterCommit(Effect.sync(() => model.joined(joined))));

  const attemptParticipant = (joined: qp.UpsertParticipantParams) =>
    Effect.andThen(db.attempt(qp.upsertParticipant(joined)), db.afterCommit(Effect.sync(() => model.joined(joined))));

  /** Ensures an orchestrator participant row matches its current profile name. */
  const seat = Effect.fnUntraced(function* (id: string) {
    const agent = agents.agent(id);
    const name = agent?.name.trim() || t("server.channel.name.orchestrator");
    if (model.participant(id)?.name === name && model.participant(id)?.role === "orchestrator") return;
    yield* upsertParticipant({
      id,
      kind: "agent",
      role: "orchestrator",
      name,
      agent_id: null,
      runtime: null,
      joined_at: yield* Clock.currentTimeMillis,
    });
  });

  yield* Effect.forEach(
    [
      [userId, "user", t("server.channel.name.user")],
      ["system", "system", "VibeValley"],
    ] as const,
    ([id, kind, name]) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        db.run(qp.upsertParticipant({ id, kind, role: null, name, agent_id: null, runtime: null, joined_at: now })),
      ),
    { discard: true },
  );
  const initialOrchestrators = Arr.map(agents.orchestrators(), (a) => a.id);
  yield* Effect.forEach(
    initialOrchestrators,
    (id) =>
      Effect.gen(function* () {
        const agent = agents.agent(id);
        const name = agent?.name.trim() || t("server.channel.name.orchestrator");
        yield* db.run(
          qp.upsertParticipant({
            id,
            kind: "agent",
            role: "orchestrator",
            name,
            agent_id: null,
            runtime: null,
            joined_at: yield* Clock.currentTimeMillis,
          }),
        );
      }),
    { discard: true },
  );
  if ((yield* db.one(qc.defaultID())) === undefined) {
    const id = newId();
    yield* db.run(
      qc.createChannel({ id, is_default: true, name: firstChannelName, description: null, repo: null, created_at: yield* Clock.currentTimeMillis }),
    );
    yield* db.run(qmb.addMember({ channel_id: id, participant_id: defaultOrchestrator, reason: "manual", from_number: 0 }));
  }
  yield* Effect.forEach(
    initialOrchestrators,
    (id) => Effect.flatMap(Clock.currentTimeMillis, (now) => db.run(qc.createDirect({ id: newId(), peer_id: id, created_at: now }))),
    { discard: true },
  );

  yield* db.inTx(
    Effect.gen(function* () {
      const [channels, participants, cursors, follows] = yield* Effect.all([
        db.run(qc.allChannels()),
        db.run(qp.participants()),
        db.run(qr.readCursorsOf({ participant_id: userId })),
        db.run(qmb.allMembers()),
      ]);
      model.load(channels, participants, cursors, follows);
    }),
  );

  const setRead = (who: string, channel: string, upto: number, now: number) =>
    Effect.andThen(
      db.run(qr.setReadCursor({ participant_id: who, channel_id: channel, read_number: upto, updated_at: now })),
      who === userId ? db.afterCommit(Effect.sync(() => model.userReadTo(channel, upto))) : Effect.void,
    );

  const threadFor = Effect.fn("Channel.threadFor")(function* (root: { id: string; number: number; channel: string }, subject: ThreadSubject) {
    const existing = model.threadOfRoot(root.id);
    if (existing !== undefined && existing !== "") return existing;
    const id = newId();
    const created_at = yield* Clock.currentTimeMillis;
    const thread = {
      id,
      root_id: root.id,
      root_number: root.number,
      subject_kind: subject.kind,
      subject_id: subject.id || null,
      parent_id: root.channel,
    };
    yield* db.run(qc.createThread({ ...thread, created_at }));
    yield* db.afterCommit(
      Effect.sync(() =>
        model.created(
          emptyChannelRow({
            ...thread,
            type: "thread",
            is_default: false,
            created_at,
          }),
        ),
      ),
    );
    if (subject.owner !== undefined && subject.owner !== "") yield* addMember(id, subject.owner, "user", root.number);
    return id;
  });

  return {
    locked,
    tx: db.inTx,
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
      db.inTx(
        Effect.gen(function* () {
          yield* db.run(qp.participantLeft({ left_at: at, id }));
          yield* db.run(qmb.removeFromAll({ at, participant_id: id }));
          yield* db.afterCommit(Effect.sync(() => model.left(id, at)));
        }),
      ),
    addMember,
    joinDefault: (channel: string) => addMember(channel, defaultOrchestrator, "manual", 0),
    setRead,
    markUnread: (channel: string, upto: number, now: number) =>
      Effect.andThen(
        db.run(qr.markUnread({ channel_id: channel, read_number: upto, updated_at: now })),
        db.afterCommit(Effect.sync(() => model.userReadBack(channel, upto))),
      ),
    touchChannel: (id: string, number: number) =>
      Effect.andThen(db.run(qc.touchChannel({ number, id })), db.afterCommit(Effect.sync(() => model.touched(id, number)))),
    threadFor,
    createChannel: Effect.fnUntraced(function* (params: {
      readonly id: string;
      readonly name: string;
      readonly description: string | null;
      readonly repo: string | null;
      readonly created_at: number;
    }) {
      yield* db.inTx(
        Effect.gen(function* () {
          yield* db.run(qc.createChannel({ ...params, is_default: false }));
          yield* db.afterCommit(
            Effect.sync(() =>
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
            ),
          );
          yield* addMember(params.id, defaultOrchestrator, "manual", 0);
        }),
      );
    }),
    openDirectRow: Effect.fnUntraced(function* (peer: string) {
      const had = Arr.findFirst(model.channels("direct"), (c) => c.peer_id === peer);
      if (Option.isSome(had)) return { id: had.value.id, created: false } as const;
      const id = newId();
      const created_at = yield* Clock.currentTimeMillis;
      yield* db.run(qc.createDirect({ id, peer_id: peer, created_at }));
      yield* db.afterCommit(
        Effect.sync(() =>
          model.created(
            emptyChannelRow({
              id,
              type: "direct",
              is_default: false,
              peer_id: peer,
              created_at,
            }),
          ),
        ),
      );
      return { id, created: true } as const;
    }),
    updateChannelRow: Effect.fnUntraced(function* (params: {
      readonly row: ChannelRow;
      readonly name: string | null;
      readonly description: string | null;
      readonly repo: string | null;
      readonly category: string | null;
      readonly joining: readonly string[];
      readonly leaving: readonly string[];
      readonly order: readonly string[] | undefined;
    }) {
      const { row, name, description, repo, category, joining, leaving, order } = params;
      yield* db.inTx(
        Effect.gen(function* () {
          if (row.type === "channel") yield* db.run(qc.updateChannel({ description, repo, id: row.id }));
          if (name !== row.name) yield* db.run(qc.renameChannel({ name, id: row.id }));
          if (category !== row.category) yield* db.run(qc.setCategory({ category, id: row.id }));
          yield* Effect.forEach(joining, (m) => Effect.andThen(seat(m), addMember(row.id, m, "manual", 0)), { discard: true });
          const at = yield* Clock.currentTimeMillis;
          yield* Effect.forEach(
            leaving,
            (m) =>
              Effect.andThen(
                db.run(qmb.removeMember({ channel_id: row.id, participant_id: m, at })),
                db.afterCommit(Effect.sync(() => model.memberRemoved(row.id, m))),
              ),
            { discard: true },
          );
          yield* Effect.forEach((order ?? []).entries(), ([position, each]) => db.run(qc.placeChannel({ position, id: each })), { discard: true });
          yield* db.afterCommit(
            Effect.sync(() => {
              if (row.type === "channel") model.channelUpdated(row.id, description, repo);
              model.patched(row.id, { name, category });
              for (const [position, each] of (order ?? []).entries()) model.patched(each, { position });
            }),
          );
        }),
      );
    }),
    setArchived: (id: string, archived_at: number | null) =>
      Effect.andThen(db.run(qc.setArchived({ archived_at, id })), db.afterCommit(Effect.sync(() => model.patched(id, { archived_at })))),
    setNotify: (id: string, notify: T.Notify) =>
      Effect.andThen(db.run(qc.setNotify({ notify, id })), db.afterCommit(Effect.sync(() => model.patched(id, { notify })))),
    makeDefault: (from: string, to: string) =>
      db.inTx(
        Effect.gen(function* () {
          yield* db.run(qc.clearDefault());
          yield* db.run(qc.makeDefault({ id: to }));
          yield* db.afterCommit(Effect.sync(() => model.defaultMoved(from, to)));
        }),
      ),
    deleteChannel: (id: string, goneTargets: ReadonlySet<string>) =>
      db.inTx(
        Effect.gen(function* () {
          yield* db.run(qm.deleteThreadMessagesIn({ id }));
          yield* db.run(qmb.deleteMembersIn({ id }));
          yield* db.run(qr.deleteCursorsIn({ id }));
          yield* db.run(qc.deleteThreadsOf({ id }));
          yield* db.run(qm.deleteMessagesIn({ id }));
          yield* db.run(qc.deleteChannel({ id }));
          yield* db.afterCommit(
            Effect.sync(() => {
              model.removed(id);
              for (const [who, target] of model.lastRead) if (goneTargets.has(target)) model.lastRead.delete(who);
            }),
          );
        }),
      ),
  };
});

export type ChannelStore = Effect.Success<typeof makeChannelStore>;
