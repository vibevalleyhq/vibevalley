// The layer over the chat and the sessions: it reads the chat's committed events (in order, after a cursor of its own)
// and routes each to the sessions, opens their threads, hires a profile's direct helper, posts their reports, and
// answers their receipts in the chat (👀, the wake breaker's notice).
import { TaskGroup } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { userId } from "@vibevalley/protocol";
import { messageId } from "@vibevalley/protocol/schema";

import { head } from "#/base/clip.ts";
import { ApiError, lookIn, missing } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import { causeMessage, type Db, SqlError } from "#/infra/db.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Agent } from "#/modules/agent/agent.ts";
import type { Channel } from "#/modules/channel/channel.ts";
import {
  actorOfParticipant,
  type ChannelEvent,
  type ChannelHearers,
  type Committed,
  type Followup,
  type Meta,
  messageKind,
  metaOf,
  type MsgRow,
  type ThreadSubject,
} from "#/modules/channel/contracts.ts";
import { inputContext } from "#/modules/session/payload.ts";
import { envelopeLines, talkBrief } from "#/modules/session/prompts.ts";
import { HireRefused, NotRecorded, type Session } from "#/modules/session/session.ts";
import type { SessionNews } from "#/modules/session/signals.ts";
import * as qw from "#db/watch_cursor.sql.ts";

import { channelTrigger } from "./trigger.ts";

/** A helper profile's seat in the chat, the peer of its direct channel: apart from the assistants and the sessions. */
const profileId = (agent: string) => `profile:${agent}`;
/** What a participant says by reacting when a message that wakes it is handed to it. */
const handedEmoji = "👀";
const reportMax = 1500;
const talkContext = 12;
/** The cursor's name in watch_cursor: how far the chat's events were routed. */
const routed = "channel";

export interface Watch {
  /** The direct channel with a profile (by name or id): an assistant's own, or a helper profile's seat; made when there is none. */
  readonly direct: (ref: string) => Promise<string>;
  /** Words for a session: said in its home, or heard by it alone when it has none. */
  readonly tell: (from: string, session: string, text: string, sendKey: string) => Promise<T.ChatMessage | undefined>;
  /** What deleting a message does, its waiting deliveries included. */
  readonly previewRemove: (id: T.MessageId) => Promise<T.Preview>;
  /** At startup, after the sessions are back and before they are woken: their threads, then the events not yet routed. */
  readonly boot: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface WatchDeps {
  readonly clock: Time;
  readonly log: Logger;
  readonly db: Db;
  readonly agent: Agent;
  readonly session: Session;
  readonly channel: Channel;
}

/** Keyed by `issue` when working one so reassigned sessions reuse the same issue thread. */
const subjectOf = (h: T.Session): ThreadSubject => (h.issue ? { kind: "issue", id: h.issue, owner: h.id } : { kind: "talk", id: h.id, owner: h.id });

export async function makeWatch(deps: WatchDeps): Promise<Watch> {
  const { db, clock, agent: agents, session: sessions, channel: chat } = deps;
  const log = deps.log.child("watch");
  const tasks = new TaskGroup({ name: "watch", onError: (task, e) => log.warn(`${task} failed`, e) });
  let closed = false;
  /** An event failed live: the cursor stays before it until startup tells it again. */
  let stuck = false;

  const moveCursor = async (seq: number) => {
    await qw.moveCursor(db.sql, { name: routed, seq });
  };

  const sessionOf = (id: string) => sessions.live(id).session;
  const hired = () => sessions.hired();
  /** A profile's talk with the user: the session answering in the direct channel. */
  const directOfSession = (h: T.Session) => {
    const place = h.channel ? chat.place(h.channel) : undefined;
    return !h.issue && place?.type === "direct" && place.peer === profileId(h.agent) ? place.id : undefined;
  };
  const channelOfSession = (h: T.Session) => {
    const place = h.channel ? chat.place(h.channel) : undefined;
    return directOfSession(h) ?? (place && place.type !== "thread" && place.name !== null ? place.id : chat.defaultChannel());
  };
  /** The helper working the issue now: the latest hired of those on it. */
  const onIssue = (issue: string) =>
    hired().reduce<T.Session | undefined>((on, h) => (h.issue === issue && (!on || h.hiredAt >= on.hiredAt) ? h : on), undefined);
  const talkSession = (channel: string) => hired().find((h) => directOfSession(h) === channel);
  /** Who a thread's words are for, worked out now rather than kept: the session on the issue, or a talk thread's own session. */
  const ownerOf = (c: Committed): string => {
    if (c.channel.type === "direct") return talkSession(c.row.channel_id)?.id ?? "";
    if (c.channel.type === "channel" || !c.topic) return "";
    if (c.topic.kind === "issue") return onIssue(c.topic.id)?.id ?? "";
    return sessionOf(c.topic.id) ? c.topic.id : "";
  };

  const route = async (c: Committed): Promise<Followup | undefined> => {
    // Told again at startup: routed before the farm stopped, past where the cursor was kept.
    if (c.replayed && (await sessions.isRouted(c.row.envelope_id))) return undefined;
    const meta = metaOf(c.row.meta);
    const sessionsNow = hired();
    const orchestrators = agents.orchestrators().map((a) => a.id);
    const present = sessionsNow.map((h) => h.id);
    const audience = sessionsNow.filter((h) => c.channel.type === "thread" || channelOfSession(h) === c.row.channel_id).map((h) => h.id);
    const addressed = meta.ingressRecipient;
    const recipients = [...new Set([...present, ...orchestrators, ...(addressed ? [addressed] : [])])];
    const fact: ChannelHearers = {
      row: c.row,
      audience: {
        from: c.row.sender_id,
        actor: actorOfParticipant(c.row.sender_kind, c.row.sender_role, c.row.sender_id, c.row.name),
        kind: messageKind(c.row.kind),
        mentions: c.mentions,
        channel: c.channel,
        orchestrator: c.orchestrator,
        channelMembers: c.channelMembers,
        orchestrators,
        threadOwner: ownerOf(c),
        sessions: audience,
        present,
        members: c.members,
        ...(meta.outcome ? { outcome: meta.outcome } : {}),
        spoken: meta.spoken === true && meta.ingressSource !== "voice",
      },
      ...(addressed ? { addressed } : {}),
      roles: Object.fromEntries(recipients.map((recipient) => [recipient, agents.isOrchestrator(recipient) ? "orchestrator" : "worker"])),
      ...(meta.outcome ? { outcome: meta.outcome } : {}),
    };
    try {
      const original = await sessions.recordTrigger(channelTrigger(fact, inputContext(chat.asEnvelope(fact.row))));
      const answer = await sessions.route(original, fact);
      return answer.heldNotice ? { hopLimit: answer.heldNotice } : undefined;
    } catch (error) {
      // A refusal is the route's answer: the message is kept and passed. Anything else (the database failing) fails the
      // write, and the event is told again at startup.
      if (!(error instanceof ApiError)) throw error;
      log.warn(`route ${c.row.envelope_id}`, error);
      return undefined;
    }
  };

  const userChat = (message: MsgRow) => message.sender_id === userId && message.kind === "chat" && message.deleted_at === null;

  // A failed write is NotRecorded: the hire stops and says so.
  const joining = async (session: T.Session, home: string) => {
    try {
      await chat.join({ id: session.id, role: "worker", name: session.name, agent: session.agent, runtime: session.runtime, home });
    } catch (e) {
      if (e instanceof SqlError) throw new NotRecorded(causeMessage(e), { cause: e });
      throw e;
    }
  };

  const notice = (channel: string, text: string, code: string) => chat.post({ _tag: "Notice", channel, text, code });

  const startTalk = async (channel: string, agentId: string) => {
    if (talkSession(channel)) return;
    const place = chat.place(channel);
    if (place?.type !== "direct") return;
    const agent = agents.agent(agentId);
    if (!agent) return;
    if (!agent.enabled)
      return notice(channel, t("server.channel.talkFailed", { why: t("server.channel.profileDisabled", { name: agent.name }) }), "talk_refused");
    const ordered = await chat.recentRows(channel, talkContext);
    const last = ordered.at(-1);
    const user = ordered.findLast(userChat);
    if (!user) return;
    const target = chat.targetOfPlace(channel);
    let opened: string;
    try {
      const received = await sessions.hireWith({
        agent,
        brief: talkBrief(agent.name, envelopeLines(ordered.map((m) => chat.envelopeOf(m, target)))),
        where: "",
        options: { context: { kind: "channel", channel }, trigger: { kind: "comment", channel, message: user.id } },
        envelopes: {
          _tag: "Talk",
          rows: ordered.filter(userChat).map((message) => {
            const row = chat.envelopeRow(message);
            return { row, context: inputContext(chat.asEnvelope(row)) };
          }),
        },
        hiring: (session) => joining(session, channel),
      });
      opened = received.hired.id;
    } catch (e) {
      if (!(e instanceof HireRefused)) throw e;
      await sessionsLeft();
      await notice(channel, t("server.channel.talkFailed", { why: e.reason }), "talk_refused");
      return;
    }
    // What the user said while it was hired: told again, so it reaches the new session too (a delivery is one per session).
    for (const row of await chat.rowsAfter(channel, last?.number ?? 0)) if (userChat(row) && row.sender_id !== opened) await chat.retell(row.id);
  };

  const talkKey = (channel: string) => `talk:${channel}`;
  const onDirect = (c: Committed) => {
    if (c.row.sender_id !== userId || c.row.kind !== "chat" || c.channel.type !== "direct" || !c.channel.peer) return;
    const peer = chat.participants().find((p) => p.id === c.channel.peer);
    if (peer?.role !== "worker" || peer.runtime !== null || !peer.agent) return;
    if (talkSession(c.row.channel_id)) return;
    const channel = c.row.channel_id;
    const agentId = peer.agent;
    // One opening per channel: another message while it opens joins the one under way.
    if (tasks.has(talkKey(channel))) return;
    tasks.keyed(talkKey(channel), () => bestEffort(log, "opening a direct context", () => startTalk(channel, agentId)));
  };

  const posted = async (c: Committed) => {
    try {
      const follow = await route(c);
      if (!c.replayed && !stuck) await moveCursor(c.event.seq);
      onDirect(c);
      return follow;
    } catch (e) {
      stuck = true;
      throw e;
    }
  };
  const removed = async (event: ChannelEvent) => {
    await sessions.withdrawEnvelope(event.message);
    if (!stuck) await moveCursor(event.seq);
  };
  chat.observe({ posted, removed });

  /** The assistants are seated under their profiles' names, each with its direct channel. */
  const seatAssistant = async (agent: T.Agent) => {
    if (!agents.isOrchestrator(agent.id)) return;
    await chat.seat({ id: agent.id, name: agent.name.trim() || t("server.channel.name.orchestrator") });
    await chat.createDirect(agent.id);
  };
  for (const agent of agents.orchestrators()) await seatAssistant(agent);
  agents.whenKept(seatAssistant);
  chat.guardRemoval(async (id) => (hired().some((h) => channelOfSession(h) === id) ? [t("server.channel.helpersThere")] : []));

  const openThread = async (h: T.Session) => {
    await chat.join({ id: h.id, role: "worker", name: h.name, agent: h.agent, runtime: h.runtime });
    const direct = directOfSession(h);
    if (direct) return handedOn(h, direct);
    const subject = subjectOf(h);
    const thread = chat.threadAbout(subject.kind, subject.id);
    if (thread) return handedOn(h, thread);
    const channel = channelOfSession(h);
    await chat.readUpTo(h.id, channel, await chat.latest(channel));
    const what = h.refining ? t("server.channel.dispatch.draft") : head(h.brief.replace(/\s+/gu, " "), 80);
    // The dispatch note is the farm's, under the name of the orchestrator in the channel.
    const opened = await chat.note({
      channel,
      from: chat.orchestratorIn(channel),
      kind: "dispatch",
      text: t("server.channel.dispatch.sent", { id: h.id, name: h.name, repo: h.repo ?? t("server.channel.dispatch.repo"), what }),
      meta: { session: h.id },
      topic: subject,
    });
    if (opened.thread) await chat.join({ id: h.id, role: "worker", name: h.name, agent: h.agent, runtime: h.runtime, home: opened.thread });
  };

  /** The issue already has its thread (reopened, or sent to another session). */
  const handedOn = async (h: T.Session, thread: string) => {
    await chat.join({ id: h.id, role: "worker", name: h.name, agent: h.agent, runtime: h.runtime, home: thread });
    if (chat.membersOf(thread).includes(h.id)) return;
    // A profile's talk: the session that answers there is not told of in it; it only follows.
    if (chat.place(thread)?.type === "direct") return chat.addFollower(thread, h.id);
    const channel = channelOfSession(h);
    await chat.readUpTo(h.id, channel, await chat.latest(channel));
    // Each dispatch of the issue is in its thread but the first, which the thread hangs under: this is the one after.
    const nth = (await chat.dispatches(thread)) + 2;
    const text = h.refining
      ? t("server.channel.dispatch.redraft", { id: h.id, name: h.name })
      : t("server.channel.dispatch.handedOn", { id: h.id, name: h.name, nth });
    await chat.note({ channel: thread, from: chat.orchestratorIn(thread), kind: "dispatch", text, meta: { session: h.id }, member: h.id });
  };

  const sessionsLeft = async () => {
    const on = new Set<string>(hired().map((h) => h.id));
    for (const p of chat.participants()) {
      if (p.role !== "worker" || p.runtime === null || p.left || on.has(p.id)) continue;
      await chat.leave(p.id);
      await sessions.withdrawDeliveries(p.id, "left");
    }
  };

  const postReport = async (id: string, outcome: T.Outcome, summary: string, spent: T.Spent | undefined, run: string | undefined) => {
    const w = sessionOf(id);
    if (!w || w.refining || outcome === "interrupted") return;
    const thread = await chat.homeOf(id);
    if (!thread) return;
    const said = outcome === "completed" ? sessions.live(id).summary : "";
    const meta: Meta = { outcome, ...(spent ? { spent } : {}), ...(run ? { run } : {}) };
    await chat.note({ channel: thread, from: id, kind: "report", text: head(said || summary, reportMax), meta });
  };

  const openThreads = async () => {
    for (const h of hired()) await bestEffort(log, `${h.id}'s thread`, () => openThread(h));
  };

  // The sessions' news, one at a time: hired and left open and close threads, a report is posted in the thread.
  const onSessionNews = async (n: SessionNews) => {
    // Runs, inputs and launches are the issues' and Mailbox's.
    if (closed || (n._tag !== "Hired" && n._tag !== "Left" && n._tag !== "Reported")) return;
    await bestEffort(log, `after ${n._tag}`, async () => {
      switch (n._tag) {
        case "Hired":
          return openThreads();
        case "Left":
          return sessionsLeft();
        case "Reported":
          return postReport(n.report.id, n.report.outcome, n.report.summary, n.report.spent, n.report.run);
      }
    });
  };

  // Subscribed now, so nothing told after the service is made is missed; each read one at a time, in order.
  const sessionNews = sessions.news();
  tasks.run("session news", async (signal) => {
    try {
      for (let n = await sessionNews.next(signal); n.done !== true; n = await sessionNews.next(signal)) await onSessionNews(n.value);
    } finally {
      sessionNews.close();
    }
  });
  const deliveries = sessions.deliveries();
  tasks.run("delivery news", async (signal) => {
    try {
      for (let n = await deliveries.next(signal); n.done !== true; n = await deliveries.next(signal)) {
        const change = n.value;
        switch (change._tag) {
          case "Consumed":
            await bestEffort(log, `👀 on ${change.envelope}`, () =>
              chat.react(messageId(change.envelope), change.session, handedEmoji, true).then(() => undefined),
            );
            break;
          case "Handed":
            break;
          case "Braked":
            await bestEffort(log, `wake breaker for ${change.session}`, async () => {
              const where = (await chat.homeOf(change.session)) ?? chat.defaultChannel();
              const name = sessions.live(change.session).session?.name ?? change.session;
              await notice(where, t("server.channel.breaker", { name, failed: change.failed }), "wake_breaker");
            });
            break;
        }
      }
    } finally {
      deliveries.close();
    }
  });

  return {
    direct: async (ref) => {
      const name = ref.trim();
      const agent = agents.named(name) ?? agents.agent(name) ?? agents.orchestrators().find((o) => o.name === name);
      if (!agent) throw missing(t("server.channel.noProfileNamed", { key: ref }), [lookIn.agent]);
      if (agents.isOrchestrator(agent.id)) {
        await seatAssistant(agent);
        return chat.createDirect(agent.id);
      }
      await chat.join({ id: profileId(agent.id), role: "worker", name: agent.name, agent: agent.id, runtime: null });
      return chat.createDirect(profileId(agent.id));
    },
    tell: async (from, session, text, sendKey) => {
      const home = await chat.homeOf(session);
      if (home) return chat.post({ _tag: "Home", from, home, text, sendKey, ...(sessions.live(from).run ? { run: sessions.live(from).run } : {}) });
      // Sent with no place to say it in: the session hears it as a trigger addressed to it alone.
      if (!sessions.live(session).reachable) throw missing(t("server.channel.noHelper", { id: session }), [lookIn.session]);
      const channel = sessionOf(session)?.channel;
      const at = clock.now();
      const speaker = sessionOf(from);
      const trigger = await sessions.recordTrigger({
        source: "channel",
        key: sendKey || newId(at),
        actor:
          from === userId
            ? { kind: "user", id: userId }
            : { kind: "agent", role: agents.isOrchestrator(from) ? "orchestrator" : "worker", id: from, ...(speaker ? { name: speaker.name } : {}) },
        text: text.trim(),
        threads: [],
        addressed: "direct",
        ...(channel ? { replyChannel: channel } : {}),
        at,
      });
      await sessions.route(trigger, { session });
      return undefined;
    },
    previewRemove: async (id) => {
      const base = await chat.previewRemove(id);
      const waiting = await sessions.waitingOn(id);
      return { ...base, does: [...base.does, ...(waiting > 0 ? [t("server.channel.deletesDeliveries", { n: waiting })] : [])] };
    },
    boot: async () => {
      await openThreads();
      const from = (await qw.cursorOf(db.sql, { name: routed }))?.seq ?? 0;
      // Each event once, in order: one that cannot be routed is logged and passed, not tried again and again.
      await chat.replay(from, (event) => moveCursor(event.seq));
      stuck = false;
    },
    close: async () => {
      closed = true;
      await tasks.close();
    },
  };
}
