import { Array as Arr, Clock, Effect, Option, String as Str } from "effect";

import { list, t } from "@vibevalley/i18n";

import { head } from "#/base/clip.ts";
import { BizCode, lookIn, missing, refuseIn } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import { Core } from "#/core/core.ts";
import { Db } from "#/infra/db.ts";
import { Agent } from "#/modules/agent/agent.ts";
import * as qc from "#db/channel.sql.ts";

import { type ChannelService, infoOf, notifyOf, optional } from "./contracts.ts";
import { type ChannelHub, profileId, threadTitleMax } from "./hub.ts";
import { channelNameProblem } from "./mentions.ts";

const refused = refuseIn(BizCode.ChannelRefused);

type DirectoryMethods = Pick<
  ChannelService,
  | "channels"
  | "openChannel"
  | "updateChannel"
  | "archive"
  | "previewRemoveChannel"
  | "removeChannel"
  | "setNotify"
  | "orchestratorIn"
  | "direct"
  | "notifyOf"
  | "markUnread"
  | "makeDefault"
  | "topOf"
  | "addressOf"
  | "channelByName"
>;

export const channelDirectory = (r: ChannelHub) =>
  Effect.gen(function* () {
    const core = yield* Core;
    const agents = yield* Agent;
    const db = yield* Db;
    const { store, orchestratorInRow, channelOfSession, hired, targetOfChannel, publishChannel, publishUserMentions } = r;

    /** A channel nothing points at any more; refused with what still does. */
    const removable = Effect.fnUntraced(function* (id: string) {
      const row = store.channel(id);
      if (!row || row.type !== "channel") return yield* missing(t("server.channel.noChannel", { id }), [lookIn.channel]);
      if (row.is_default) return yield* refused(t("server.channel.defaultStays"));
      if (hired().some((h) => channelOfSession(h) === id)) return yield* refused(t("server.channel.inUse", { why: t("server.channel.helpersThere") }));
      const used = yield* db.run(qc.channelInUse({ id }));
      const why = [
        used.crons != null && used.crons !== 0 ? t("server.channel.cronsThere", { n: used.crons }) : "",
        used.connectors != null && used.connectors !== 0 ? t("server.channel.connectorsThere") : "",
        used.queued != null && used.queued !== 0 ? t("server.channel.queuedThere", { n: used.queued }) : "",
        used.issue_threads != null && used.issue_threads !== 0 ? t("server.channel.issuesThere", { n: used.issue_threads }) : "",
      ].filter(Boolean);
      if (why.length > 0) return yield* refused(t("server.channel.inUse", { why: list(why) }));
      const threads = store.threadsOf(id);
      const said = (row.last_number ?? 0) + threads.reduce((n, thread) => n + thread.reply_count, 0);
      return { target: targetOfChannel(row), threads: threads.length, said };
    });

    const openDirect = Effect.fn("Channel.openDirect")(function* (agent: { readonly id: string; readonly name: string }) {
      const mine = agents.isOrchestrator(agent.id);
      const peer = mine ? agent.id : profileId(agent.id);
      if (mine) yield* store.seat(agent.id);
      else {
        yield* store.upsertParticipant({
          id: peer,
          kind: "agent",
          role: "worker",
          name: agent.name,
          agent_id: agent.id,
          runtime: null,
          joined_at: yield* Clock.currentTimeMillis,
        });
      }
      const { id, created } = yield* store.openDirectRow(peer);
      if (created) yield* publishChannel(id);
      return id;
    }, store.locked);

    return {
      channels: Effect.fn("Channel.channels")(() => Effect.sync(() => store.channels().map(infoOf))),
      openChannel: Effect.fn("Channel.openChannel")(function* (name, description, repo) {
        const clean = name.trim().replace(/^#/u, "");
        const rows = store.channels();
        const problem = channelNameProblem(
          clean,
          rows.flatMap((row) => (row.name !== null ? [row.name] : [])),
        );
        if (problem) return yield* refused(problem);
        const desc = optional(description);
        const proj = optional(repo);
        const id = newId();
        const created_at = yield* Clock.currentTimeMillis;
        yield* store.createChannel({ id, name: clean, description: desc, repo: proj, created_at });
        yield* publishChannel(id);
        return infoOf({ id, name: clean, description: desc, repo: proj, is_default: false });
      }, store.locked),
      updateChannel: Effect.fn("Channel.updateChannel")(function* (id, upd) {
        const row = store.channel(id);
        if (!row || row.type === "direct") return yield* missing(t("server.channel.noChannel", { id }), [lookIn.channel]);
        const onlyName =
          upd.description === undefined && upd.repo === undefined && upd.category === undefined && upd.before === undefined && upd.members === undefined;
        if (row.type === "thread" && !onlyName) return yield* refused(t("server.channel.threadOnlyTitle"));
        let name = row.name;
        if (upd.name !== undefined) {
          const clean = upd.name.trim().replace(/^#/u, "");
          if (row.type === "thread") name = clean ? head(clean, threadTitleMax * 2) : null;
          else {
            const problem = channelNameProblem(
              clean,
              store.channels().flatMap((c) => (c.name !== null && c.id !== id ? [c.name] : [])),
            );
            if (problem) return yield* refused(problem);
            name = clean;
          }
        }
        const desc = (upd.description !== undefined ? optional(upd.description) : null) ?? row.description;
        const proj = upd.repo !== undefined ? optional(upd.repo) : row.repo;
        const category = upd.category !== undefined ? optional(upd.category) : row.category;
        // Only an orchestrator is put in a channel: a helper is hired into a place, not seated in one.
        const wanted = upd.members === undefined ? undefined : Arr.dedupe(Arr.filter(Arr.map(upd.members, Str.trim), Str.isNonEmpty));
        const notOne = wanted === undefined ? Option.none() : Arr.findFirst(wanted, (m) => !agents.isOrchestrator(m));
        if (Option.isSome(notOne)) return yield* refused(t("server.channel.notOrchestrator", { id: notOne.value }));
        const had = store.membersOf(id);
        const joining = wanted === undefined ? [] : Arr.difference(wanted, had);
        const leaving = wanted === undefined ? [] : Arr.filter(had, (m) => agents.isOrchestrator(m) && !Arr.contains(wanted, m));
        // Placed before another channel: every channel but the default gets its place again, in order.
        const order =
          upd.before === undefined
            ? undefined
            : (() => {
                const rest = store
                  .channels()
                  .filter((c) => !c.is_default && c.id !== id)
                  .map((c) => c.id);
                const at = rest.indexOf(upd.before);
                rest.splice(at < 0 ? rest.length : at, 0, id);
                return rest;
              })();
        yield* store.updateChannelRow({ row, name, description: desc, repo: proj, category, joining, leaving, order });
        yield* Effect.forEach(order ?? [id], (each) => publishChannel(each), { discard: true });
        // Its threads are in the same channel: they show who is in it now too.
        if (joining.length > 0 || leaving.length > 0) yield* Effect.forEach(store.threadsOf(id), (item) => publishChannel(item.id), { discard: true });
      }, store.locked),
      archive: Effect.fn("Channel.archive")(function* (id, on) {
        const row = store.channel(id);
        if (!row || row.type === "direct") return yield* missing(t("server.channel.noChannel", { id }), [lookIn.channel]);
        if ((row.archived_at !== null) === on) return;
        if (row.is_default) return yield* refused(t("server.channel.defaultStays"));
        const archived_at = on ? yield* Clock.currentTimeMillis : null;
        yield* store.setArchived(id, archived_at);
        yield* publishChannel(id);
      }, store.locked),
      previewRemoveChannel: Effect.fn("Channel.previewRemoveChannel")(function* (id) {
        const rem = yield* removable(id);
        return { does: [t("server.channel.deletesChannel", { target: rem.target, threads: rem.threads, said: rem.said })] };
      }),
      removeChannel: Effect.fn("Channel.removeChannel")(function* (id) {
        yield* removable(id);
        const gone = new Set([store.channel(id), ...store.threadsOf(id)].flatMap((c) => (c ? [targetOfChannel(c)] : [])));
        yield* store.deleteChannel(id, gone);
        yield* core.apply({ type: "channelRemoved", id });
      }, store.locked),
      setNotify: Effect.fn("Channel.setNotify")(function* (id, notify) {
        if (!store.channel(id)) return yield* missing(t("server.channel.noChannel", { id }), [lookIn.channel]);
        yield* store.setNotify(id, notify);
        yield* publishChannel(id);
        yield* publishUserMentions;
      }, store.locked),
      orchestratorIn: (channel) => orchestratorInRow(store.channel(channel)),
      direct: Effect.fn("Channel.direct")(function* (ref) {
        const name = ref.trim();
        const agent = agents.named(name) ?? agents.agent(name) ?? agents.orchestrators().find((o) => o.name === name);
        if (!agent) return yield* missing(t("server.channel.noProfileNamed", { key: ref }), [lookIn.agent]);
        return yield* openDirect(agent);
      }),
      notifyOf: (id) => {
        const c = store.channel(id);
        const top = c?.parent_id ? store.channel(c.parent_id) : undefined;
        if (c?.notify === "none" || top?.notify === "none") return "none";
        return notifyOf(c?.notify !== "all" ? (c?.notify ?? "all") : (top?.notify ?? "all"));
      },
      markUnread: Effect.fn("Channel.markUnread")(function* (channel, number) {
        if (!store.channel(channel)) return yield* missing(t("server.channel.noChannel", { id: channel }), [lookIn.channel]);
        const upto = Math.max(0, number - 1);
        const now = yield* Clock.currentTimeMillis;
        yield* store.markUnread(channel, upto, now);
        yield* publishChannel(channel);
        yield* publishUserMentions;
      }, store.locked),
      makeDefault: Effect.fn("Channel.makeDefault")(function* (id) {
        const row = store.channel(id);
        if (!row) return yield* missing(t("server.channel.noChannel", { id }), [lookIn.channel]);
        if (row.type !== "channel") return yield* refused(t("server.channel.defaultIsChannel"));
        const was = store.defaultId();
        if (id === was) return;
        yield* store.makeDefault(was, id);
        yield* publishChannel(was);
        yield* publishChannel(id);
      }, store.locked),
      topOf: Effect.fn("Channel.topOf")((channel) =>
        Effect.sync(() => {
          const top = store.topChannel(channel);
          return top ? infoOf(top) : { id: store.defaultId(), name: "general", description: "", repo: "", default: true };
        }),
      ),
      addressOf: Effect.fn("Channel.addressOf")((channel) =>
        Effect.sync(() => {
          const row = store.channel(channel);
          if (row?.type === "direct") return { direct: true, target: targetOfChannel(row) };
          const top = store.topChannel(channel);
          return { direct: false, target: top ? targetOfChannel(top) : "#general" };
        }),
      ),
      channelByName: Effect.fn("Channel.channelByName")((name) =>
        Effect.sync(() => {
          const found = store.channelByName(name.trim().replace(/^#/u, ""));
          return found ? infoOf(found) : undefined;
        }),
      ),
    } satisfies DirectoryMethods;
  });
