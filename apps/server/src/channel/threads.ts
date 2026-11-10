import { Clock, Effect } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { head } from "#/base/clip.ts";
import { Db } from "#/infra/db.ts";
import { bestEffort } from "#/infra/log.ts";
import { Mailbox } from "#/mailbox/mailbox.ts";
import { Session } from "#/session/session.ts";
import * as qmb from "#db/channel_member.sql.ts";
import * as qm from "#db/channel_message.sql.ts";
import * as qp from "#db/channel_participant.sql.ts";

import { type Meta, subjectOf, type ChannelEnvelopeRow, type SessionNews } from "./contracts.ts";
import type { ChannelHub } from "./hub.ts";
import type { ChannelWriting } from "./writing.ts";

const reportMax = 1500;

export const sessionThreads = (r: ChannelHub, w: ChannelWriting) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const sessions = yield* Session;
    const mailbox = yield* Mailbox;
    const {
      model,
      addMember,
      locked,
      seat,
      orchestratorInRow,
      directOfSession,
      channelOfSession,
      sessionOf,
      hired,
      threadOf,
      threadOfSession,
      setRead,
      messageRow,
    } = r;
    const { settle, write } = w;
    let closed = false;

    const openThread = Effect.fn("Channel.openThread")(function* (h: T.Session) {
      const joined: qp.UpsertParticipantParams = {
        id: h.id,
        kind: "session",
        name: h.name,
        agent_id: h.agent,
        runtime: h.runtime,
        joined_at: yield* Clock.currentTimeMillis,
      };
      yield* db.run(qp.upsertParticipant(joined));
      model.joined(joined);
      const direct = directOfSession(h);
      if (direct) return yield* handedOn(h, direct);
      const subject = subjectOf(h);
      const thread = yield* threadOf(subject);
      if (thread) return yield* handedOn(h, thread);
      const channel = channelOfSession(h);
      const latest = (yield* db.run(qm.latestNumber({ channel_id: channel }))).n ?? 0;
      const now = yield* Clock.currentTimeMillis;
      yield* setRead(h.id, channel, latest, now);
      const what = h.refining ? t("server.channel.dispatch.draft") : head(h.brief.replace(/\s+/gu, " "), 80);
      // The dispatch note is the farm's, under the name of the orchestrator in the channel.
      const by = orchestratorInRow(model.channel(channel));
      yield* seat(by);
      yield* write({
        channel: channel,
        from: by,
        kind: "dispatch",
        text: t("server.channel.dispatch.sent", { id: h.id, name: h.name, repo: h.repo ?? t("server.channel.dispatch.repo"), what }),
        meta: { session: h.id },
        thread: subject,
      });
    });

    /** The issue already has its thread (reopened, or sent to another session). */
    const handedOn = Effect.fn("Channel.handedOn")(function* (h: T.Session, thread: string) {
      if (model.membersOf(thread).includes(h.id)) return;
      // A profile's talk: the session that answers there is not told of in it; it only follows.
      if (model.channel(thread)?.type === "direct") return yield* addMember(thread, h.id, "user", model.channel(thread)?.last_number ?? 0);
      const channel = channelOfSession(h);
      const latest = (yield* db.run(qm.latestNumber({ channel_id: channel }))).n ?? 0;
      const now = yield* Clock.currentTimeMillis;
      yield* setRead(h.id, channel, latest, now);
      // Each dispatch of the issue is in its thread but the first, which the thread hangs under: this is the one after.
      const nth = ((yield* db.run(qm.dispatchesIn({ channel_id: thread }))).n ?? 0) + 2;
      const text = h.refining
        ? t("server.channel.dispatch.redraft", { id: h.id, name: h.name })
        : t("server.channel.dispatch.handedOn", { id: h.id, name: h.name, nth });
      const by = orchestratorInRow(model.channel(thread));
      yield* seat(by);
      yield* write({ channel: thread, from: by, kind: "dispatch", text, meta: { session: h.id }, member: h.id });
    });

    const sessionsLeft = Effect.gen(function* () {
      const on = new Set<string>(hired().map((h) => h.id));
      const now = yield* Clock.currentTimeMillis;
      for (const p of model.participants()) {
        if (p.kind !== "session" || p.left_at !== null || on.has(p.id)) continue;
        yield* db.run(qp.participantLeft({ left_at: now, id: p.id }));
        model.left(p.id, now);
        yield* mailbox.withdraw({ _tag: "Session", session: p.id, why: "left" });
        yield* db.run(qmb.removeFromAll({ at: now, participant_id: p.id }));
      }
    });

    const postReport = Effect.fn("Channel.postReport")(function* (
      id: string,
      outcome: T.Outcome,
      summary: string,
      spent: T.Spent | undefined,
      run: string | undefined,
    ) {
      const w = sessionOf(id);
      if (!w || w.refining || outcome === "interrupted") return;
      const thread = yield* threadOfSession(id);
      if (!thread) return;
      const said = outcome === "completed" ? sessions.reportOf(id) : "";
      const meta: Meta = { outcome, ...(spent ? { spent } : {}), ...(run ? { run } : {}) };
      yield* write({ channel: thread, from: id, kind: "report", text: head(said || summary, reportMax), meta });
    });

    // The sessions' news: hired and left open and close threads, a report is posted in the thread. One at a time, before the
    // next.
    const onSessionNews = Effect.fnUntraced(function* (n: SessionNews) {
      // Runs, inputs and launches are the issues' and Mailbox's.
      if (n._tag !== "Hired" && n._tag !== "Left" && n._tag !== "Reported") return;
      yield* locked(
        Effect.suspend(() => {
          if (closed) return Effect.void;
          switch (n._tag) {
            case "Hired":
              return Effect.forEach(hired(), (h) => openThread(h).pipe(bestEffort(`chat: ${h.id}'s thread`)), {
                discard: true,
              });
            case "Left":
              return sessionsLeft;
            case "Reported":
              return postReport(n.report.id, n.report.outcome, n.report.summary, n.report.spent, n.report.run);
          }
        }),
      ).pipe(bestEffort(`chat: after ${n._tag}`));
    });
    // Once the helpers are back, Collaboration restores their threads; Mailbox wakes them after its own recovery.
    const replayDelivery = Effect.fn("Channel.replayDelivery")(function* (row: ChannelEnvelopeRow) {
      const written = yield* settle(messageRow(row));
      if (written.heldNotice) yield* write({ channel: row.channel_id, from: "system", kind: "notice", text: written.heldNotice, meta: { code: "hop_limit" } });
    }, locked);
    const start = Effect.gen(function* () {
      yield* locked(Effect.forEach(hired(), (h) => openThread(h).pipe(bestEffort(`chat: ${h.id}'s thread`)), { discard: true }));
      // Each row once, in order: one that cannot be routed stays unrouted, and is not fetched again.
      let after = { after_channel: "", after_number: 0 };
      while (true) {
        const rows = yield* db.run(qm.unroutedChannelMessages(after));
        const last = rows.at(-1);
        if (!last) break;
        yield* Effect.forEach(rows, (row) => replayDelivery(row).pipe(bestEffort(`chat: route ${row.envelope_id}`)), { discard: true });
        after = { after_channel: last.channel_id, after_number: last.number };
      }
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closed = true;
      }),
    );
    return { sessionsLeft, onSessionNews, start };
  });

export type SessionThreads = Effect.Success<ReturnType<typeof sessionThreads>>;
