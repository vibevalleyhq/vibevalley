import { Clock, Context, Duration, Effect, FiberSet, Layer, Queue, Schedule, Stream } from "effect";
import { HttpClient } from "effect/http";
import type { SqlClient } from "effect/sql";

import { t } from "@vibevalley/i18n";
import { type ConnectorID, type ConnectorLogin, type ConnectorStatus, dayMs } from "@vibevalley/protocol";
import { type ApiError } from "@vibevalley/protocol/api";

import { Channel } from "#/channel/channel.ts";
import { Core } from "#/core/core.ts";
import { Inbox } from "#/inbox/inbox.ts";
import { Db } from "#/infra/db.ts";
import { Ingress } from "#/ingress/ingress.ts";
import * as inboundQ from "#db/connector_inbound.sql.ts";
import * as outboxQ from "#db/connector_outbox.sql.ts";

import { bridgeError, makeBridge, type SqlFailure } from "./bridge.ts";
import { type FeishuApi, FeishuClient, feishuAdapter } from "./feishu.ts";
import { type QQApi, QQClient, qqAdapter } from "./qq.ts";
import { type WeixinApi, WeixinClient, weixinAdapter } from "./weixin.ts";

/** How long a message in or out is kept after it went through, for a reply to point at. */
const keptDays = 30;

export class Connector extends Context.Service<
  Connector,
  {
    readonly list: () => Effect.Effect<ConnectorStatus[]>;
    readonly login: (id: ConnectorID, input: ConnectorLogin) => Effect.Effect<ConnectorStatus>;
    readonly verify: (id: ConnectorID, code: string) => Effect.Effect<ConnectorStatus>;
    readonly logout: (id: ConnectorID) => Effect.Effect<ConnectorStatus>;
    readonly setChannel: (id: ConnectorID, name: string) => Effect.Effect<ConnectorStatus, ApiError>;
  }
>()("@vibevalley/server/connector/connector") {
  static readonly layer = (options?: ConnectorOptions) => Layer.effect(Connector, make(options));
}

export interface ConnectorOptions {
  readonly weixin?: WeixinApi;
  readonly feishu?: FeishuApi;
  readonly qq?: QQApi;
  /** Held messages are tried again after retryFirstMs, then twice as long after each try that fails, up to retryMostMs. */
  readonly retryFirstMs?: number;
  readonly retryMostMs?: number;
}

const make = (options: ConnectorOptions = {}) =>
  Effect.gen(function* () {
    // The farm's own waits and times (a pause, a retry, when a message went out) on the service's Clock.
    const clock = yield* Clock.Clock;
    const now = () => clock.currentTimeMillisUnsafe();
    const db = yield* Db;
    const chat = yield* Channel;
    const ingress = yield* Ingress;
    const core = yield* Core;
    const inbox = yield* Inbox;
    const retryFirst = options.retryFirstMs ?? 30_000;
    const retryMost = options.retryMostMs ?? 30 * 60_000;
    // The bridges' fibers (each account's generation, the status said to the core) belong to this service.
    const forkHere = yield* FiberSet.makeRuntime();
    /** The database's own failures stay failures here: the status says them. */
    const tried = <A>(e: Effect.Effect<A, SqlFailure, SqlClient.SqlClient>) => Effect.mapError(db.attempt(e), bridgeError);
    const inTx = <A>(work: Effect.Effect<A, SqlFailure, SqlClient.SqlClient>) => Effect.mapError(db.attemptTx(work), bridgeError);
    let closing = false;
    const env = { now, chat, ingress, core, inbox, retryFirst, retryMost, forkHere, tried, inTx, isClosing: () => closing };

    const http = yield* HttpClient.HttpClient;
    const adapters = [
      weixinAdapter(options.weixin ?? new WeixinClient(http)),
      feishuAdapter(options.feishu ?? new FeishuClient(http)),
      qqAdapter(options.qq ?? new QQClient(http)),
    ];
    // Each queue is a wake: holding one at most, so wakes while it works are one more look, never lost.
    const bridges = yield* Effect.forEach(adapters, (a) =>
      Effect.map(Effect.all({ outbox: Queue.sliding<void>(1), inbox: Queue.sliding<void>(1) }), (mail) => makeBridge(env, a, mail)),
    );
    yield* Effect.forEach(bridges, (b) => b.load, { discard: true });
    const externalChanges2 = yield* inbox.externalChanges;
    yield* Effect.forkScoped(
      Stream.runForEach(externalChanges2, () =>
        Effect.sync(() => {
          for (const bridge of bridges) bridge.changed();
        }),
      ),
    );
    const bridge = (id: ConnectorID) => bridges.find((b) => b.id === id);

    const toOwner2 = yield* inbox.toOwner;
    // What the owner hears off the farm (the inbox says what) goes out on every app the owner has, each checking it is
    // its owner's channel.
    yield* Effect.forkScoped(Stream.runForEach(toOwner2, (m) => Effect.forEach(bridges, (b) => b.offer(m), { concurrency: "unbounded", discard: true })));
    for (const b of bridges) if (b.hasAccount()) forkHere(b.resume);
    // What came in and went out is kept for a while for replies to point at, then dropped, once at start and daily.
    const prune = Effect.gen(function* () {
      const before = (yield* Clock.currentTimeMillis) - keptDays * dayMs;
      yield* tried(inboundQ.pruneInbound({ before }));
      yield* tried(outboxQ.pruneOutbox({ before }));
    }).pipe(Effect.catch((e) => Effect.logWarning("vibevalley: connector history was not pruned", e)));
    yield* Effect.forkScoped(Effect.repeat(prune, Schedule.spaced(Duration.days(1))));
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        closing = true;
        return Effect.forEach(bridges, (b) => b.stop, { concurrency: "unbounded", discard: true });
      }),
    );

    const off = (id: ConnectorID): ConnectorStatus => ({ id, state: "off", pending: 0, error: "", qr: "", pairCode: "" });
    return Connector.of({
      list: Effect.fn("Connector.list")(function* () {
        return yield* Effect.forEach(bridges, (b) => b.status);
      }),
      login: Effect.fn("Connector.login")(function* (id, input) {
        const b = bridge(id);
        return b ? yield* b.login(input) : off(id);
      }),
      verify: Effect.fn("Connector.verify")(function* (id, code) {
        const b = bridge(id);
        return b ? yield* b.verify(code) : off(id);
      }),
      logout: Effect.fn("Connector.logout")(function* (id) {
        const b = bridge(id);
        return b ? yield* b.logout : off(id);
      }),
      setChannel: Effect.fn("Connector.setChannel")(function* (id, name) {
        const b = bridge(id);
        if (!b)
          return yield* Effect.fail<ApiError>({
            _tag: "ConnectorRefused",
            reason: t("server.connector.noConnector", { id }),
          });
        const channel = yield* chat.channelByName(name);
        if (!channel)
          return yield* Effect.fail<ApiError>({
            _tag: "ConnectorRefused",
            reason: t("server.connector.noChannel", { name }),
          });
        return yield* Effect.mapError(b.setChannel(channel.id !== chat.defaultChannel() ? channel.id : undefined), (e): ApiError => ({
          _tag: "ConnectorRefused",
          reason: e.message,
        }));
      }),
    });
  });
