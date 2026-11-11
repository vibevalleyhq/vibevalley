import { Effect, FiberMap } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { userId } from "@vibevalley/protocol";

import { causeMessage, Db } from "#/infra/db.ts";
import { bestEffort } from "#/infra/log.ts";
import { Agent } from "#/modules/agent/agent.ts";
import { Mailbox } from "#/modules/mailbox/mailbox.ts";
import { inputContext } from "#/modules/mailbox/payload.ts";
import { envelopeLines, talkBrief } from "#/modules/mailbox/prompts.ts";
import { NotRecorded } from "#/modules/session/session.ts";
import * as qm from "#db/channel_message.sql.ts";

import type { MsgRow } from "./contracts.ts";
import type { ChannelHub } from "./hub.ts";
import type { SessionThreads } from "./threads.ts";
import type { ChannelWriting } from "./writing.ts";

const talkContext = 12;

export const directTalk = (
  r: ChannelHub,
  w: ChannelWriting,
  th: Pick<SessionThreads, "sessionsLeft">,
  notice: (channel: string, text: string, code: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const agents = yield* Agent;
    const db = yield* Db;
    const mailbox = yield* Mailbox;
    const { store, talkSession, targetOfChannel, channelEnvelope, asEnvelope, envelopeOf } = r;
    const { sessionsLeft } = th;
    const { settle } = w;
    const talkStarts = yield* FiberMap.make<string>();

    const userChat = (message: MsgRow) => message.sender_id === userId && message.kind === "chat" && message.deleted_at === null;

    const joining = (session: T.Session, at: number) =>
      store.locked(
        store
          .attemptParticipant({
            id: session.id,
            kind: "agent",
            role: "worker",
            name: session.name,
            agent_id: session.agent,
            runtime: session.runtime,
            joined_at: at,
          })
          .pipe(Effect.mapError((cause) => NotRecorded.make({ message: causeMessage(cause), cause }))),
      );

    const startTalk = Effect.fnUntraced(function* (channel: string, agentId: string) {
      if (talkSession(channel)) return;
      const place = store.channel(channel);
      if (place?.type !== "direct") return;
      const agent = agents.agent(agentId);
      if (!agent) return;
      if (!agent.enabled)
        return yield* notice(channel, t("server.channel.talkFailed", { why: t("server.channel.profileDisabled", { name: agent.name }) }), "talk_refused");
      const snapshot = yield* store.locked(db.run(qm.messagesBefore({ channel_id: channel, number: 2147483647, n: talkContext })));
      const ordered = snapshot.toReversed();
      const last = ordered.at(-1);
      const user = ordered.findLast(userChat);
      if (!user) return;
      const target = targetOfChannel(place);
      const opened = yield* mailbox
        .receive({
          _tag: "Hire",
          agent,
          brief: talkBrief(agent.name, envelopeLines(ordered.map((m) => envelopeOf(m, target)))),
          where: "",
          options: { context: { kind: "channel", channel }, trigger: { kind: "comment", channel, message: user.id } },
          envelopes: {
            _tag: "Talk",
            rows: ordered.filter(userChat).map((message) => {
              const row = channelEnvelope(message);
              return { row, context: inputContext(asEnvelope(row)) };
            }),
          },
          hiring: (session, _launch, at) => joining(session, at),
        })
        .pipe(
          Effect.matchEffect({
            onFailure: (refused) =>
              Effect.as(
                Effect.andThen(store.locked(sessionsLeft), notice(channel, t("server.channel.talkFailed", { why: refused.reason }), "talk_refused")),
                undefined,
              ),
            onSuccess: (received) => Effect.succeed(received.hired.id),
          }),
        );
      if (opened === undefined) return;
      yield* store.locked(
        Effect.gen(function* () {
          const missed = yield* db.run(qm.missingDirectDeliveries({ channel_id: channel, recipient_id: opened, after_number: last?.number ?? 0 }));
          yield* Effect.forEach(missed, (row) => settle(row), { discard: true });
        }),
      );
    });

    const onDirectMessage = Effect.fnUntraced(function* (message: T.ChatMessage) {
      if (message.actor.kind !== "user" || message.kind !== "chat") return;
      const channel = store.channel(message.channel);
      const peer = channel?.peer_id ? store.participant(channel.peer_id) : undefined;
      if (channel?.type !== "direct" || peer?.role !== "worker" || peer.runtime !== null || !peer.agent_id) return;
      const session = talkSession(channel.id);
      if (session) return;
      yield* FiberMap.run(talkStarts, channel.id, startTalk(channel.id, peer.agent_id).pipe(bestEffort("chat: opening a direct context")), {
        onlyIfMissing: true,
      });
    });
    return { onDirectMessage };
  });
