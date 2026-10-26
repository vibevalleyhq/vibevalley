// The chat apps: WeChat, Feishu and QQ, each tied to one farm channel; each app's protocol is
// its adapter's. Only outbound connections: no public HTTP endpoint. The bots' secrets never leave the database.
//
// Each app's account has one generation of work at a time (receiving, the inbox, the outbox); a login or logout cancels
// and waits for the generation before it replaces the account. What an app hands over is accepted into connector_inbound
// (a durable acceptance, with the page's cursor) and delivered to the orchestrator from there; a delivery the orchestrator took but
// whose mark was not written yet may come again after a restart. Some apps let a bot answer only on the context of the
// owner's latest message, and only so many times: what an app will not take waits in connector_outbox and goes when the
// owner next says something, several as one digest.

import { randomInt } from "node:crypto";
import type { ChatMessage, ConnectorID, ConnectorLogin, ConnectorState, ConnectorStatus } from "@vibevalley/protocol";
import { type ApiError } from "@vibevalley/protocol/api";
import { conversationOf, generalOf } from "../channel/state.ts";
import { Cause, Clock, Context, Data, Deferred, Effect, Fiber, FiberSet, Layer, Option, Predicate, Schema, Semaphore, Stream } from "effect";
import { SqlClient } from "effect/sql";
import * as accountQ from "../../db/generated/connector_account.sql.ts";
import * as inboundQ from "../../db/generated/connector_inbound.sql.ts";
import * as outboxQ from "../../db/generated/connector_outbox.sql.ts";
import { newId } from "../base/ids.ts";
import { causeMessage, Db } from "../base/db.ts";
import { reasonOf } from "../errors.ts";
import { Channels } from "../channel/chat.ts";
import { Core } from "../core/core.ts";
import { Orchestrator } from "../orchestrator/orchestrator.ts";
import { type FeishuApi, FeishuClient, text as feishuText } from "./feishu.ts";
import { type QQApi, QQClient, SendError } from "./qq.ts";
import { digestOver, flushText, isPairing, maxChars, ownerLine, shortId, splitText } from "./text.ts";
import {
  baseUrl,
  decodeUpdates,
  failed as weixinFailed,
  quoted,
  restricted,
  staleToken,
  text as weixinText,
  type WeixinApi,
  WeixinClient,
  WeixinError,
} from "./weixin.ts";
import { Notices } from "../notice/notice.ts";

/** WeChat's official client rests this long too. */
const stalePauseMs = 60 * 60_000;
const weixinPollMs = 35_000;

export interface Inbound {
  /** Each is taken once. */
  readonly id: string;
  readonly from: string;
  readonly text: string;
  /** WeChat's context token, QQ's message id. */
  readonly reply?: string;
  readonly quoted?: string;
}

const InboundSchema: Schema.Codec<Inbound> = Schema.Struct({
  id: Schema.String,
  from: Schema.String,
  text: Schema.String,
  reply: Schema.optionalKey(Schema.String),
  quoted: Schema.optionalKey(Schema.String),
});

export interface Failure {
  readonly kind: "restricted" | "stale" | "failed";
  readonly reason: string;
}

interface Linked {
  readonly secrets: Record<string, string>;
  readonly owner: string;
}

interface Progress {
  readonly state: ConnectorState;
  readonly qr?: string;
}

interface Receiving {
  readonly cursor: string;
  readonly accept: (messages: readonly Inbound[], cursor: string) => Promise<void>;
}

export interface Adapter {
  readonly id: ConnectorID;
  login(signal: AbortSignal, input: ConnectorLogin, progress: (p: Progress) => void, verifyCode: () => string): Promise<Linked>;
  /** Until it fails (a failure) or signal aborts (undefined). */
  receive(signal: AbortSignal, secrets: Record<string, string>, io: Receiving): Promise<Failure | undefined>;
  send(signal: AbortSignal, secrets: Record<string, string>, to: string, text: string, reply: string): Promise<string | Failure>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function weixinAdapter(api: WeixinApi): Adapter {
  const accountOf = (s: Record<string, string>) => ({
    baseUrl: s.baseUrl || baseUrl,
    token: s.token ?? "",
  });
  return {
    id: "weixin",
    login: async (signal, _input, progress, verifyCode) => {
      const linked = await api.login(signal, (state, url) => progress({ state, qr: url }), verifyCode);
      return {
        secrets: {
          token: linked.account.token,
          botId: linked.botId,
          baseUrl: linked.account.baseUrl,
        },
        owner: linked.owner,
      };
    },
    receive: async (signal, secrets, io) => {
      const account = accountOf(secrets);
      let buf = io.cursor;
      let timeout = weixinPollMs;
      while (!signal.aborted) {
        let updates;
        try {
          updates = decodeUpdates(await api.getUpdates(signal, account, buf, timeout));
        } catch (e) {
          return signal.aborted ? undefined : { kind: "failed", reason: message(e) };
        }
        if (signal.aborted) return undefined;
        const code = weixinFailed(updates.ret, updates.errcode);
        if (code !== undefined) {
          if (code === staleToken) return { kind: "stale", reason: "微信说登录过期了" };
          return { kind: "failed", reason: "getupdates: " + (updates.errmsg || String(code)) };
        }
        if (updates.longpolling_timeout_ms && updates.longpolling_timeout_ms > 0) timeout = updates.longpolling_timeout_ms;
        // Its own messages echo back; groups are not for the farm.
        const messages = (updates.msgs ?? [])
          .filter((m) => m.message_type !== 2 && !m.group_id && m.from_user_id)
          .map((m) => ({
            id: m.message_id ?? "",
            from: m.from_user_id!,
            text: weixinText(m),
            reply: m.context_token ?? "",
            quoted: quoted(m),
          }));
        try {
          await io.accept(messages, updates.get_updates_buf ?? "");
        } catch (e) {
          return { kind: "failed", reason: message(e) };
        }
        if (updates.get_updates_buf) buf = updates.get_updates_buf;
      }
      return undefined;
    },
    send: async (signal, secrets, to, text, reply) => {
      try {
        return await api.sendText(signal, accountOf(secrets), to, text, reply);
      } catch (e) {
        const code = e instanceof WeixinError ? e.code : 0;
        return {
          kind: code === staleToken ? "stale" : code === restricted ? "restricted" : "failed",
          reason: message(e),
        };
      }
    },
  };
}

export function feishuAdapter(api: FeishuApi): Adapter {
  const appOf = (s: Record<string, string>) => ({
    appId: s.appId ?? "",
    appSecret: s.appSecret ?? "",
    domain: s.domain === "lark" ? ("lark" as const) : ("feishu" as const),
  });
  return {
    id: "feishu",
    login: async (signal, _input, progress) => {
      const linked = await api.login(signal, (url) => progress({ state: "waiting", qr: url }));
      return {
        secrets: {
          appId: linked.app.appId,
          appSecret: linked.app.appSecret,
          domain: linked.app.domain,
        },
        owner: linked.owner,
      };
    },
    // Returning to the SDK acknowledges only a durable inbox write; the orchestrator's work runs elsewhere.
    receive: async (signal, secrets, io) => {
      try {
        await api.listen(signal, appOf(secrets), (m) =>
          m.chatType === "p2p" ? io.accept([{ id: m.messageId, from: m.from, text: feishuText(m), quoted: m.parentId }], "") : Promise.resolve(),
        );
        return undefined;
      } catch (e) {
        return signal.aborted ? undefined : { kind: "failed", reason: message(e) };
      }
    },
    send: async (signal, secrets, to, text) => {
      try {
        return await api.sendText(signal, appOf(secrets), to, text);
      } catch (e) {
        return { kind: "failed", reason: message(e) };
      }
    },
  };
}

export function qqAdapter(api: QQApi): Adapter {
  const appOf = (s: Record<string, string>) => ({ appId: s.appId ?? "", secret: s.secret ?? "" });
  return {
    id: "qq",
    login: async (signal, input) => {
      const appId = (input.appId ?? "").trim();
      const secret = (input.secret ?? "").trim();
      if (!appId || !secret) throw new Error("要填 QQ 机器人的 AppID 和 AppSecret（在 q.qq.com 的机器人管理页里）。");
      await api.check(signal, { appId, secret });
      return { secrets: { appId, secret }, owner: "" };
    },
    receive: async (signal, secrets, io) => {
      try {
        await api.listen(signal, appOf(secrets), (m) => {
          const parts = [m.content.trim(), m.attachments > 0 ? "[附件]" : ""].filter(Boolean);
          return io.accept([{ id: m.id, from: m.from, text: parts.join("\n"), reply: m.id }], "");
        });
        return undefined;
      } catch (e) {
        return signal.aborted ? undefined : { kind: "failed", reason: message(e) };
      }
    },
    send: async (signal, secrets, to, text, reply) => {
      try {
        return await api.sendText(signal, appOf(secrets), to, text, reply);
      } catch (e) {
        // A refused passive reply (too late, too many) waits for the owner's next message; a bad login is stale.
        const status = e instanceof SendError ? e.status : 0;
        return {
          kind: status === 401 ? "stale" : status >= 400 && status < 500 ? "restricted" : "failed",
          reason: message(e),
        };
      }
    },
  };
}

interface Account {
  secrets: Record<string, string>;
  owner: string;
  pairCode: string;
  cursor: string;
  replyContext: string;
  lastInbound: number;
  pausedUntil: number;
  connectedAt: number;
  channel?: string;
}

const paused = (a: Account, now: number) => a.pausedUntil !== 0 && a.pausedUntil > now;

/** Why a step of the bridge did not go through: the database, the orchestrator, or an app. Said as the status's error. */
class BridgeError extends Data.TaggedError("BridgeError")<{ readonly message: string }> {}

const bridgeError = (e: unknown) => (e instanceof BridgeError ? e : new BridgeError({ message: causeMessage(e) }));

const Secrets = Schema.Record(Schema.String, Schema.String);

export interface ConnectorShape {
  readonly list: () => Effect.Effect<ConnectorStatus[]>;
  readonly login: (id: ConnectorID, input: ConnectorLogin) => Effect.Effect<ConnectorStatus>;
  readonly verify: (id: ConnectorID, code: string) => Effect.Effect<ConnectorStatus>;
  readonly logout: (id: ConnectorID) => Effect.Effect<ConnectorStatus>;
  readonly setChannel: (id: ConnectorID, name: string) => Effect.Effect<ConnectorStatus, ApiError>;
}

export class Connectors extends Context.Service<Connectors, ConnectorShape>()("vibevalley/Connector") {}

export interface ConnectorOptions {
  readonly weixin?: WeixinApi;
  readonly feishu?: FeishuApi;
  readonly qq?: QQApi;
  /** Held messages are tried again after retryFirstMs, then twice as long after each try that fails, up to retryMostMs. */
  readonly retryFirstMs?: number;
  readonly retryMostMs?: number;
  /** What the owner said, to the orchestrator; the orchestrator's say when absent. */
  readonly say?: (text: string, conversation: string | undefined, chat: Channels["Service"]) => Effect.Effect<void, ApiError>;
}

/** Until woken or ms on the Clock: "wake" or "timeout". The wake is registered each time it runs. */
const sleepOrWake = (ms: number, register: (wake: () => void) => void) =>
  Effect.suspend(() => {
    const woke = Deferred.makeUnsafe<void>();
    register(() => Deferred.doneUnsafe(woke, Effect.void));
    return Effect.raceFirst(Effect.as(Deferred.await(woke), "wake" as const), Effect.as(Effect.sleep(Math.max(0, ms)), "timeout" as const));
  });

export const make = (options: ConnectorOptions = {}) =>
  Effect.gen(function* () {
    // The farm's own waits and times (a pause, a retry, when a message went out) on the service's Clock.
    const clock = yield* Clock.Clock;
    const now = () => clock.currentTimeMillisUnsafe();
    const sql = yield* SqlClient.SqlClient;
    const { attempt: db } = yield* Db;
    const chat = yield* Channels;
    const core = yield* Core;
    const notices = yield* Notices;
    const orchestrator = yield* Orchestrator;
    const retryFirst = options.retryFirstMs ?? 30_000;
    const retryMost = options.retryMostMs ?? 30 * 60_000;
    // The bridges' fibers (each account's generation, the status said to the core) belong to this service: they end with
    // it and keep its services (the logger, the Clock).
    const forkHere = yield* FiberSet.makeRuntime<never>();
    /** The database's own failures stay failures here: the status says them. */
    const run = <A, E>(e: Effect.Effect<A, E, SqlClient.SqlClient>) => Effect.mapError(db(e), bridgeError);
    const inTx = <A, E>(work: Effect.Effect<A, E>) => Effect.mapError(sql.withTransaction(work), bridgeError);
    const general = chat.general();
    let closing = false;
    const say = (text: string, conversation: string | undefined) =>
      options.say ? options.say(text, conversation, chat) : orchestrator.say(text, {}, conversation, "");

    const bridgeOf = (adapter: Adapter) => {
      const id = adapter.id;
      let account: Account | undefined;
      let progress: Progress | undefined;
      let verifyCode = "";
      // A login stopped by a newer one leaves the newer one's progress alone.
      let attempt = 0;
      let err = "";
      const progressed = new Set<() => void>();
      // The coordinator: one command at a time; only it replaces the account, after all work of the old one has ended.
      const commands = Semaphore.makeUnsafe(1);
      /** The account's work now: receiving, the inbox and the outbox; or a login. */
      let current: Fiber.Fiber<unknown> | undefined;

      // What the page and the tests see: the status, said to the core whenever a part of it may have changed (the error,
      // the account, the login's progress, what waits to go out); the core keeps it only when it differs. One at a time,
      // each read when its turn comes, so the last said is the latest.
      const telling = Semaphore.makeUnsafe(1);
      const told = () => {
        forkHere(telling.withPermits(1)(Effect.ignore(Effect.flatMap(status, (s) => core.apply({ type: "connector", status: s })))));
      };
      const setErr = (e: string) => {
        if (err === e) return;
        err = e;
        told();
      };
      const changed = () => {
        for (const f of progressed) f();
        told();
      };

      const reloadAccount = Effect.gen(function* () {
        const row = yield* run(Effect.catchNoSuchElement(accountQ.connectorAccount({ connector: id })));
        if (Option.isNone(row)) {
          account = undefined;
          return;
        }
        const r = row.value;
        const secrets = Schema.decodeUnknownOption(Schema.fromJsonString(Secrets))(r.secrets);
        if (Option.isNone(secrets)) {
          setErr("存着的登录信息读不出来，断开重新连一次");
          yield* Effect.logError(`vibevalley: ${id}: the saved secrets cannot be read`);
        }
        account = {
          secrets: Option.getOrElse(secrets, () => ({})),
          owner: r.owner_id ?? "",
          pairCode: r.pair_code ?? "",
          cursor: r.cursor,
          replyContext: r.reply_context ?? "",
          lastInbound: r.last_inbound ?? 0,
          pausedUntil: r.paused_until ?? 0,
          connectedAt: r.connected_at,
          ...(r.channel_id ? { channel: r.channel_id } : {}),
        };
      });
      const reload = Effect.andThen(reloadAccount, Effect.sync(told));
      /** A write the bridge goes on without. */
      const kept = <A>(e: Effect.Effect<A, BridgeError>) => Effect.catch(e, (x) => Effect.logError(`vibevalley: ${id}: ${x.message}`));
      const snapshot = () => (account ? { ...account } : undefined);

      // How many wait to go out, as the status says it: counted in the database when not known, then moved by each change
      // that commits. A change that failed, or one made while it was being counted, leaves it unknown again.
      let pendingOut: number | undefined;
      let outChanges = 0;
      const outboxChanged = (by?: (n: number) => number) => {
        outChanges++;
        pendingOut = by && pendingOut !== undefined ? by(pendingOut) : undefined;
        told();
      };
      const pendingNow = Effect.suspend(() => {
        if (pendingOut !== undefined) return Effect.succeed(pendingOut);
        const at = outChanges;
        return run(Effect.map(outboxQ.countPendingOutbox({ connector: id }), (r) => r?.n ?? 0)).pipe(
          Effect.tap((n) =>
            Effect.sync(() => {
              if (at === outChanges) pendingOut = n;
            }),
          ),
          Effect.orElseSucceed(() => 0),
        );
      });

      const status: Effect.Effect<ConnectorStatus> = Effect.map(pendingNow, (pending) => {
        const state = chat.now();
        const s: ConnectorStatus = { id, state: "off", pending };
        if (err) s.error = err;
        const a = account;
        if (a) {
          const where = a.channel ? conversationOf(state, a.channel) : generalOf(state);
          if (where?.name) s.channel = where.name;
        }
        if (progress) return { ...s, state: progress.state, ...(progress.qr ? { qr: progress.qr } : {}) };
        if (!a) return s;
        if (!a.owner)
          return {
            ...s,
            state: "pairing",
            ...(a.pairCode ? { pairCode: a.pairCode } : {}),
            since: a.connectedAt,
          };
        const stopped = paused(a, now());
        return {
          ...s,
          state: stopped ? "paused" : "connected",
          ...(stopped ? { pausedUntil: a.pausedUntil } : {}),
          owner: shortId(a.owner),
          since: a.connectedAt,
          ...(a.lastInbound ? { lastInbound: a.lastInbound } : {}),
        };
      });

      /** Whether the pause was kept. */
      const pause = Effect.gen(function* () {
        yield* run(accountQ.pauseAccount({ paused_until: now() + stalePauseMs, connector: id }));
        yield* reload;
        setErr("登录过期了，一小时后再试；也可以断开重新连。");
        return true;
      }).pipe(
        Effect.catch((e) =>
          Effect.as(
            Effect.sync(() => setErr(e.message)),
            false,
          ),
        ),
      );

      const quotedConversation = Effect.fnUntraced(function* (ext: string | undefined) {
        if (!ext) return undefined;
        const rows = yield* run(outboxQ.messageOfExt({ connector: id, ext_id: ext }));
        const message = rows[0]?.message_id;
        if (!message) return undefined;
        return (yield* Effect.mapError(chat.messageLocation(message), bridgeError))?.conversation.id;
      });

      /** The app's send; a send that throws is a failure like the ones it says. */
      const send = (secrets: Record<string, string>, to: string, text: string, reply: string) =>
        Effect.tryPromise({
          try: (signal) => adapter.send(signal, secrets, to, text, reply),
          catch: (e): Failure => ({ kind: "failed", reason: message(e) }),
        }).pipe(Effect.catch((f) => Effect.succeed(f)));

      // The outbox: one drain at a time, in order. True when nothing is left that it could send now.
      const draining = Semaphore.makeUnsafe(1);
      let wakeOutbox: (() => void) | undefined;
      let outboxDirty = false;
      const drain = (late: boolean) =>
        draining.withPermits(1)(
          Effect.gen(function* () {
            const a = snapshot();
            if (!a || !a.owner || paused(a, now())) return true;
            const listed = yield* Effect.result(run(outboxQ.pendingOutbox({ connector: id })));
            if (listed._tag === "Failure") {
              yield* Effect.logError(`vibevalley: ${id}: ${listed.failure.message}`);
              return false;
            }
            const pending = listed.success;
            if (pending.length === 0) return true;
            const batches =
              late && pending.length > digestOver
                ? [{ ids: pending.map((r) => r.id), text: flushText(pending.map((r) => r.body))[0]! }]
                : pending.map((r) => ({ ids: [r.id], text: r.body }));
            for (const out of batches) {
              const sent = yield* send(a.secrets, a.owner, out.text, a.replyContext);
              if (Predicate.isString(sent)) {
                const marked = yield* Effect.result(
                  inTx(Effect.forEach(out.ids, (oid) => db(outboxQ.outboxSent({ sent_at: now(), ext_id: sent || null, id: oid })), { discard: true })),
                );
                if (marked._tag === "Failure") {
                  outboxChanged();
                  setErr(marked.failure.message);
                  return false;
                }
                outboxChanged((n) => n - out.ids.length);
                setErr("");
                continue;
              }
              for (const oid of out.ids) yield* kept(run(outboxQ.outboxFailed({ error: sent.reason || null, id: oid })));
              if (sent.kind === "stale") yield* pause;
              // The app would not take it now (WeChat's, QQ's reply window): tried again later, and with the owner's next message.
              else if (sent.kind === "restricted") setErr("");
              else setErr(sent.reason);
              return false;
            }
            return true;
          }),
        );
      const retire = (reason: string) => db(outboxQ.dropPendingOutbox({ error: reason, connector: id }));

      const offer = Effect.fnUntraced(function* (m: ChatMessage) {
        const a = snapshot();
        if (!a || !a.owner) return;
        const added = yield* Effect.result(
          Effect.gen(function* () {
            const place = yield* Effect.mapError(chat.messageLocation(m.id), bridgeError);
            if (!place || place.channel !== (a.channel ?? general)) return 0;
            const pieces = splitText(ownerLine(m, place.conversation), maxChars[id]);
            const at = now();
            yield* inTx(
              Effect.forEach(pieces, (piece) => db(outboxQ.addOutbox({ id: newId(), connector: id, message_id: m.id, body: piece, created_at: at })), {
                discard: true,
              }),
            );
            return pieces.length;
          }),
        );
        if (added._tag === "Failure") {
          outboxChanged();
          setErr(added.failure.message);
          return;
        }
        if (added.success === 0) return;
        outboxChanged((n) => n + added.success);
        outboxDirty = true;
        wakeOutbox?.();
      });

      const outboxRun = Effect.gen(function* () {
        let wait = retryFirst;
        for (;;) {
          if (outboxDirty) {
            outboxDirty = false;
            yield* drain(false);
            wait = retryFirst;
            continue;
          }
          const result = yield* sleepOrWake(wait, (wake) => (wakeOutbox = wake)).pipe(Effect.ensuring(Effect.sync(() => (wakeOutbox = undefined))));
          if (result === "timeout") wait = (yield* drain(false)) ? retryFirst : Math.min(2 * wait, retryMost);
        }
      });

      const got = Effect.fnUntraced(function* (m: Inbound) {
        const a = snapshot();
        if (!a) return;
        if (!a.owner) {
          if (!a.pairCode || !isPairing(m.text, a.pairCode)) return;
          const at = now();
          yield* inTx(
            Effect.gen(function* () {
              yield* db(accountQ.accountOwner({ owner_id: m.from || null, connector: id }));
              yield* db(accountQ.accountReply({ reply_context: m.reply || null, at, connector: id }));
              if (m.id) yield* db(inboundQ.deliverInbound({ connector: id, ext_id: m.id }));
            }),
          );
          // Told once the owner has the word: the status is not paired before the app's confirmation went out.
          yield* reloadAccount;
          yield* send(a.secrets, m.from, "配对好了：以后在这里说的话，就是你在田头上说的。", m.reply ?? "");
          told();
          return;
        }
        if (m.from !== a.owner) return;
        yield* run(accountQ.accountReply({ reply_context: m.reply || null, at: now(), connector: id }));
        yield* reload;
        // A fresh reply opens the platform's delivery window; older messages precede its answer.
        yield* drain(true);
        if (!m.text) return;
        const conversation = (yield* quotedConversation(m.quoted)) ?? snapshot()?.channel;
        yield* Effect.mapError(say(m.text, conversation), (e) => new BridgeError({ message: reasonOf(e) }));
      });

      // The inbox: what the app handed over, delivered to the orchestrator in order.
      let wakeInbox: (() => void) | undefined;
      const accept = (messages: readonly Inbound[], cursor: string) =>
        inTx(
          Effect.gen(function* () {
            yield* db(accountQ.connectorAccount({ connector: id }));
            for (const m of messages) {
              const withId = m.id ? m : { ...m, id: newId() };
              yield* db(
                inboundQ.acceptInbound({
                  connector: id,
                  ext_id: withId.id,
                  payload: JSON.stringify(withId),
                  created_at: yield* Clock.currentTimeMillis,
                }),
              );
            }
            if (cursor) yield* db(accountQ.accountCursor({ connector: id, cursor }));
          }),
        ).pipe(
          Effect.tapError((e) => Effect.sync(() => (closing ? undefined : setErr(e.message)))),
          Effect.tap(() => Effect.sync(() => wakeInbox?.())),
        );
      const drainInbox = Effect.gen(function* () {
        const rows = yield* run(inboundQ.pendingInbound({ connector: id }));
        for (const row of rows) {
          const m = Schema.decodeUnknownOption(Schema.fromJsonString(InboundSchema))(row.payload);
          if (Option.isNone(m) || m.value.id !== row.ext_id) {
            // A malformed row can never be delivered; settle it explicitly so later valid messages are not blocked.
            yield* Effect.logError(`vibevalley: ${id}: discarding malformed durable inbound ${row.ext_id}`);
            yield* run(inboundQ.deliverInbound({ connector: id, ext_id: row.ext_id }));
            continue;
          }
          yield* got(m.value);
          yield* run(inboundQ.deliverInbound({ connector: id, ext_id: row.ext_id }));
        }
      });
      const inboxRun = Effect.forever(
        Effect.andThen(
          Effect.catch(drainInbox, (e) => Effect.sync(() => setErr(e.message))),
          sleepOrWake(1_000, (wake) => (wakeInbox = wake)).pipe(Effect.ensuring(Effect.sync(() => (wakeInbox = undefined)))),
        ),
      );

      // An SDK handler may outlive receive: acceptance is sealed and the writes it accepted joined before it returns.
      const receive = (secrets: Record<string, string>) =>
        Effect.scoped(
          Effect.gen(function* () {
            const row = yield* run(Effect.catchNoSuchElement(accountQ.connectorAccount({ connector: id })));
            const cursor = Option.match(row, { onNone: () => "", onSome: (a) => a.cursor });
            const accepting = yield* FiberSet.make<void, BridgeError>();
            const acceptHere = yield* FiberSet.runtimePromise(accepting)<never>();
            let sealed = false;
            return yield* Effect.tryPromise({
              try: (signal) =>
                adapter.receive(signal, secrets, {
                  cursor,
                  accept: (messages, c) => (sealed || signal.aborted ? Promise.reject(new Error("canceled")) : acceptHere(accept(messages, c))),
                }),
              catch: (e): Failure => ({ kind: "failed", reason: message(e) }),
            }).pipe(
              Effect.catch((f) => Effect.succeed(f)),
              Effect.ensuring(
                Effect.suspend(() => {
                  sealed = true;
                  return FiberSet.awaitEmpty(accepting);
                }),
              ),
            );
          }),
        );
      const receiving = Effect.gen(function* () {
        let failures = 0;
        for (;;) {
          const a = snapshot();
          if (!a) return;
          if (paused(a, now())) {
            yield* Effect.sleep(Math.max(0, a.pausedUntil - now()));
            const resumed = yield* Effect.result(Effect.andThen(run(accountQ.pauseAccount({ paused_until: null, connector: id })), reload));
            if (resumed._tag === "Failure") {
              setErr(resumed.failure.message);
              yield* Effect.sleep(Math.min(30_000, retryMost));
            }
            continue;
          }
          const stopped = yield* receive(a.secrets).pipe(
            Effect.map((f): Failure => f ?? { kind: "failed", reason: "收消息停了" }),
            Effect.catch((e) => Effect.succeed<Failure>({ kind: "failed", reason: e.message })),
          );
          if (stopped.kind === "stale") {
            if (!(yield* pause)) yield* Effect.sleep(Math.min(30_000, retryMost));
            continue;
          }
          setErr(stopped.reason);
          failures++;
          let wait = 2_000;
          if (failures >= 3) {
            wait = 30_000;
            failures = 0;
          }
          yield* Effect.sleep(wait);
        }
      });

      /** Starts work as the account's generation, on the service's fibers: a failure is logged, an interruption is the stop. */
      const generation = (work: Effect.Effect<unknown, unknown>) =>
        forkHere(
          work.pipe(
            Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError(`vibevalley: ${id}: ${Cause.pretty(cause)}`))),
          ),
        );
      const stopGeneration = Effect.suspend(() => {
        const g = current;
        current = undefined;
        return g ? Fiber.interrupt(g) : Effect.void;
      });
      const connected = () =>
        account && !closing ? generation(Effect.all([receiving, inboxRun, outboxRun], { concurrency: "unbounded", discard: true })) : undefined;
      const resetProgress = () => {
        progress = undefined;
        verifyCode = "";
        changed();
      };
      const loginResult = (g: Fiber.Fiber<unknown>, result: Linked | Error) =>
        commands.withPermits(1)(
          Effect.gen(function* () {
            if (g !== current) return;
            yield* stopGeneration;
            let failure = result instanceof Error ? result.message : undefined;
            if (failure === undefined && !closing) {
              const linked = result as Linked;
              const pair = linked.owner ? null : String(100_000 + randomInt(900_000));
              const at = yield* Clock.currentTimeMillis;
              const connectedNow = yield* Effect.result(
                inTx(
                  Effect.gen(function* () {
                    yield* db(
                      accountQ.connectAccount({
                        connector: id,
                        secrets: JSON.stringify(linked.secrets),
                        owner_id: linked.owner || null,
                        pair_code: pair,
                        connected_at: at,
                      }),
                    );
                    yield* db(inboundQ.clearInbound({ connector: id }));
                    yield* retire("换了账号");
                  }),
                ).pipe(Effect.andThen(Effect.sync(() => outboxChanged(() => 0))), Effect.andThen(reload)),
              );
              if (connectedNow._tag === "Failure") {
                outboxChanged();
                failure = connectedNow.failure.message;
              }
            }
            setErr(failure ?? "");
            resetProgress();
            current = connected();
          }),
        );
      const loggingIn = (input: ConnectorLogin) => {
        const login = Effect.tryPromise({
          try: (signal) =>
            adapter.login(
              signal,
              input,
              (p) => {
                if (!signal.aborted) progress = p;
                changed();
              },
              () => verifyCode,
            ),
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        });
        // The login's answer is taken by the coordinator, on its own fiber: replacing this generation must not cut it short.
        const g: Fiber.Fiber<unknown> = generation(
          Effect.flatMap(Effect.result(login), (r) => Effect.sync(() => void forkHere(loginResult(g, r._tag === "Success" ? r.success : r.failure)))),
        );
        return g;
      };

      return {
        id,
        load: reload,
        status,
        offer: (m: ChatMessage) => commands.withPermits(1)(Effect.suspend(() => (closing ? Effect.void : offer(m)))),
        resume: commands.withPermits(1)(
          Effect.sync(() => {
            current ??= connected();
          }),
        ),
        login: Effect.fnUntraced(function* (input: ConnectorLogin) {
          const started = yield* commands.withPermits(1)(
            Effect.gen(function* () {
              if (progress && !input.force) return attempt;
              yield* stopGeneration;
              attempt++;
              setErr("");
              verifyCode = "";
              progress = { state: "waiting" };
              current = loggingIn(input);
              told();
              return attempt;
            }),
          );
          // Up to a moment for the code to show.
          const shown = Deferred.makeUnsafe<void>();
          const done = () => {
            if (attempt !== started || !progress || progress.qr) Deferred.doneUnsafe(shown, Effect.void);
          };
          progressed.add(done);
          done();
          yield* Effect.raceFirst(Deferred.await(shown), Effect.sleep(1_500)).pipe(Effect.ensuring(Effect.sync(() => progressed.delete(done))));
          return yield* status;
        }),
        verify: (code: string) =>
          Effect.suspend(() => {
            verifyCode = code.trim();
            if (progress?.state === "verify") progress = { state: "scanned", ...(progress.qr ? { qr: progress.qr } : {}) };
            told();
            return status;
          }),
        logout: Effect.andThen(
          commands.withPermits(1)(
            Effect.gen(function* () {
              yield* stopGeneration;
              const retired = yield* Effect.result(
                inTx(
                  Effect.gen(function* () {
                    yield* db(accountQ.disconnectAccount({ connector: id }));
                    yield* db(inboundQ.clearInbound({ connector: id }));
                    yield* retire("断开了");
                  }),
                ),
              );
              if (retired._tag === "Success") outboxChanged(() => 0);
              else outboxChanged();
              resetProgress();
              attempt++;
              if (retired._tag === "Failure") {
                setErr(retired.failure.message);
                current = connected();
              } else {
                account = undefined;
                setErr("");
              }
              told();
            }),
          ),
          status,
        ),
        setChannel: (to: string | undefined) =>
          Effect.andThen(Effect.andThen(run(accountQ.accountChannel({ channel_id: to ?? null, connector: id })), reload), status),
        stop: commands.withPermits(1)(stopGeneration),
        hasAccount: () => account !== undefined,
      };
    };

    const adapters = [
      weixinAdapter(options.weixin ?? new WeixinClient()),
      feishuAdapter(options.feishu ?? new FeishuClient()),
      qqAdapter(options.qq ?? new QQClient()),
    ];
    const bridges = adapters.map(bridgeOf);
    for (const b of bridges) yield* Effect.orDie(b.load);
    const bridge = (id: ConnectorID) => bridges.find((b) => b.id === id);

    // What the owner hears off the farm (Notifications says what) goes out on every app the owner has, each checking it is
    // its owner's channel.
    yield* Effect.forkScoped(
      Stream.runForEach(yield* notices.toOwner, (m) => Effect.forEach(bridges, (b) => b.offer(m), { concurrency: "unbounded", discard: true })),
    );
    for (const b of bridges) if (b.hasAccount()) forkHere(b.resume);
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        closing = true;
        return Effect.forEach(bridges, (b) => b.stop, { concurrency: "unbounded", discard: true });
      }),
    );

    const off = (id: ConnectorID): ConnectorStatus => ({ id, state: "off", pending: 0 });
    return Connectors.of({
      list: () => Effect.forEach(bridges, (b) => b.status),
      login: (id, input) => bridge(id)?.login(input) ?? Effect.succeed(off(id)),
      verify: (id, code) => bridge(id)?.verify(code) ?? Effect.succeed(off(id)),
      logout: (id) => bridge(id)?.logout ?? Effect.succeed(off(id)),
      setChannel: Effect.fn("Connectors.setChannel")(function* (id, name) {
        const b = bridge(id);
        if (!b)
          return yield* Effect.fail<ApiError>({
            _tag: "ConnectorRefused",
            reason: `没有 ${id} 这个连接`,
          });
        const channel = yield* chat.channelByName(name);
        if (!channel)
          return yield* Effect.fail<ApiError>({
            _tag: "ConnectorRefused",
            reason: `没有叫 ${name} 的频道`,
          });
        return yield* Effect.mapError(b.setChannel(channel.id !== general ? channel.id : undefined), (e): ApiError => ({
          _tag: "ConnectorRefused",
          reason: e.message,
        }));
      }),
    });
  });

export const layer = (options?: ConnectorOptions) => Layer.effect(Connectors, make(options));
