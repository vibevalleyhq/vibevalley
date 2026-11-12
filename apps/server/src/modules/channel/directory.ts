import { list, t } from "@vibevalley/i18n";

import { head } from "#/base/clip.ts";
import { BizCode, lookIn, missing, refuseIn } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import type { Core } from "#/core/core.ts";
import type { Db } from "#/infra/db.ts";
import type { Time } from "#/infra/time.ts";
import type { Agent } from "#/modules/agent/agent.ts";
import * as qc from "#db/channel.sql.ts";

import { type ChannelService, infoOf, notifyOf, optional, theRow } from "./contracts.ts";
import { type ChannelHub, profileId, threadTitleMax } from "./hub.ts";
import { channelNameProblem } from "./mentions.ts";

const refused = refuseIn(BizCode.ChannelRefused);

type DirectoryMethods = Pick<
  ChannelService,
  | "guardRemoval"
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

export interface ChannelDirectoryDeps {
  readonly clock: Time;
  readonly db: Db;
  readonly core: Core;
  readonly agent: Agent;
}

export function channelDirectory(deps: ChannelDirectoryDeps, r: ChannelHub): DirectoryMethods {
  const { core, agent: agents, db, clock } = deps;
  const { store, orchestratorInRow, targetOfChannel, publishChannel, publishUserMentions } = r;
  const guards: ((channel: string) => Promise<readonly string[]>)[] = [];

  /** A channel nothing points at any more; refused with what still does. */
  const removable = async (id: string) => {
    const row = store.channel(id);
    if (!row || row.type !== "channel") throw missing(t("server.channel.noChannel", { id }), [lookIn.channel]);
    if (row.is_default) throw refused(t("server.channel.defaultStays"));
    const topics = theRow(await qc.topicThreadsIn(db.sql, { id }), "TopicThreadsIn").n ?? 0;
    const why = [...(await Promise.all(guards.map((guard) => guard(id)))).flat(), ...(topics !== 0 ? [t("server.channel.issuesThere", { n: topics })] : [])];
    if (why.length > 0) throw refused(t("server.channel.inUse", { why: list(why) }));
    const threads = store.threadsOf(id);
    const said = (row.last_number ?? 0) + threads.reduce((n, thread) => n + thread.reply_count, 0);
    return { target: targetOfChannel(row), threads: threads.length, said };
  };

  const openDirect = (agent: { readonly id: string; readonly name: string }) =>
    store.locked(async () => {
      const mine = agents.isOrchestrator(agent.id);
      const peer = mine ? agent.id : profileId(agent.id);
      if (mine) await store.seat(agent.id);
      else {
        await store.upsertParticipant({
          id: peer,
          kind: "agent",
          role: "worker",
          name: agent.name,
          agent_id: agent.id,
          runtime: null,
          home_id: null,
          joined_at: clock.now(),
        });
      }
      const { id, created } = await store.openDirectRow(peer);
      if (created) await publishChannel(id);
      return id;
    });

  return {
    guardRemoval: (guard) => {
      guards.push(guard);
    },
    channels: async () => store.channels().map(infoOf),
    openChannel: (name, description, repo) =>
      store.locked(async () => {
        const clean = name.trim().replace(/^#/u, "");
        const rows = store.channels();
        const problem = channelNameProblem(
          clean,
          rows.flatMap((row) => (row.name !== null ? [row.name] : [])),
        );
        if (problem) throw refused(problem);
        const desc = optional(description);
        const proj = optional(repo);
        const id = newId();
        const created_at = clock.now();
        await store.createChannel({ id, name: clean, description: desc, repo: proj, created_at });
        await publishChannel(id);
        return infoOf({ id, name: clean, description: desc, repo: proj, is_default: false });
      }),
    updateChannel: (id, upd) =>
      store.locked(async () => {
        const row = store.channel(id);
        if (!row || row.type === "direct") throw missing(t("server.channel.noChannel", { id }), [lookIn.channel]);
        const onlyName =
          upd.description === undefined && upd.repo === undefined && upd.category === undefined && upd.before === undefined && upd.members === undefined;
        if (row.type === "thread" && !onlyName) throw refused(t("server.channel.threadOnlyTitle"));
        let name = row.name;
        if (upd.name !== undefined) {
          const clean = upd.name.trim().replace(/^#/u, "");
          if (row.type === "thread") name = clean ? head(clean, threadTitleMax * 2) : null;
          else {
            const problem = channelNameProblem(
              clean,
              store.channels().flatMap((c) => (c.name !== null && c.id !== id ? [c.name] : [])),
            );
            if (problem) throw refused(problem);
            name = clean;
          }
        }
        const desc = (upd.description !== undefined ? optional(upd.description) : null) ?? row.description;
        const proj = upd.repo !== undefined ? optional(upd.repo) : row.repo;
        const category = upd.category !== undefined ? optional(upd.category) : row.category;
        // Only an orchestrator is put in a channel: a helper is hired into a place, not seated in one.
        const wanted = upd.members === undefined ? undefined : [...new Set(upd.members.map((m) => m.trim()).filter((m) => m !== ""))];
        const notOne = wanted?.find((m) => !agents.isOrchestrator(m));
        if (notOne !== undefined) throw refused(t("server.channel.notOrchestrator", { id: notOne }));
        const had = store.membersOf(id);
        const joining = wanted === undefined ? [] : wanted.filter((m) => !had.includes(m));
        const leaving = wanted === undefined ? [] : had.filter((m) => agents.isOrchestrator(m) && !wanted.includes(m));
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
        await store.updateChannelRow({ row, name, description: desc, repo: proj, category, joining, leaving, order });
        for (const each of order ?? [id]) await publishChannel(each);
        // Its threads are in the same channel: they show who is in it now too.
        if (joining.length > 0 || leaving.length > 0) for (const item of store.threadsOf(id)) await publishChannel(item.id);
      }),
    archive: (id, on) =>
      store.locked(async () => {
        const row = store.channel(id);
        if (!row || row.type === "direct") throw missing(t("server.channel.noChannel", { id }), [lookIn.channel]);
        if ((row.archived_at !== null) === on) return;
        if (row.is_default) throw refused(t("server.channel.defaultStays"));
        const archived_at = on ? clock.now() : null;
        await store.setArchived(id, archived_at);
        await publishChannel(id);
      }),
    previewRemoveChannel: async (id) => {
      const rem = await removable(id);
      return { does: [t("server.channel.deletesChannel", { target: rem.target, threads: rem.threads, said: rem.said })] };
    },
    removeChannel: (id) =>
      store.locked(async () => {
        await removable(id);
        const gone = new Set([store.channel(id), ...store.threadsOf(id)].flatMap((c) => (c ? [targetOfChannel(c)] : [])));
        await store.deleteChannel(id, gone);
        core.apply({ type: "channelRemoved", id });
      }),
    setNotify: (id, notify) =>
      store.locked(async () => {
        if (!store.channel(id)) throw missing(t("server.channel.noChannel", { id }), [lookIn.channel]);
        await store.setNotify(id, notify);
        await publishChannel(id);
        await publishUserMentions();
      }),
    orchestratorIn: (channel) => orchestratorInRow(store.channel(channel)),
    direct: async (ref) => {
      const name = ref.trim();
      const agent = agents.named(name) ?? agents.agent(name) ?? agents.orchestrators().find((o) => o.name === name);
      if (!agent) throw missing(t("server.channel.noProfileNamed", { key: ref }), [lookIn.agent]);
      return openDirect(agent);
    },
    notifyOf: (id) => {
      const c = store.channel(id);
      const top = c?.parent_id ? store.channel(c.parent_id) : undefined;
      if (c?.notify === "none" || top?.notify === "none") return "none";
      return notifyOf(c?.notify !== "all" ? (c?.notify ?? "all") : (top?.notify ?? "all"));
    },
    markUnread: (channel, number) =>
      store.locked(async () => {
        if (!store.channel(channel)) throw missing(t("server.channel.noChannel", { id: channel }), [lookIn.channel]);
        const upto = Math.max(0, number - 1);
        const now = clock.now();
        await store.markUnread(channel, upto, now);
        await publishChannel(channel);
        await publishUserMentions();
      }),
    makeDefault: (id) =>
      store.locked(async () => {
        const row = store.channel(id);
        if (!row) throw missing(t("server.channel.noChannel", { id }), [lookIn.channel]);
        if (row.type !== "channel") throw refused(t("server.channel.defaultIsChannel"));
        const was = store.defaultId();
        if (id === was) return;
        await store.makeDefault(was, id);
        await publishChannel(was);
        await publishChannel(id);
      }),
    topOf: async (channel) => {
      const top = store.topChannel(channel);
      return top ? infoOf(top) : { id: store.defaultId(), name: "general", description: "", repo: "", default: true };
    },
    addressOf: async (channel) => {
      const row = store.channel(channel);
      if (row?.type === "direct") return { direct: true, target: targetOfChannel(row) };
      const top = store.topChannel(channel);
      return { direct: false, target: top ? targetOfChannel(top) : "#general" };
    },
    channelByName: async (name) => {
      const found = store.channelByName(name.trim().replace(/^#/u, ""));
      return found ? infoOf(found) : undefined;
    },
  };
}
