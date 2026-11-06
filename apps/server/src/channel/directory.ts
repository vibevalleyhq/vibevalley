import { Clock, Effect } from "effect";

import { list, t } from "@vibevalley/i18n";
import { defaultOrchestrator } from "@vibevalley/protocol";

import { Agent } from "#/agent/agent.ts";
import { head } from "#/base/clip.ts";
import { lookIn, missing, refused } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import { Core } from "#/core/core.ts";
import { Db } from "#/infra/db.ts";
import * as qc from "#db/channel.sql.ts";
import * as qf from "#db/channel_follow.sql.ts";
import * as qm from "#db/channel_message.sql.ts";
import * as qp from "#db/channel_participant.sql.ts";
import * as qr from "#db/channel_read_cursor.sql.ts";

import { type ChannelService, infoOf, notifyOf, optional } from "./contracts.ts";
import { channelNameProblem } from "./mentions.ts";
import { type ChannelRecords, profileId, threadTitleMax } from "./records.ts";

type DirectoryMethods = Pick<
  ChannelService,
  | "channels"
  | "openChannel"
  | "updateChannel"
  | "archive"
  | "previewRemoveChannel"
  | "removeChannel"
  | "setNotify"
  | "orchestratorOf"
  | "direct"
  | "notifyOf"
  | "markUnread"
  | "makeDefault"
  | "topOf"
  | "addressOf"
  | "channelByName"
>;

export const channelDirectory = (r: ChannelRecords) =>
  Effect.gen(function* () {
    const core = yield* Core;
    const agents = yield* Agent;
    const db = yield* Db;
    const { model, reload, tx, locked, seat, orchestratorOfRow, channelOfSession, presentSessions, targetOfChannel, publishChannel, publishOwnerMentions } = r;

    /** A channel nothing points at any more; refused with what still does. */
    const removable = Effect.fnUntraced(function* (id: string) {
      const row = model.channel(id);
      if (!row || row.type !== "channel") return yield* Effect.fail(missing(t("server.channel.noChannel", { id }), [lookIn.channel]));
      if (row.is_default) return yield* Effect.fail(refused(t("server.channel.defaultStays")));
      if (presentSessions().some((h) => channelOfSession(h) === id))
        return yield* Effect.fail(refused(t("server.channel.inUse", { why: t("server.channel.helpersThere") })));
      const used = yield* db.run(qc.channelInUse({ id }));
      const why = [
        used.crons != null && used.crons !== 0 ? t("server.channel.cronsThere", { n: used.crons }) : "",
        used.connectors != null && used.connectors !== 0 ? t("server.channel.connectorsThere") : "",
        used.queued != null && used.queued !== 0 ? t("server.channel.queuedThere", { n: used.queued }) : "",
        used.issue_threads != null && used.issue_threads !== 0 ? t("server.channel.issuesThere", { n: used.issue_threads }) : "",
      ].filter(Boolean);
      if (why.length > 0) return yield* Effect.fail(refused(t("server.channel.inUse", { why: list(why) })));
      const threads = model.threadsOf(id);
      const said = (row.last_number ?? 0) + threads.reduce((n, thread) => n + thread.reply_count, 0);
      return { target: targetOfChannel(row), threads: threads.length, said };
    });

    const openDirect = Effect.fn("Channel.openDirect")(function* (agent: { readonly id: string; readonly name: string }) {
      const mine = agents.isOrchestrator(agent.id);
      const peer = mine ? agent.id : profileId(agent.id);
      if (mine) yield* seat(agent.id);
      else {
        const joined: qp.UpsertParticipantParams = {
          id: peer,
          kind: "profile",
          name: agent.name,
          agent_id: agent.id,
          runtime: null,
          joined_at: yield* Clock.currentTimeMillis,
        };
        yield* db.run(qp.upsertParticipant(joined));
        model.joined(joined);
      }
      const had = model.channels("direct").find((c) => c.peer_id === peer);
      if (had) return had.id;
      const id = newId();
      yield* db.run(qc.createDirect({ id, peer_id: peer, created_at: yield* Clock.currentTimeMillis }));
      yield* reload;
      yield* publishChannel(id);
      return id;
    }, locked);

    return {
      channels: Effect.fn("Channel.channels")(() => Effect.sync(() => model.channels().map(infoOf))),
      openChannel: Effect.fn("Channel.openChannel")(function* (name, description, repo) {
        const clean = name.trim().replace(/^#/u, "");
        const rows = model.channels();
        const problem = channelNameProblem(
          clean,
          rows.flatMap((row) => (row.name !== null ? [row.name] : [])),
        );
        if (problem) return yield* Effect.fail(refused(problem));
        const desc = optional(description);
        const proj = optional(repo);
        const id = newId();
        const created_at = yield* Clock.currentTimeMillis;
        yield* db.run(qc.createChannel({ id, is_default: false, name: clean, description: desc, repo: proj, created_at }));
        model.created({
          id,
          type: "channel",
          is_default: false,
          root_id: null,
          root_number: null,
          subject_kind: null,
          subject_id: null,
          last_number: null,
          reply_count: 0,
          created_at,
          name: clean,
          description: desc,
          repo: proj,
          parent_id: null,
          peer_id: null,
          revision: 0,
          category: null,
          position: null,
          archived_at: null,
          notify: "all",
          orchestrator: null,
        });
        yield* publishChannel(id);
        return infoOf({ id, name: clean, description: desc, repo: proj, is_default: false });
      }, locked),
      updateChannel: Effect.fn("Channel.updateChannel")(function* (id, upd) {
        const row = model.channel(id);
        if (!row || row.type === "direct") return yield* Effect.fail(missing(t("server.channel.noChannel", { id }), [lookIn.channel]));
        const onlyName =
          upd.description === undefined && upd.repo === undefined && upd.category === undefined && upd.before === undefined && upd.orchestrator === undefined;
        if (row.type === "thread" && !onlyName) return yield* Effect.fail(refused(t("server.channel.threadOnlyTitle")));
        let name = row.name;
        if (upd.name !== undefined) {
          const clean = upd.name.trim().replace(/^#/u, "");
          if (row.type === "thread") name = clean ? head(clean, threadTitleMax * 2) : null;
          else {
            const problem = channelNameProblem(
              clean,
              model.channels().flatMap((c) => (c.name !== null && c.id !== id ? [c.name] : [])),
            );
            if (problem) return yield* Effect.fail(refused(problem));
            name = clean;
          }
        }
        const desc = (upd.description !== undefined ? optional(upd.description) : null) ?? row.description;
        const proj = upd.repo !== undefined ? optional(upd.repo) : row.repo;
        const category = upd.category !== undefined ? optional(upd.category) : row.category;
        // The default orchestrator is kept as none, so a channel follows whichever is the default.
        const wanted = upd.orchestrator?.trim();
        if (wanted && !agents.isOrchestrator(wanted)) return yield* Effect.fail(refused(t("server.channel.notOrchestrator", { id: wanted })));
        const orchestrator = wanted === undefined ? row.orchestrator : wanted && wanted !== defaultOrchestrator ? wanted : null;
        // Placed before another channel: every channel but the default gets its place again, in order.
        const order =
          upd.before === undefined
            ? undefined
            : (() => {
                const rest = model
                  .channels()
                  .filter((c) => !c.is_default && c.id !== id)
                  .map((c) => c.id);
                const at = rest.indexOf(upd.before);
                rest.splice(at < 0 ? rest.length : at, 0, id);
                return rest;
              })();
        yield* tx(
          Effect.gen(function* () {
            if (row.type === "channel") yield* db.run(qc.updateChannel({ description: desc, repo: proj, id }));
            if (name !== row.name) yield* db.run(qc.renameChannel({ name, id }));
            if (category !== row.category) yield* db.run(qc.setCategory({ category, id }));
            if (orchestrator !== row.orchestrator) yield* db.run(qc.setOrchestrator({ orchestrator, id }));
            yield* Effect.forEach((order ?? []).entries(), ([position, each]) => db.run(qc.placeChannel({ position, id: each })), { discard: true });
          }),
        );
        if (row.type === "channel") model.channelUpdated(id, desc, proj);
        model.patched(id, { name, category, orchestrator });
        for (const [position, each] of (order ?? []).entries()) model.patched(each, { position });
        yield* Effect.forEach(order ?? [id], (each) => publishChannel(each), { discard: true });
        // Its threads are looked after by the same orchestrator: they show the new one too.
        if (orchestrator !== row.orchestrator) yield* Effect.forEach(model.threadsOf(id), (item) => publishChannel(item.id), { discard: true });
      }, locked),
      archive: Effect.fn("Channel.archive")(function* (id, on) {
        const row = model.channel(id);
        if (!row || row.type === "direct") return yield* Effect.fail(missing(t("server.channel.noChannel", { id }), [lookIn.channel]));
        if ((row.archived_at !== null) === on) return;
        if (row.is_default) return yield* Effect.fail(refused(t("server.channel.defaultStays")));
        const archived_at = on ? yield* Clock.currentTimeMillis : null;
        yield* db.run(qc.setArchived({ archived_at, id }));
        model.patched(id, { archived_at });
        yield* publishChannel(id);
      }, locked),
      previewRemoveChannel: Effect.fn("Channel.previewRemoveChannel")(function* (id) {
        const rem = yield* removable(id);
        return { does: [t("server.channel.deletesChannel", { target: rem.target, threads: rem.threads, said: rem.said })] };
      }),
      removeChannel: Effect.fn("Channel.removeChannel")(function* (id) {
        yield* removable(id);
        const gone = new Set([model.channel(id), ...model.threadsOf(id)].flatMap((c) => (c ? [targetOfChannel(c)] : [])));
        yield* tx(
          Effect.gen(function* () {
            yield* db.run(qm.deleteThreadMessagesIn({ id }));
            yield* db.run(qf.deleteFollowsIn({ id }));
            yield* db.run(qr.deleteCursorsIn({ id }));
            yield* db.run(qc.deleteThreadsOf({ id }));
            yield* db.run(qm.deleteMessagesIn({ id }));
            yield* db.run(qc.deleteChannel({ id }));
          }),
        );
        yield* reload;
        for (const [who, target] of model.lastRead) if (gone.has(target)) model.lastRead.delete(who);
        yield* core.apply({ type: "channelRemoved", id });
      }, locked),
      setNotify: Effect.fn("Channel.setNotify")(function* (id, notify) {
        if (!model.channel(id)) return yield* Effect.fail(missing(t("server.channel.noChannel", { id }), [lookIn.channel]));
        yield* db.run(qc.setNotify({ notify, id }));
        model.patched(id, { notify });
        yield* publishChannel(id);
        yield* publishOwnerMentions;
      }, locked),
      orchestratorOf: (channel) => orchestratorOfRow(model.channel(channel)),
      direct: Effect.fn("Channel.direct")(function* (ref) {
        const name = ref.trim();
        const agent = agents.named(name) ?? agents.agent(name) ?? agents.orchestrators().find((o) => o.name === name);
        if (!agent) return yield* Effect.fail(missing(t("server.channel.noProfileNamed", { key: ref }), [lookIn.agent]));
        return yield* openDirect(agent);
      }),
      notifyOf: (id) => {
        const c = model.channel(id);
        const top = c?.parent_id ? model.channel(c.parent_id) : undefined;
        if (c?.notify === "none" || top?.notify === "none") return "none";
        return notifyOf(c?.notify !== "all" ? (c?.notify ?? "all") : (top?.notify ?? "all"));
      },
      markUnread: Effect.fn("Channel.markUnread")(function* (channel, number) {
        if (!model.channel(channel)) return yield* Effect.fail(missing(t("server.channel.noChannel", { id: channel }), [lookIn.channel]));
        const upto = Math.max(0, number - 1);
        yield* db.run(qr.markUnread({ channel_id: channel, read_number: upto, updated_at: yield* Clock.currentTimeMillis }));
        model.ownerReadBack(channel, upto);
        yield* publishChannel(channel);
        yield* publishOwnerMentions;
      }, locked),
      makeDefault: Effect.fn("Channel.makeDefault")(function* (id) {
        const row = model.channel(id);
        if (!row) return yield* Effect.fail(missing(t("server.channel.noChannel", { id }), [lookIn.channel]));
        if (row.type !== "channel") return yield* Effect.fail(refused(t("server.channel.defaultIsChannel")));
        const was = model.defaultId();
        if (id === was) return;
        yield* tx(Effect.andThen(db.run(qc.clearDefault()), db.run(qc.makeDefault({ id }))));
        model.defaultMoved(was, id);
        yield* publishChannel(was);
        yield* publishChannel(id);
      }, locked),
      topOf: Effect.fn("Channel.topOf")((channel) =>
        Effect.sync(() => {
          const top = model.topChannel(channel);
          return top ? infoOf(top) : { id: model.defaultId(), name: "general", description: "", repo: "", default: true };
        }),
      ),
      addressOf: Effect.fn("Channel.addressOf")((channel) =>
        Effect.sync(() => {
          const row = model.channel(channel);
          if (row?.type === "direct") return { direct: true, target: targetOfChannel(row) };
          const top = model.topChannel(channel);
          return { direct: false, target: top ? targetOfChannel(top) : "#general" };
        }),
      ),
      channelByName: Effect.fn("Channel.channelByName")((name) =>
        Effect.sync(() => {
          const found = model.channelByName(name.trim().replace(/^#/u, ""));
          return found ? infoOf(found) : undefined;
        }),
      ),
    } satisfies DirectoryMethods;
  });
