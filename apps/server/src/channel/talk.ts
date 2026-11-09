import { Effect, FiberMap } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { ownerId } from "@vibevalley/protocol";

import { Agent } from "#/agent/agent.ts";
import { causeMessage, Db } from "#/infra/db.ts";
import { bestEffort } from "#/infra/log.ts";
import { Mailbox } from "#/mailbox/mailbox.ts";
import { inputContext } from "#/mailbox/payload.ts";
import { inboxLines, talkBrief } from "#/mailbox/prompts.ts";
import { NotRecorded } from "#/session/session.ts";
import * as qm from "#db/channel_message.sql.ts";
import * as qp from "#db/channel_participant.sql.ts";

import { type MsgRow, type ChannelService } from "./contracts.ts";
import type { ChannelHub } from "./hub.ts";
import type { SessionThreads } from "./threads.ts";
import type { ChannelWriting } from "./writing.ts";

const talkContext = 12;

export const directTalk = (r: ChannelHub, w: ChannelWriting, th: Pick<SessionThreads, "sessionsLeft">, notice: ChannelService["notice"]) =>
  Effect.gen(function* () {
    const agents = yield* Agent;
    const db = yield* Db;
    const mailbox = yield* Mailbox;
    const { model, locked, talkSession, targetOfChannel, channelEnvelope, asInbox, inboxOf } = r;
    const { sessionsLeft } = th;
    const { settle } = w;
    const talkStarts = yield* FiberMap.make<string>();

    const ownerChat = (message: MsgRow) => message.sender_id === ownerId && message.kind === "chat" && message.deleted_at === null;

    const joining = (session: T.Session, at: number) =>
      locked(
        Effect.gen(function* () {
          const joined: qp.UpsertParticipantParams = {
            id: session.id,
            kind: "session",
            name: session.name,
            agent_id: session.agent,
            runtime: session.runtime,
            joined_at: at,
          };
          yield* db.attempt(qp.upsertParticipant(joined));
          model.joined(joined);
        }).pipe(Effect.mapError((cause) => NotRecorded.make({ message: causeMessage(cause), cause }))),
      );

    const startTalk = Effect.fnUntraced(function* (channel: string, agentId: string) {
      if (talkSession(channel)) return;
      const place = model.channel(channel);
      if (place?.type !== "direct") return;
      const agent = agents.agent(agentId);
      if (!agent) return;
      if (!agent.enabled)
        return yield* notice(channel, t("server.channel.talkFailed", { why: t("server.channel.profileDisabled", { name: agent.name }) }), "talk_refused");
      const snapshot = yield* locked(db.run(qm.messagesBefore({ channel_id: channel, number: 2147483647, n: talkContext })));
      const ordered = snapshot.toReversed();
      const last = ordered.at(-1);
      const owner = ordered.findLast(ownerChat);
      if (!owner) return;
      const target = targetOfChannel(place);
      const received = yield* mailbox.receive({
        _tag: "Open",
        agent,
        brief: talkBrief(agent.name, inboxLines(ordered.map((m) => inboxOf(m, target)))),
        where: "",
        options: { context: { kind: "channel", channel }, trigger: { kind: "comment", channel, message: owner.id } },
        letters: {
          _tag: "Talk",
          rows: ordered.filter(ownerChat).map((message) => {
            const row = channelEnvelope(message);
            return { row, context: inputContext(asInbox(row)) };
          }),
        },
        joining: (session, _launch, at) => joining(session, at),
      });
      const opened = received.opened?.id;
      if (opened === undefined) {
        yield* locked(sessionsLeft);
        return yield* notice(channel, t("server.channel.talkFailed", { why: received.refused ?? "" }), "talk_refused");
      }
      yield* locked(
        Effect.gen(function* () {
          const missed = yield* db.run(qm.missingDirectDeliveries({ channel_id: channel, recipient_id: opened, after_number: last?.number ?? 0 }));
          yield* Effect.forEach(missed, (row) => settle(row), { discard: true });
        }),
      );
    });

    const onDirectMessage = Effect.fnUntraced(function* (message: T.ChatMessage) {
      if (message.fromKind !== "owner" || message.kind !== "chat") return;
      const channel = model.channel(message.channel);
      const peer = channel?.peer_id ? model.participant(channel.peer_id) : undefined;
      if (channel?.type !== "direct" || peer?.kind !== "profile" || !peer.agent_id) return;
      const session = talkSession(channel.id);
      if (session) return;
      yield* FiberMap.run(talkStarts, channel.id, startTalk(channel.id, peer.agent_id).pipe(bestEffort("chat: opening a direct context")), {
        onlyIfMissing: true,
      });
    });
    return { onDirectMessage };
  });
