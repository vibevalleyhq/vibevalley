import { Clock, Effect, FiberSet } from "effect";
import { HttpClient } from "effect/http";

import type * as T from "@vibevalley/protocol";
import { everyone, ownerId } from "@vibevalley/protocol";

import { Agent } from "#/agent/agent.ts";
import { Inconsistent } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import { Db } from "#/infra/db.ts";
import { bestEffort } from "#/infra/log.ts";
import { Mailbox } from "#/mailbox/mailbox.ts";
import { inputContext } from "#/mailbox/payload.ts";
import * as qc from "#db/channel.sql.ts";
import * as qmn from "#db/channel_mention.sql.ts";
import * as qm from "#db/channel_message.sql.ts";

import { metaOf, metaText, type MsgRow, senderKind, messageKind, channelType, type Write, type Written, type ChannelRouteInput } from "./contracts.ts";
import { linksIn, readEmbed } from "./embeds.ts";
import type { ChannelHub } from "./hub.ts";
import { mentionsIn } from "./mentions.ts";
import { channelInput } from "./messages.ts";

export const channelWriting = (r: ChannelHub) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const agents = yield* Agent;
    const db = yield* Db;
    const mailbox = yield* Mailbox;
    const {
      model,
      follow,
      tx,
      locked,
      orchestratorIds,
      orchestratorOfRow,
      channelOfSession,
      presentSessions,
      publishChannel,
      publishOwnerMentions,
      publishMessage,
      ownerOf,
      threadFor,
      readUpTo,
      change,
      channelEnvelope,
      asInbox,
    } = r;
    // Work set off by a timer belongs to this service: it ends with it and keeps its services.
    const forkHere = yield* FiberSet.makeRuntime();

    const settle = Effect.fn("Channel.settle")(function* (inserted: MsgRow) {
      let row = inserted;
      const ch = model.channel(row.channel_id);
      if (!ch) return yield* Effect.die(Inconsistent.make({ message: `no channel ${row.channel_id}` }));
      const meta = metaOf(row.meta);
      const orchestrators = orchestratorIds();
      const here = orchestratorOfRow(ch);
      // No one else is in a direct channel to be named.
      const mentions = ch.type === "direct" ? [] : mentionsIn(row.body, { here, orchestrators });
      const sessionsNow = presentSessions();
      // Participants are sessions, agents and the owner alike: a mention is any of them.
      const present: readonly string[] = sessionsNow.map((h) => h.id);
      const known = new Set(model.participants().map((p) => p.id));
      const named: { id: string; how: "delivered" | "absent" | "unknown" }[] = [];
      yield* Effect.forEach(
        mentions,
        (m) =>
          Effect.gen(function* () {
            const how = orchestrators.includes(m) || m === ownerId || m === everyone || present.includes(m) ? "delivered" : known.has(m) ? "absent" : "unknown";
            named.push({ id: m, how });
            yield* db.run(qmn.insertMention({ message_id: row.id, target_id: m, resolved: how }));
          }),
        { discard: true },
      );
      if (mentions.length > 0) {
        row = { ...row, meta: metaText({ ...meta, mentions }) };
        yield* db.run(qm.updateMessageMeta({ meta: row.meta, id: row.id }));
      }
      let followers: string[] = [];
      if (ch.type === "thread") {
        // A dispatch handing the issue to its next session makes no one a follower: the orchestrator would be woken by every word in it.
        if (row.sender_id !== "system" && row.kind !== "dispatch") yield* follow(ch.id, row.sender_id, "replied", row.number);
        yield* Effect.forEach(
          named,
          (m) =>
            Effect.gen(function* () {
              if (m.how === "delivered" && (orchestrators.includes(m.id) || present.includes(m.id))) yield* follow(ch.id, m.id, "mentioned", row.number - 1);
            }),
          { discard: true },
        );
        followers = model.followers(ch.id);
      }
      const audience = sessionsNow.filter((h) => ch.type === "thread" || channelOfSession(h) === ch.id).map((h) => h.id);
      const heard = {
        from: row.sender_id,
        fromKind: senderKind(row.sender_kind),
        kind: messageKind(row.kind),
        mentions,
        channel: { type: channelType(ch.type), ...(ch.peer_id !== null ? { peer: ch.peer_id } : {}) },
        orchestrator: here,
        orchestrators,
        threadOwner: ownerOf(ch),
        sessions: audience,
        present,
        followers,
        ...(meta.outcome ? { outcome: meta.outcome } : {}),
        spoken: meta.spoken === true && meta.ingressSource !== "voice",
      };
      const addressed = meta.ingressRecipient;
      const recipients = [...new Set([...present, ...orchestrators, ...(addressed ? [addressed] : [])])];
      const fact: ChannelRouteInput = {
        row: channelEnvelope(row),
        audience: heard,
        ...(addressed ? { addressed } : {}),
        roles: Object.fromEntries(recipients.map((recipient) => [recipient, agents.isOrchestrator(recipient) ? "orchestrator" : "worker"])),

        ...(meta.outcome ? { outcome: meta.outcome } : {}),
      };
      const { input, mail } = channelInput(fact, inputContext(asInbox(fact.row)));
      const routed = yield* Effect.gen(function* () {
        const original = yield* mailbox.recordTrigger(input);
        return yield* mailbox.receive({ _tag: "Trigger", trigger: original, to: mail });
      }).pipe(Effect.catch((error) => Effect.as(Effect.logWarning(`chat: route ${fact.row.envelope_id}`, error), { heldNotice: "" })));
      const written: Written = { absent: [], heldNotice: "", thread: "", again: false, row };
      if (routed.heldNotice && (yield* db.run(qm.holdNoticeSinceUser({ channel: ch.id }))).n === 0) written.heldNotice = routed.heldNotice;
      written.absent = named.filter((m) => m.how !== "delivered").map((m) => m.id);
      return written;
    });

    const post = Effect.fnUntraced(function* (w: Write, heard: (row: MsgRow) => Effect.Effect<Written>): Effect.fn.Return<Written> {
      const written = yield* tx(
        Effect.gen(function* () {
          if (w.sendKey) {
            const seen = yield* db.one(qm.messageBySendKey({ sender_id: w.from, send_key: w.sendKey }));
            if (seen) return { absent: [], heldNotice: "", thread: "", again: true, row: seen };
          }
          // The row as MessageByID would read it back: the sender's name and kind are the participant's.
          const sender = model.participant(w.from);
          if (!sender) return yield* Effect.die(Inconsistent.make({ message: `no participant ${w.from}` }));
          const id = newId();
          const meta = metaText(w.meta);
          const created_at = yield* Clock.currentTimeMillis;
          const { revision } = yield* db.run(qc.bumpRevision({ id: w.channel }));
          const { number } = yield* db.run(
            qm.insertMessage({
              id,
              channel: w.channel,
              sender: w.from,
              kind: w.kind,
              body: w.text,
              meta,
              send_key: w.sendKey || null,
              created_at,
              revision,
              reply_number: w.replyTo ?? null,
            }),
          );
          yield* db.run(qc.touchChannel({ number, id: w.channel }));
          model.touched(w.channel, number);
          const row: MsgRow = {
            id,
            channel_id: w.channel,
            number,
            sender_id: w.from,
            kind: w.kind,
            body: w.text,
            meta,
            send_key: w.sendKey || null,
            created_at,
            sender_name: sender.name,
            sender_kind: sender.kind,
            sender_agent: sender.agent_id,
            revision,
            reply_number: w.replyTo ?? null,
            edited_at: null,
            deleted_at: null,
            pinned_at: null,
            reactions: null,
          };
          const out: Written = { absent: [], heldNotice: "", thread: "", again: false, row };
          if (w.readBy) yield* readUpTo(w.readBy, w.channel, number);
          if (w.follow) yield* follow(w.channel, w.follow, "owner", number);
          if (w.thread) out.thread = yield* threadFor({ id, number, channel: w.channel }, w.thread);
          return out;
        }),
      );
      if (written.again) return written;
      const routed = yield* heard(written.row);
      const complete = { ...routed, thread: written.thread };
      yield* after(w.channel, complete, w.answers);
      return complete;
    });

    /** Routing follows the committed message, so startup can replay an interrupted handoff. */
    const write = (w: Write) => post(w, settle);

    /** The previews of a message's links, read after it is out (the server's own requests take seconds) and then put on
     * it as a change. */
    const embedLater = (row: MsgRow) => {
      const links = row.kind === "chat" && row.deleted_at === null ? linksIn(row.body) : [];
      if (links.length === 0) return;
      void forkHere(
        Effect.gen(function* () {
          const found = (yield* Effect.forEach(
            links,
            (l) =>
              readEmbed(l).pipe(
                Effect.provideService(HttpClient.HttpClient, http),
                Effect.catchCause((cause) => Effect.as(Effect.logWarning("a link preview was not read", cause), undefined)),
              ),
            { concurrency: 4 },
          )).filter((e): e is T.Embed => e !== undefined);
          yield* locked(
            Effect.gen(function* () {
              const now = yield* db.one(qm.messageByID({ id: row.id }));
              // Changed meanwhile: its words are not the ones read.
              if (!now || now.deleted_at !== null || now.body !== row.body) return;
              const meta = metaOf(now.meta);
              if (found.length === 0 && !meta.embeds) return;
              yield* change(now, (revision) => db.run(qm.setEmbeds({ meta: metaText({ ...meta, embeds: found }), revision, id: now.id })));
            }),
          );
        }).pipe(bestEffort("chat: link previews")),
      );
    };

    const after = Effect.fnUntraced(function* (channel: string, written: Written, answers: T.SessionId | undefined): Effect.fn.Return<void> {
      yield* publishMessage(written.row, answers);
      embedLater(written.row);
      yield* publishChannel(channel);
      const meta = metaOf(written.row.meta);
      if (written.row.sender_id === ownerId || meta.mentions?.includes(ownerId) === true) yield* publishOwnerMentions;
      if (written.thread) yield* publishChannel(written.thread);
      if (written.heldNotice) yield* write({ channel, from: "system", kind: "notice", text: written.heldNotice, meta: { code: "hop_limit" } });
    });
    return { settle, write, embedLater, after };
  });

export type ChannelWriting = Effect.Success<ReturnType<typeof channelWriting>>;
