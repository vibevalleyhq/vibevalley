import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { head } from "#/base/clip.ts";
import type { Db } from "#/infra/db.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Session } from "#/modules/session/session.ts";
import * as qm from "#db/channel_message.sql.ts";

import { type Meta, subjectOf, type ChannelEnvelopeRow, type SessionNews, theRow } from "./contracts.ts";
import type { ChannelHub } from "./hub.ts";
import type { ChannelWriting } from "./writing.ts";

const reportMax = 1500;

export interface SessionThreadsDeps {
  readonly clock: Time;
  readonly log: Logger;
  readonly db: Db;
  readonly session: Session;
}

export function sessionThreads(deps: SessionThreadsDeps, r: ChannelHub, w: ChannelWriting) {
  const { db, session: sessions, clock, log } = deps;
  const { store, orchestratorInRow, directOfSession, channelOfSession, sessionOf, hired, threadOf, threadOfSession, messageRow } = r;
  const { settle, write } = w;
  let closed = false;

  const latestIn = async (channel: string) => theRow(await qm.latestNumber(db.sql, { channel_id: channel }), "LatestNumber").n ?? 0;

  const openThread = async (h: T.Session) => {
    await store.upsertParticipant({
      id: h.id,
      kind: "agent",
      role: "worker",
      name: h.name,
      agent_id: h.agent,
      runtime: h.runtime,
      joined_at: clock.now(),
    });
    const direct = directOfSession(h);
    if (direct) return handedOn(h, direct);
    const subject = subjectOf(h);
    const thread = threadOf(subject);
    if (thread) return handedOn(h, thread);
    const channel = channelOfSession(h);
    const latest = await latestIn(channel);
    await store.setRead(h.id, channel, latest, clock.now());
    const what = h.refining ? t("server.channel.dispatch.draft") : head(h.brief.replace(/\s+/gu, " "), 80);
    // The dispatch note is the farm's, under the name of the orchestrator in the channel.
    const by = orchestratorInRow(store.channel(channel));
    await store.seat(by);
    await write({
      channel: channel,
      from: by,
      kind: "dispatch",
      text: t("server.channel.dispatch.sent", { id: h.id, name: h.name, repo: h.repo ?? t("server.channel.dispatch.repo"), what }),
      meta: { session: h.id },
      thread: subject,
    });
  };

  /** The issue already has its thread (reopened, or sent to another session). */
  const handedOn = async (h: T.Session, thread: string) => {
    if (store.membersOf(thread).includes(h.id)) return;
    // A profile's talk: the session that answers there is not told of in it; it only follows.
    const row = store.channel(thread);
    if (row?.type === "direct") return store.addMember(thread, h.id, "user", row.last_number ?? 0);
    const channel = channelOfSession(h);
    const latest = await latestIn(channel);
    await store.setRead(h.id, channel, latest, clock.now());
    // Each dispatch of the issue is in its thread but the first, which the thread hangs under: this is the one after.
    const nth = (theRow(await qm.dispatchesIn(db.sql, { channel_id: thread }), "DispatchesIn").n ?? 0) + 2;
    const text = h.refining
      ? t("server.channel.dispatch.redraft", { id: h.id, name: h.name })
      : t("server.channel.dispatch.handedOn", { id: h.id, name: h.name, nth });
    const by = orchestratorInRow(row);
    await store.seat(by);
    await write({ channel: thread, from: by, kind: "dispatch", text, meta: { session: h.id }, member: h.id });
  };

  const sessionsLeft = async () => {
    const on = new Set<string>(hired().map((h) => h.id));
    const now = clock.now();
    for (const p of store.participants()) {
      if (p.role !== "worker" || p.runtime === null || p.left_at !== null || on.has(p.id)) continue;
      await store.markParticipantLeft(p.id, now);
      await sessions.withdrawDeliveries(p.id, "left");
    }
  };

  const postReport = async (id: string, outcome: T.Outcome, summary: string, spent: T.Spent | undefined, run: string | undefined) => {
    const w = sessionOf(id);
    if (!w || w.refining || outcome === "interrupted") return;
    const thread = await threadOfSession(id);
    if (!thread) return;
    const said = outcome === "completed" ? sessions.live(id).summary : "";
    const meta: Meta = { outcome, ...(spent ? { spent } : {}), ...(run ? { run } : {}) };
    await write({ channel: thread, from: id, kind: "report", text: head(said || summary, reportMax), meta });
  };

  const openThreads = async () => {
    for (const h of hired()) await bestEffort(log, `chat: ${h.id}'s thread`, () => openThread(h));
  };

  // The sessions' news: hired and left open and close threads, a report is posted in the thread. One at a time, before the
  // next.
  const onSessionNews = async (n: SessionNews) => {
    // Runs, inputs and launches are the issues' and Mailbox's.
    if (n._tag !== "Hired" && n._tag !== "Left" && n._tag !== "Reported") return;
    await bestEffort(log, `chat: after ${n._tag}`, () =>
      store.locked(async () => {
        if (closed) return;
        switch (n._tag) {
          case "Hired":
            return openThreads();
          case "Left":
            return sessionsLeft();
          case "Reported":
            return postReport(n.report.id, n.report.outcome, n.report.summary, n.report.spent, n.report.run);
        }
      }),
    );
  };
  // Once the helpers are back, Collaboration restores their threads; Mailbox wakes them after its own recovery.
  const replayDelivery = (row: ChannelEnvelopeRow) =>
    store.locked(async () => {
      const written = await settle(messageRow(row));
      if (written.heldNotice) await write({ channel: row.channel_id, from: "system", kind: "notice", text: written.heldNotice, meta: { code: "hop_limit" } });
    });
  const start = async () => {
    await store.locked(openThreads);
    // Each row once, in order: one that cannot be routed stays unrouted, and is not fetched again.
    let after = { after_channel: "", after_number: 0 };
    while (true) {
      const rows = await qm.unroutedChannelMessages(db.sql, after);
      const last = rows.at(-1);
      if (!last) break;
      for (const row of rows) await bestEffort(log, `chat: route ${row.envelope_id}`, () => replayDelivery(row));
      after = { after_channel: last.channel_id, after_number: last.number };
    }
  };
  /** News after this is not acted on. */
  const close = () => {
    closed = true;
  };
  return { sessionsLeft, onSessionNews, start, close };
}

export type SessionThreads = ReturnType<typeof sessionThreads>;
