import type { TaskGroup } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { userId } from "@vibevalley/protocol";

import type { Db } from "#/infra/db.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import type { Agent } from "#/modules/agent/agent.ts";
import { inputContext } from "#/modules/session/payload.ts";
import { envelopeLines, talkBrief } from "#/modules/session/prompts.ts";
import { HireRefused, type Session } from "#/modules/session/session.ts";
import * as qm from "#db/channel_message.sql.ts";

import type { MsgRow } from "./contracts.ts";
import type { ChannelHub } from "./hub.ts";
import type { SessionThreads } from "./threads.ts";
import type { ChannelWriting } from "./writing.ts";

const talkContext = 12;

export interface DirectTalkDeps {
  readonly log: Logger;
  readonly db: Db;
  readonly agent: Agent;
  readonly session: Session;
}

/** tasks: the channel's own; a direct context being opened is keyed by its channel, one at a time. */
export function directTalk(
  deps: DirectTalkDeps,
  r: ChannelHub,
  w: ChannelWriting,
  th: Pick<SessionThreads, "sessionsLeft">,
  notice: (channel: string, text: string, code: string) => Promise<void>,
  tasks: TaskGroup,
) {
  const { agent: agents, db, session: sessions, log } = deps;
  const { store, talkSession, targetOfChannel, channelEnvelope, asEnvelope, envelopeOf } = r;
  const { sessionsLeft } = th;
  const { settle } = w;
  const talkKey = (channel: string) => `talk:${channel}`;

  const userChat = (message: MsgRow) => message.sender_id === userId && message.kind === "chat" && message.deleted_at === null;

  // A failed write is NotRecorded (attemptParticipant): the hire stops and says so.
  const joining = (session: T.Session, at: number) =>
    store.locked(() =>
      store.attemptParticipant({
        id: session.id,
        kind: "agent",
        role: "worker",
        name: session.name,
        agent_id: session.agent,
        runtime: session.runtime,
        joined_at: at,
      }),
    );

  const startTalk = async (channel: string, agentId: string) => {
    if (talkSession(channel)) return;
    const place = store.channel(channel);
    if (place?.type !== "direct") return;
    const agent = agents.agent(agentId);
    if (!agent) return;
    if (!agent.enabled)
      return notice(channel, t("server.channel.talkFailed", { why: t("server.channel.profileDisabled", { name: agent.name }) }), "talk_refused");
    const snapshot = await store.locked(() => qm.messagesBefore(db.sql, { channel_id: channel, number: 2147483647, n: talkContext }));
    const ordered = snapshot.toReversed();
    const last = ordered.at(-1);
    const user = ordered.findLast(userChat);
    if (!user) return;
    const target = targetOfChannel(place);
    let opened: string;
    try {
      const received = await sessions.receive({
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
      });
      opened = received.hired.id;
    } catch (e) {
      if (!(e instanceof HireRefused)) throw e;
      await store.locked(sessionsLeft);
      await notice(channel, t("server.channel.talkFailed", { why: e.reason }), "talk_refused");
      return;
    }
    await store.locked(async () => {
      const missed = await qm.missingDirectDeliveries(db.sql, { channel_id: channel, recipient_id: opened, after_number: last?.number ?? 0 });
      for (const row of missed) await settle(row);
    });
  };

  const onDirectMessage = (message: T.ChatMessage) => {
    if (message.actor.kind !== "user" || message.kind !== "chat") return;
    const channel = store.channel(message.channel);
    const peer = channel?.peer_id ? store.participant(channel.peer_id) : undefined;
    if (channel?.type !== "direct" || peer?.role !== "worker" || peer.runtime !== null || !peer.agent_id) return;
    const session = talkSession(channel.id);
    if (session) return;
    const agentId = peer.agent_id;
    // One opening per channel: another message while it opens joins the one under way.
    if (tasks.has(talkKey(channel.id))) return;
    tasks.keyed(talkKey(channel.id), () => bestEffort(log, "chat: opening a direct context", () => startTalk(channel.id, agentId)));
  };
  return { onDirectMessage };
}
