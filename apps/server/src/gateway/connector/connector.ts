import { z } from "zod";

import { Queue, type Subscription, TaskGroup } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import { type ConnectorID, type ConnectorLogin, type ConnectorStatus, dayMs } from "@vibevalley/protocol";

import { BizCode, bizError } from "#/base/errors.ts";
import type { Core } from "#/core/core.ts";
import { causeMessage, type Db, SqlError } from "#/infra/db.ts";
import type { Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Channel } from "#/modules/channel/channel.ts";
import type { Watch } from "#/modules/watch/watch.ts";
import * as accountQ from "#db/connector_account.sql.ts";
import * as inboundQ from "#db/connector_inbound.sql.ts";
import * as outboxQ from "#db/connector_outbox.sql.ts";

import { ConnectorBridgeError, makeBridge } from "./bridge.ts";
import { type FeishuApi, FeishuClient, feishuAdapter } from "./feishu.ts";
import { type QQApi, QQClient, qqAdapter } from "./qq.ts";
import { baseUrl, type WeixinApi, WeixinClient, weixinAdapter } from "./weixin.ts";

/** How long a message in or out is kept after it went through, for a reply to point at. */
const keptDays = 30;

export interface Connector {
  readonly list: () => Promise<ConnectorStatus[]>;
  readonly login: (id: ConnectorID, input: ConnectorLogin) => Promise<ConnectorStatus>;
  readonly verify: (id: ConnectorID, code: string) => Promise<ConnectorStatus>;
  readonly logout: (id: ConnectorID) => Promise<ConnectorStatus>;
  readonly setChannel: (id: ConnectorID, name: string) => Promise<ConnectorStatus>;
  /** Every account's work stopped, and waited for. */
  readonly close: () => Promise<void>;
}

export interface ConnectorOptions {
  readonly weixin?: WeixinApi;
  readonly feishu?: FeishuApi;
  readonly qq?: QQApi;
  /** Held messages are tried again after retryFirstMs, then twice as long after each try that fails, up to retryMostMs. */
  readonly retryFirstMs?: number;
  readonly retryMostMs?: number;
}

export interface ConnectorDeps {
  readonly clock: Time;
  readonly db: Db;
  readonly log: Logger;
  readonly fetch: typeof fetch;
  readonly core: Core;
  readonly channel: Channel;
  readonly watch: Watch;
}

/** The database's own failures (a statement refused, a row that does not read) are a bridge's failure: its status says them. */
const asBridgeError = (e: unknown): unknown =>
  e instanceof ConnectorBridgeError ? e : e instanceof SqlError || e instanceof z.ZodError ? new ConnectorBridgeError(causeMessage(e), { cause: e }) : e;

export async function makeConnector(deps: ConnectorDeps, options: ConnectorOptions = {}): Promise<Connector> {
  // The farm's own waits and times (a pause, a retry, when a message went out) on the service's clock.
  const { clock, db, core, watch } = deps;
  const chat = deps.channel;
  const log = deps.log.child("connector");
  chat.guardRemoval(async (id) => (((await accountQ.accountsIn(db.sql, { channel_id: id }))?.n ?? 0) !== 0 ? [t("server.channel.connectorsThere")] : []));
  const retryFirst = options.retryFirstMs ?? 30_000;
  const retryMost = options.retryMostMs ?? 30 * 60_000;
  // The bridges' tasks (each account's generation, the status said to the core) belong to this service.
  const tasks = new TaskGroup({ name: "connector", onError: (task, e) => log.error(`vibevalley: connector: ${task}`, e) });
  const tried = async <A>(work: () => Promise<A>): Promise<A> => {
    try {
      return await work();
    } catch (e) {
      throw asBridgeError(e);
    }
  };
  const inTx = async <A>(work: () => Promise<A>): Promise<A> => {
    try {
      return await db.tx(work);
    } catch (e) {
      throw asBridgeError(e);
    }
  };
  let closing = false;
  const env = { clock, sql: db.sql, log, chat, core, watch, retryFirst, retryMost, tasks, tried, inTx, isClosing: () => closing };

  const adapters = [
    weixinAdapter(options.weixin ?? new WeixinClient(deps.fetch, baseUrl, clock, log)),
    feishuAdapter(options.feishu ?? new FeishuClient(deps.fetch, clock)),
    qqAdapter(options.qq ?? new QQClient(deps.fetch, undefined, undefined, clock)),
  ];
  // Each queue is a wake: holding one at most, so wakes while it works are one more look, never lost.
  const bridges = adapters.map((a) =>
    makeBridge(env, a, { outbox: new Queue<void>({ overflow: "sliding", capacity: 1 }), inbox: new Queue<void>({ overflow: "sliding", capacity: 1 }) }),
  );
  for (const b of bridges) await b.load();
  const each = <A>(name: string, sub: Subscription<A>, f: (a: A) => Promise<unknown> | void) =>
    tasks.run(name, async (signal) => {
      try {
        for (;;) {
          const next = await sub.next(signal);
          if (next.done === true) return;
          await f(next.value);
        }
      } finally {
        sub.close();
      }
    });
  each("inbox changes", watch.externalChanges(), () => {
    for (const bridge of bridges) bridge.changed();
  });
  const bridge = (id: ConnectorID) => bridges.find((b) => b.id === id);

  // What the user hears off the farm (the inbox says what) goes out on every app the user has, each checking it is
  // its user's channel.
  each("to the user", watch.toUser(), (m) => Promise.all(bridges.map((b) => b.offer(m))));
  for (const b of bridges) if (b.hasAccount()) tasks.run(`${b.id} resume`, () => b.resume());
  // What came in and went out is kept for a while for replies to point at, then dropped, once at start and daily.
  tasks.run("prune", async (signal) => {
    for (;;) {
      const before = clock.now() - keptDays * dayMs;
      try {
        await tried(() => inboundQ.pruneInbound(db.sql, { before }));
        await tried(() => outboxQ.pruneOutbox(db.sql, { before }));
      } catch (e) {
        if (!(e instanceof ConnectorBridgeError)) throw e;
        log.warn("vibevalley: connector history was not pruned", e.message);
      }
      await clock.sleep(dayMs, signal);
    }
  });

  const off = (id: ConnectorID): ConnectorStatus => ({ id, state: "off", pending: 0, error: "", qr: "", pairCode: "" });
  return {
    list: () => Promise.all(bridges.map((b) => b.status())),
    login: async (id, input) => {
      const b = bridge(id);
      return b ? b.login(input) : off(id);
    },
    verify: async (id, code) => {
      const b = bridge(id);
      return b ? b.verify(code) : off(id);
    },
    logout: async (id) => {
      const b = bridge(id);
      return b ? b.logout() : off(id);
    },
    setChannel: async (id, name) => {
      const b = bridge(id);
      if (!b) throw bizError(BizCode.ConnectorRefused, t("server.connector.noConnector", { id }));
      const channel = await chat.channelByName(name);
      if (!channel) throw bizError(BizCode.ConnectorRefused, t("server.connector.noChannel", { name }));
      try {
        return await b.setChannel(channel.id !== chat.defaultChannel() ? channel.id : undefined);
      } catch (e) {
        if (e instanceof ConnectorBridgeError) throw bizError(BizCode.ConnectorRefused, e.message);
        throw e;
      }
    },
    close: async () => {
      closing = true;
      await Promise.all(bridges.map((b) => b.stop()));
      await tasks.close();
    },
  };
}
