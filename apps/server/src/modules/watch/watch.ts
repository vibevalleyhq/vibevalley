// The layer over the chat and the sessions: it reads the chat's committed events (in order, after a cursor of its own)
// and routes each to the sessions, opens their threads, hires a profile's direct helper, posts their reports, and
// answers their receipts in the chat (👀, the wake breaker's notice). It is also the user's inbox and the patrol
// (inbox.ts).
//
// The events come live from Channel.committed, one at a time; the chat's writes wait on each (awaitReader), so a
// message's routing is done when the write that said it returns. watch_cursor moves only once an event's effects are
// kept (its route, a direct talk it opened), and startup reads the events after it again: a route is kept with the
// trigger's id (the message's), so one already routed is passed.
import { Semaphore, TaskGroup } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { userId } from "@vibevalley/protocol";
import { messageId } from "@vibevalley/protocol/schema";

import { head } from "#/base/clip.ts";
import { ApiError, lookIn, missing } from "#/base/errors.ts";
import type { Core } from "#/core/core.ts";
import type { ServerConfig } from "#/infra/config.ts";
import { causeMessage, type Db, SqlError } from "#/infra/db.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Agent } from "#/modules/agent/agent.ts";
import type { Channel } from "#/modules/channel/channel.ts";
import { type Committed, type Meta, messageKind, metaOf, type MsgRow, type ThreadSubject, type Told } from "#/modules/channel/contracts.ts";
import type { Issue } from "#/modules/issue/issue.ts";
import { actorOfParticipant, type DeliveryEvent, type DeliveryReason, type Hearer } from "#/modules/session/envelope.ts";
import { deliveryScope, inputContext } from "#/modules/session/payload.ts";
import { envelopeLines, talkBrief } from "#/modules/session/prompts.ts";
import { HireRefused, NotRecorded, type Session } from "#/modules/session/session.ts";
import type { Trigger } from "#/modules/session/shapes.ts";
import type { SessionNews } from "#/modules/session/signals.ts";
import * as qw from "#db/watch_cursor.sql.ts";

import { brakes, hopLimit, hopLimitText, Reach, type Recipient, WakeBreaker } from "./brakes.ts";
import { type ChannelAudience, eventOf, whoHears } from "./hearers.ts";
import { userInbox, type UserInbox } from "./inbox.ts";
import { channelTrigger, envelopeRowOf } from "./trigger.ts";

/** A helper profile's seat in the chat, the peer of its direct channel: apart from the orchestrators and the sessions. */
const profileId = (agent: string) => `profile:${agent}`;
/** What a participant says by reacting when a message that wakes it is handed to it. */
const handedEmoji = "👀";
const reportMax = 1500;
const talkContext = 12;
/** The cursor's name in watch_cursor: how far the chat's events were routed. */
const routed = "channel";

export interface Watch extends UserInbox {
  /** The direct channel with a profile (by name or id): an orchestrator's own, or a helper profile's seat; made when there is none. */
  readonly direct: (ref: string) => Promise<string>;
  /** What deleting a message does, its waiting deliveries included. */
  readonly previewRemove: (id: T.MessageId) => Promise<T.Preview>;
  /** At startup: the sessions' threads, the chat's events after the cursor (each once), then the inbox as it stands and
   * the patrol's rounds. */
  readonly boot: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface WatchDeps {
  readonly config: ServerConfig;
  readonly clock: Time;
  readonly log: Logger;
  readonly db: Db;
  readonly core: Core;
  readonly agent: Agent;
  readonly session: Session;
  readonly channel: Channel;
  readonly issue: Issue;
}

/** Keyed by `issue` when working one so reassigned sessions reuse the same issue thread. */
const subjectOf = (h: T.Session): ThreadSubject => (h.issue ? { kind: "issue", id: h.issue, owner: h.id } : { kind: "talk", id: h.id, owner: h.id });

export async function makeWatch(deps: WatchDeps): Promise<Watch> {
  const { db, clock, agent: agents, session: sessions, channel: chat } = deps;
  const log = deps.log.child("watch");
  const tasks = new TaskGroup({ name: "watch", onError: (task, e) => log.warn(`${task} failed`, e) });
  let closed = false;
  /** One event at a time, live or read again. */
  const turn = new Semaphore(1);
  /** Whether the cursor follows what is handled: held until startup has read the events after it, stuck once an event
   * failed live (it stays before that one until the next startup reads it again). */
  let cursor: "held" | "moving" | "stuck" = "held";
  /** The newest event handled live, and the ones that failed (a waiting write is failed with it). */
  let handledLive = 0;
  const failures = new Map<number, Error>();
  const waiting: { readonly seq: number; readonly done: (failure?: Error) => void }[] = [];
  /** The newest event handled, and the cursor kept. */
  let through = 0;
  let kept = (await qw.cursorOf(db.sql, { name: routed }))?.seq ?? 0;
  const reach = new Reach();
  const breaker = new WakeBreaker();
  /** A direct talk being opened, by channel: the cursor stays before the event that opens it until it is open. */
  const opening = new Map<string, number>();

  const advance = async () => {
    if (cursor !== "moving") return;
    const to = Math.min(through, ...[...opening.values()].map((seq) => seq - 1));
    if (to <= kept) return;
    await qw.moveCursor(db.sql, { name: routed, seq: to });
    kept = to;
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

  /** A trigger routed to the candidates, each through the brakes first (scope: where the hops are counted); the hop
   * limit's notice when it held one back. What woke whom is kept for the next. */
  const hear = async (trigger: Trigger, scope: string, candidates: readonly Recipient[], event: (reason: DeliveryReason) => DeliveryEvent) => {
    const at = clock.now();
    const braked = brakes(candidates, {
      actor: trigger.actor,
      orchestrators: agents.orchestrators().map((a) => a.id),
      hops: reach.hops(scope),
      cooling: reach.cooling(
        candidates.map((d) => d.recipient),
        at,
      ),
      broken: breaker.tripped(),
    });
    const hearers: Hearer[] = braked.map((d) => ({
      session: d.recipient,
      reason: d.reason,
      wakes: d.wakes,
      ...(d.heldBy ? { heldBy: d.heldBy } : {}),
      role: agents.isOrchestrator(d.recipient) ? "orchestrator" : "worker",
      event: event(d.reason),
    }));
    await deps.issue.route(trigger, hearers);
    if (trigger.actor.kind === "user") {
      reach.userSpoke(scope);
      // Spoken to by the user: the breaker lets it wake again.
      for (const h of hearers) if (h.wakes && breaker.reset(h.session)) await sessions.holdWakes(h.session, false);
    } else if (trigger.actor.kind === "agent") for (const h of hearers) if (h.wakes && !h.heldBy) reach.woke(scope, h.session, at);
    return hearers.some((h) => h.heldBy === "hop_limit") ? hopLimitText(hopLimit) : undefined;
  };

  /** again: read again from the events (at startup), so it may have been routed before; the hop limit's notice, if any. */
  const route = async (c: Committed, again: boolean): Promise<string | undefined> => {
    if (again && (await sessions.isRouted(c.row.id))) return undefined;
    const row = envelopeRowOf(c.row, c.place, c.channelName);
    const meta = metaOf(c.row.meta);
    const sessionsNow = hired();
    const orchestrators = agents.orchestrators().map((a) => a.id);
    const present = sessionsNow.map((h) => h.id);
    const listening = sessionsNow.filter((h) => c.channel.type === "thread" || channelOfSession(h) === c.row.channel_id).map((h) => h.id);
    const addressed = meta.ingressRecipient;
    const threadOwner = ownerOf(c);
    const audience: ChannelAudience = {
      from: row.sender_id,
      actor: actorOfParticipant(row.sender_kind, row.sender_role, row.sender_id, row.name),
      kind: messageKind(c.row.kind),
      mentions: c.mentions,
      channel: c.channel,
      orchestrator: c.orchestrator,
      channelMembers: c.channelMembers,
      orchestrators,
      threadOwner,
      sessions: listening,
      present,
      members: c.members,
      ...(meta.outcome ? { outcome: meta.outcome } : {}),
      spoken: meta.spoken === true && meta.ingressSource !== "voice",
    };
    const candidates: Recipient[] = addressed ? [{ recipient: addressed, reason: "addressed", wakes: true }] : whoHears(audience);
    try {
      const fact = { row, mentions: c.mentions, threadOwner, ...(addressed ? { addressed } : {}) };
      const original = await sessions.recordTrigger(channelTrigger(fact, inputContext(chat.addressedOf(c.row))));
      return await hear(original, deliveryScope(c.row.channel_id), candidates, (reason) => eventOf(audience, reason));
    } catch (error) {
      // A refusal is the route's answer: the message is kept and passed. Anything else (the database failing) fails the
      // write, and the event is told again at startup.
      if (!(error instanceof ApiError)) throw error;
      log.warn(`route ${c.row.id}`, error);
      return undefined;
    }
  };

  const userChat = (message: MsgRow) => message.sender_id === userId && message.kind === "chat" && message.deleted_at === null;

  // A failed write is NotRecorded: the hire stops and says so.
  const joining = async (session: T.Session, home: string) => {
    try {
      await chat.seat({ id: session.id, name: session.name, agent: session.agent, home });
    } catch (e) {
      if (e instanceof SqlError) throw new NotRecorded(causeMessage(e), { cause: e });
      throw e;
    }
  };

  const notice = (channel: string, text: string, code: string) => chat.notice({ channel, text, code });

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
    const channelName = place.name ?? "";
    let opened: string;
    try {
      const received = await sessions.hireWith({
        agent,
        brief: talkBrief(agent.name, envelopeLines(ordered.map(chat.addressedOf))),
        where: "",
        options: { context: { kind: "channel", channel }, trigger: { kind: "comment", channel, message: user.id } },
        envelopes: {
          _tag: "Talk",
          rows: ordered
            .filter(userChat)
            .map((message) => ({ row: envelopeRowOf(message, place, channelName), context: inputContext(chat.addressedOf(message)) })),
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
    // What the user said while it was hired: routed again, so it reaches the new session too (a delivery is one per session).
    for (const row of await chat.rowsAfter(channel, last?.number ?? 0)) {
      if (!userChat(row) || row.sender_id === opened) continue;
      const c = await chat.committedOf(row.id);
      if (c) await turn.with(() => route(c, false));
    }
  };

  const talkKey = (channel: string) => `talk:${channel}`;
  const onDirect = (c: Committed) => {
    if (c.row.sender_id !== userId || c.row.kind !== "chat" || c.channel.type !== "direct" || !c.channel.peer) return;
    const peer = chat.participants().find((p) => p.id === c.channel.peer);
    if (!peer?.agent || peer.id !== profileId(peer.agent)) return;
    if (talkSession(c.row.channel_id)) return;
    const channel = c.row.channel_id;
    const agentId = peer.agent;
    // One opening per channel: another message while it opens joins the one under way.
    if (tasks.has(talkKey(channel))) return;
    opening.set(channel, c.event.seq);
    tasks.keyed(talkKey(channel), async () => {
      try {
        await bestEffort(log, "opening a direct context", () => startTalk(channel, agentId));
      } finally {
        opening.delete(channel);
        await bestEffort(log, "the watch's cursor", () => turn.with(advance));
      }
    });
  };

  /** One event, under the turn: routed (posted) or taken back (removed), then the cursor moved past it. */
  const handle = async (told: Told, again: boolean) => {
    switch (told.kind) {
      case "posted": {
        const c = told.posted;
        const hopLimit = await route(c, again);
        // Said once there by the farm, until the user next speaks there; it does not wait on this turn.
        if (hopLimit) await chat.notice({ channel: c.row.channel_id, text: hopLimit, code: "hop_limit", untilUserSpeaks: true });
        onDirect(c);
        through = Math.max(through, c.event.seq);
        break;
      }
      case "removed":
        await sessions.withdrawEnvelope(told.event.message);
        through = Math.max(through, told.event.seq);
        break;
    }
    await advance();
  };

  const seqOf = (told: Told) => (told.kind === "posted" ? told.posted.event.seq : told.event.seq);
  const live = async (told: Told) => {
    const seq = seqOf(told);
    await turn.with(async () => {
      try {
        await handle(told, false);
      } catch (e) {
        // The write that made it fails with this; startup reads it again.
        cursor = "stuck";
        failures.set(seq, e instanceof Error ? e : new Error(String(e)));
        log.warn(`event ${seq}`, e);
      }
      handledLive = Math.max(handledLive, seq);
    });
    for (const w of waiting.filter((w) => w.seq <= handledLive)) {
      waiting.splice(waiting.indexOf(w), 1);
      const failure = failures.get(w.seq);
      failures.delete(w.seq);
      w.done(failure);
    }
  };
  const committed = chat.committed();
  tasks.run("chat events", async (signal) => {
    try {
      for (let n = await committed.next(signal); n.done !== true; n = await committed.next(signal)) await live(n.value);
    } finally {
      committed.close();
      for (const w of waiting.splice(0)) w.done();
    }
  });
  chat.awaitReader(
    (seq) =>
      new Promise<void>((resolve, reject) => {
        const done = (failure?: Error) => (failure === undefined ? resolve() : reject(failure));
        if (closed) return resolve();
        if (seq > handledLive) return void waiting.push({ seq, done });
        const failure = failures.get(seq);
        failures.delete(seq);
        done(failure);
      }),
  );
  sessions.useChat({
    defaultChannel: () => chat.defaultChannel(),
    unreadOf: async (participant, channel) =>
      (await chat.unread(participant, channel)).map((u) => ({
        target: u.channel,
        unread: u.unread,
        mentionsYou: u.mentionsYou,
        ...(u.latest !== undefined ? { latest: u.latest } : {}),
      })),
  });

  /** The orchestrators are seated under their profiles' names, each with its direct channel. */
  const seatOrchestrator = async (agent: T.Agent) => {
    if (!agents.isOrchestrator(agent.id)) return;
    await chat.seat({ id: agent.id, name: agent.name.trim() || t("server.channel.name.orchestrator") });
    await chat.createDirect(agent.id);
  };
  for (const agent of agents.orchestrators()) await seatOrchestrator(agent);
  agents.whenKept(seatOrchestrator);
  chat.guardRemoval(async (id) => (hired().some((h) => channelOfSession(h) === id) ? [t("server.channel.helpersThere")] : []));

  const openThread = async (h: T.Session) => {
    await chat.seat({ id: h.id, name: h.name, agent: h.agent });
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
    if (opened.thread) await chat.seat({ id: h.id, name: h.name, agent: h.agent, home: opened.thread });
  };

  /** The issue already has its thread (reopened, or sent to another session). */
  const handedOn = async (h: T.Session, thread: string) => {
    await chat.seat({ id: h.id, name: h.name, agent: h.agent, home: thread });
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
      // A session's seat: a helper's that is not a profile's seat in its direct channel.
      if (!p.agent || p.id === profileId(p.agent) || p.left || on.has(p.id)) continue;
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
    if (closed) return;
    // A word said: the wakes before that ended without one do not count.
    if (n._tag === "Spoke") return breaker.spoke(n.id);
    if (n._tag === "Left") {
      reach.left(n.left.id);
      breaker.reset(n.left.id);
    }
    // Runs, inputs and launches are the issues' and the deliveries'.
    if (n._tag !== "Hired" && n._tag !== "Left" && n._tag !== "Reported") return;
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
            // Marked before anything else the news sets off, in the order taken: a session that speaks right after
            // taking its input is not held back by it.
            await bestEffort(log, `${change.session} saw ${change.envelope}`, () => chat.markSeen(change.session, change.envelope));
            await bestEffort(log, `👀 on ${change.envelope}`, () =>
              chat.react(messageId(change.envelope), change.session, handedEmoji, true).then(() => undefined),
            );
            break;
          case "Handed":
            break;
          case "EmptyWake": {
            const { count, tripped } = breaker.failed(change.session);
            if (!tripped) break;
            await bestEffort(log, `wake breaker for ${change.session}`, async () => {
              await sessions.holdWakes(change.session, true);
              const where = (await chat.homeOf(change.session)) ?? chat.defaultChannel();
              const name = sessions.live(change.session).session?.name ?? change.session;
              await notice(where, t("server.channel.breaker", { name, failed: count }), "wake_breaker");
            });
            break;
          }
        }
      }
    } finally {
      deliveries.close();
    }
  });

  const inbox = userInbox(deps, (trigger) =>
    turn.with(async () => {
      // The patrol's note is for the orchestrator of its place, as a digest: it wakes no one.
      const place = trigger.replyChannel ?? chat.defaultChannel();
      await hear(trigger, deliveryScope(place), [{ recipient: chat.orchestratorIn(place), reason: "addressed", wakes: false }], () => "ambient");
    }),
  );

  return {
    inboxNews: inbox.inboxNews,
    toUser: inbox.toUser,
    patrol: inbox.patrol,
    handoffState: inbox.handoffState,
    externalChanges: inbox.externalChanges,
    direct: async (ref) => {
      const name = ref.trim();
      const agent = agents.named(name) ?? agents.agent(name) ?? agents.orchestrators().find((o) => o.name === name);
      if (!agent) throw missing(t("server.channel.noProfileNamed", { key: ref }), [lookIn.agent]);
      if (agents.isOrchestrator(agent.id)) {
        await seatOrchestrator(agent);
        return chat.createDirect(agent.id);
      }
      await chat.seat({ id: profileId(agent.id), name: agent.name, agent: agent.id });
      return chat.createDirect(profileId(agent.id));
    },
    previewRemove: async (id) => {
      const base = await chat.previewRemove(id);
      const waiting = await sessions.waitingOn(id);
      return { ...base, does: [...base.does, ...(waiting > 0 ? [t("server.channel.deletesDeliveries", { n: waiting })] : [])] };
    },
    boot: async () => {
      const wakes = await sessions.agentWakes();
      reach.load(wakes.scopes, wakes.sessions);
      await openThreads();
      await turn.with(async () => {
        // Each event once, in order: one that cannot be routed is logged and passed, not tried again and again.
        for (let from = (await qw.cursorOf(db.sql, { name: routed }))?.seq ?? 0; ;) {
          const page = await chat.events(from);
          const last = page.at(-1);
          if (!last) break;
          for (const event of page) {
            await bestEffort(log, `event ${event.seq}`, async () => {
              if (event.kind === "removed") return handle({ kind: "removed", event }, true);
              // A message deleted since, or whose place is gone, has nothing left to route.
              const posted = await chat.committedOf(event.message);
              if (posted) await handle({ kind: "posted", posted }, true);
            });
            through = Math.max(through, event.seq);
          }
          from = last.seq;
        }
        cursor = "moving";
        failures.clear();
        await advance();
      });
      await inbox.boot();
    },
    close: async () => {
      closed = true;
      await inbox.close();
      await tasks.close();
      for (const w of waiting.splice(0)) w.done();
    },
  };
}
