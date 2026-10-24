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
import { Context, Effect, FiberSet, Layer, Option, Stream } from "effect";
import { SqlClient } from "effect/sql";
import * as accountQ from "../../db/generated/connector_account.sql.ts";
import * as inboundQ from "../../db/generated/connector_inbound.sql.ts";
import * as outboxQ from "../../db/generated/connector_outbox.sql.ts";
import { newId } from "../base/ids.ts";
import { causeMessage, optional } from "../base/db.ts";
import { Channels } from "../channel/chat.ts";
import { Orchestrator } from "../orchestrator/orchestrator.ts";
import { type FeishuApi, FeishuClient, text as feishuText } from "./feishu.ts";
import { type QQApi, QQClient, SendError } from "./qq.ts";
import { digestOver, flushText, isPairing, maxChars, ownerLine, shortId, splitText } from "./text.ts";
import { baseUrl, failed as weixinFailed, quoted, restricted, staleToken, text as weixinText, type WeixinApi, WeixinClient, WeixinError } from "./weixin.ts";
import { callbackLog } from "../base/log.ts";
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
const isFailure = (x: unknown): x is Failure => typeof x === "object" && x !== null && "kind" in x && "reason" in x;

export function weixinAdapter(api: WeixinApi): Adapter {
  const accountOf = (s: Record<string, string>) => ({ baseUrl: s.baseUrl || baseUrl, token: s.token ?? "" });
  return {
    id: "weixin",
    login: async (signal, _input, progress, verifyCode) => {
      const linked = await api.login(signal, (state, url) => progress({ state, qr: url }), verifyCode);
      return { secrets: { token: linked.account.token, botId: linked.botId, baseUrl: linked.account.baseUrl }, owner: linked.owner };
    },
    receive: async (signal, secrets, io) => {
      const account = accountOf(secrets);
      let buf = io.cursor;
      let timeout = weixinPollMs;
      while (!signal.aborted) {
        let updates;
        try {
          updates = await api.getUpdates(signal, account, buf, timeout);
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
          .map((m) => ({ id: m.message_id ?? "", from: m.from_user_id!, text: weixinText(m), reply: m.context_token ?? "", quoted: quoted(m) }));
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
        return { kind: code === staleToken ? "stale" : code === restricted ? "restricted" : "failed", reason: message(e) };
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
      return { secrets: { appId: linked.app.appId, appSecret: linked.app.appSecret, domain: linked.app.domain }, owner: linked.owner };
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
        return { kind: status === 401 ? "stale" : status >= 400 && status < 500 ? "restricted" : "failed", reason: message(e) };
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

const paused = (a: Account) => a.pausedUntil !== 0 && a.pausedUntil > Date.now();

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<boolean>((resolve) => {
    if (signal.aborted) return resolve(false);
    const t = setTimeout(() => resolve(true), Math.max(0, ms));
    signal.addEventListener("abort", () => (clearTimeout(t), resolve(false)), { once: true });
  });

interface Generation {
  readonly control: AbortController;
  readonly done: Promise<unknown>;
}

const stopGeneration = async (g: Generation | undefined) => {
  if (!g) return;
  g.control.abort();
  await g.done;
};

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

export const make = (options: ConnectorOptions = {}) =>
  Effect.gen(function* () {
    const logs = yield* callbackLog;
    const sql = yield* SqlClient.SqlClient;
    const chat = yield* Channels;
    const notices = yield* Notices;
    const orchestrator = yield* Orchestrator;
    const retryFirst = options.retryFirstMs ?? 30_000;
    const retryMost = options.retryMostMs ?? 30 * 60_000;
    // Fibers started from callbacks belong to this service: they end with it and keep its services (the logger).
    const runHere = yield* FiberSet.makeRuntimePromise<never>();
    const run = <A, E>(e: Effect.Effect<A, E, SqlClient.SqlClient>) =>
      runHere(Effect.mapError(Effect.provideService(e, SqlClient.SqlClient, sql), (err) => new Error(causeMessage(err))));
    const inTx = <A>(f: Effect.Effect<A, unknown, SqlClient.SqlClient>) => run(sql.withTransaction(f));
    const general = chat.general();
    const life = new AbortController();
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
      const signal = () => {
        for (const f of progressed) f();
      };

      const reload = async () => {
        const row = await run(optional(accountQ.connectorAccount({ connector: id })));
        if (Option.isNone(row)) {
          account = undefined;
          return;
        }
        const r = row.value;
        let secrets: Record<string, string> = {};
        try {
          secrets = JSON.parse(r.secrets) as Record<string, string>;
        } catch (e) {
          err = "存着的登录信息读不出来，断开重新连一次";
          logs.error(`vibevalley: ${id}: the saved secrets cannot be read:`, message(e));
        }
        account = {
          secrets,
          owner: r.owner_id ?? "",
          pairCode: r.pair_code ?? "",
          cursor: r.cursor,
          replyContext: r.reply_context ?? "",
          lastInbound: r.last_inbound ?? 0,
          pausedUntil: r.paused_until ?? 0,
          connectedAt: r.connected_at,
          ...(r.channel_id ? { channel: r.channel_id } : {}),
        };
      };
      // A write the bridge goes on without.
      const kept = (p: Promise<unknown>) => p.catch((e) => logs.error(`vibevalley: ${id}:`, message(e)));
      const now = () => (account ? { ...account } : undefined);

      const status = async (): Promise<ConnectorStatus> => {
        const pending = await run(Effect.map(outboxQ.countPendingOutbox({ connector: id }), (r) => r?.n ?? 0)).catch(() => 0);
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
        if (!a.owner) return { ...s, state: "pairing", ...(a.pairCode ? { pairCode: a.pairCode } : {}), since: a.connectedAt };
        return {
          ...s,
          state: paused(a) ? "paused" : "connected",
          ...(paused(a) ? { pausedUntil: a.pausedUntil } : {}),
          owner: shortId(a.owner),
          since: a.connectedAt,
          ...(a.lastInbound ? { lastInbound: a.lastInbound } : {}),
        };
      };

      const pause = async () => {
        await kept(run(accountQ.pauseAccount({ paused_until: Date.now() + stalePauseMs, connector: id })));
        await kept(reload());
        err = "登录过期了，一小时后再试；也可以断开重新连。";
      };

      const quotedConversation = async (ext: string | undefined) => {
        if (!ext) return undefined;
        const rows = await run(outboxQ.messageOfExt({ connector: id, ext_id: ext })).catch(() => []);
        const message = rows[0]?.message_id;
        if (!message) return undefined;
        return (await runHere(chat.messageLocation(message)))?.conversation.id;
      };

      // The outbox: one drain at a time, in order.
      let sending = Promise.resolve(true);
      let wakeOutbox: (() => void) | undefined;
      const drain = (signal: AbortSignal, late: boolean) => {
        const next = sending.then(async () => {
          if (signal.aborted) return false;
          const a = now();
          if (!a || !a.owner || paused(a)) return true;
          let pending: readonly { id: string; body: string }[];
          try {
            pending = await run(outboxQ.pendingOutbox({ connector: id }));
          } catch (e) {
            logs.error(`vibevalley: ${id}:`, message(e));
            return false;
          }
          if (pending.length === 0) return true;
          const batches =
            late && pending.length > digestOver
              ? [{ ids: pending.map((r) => r.id), text: flushText(pending.map((r) => r.body))[0]! }]
              : pending.map((r) => ({ ids: [r.id], text: r.body }));
          for (const out of batches) {
            const sent = await adapter.send(signal, a.secrets, a.owner, out.text, a.replyContext);
            if (!isFailure(sent)) {
              try {
                await inTx(Effect.forEach(out.ids, (oid) => outboxQ.outboxSent({ sent_at: Date.now(), ext_id: sent || null, id: oid }), { discard: true }));
              } catch (e) {
                err = message(e);
                return false;
              }
              err = "";
              continue;
            }
            for (const oid of out.ids) await kept(run(outboxQ.outboxFailed({ error: sent.reason || null, id: oid })));
            if (sent.kind === "stale") await pause();
            // The app would not take it now (WeChat's, QQ's reply window): tried again later, and with the owner's next message.
            else if (sent.kind === "restricted") err = "";
            else err = sent.reason;
            return false;
          }
          return true;
        });
        sending = next.catch(() => false);
        return next;
      };
      const retire = (reason: string) => outboxQ.dropPendingOutbox({ error: reason, connector: id });

      const offer = async (m: ChatMessage) => {
        const a = now();
        if (!a || !a.owner) return;
        try {
          const place = await runHere(chat.messageLocation(m.id));
          if (!place || place.channel !== (a.channel ?? general)) return;
          await inTx(
            Effect.forEach(
              splitText(ownerLine(m, place.conversation), maxChars[id]),
              (piece) => outboxQ.addOutbox({ id: newId(), connector: id, message_id: m.id, body: piece, created_at: Date.now() }),
              {
                discard: true,
              },
            ),
          );
        } catch (e) {
          err = message(e);
          return;
        }
        wakeOutbox?.();
      };

      const outboxRun = async (signal: AbortSignal) => {
        let wait = retryFirst;
        while (!signal.aborted) {
          const woke = await new Promise<boolean>((resolve) => {
            const t = setTimeout(() => resolve(false), wait);
            wakeOutbox = () => (clearTimeout(t), resolve(true));
            signal.addEventListener("abort", () => (clearTimeout(t), resolve(false)), { once: true });
          });
          wakeOutbox = undefined;
          if (signal.aborted) return;
          if (woke) {
            await drain(signal, false);
            wait = retryFirst;
          } else wait = (await drain(signal, false)) ? retryFirst : Math.min(2 * wait, retryMost);
        }
      };

      const got = async (signal: AbortSignal, m: Inbound) => {
        if (signal.aborted) throw new Error("canceled");
        const a = now();
        if (!a) return;
        if (!a.owner) {
          if (!a.pairCode || !isPairing(m.text, a.pairCode)) return;
          const at = Date.now();
          await inTx(
            Effect.gen(function* () {
              yield* accountQ.accountOwner({ owner_id: m.from || null, connector: id });
              yield* accountQ.accountReply({ reply_context: m.reply || null, at, connector: id });
              if (m.id) yield* inboundQ.deliverInbound({ connector: id, ext_id: m.id });
            }),
          );
          await reload();
          await adapter.send(signal, a.secrets, m.from, "配对好了：以后在这里说的话，就是你在田头上说的。", m.reply ?? "");
          return;
        }
        if (m.from !== a.owner) return;
        await run(accountQ.accountReply({ reply_context: m.reply || null, at: Date.now(), connector: id }));
        await reload();
        // A fresh reply opens the platform's delivery window; older messages precede its answer.
        await drain(signal, true);
        if (!m.text) return;
        const conversation = (await quotedConversation(m.quoted)) ?? now()?.channel;
        await runHere(Effect.mapError(say(m.text, conversation), (e) => new Error("reason" in e ? String(e.reason) : e._tag)));
      };

      // The inbox: what the app handed over, delivered to the orchestrator in order.
      let wakeInbox: (() => void) | undefined;
      const accept = async (messages: readonly Inbound[], cursor: string) => {
        try {
          await inTx(
            Effect.gen(function* () {
              yield* accountQ.connectorAccount({ connector: id });
              for (const m of messages) {
                const withId = m.id ? m : { ...m, id: newId() };
                yield* inboundQ.acceptInbound({ connector: id, ext_id: withId.id, payload: JSON.stringify(withId), created_at: Date.now() });
              }
              if (cursor) yield* accountQ.accountCursor({ connector: id, cursor });
            }),
          );
        } catch (e) {
          if (!life.signal.aborted) err = message(e);
          throw e;
        }
        wakeInbox?.();
      };
      const drainInbox = async (signal: AbortSignal) => {
        const rows = await run(inboundQ.pendingInbound({ connector: id }));
        for (const row of rows) {
          if (signal.aborted) return;
          const m = JSON.parse(row.payload) as Inbound;
          if (m.id !== row.ext_id) throw new Error("收件记录的编号不一致");
          await got(signal, m);
          await run(inboundQ.deliverInbound({ connector: id, ext_id: row.ext_id }));
        }
      };
      const inboxRun = async (signal: AbortSignal) => {
        while (!signal.aborted) {
          try {
            await drainInbox(signal);
          } catch (e) {
            if (!signal.aborted) err = message(e);
          }
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 1_000);
            wakeInbox = () => (clearTimeout(t), resolve());
            signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
          });
          wakeInbox = undefined;
        }
      };
      // An SDK handler may outlive receive: acceptance is sealed and in-flight writes joined before it returns.
      const receive = async (signal: AbortSignal, secrets: Record<string, string>) => {
        const cursor = (await run(optional(accountQ.connectorAccount({ connector: id })))).pipe(Option.match({ onNone: () => "", onSome: (a) => a.cursor }));
        let closed = false;
        const pending = new Set<Promise<void>>();
        const result = await adapter.receive(signal, secrets, {
          cursor: cursor ?? "",
          accept: (messages, c) => {
            if (closed || signal.aborted) return Promise.reject(new Error("canceled"));
            const p = accept(messages, c);
            pending.add(p);
            return p.finally(() => pending.delete(p));
          },
        });
        closed = true;
        await Promise.allSettled(pending);
        return result;
      };
      const receiving = async (signal: AbortSignal) => {
        let failures = 0;
        while (!signal.aborted) {
          const a = now();
          if (!a) return;
          if (paused(a)) {
            if (!(await sleep(a.pausedUntil - Date.now(), signal))) return;
            await kept(run(accountQ.pauseAccount({ paused_until: null, connector: id })));
            await kept(reload());
            continue;
          }
          const stopped = (await receive(signal, a.secrets).catch((e) => ({ kind: "failed" as const, reason: message(e) }))) ?? {
            kind: "failed",
            reason: "收消息停了",
          };
          if (signal.aborted) return;
          if (stopped.kind === "stale") {
            await pause();
            continue;
          }
          err = stopped.reason;
          failures++;
          let wait = 2_000;
          if (failures >= 3) {
            wait = 30_000;
            failures = 0;
          }
          if (!(await sleep(wait, signal))) return;
        }
      };

      // The coordinator: one command at a time; only it replaces the account, after all work of the old one has ended.
      let current: Generation | undefined;
      let queue = Promise.resolve();
      const serially = <A>(f: () => Promise<A>): Promise<A> => {
        const next = queue.then(f);
        queue = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      };
      const generation = (work: (signal: AbortSignal) => Promise<unknown>): Generation => {
        const control = new AbortController();
        const stop = () => control.abort();
        life.signal.addEventListener("abort", stop, { once: true });
        return { control, done: work(control.signal).catch((e) => logs.error(`vibevalley: ${id}:`, message(e))) };
      };
      const connected = () => (account && !life.signal.aborted ? generation((s) => Promise.all([receiving(s), inboxRun(s), outboxRun(s)])) : undefined);
      const resetProgress = () => {
        progress = undefined;
        verifyCode = "";
        signal();
      };
      const loginResult = (g: Generation, result: Linked | Error) =>
        serially(async () => {
          if (g !== current) return;
          await stopGeneration(current);
          current = undefined;
          let failure = result instanceof Error ? result : undefined;
          if (!failure && !life.signal.aborted) {
            const linked = result as Linked;
            try {
              const pair = linked.owner ? null : String(100_000 + randomInt(900_000));
              await inTx(
                Effect.gen(function* () {
                  yield* accountQ.connectAccount({
                    connector: id,
                    secrets: JSON.stringify(linked.secrets),
                    owner_id: linked.owner || null,
                    pair_code: pair,
                    connected_at: Date.now(),
                  });
                  yield* inboundQ.clearInbound({ connector: id });
                  yield* retire("换了账号");
                }),
              );
              await reload();
            } catch (e) {
              failure = e instanceof Error ? e : new Error(String(e));
            }
          }
          err = failure ? failure.message : "";
          resetProgress();
          current = connected();
        });
      const loggingIn = (input: ConnectorLogin) => {
        const g: Generation = generation(async (s) => {
          let result: Linked | Error;
          try {
            result = await adapter.login(
              s,
              input,
              (p) => {
                if (!s.aborted) progress = p;
                signal();
              },
              () => verifyCode,
            );
          } catch (e) {
            result = e instanceof Error ? e : new Error(String(e));
          }
          if (!s.aborted) void loginResult(g, result);
        });
        return g;
      };

      return {
        id,
        load: reload,
        status,
        offer: (m: ChatMessage) =>
          serially(async () => {
            if (!life.signal.aborted) await offer(m);
          }),
        resume: () =>
          serially(async () => {
            current ??= connected();
          }),
        login: async (input: ConnectorLogin) => {
          const started = await serially(async () => {
            if (progress && !input.force) return attempt;
            await stopGeneration(current);
            current = undefined;
            attempt++;
            err = "";
            verifyCode = "";
            progress = { state: "waiting" };
            current = loggingIn(input);
            return attempt;
          });
          // Up to a moment for the code to show.
          await new Promise<void>((resolve) => {
            const done = () => {
              if (attempt !== started || !progress || progress.qr) finish();
            };
            const finish = () => {
              clearTimeout(t);
              progressed.delete(done);
              resolve();
            };
            const t = setTimeout(finish, 1_500);
            progressed.add(done);
            done();
          });
          return status();
        },
        verify: (code: string) => {
          verifyCode = code.trim();
          if (progress?.state === "verify") progress = { state: "scanned", ...(progress.qr ? { qr: progress.qr } : {}) };
          return status();
        },
        logout: async () => {
          await serially(async () => {
            await stopGeneration(current);
            current = undefined;
            let failure: unknown;
            try {
              await inTx(
                Effect.gen(function* () {
                  yield* accountQ.disconnectAccount({ connector: id });
                  yield* inboundQ.clearInbound({ connector: id });
                  yield* retire("断开了");
                }),
              );
            } catch (e) {
              failure = e;
            }
            resetProgress();
            attempt++;
            if (failure) {
              err = message(failure);
              current = connected();
            } else {
              account = undefined;
              err = "";
            }
          });
          return status();
        },
        setChannel: async (to: string | undefined) => {
          await run(accountQ.accountChannel({ channel_id: to ?? null, connector: id }));
          await reload();
          return status();
        },
        stop: () => serially(() => stopGeneration(current)),
        hasAccount: () => account !== undefined,
      };
    };

    const adapters = [
      weixinAdapter(options.weixin ?? new WeixinClient()),
      feishuAdapter(options.feishu ?? new FeishuClient()),
      qqAdapter(options.qq ?? new QQClient()),
    ];
    const bridges = adapters.map(bridgeOf);
    for (const b of bridges) yield* Effect.promise(b.load);
    const bridge = (id: ConnectorID) => bridges.find((b) => b.id === id);

    // What the owner hears off the farm (Notifications says what) goes out on every app the owner has, each checking it is
    // its owner's channel.
    yield* Effect.forkScoped(Stream.runForEach(yield* notices.toOwner, (m) => Effect.promise(() => Promise.all(bridges.map((b) => b.offer(m))))));
    for (const b of bridges) if (b.hasAccount()) void b.resume();
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        life.abort();
        await Promise.all(bridges.map((b) => b.stop()));
      }),
    );

    const off = (id: ConnectorID): ConnectorStatus => ({ id, state: "off", pending: 0 });
    return Connectors.of({
      list: () => Effect.promise(() => Promise.all(bridges.map((b) => b.status()))),
      login: (id, input) => Effect.promise(async () => (bridge(id) ? bridge(id)!.login(input) : off(id))),
      verify: (id, code) => Effect.promise(async () => (bridge(id) ? bridge(id)!.verify(code) : off(id))),
      logout: (id) => Effect.promise(async () => (bridge(id) ? bridge(id)!.logout() : off(id))),
      setChannel: Effect.fn("Connectors.setChannel")(function* (id, name) {
        const b = bridge(id);
        if (!b) return yield* Effect.fail<ApiError>({ _tag: "ConnectorRefused", reason: `没有 ${id} 这个连接` });
        const channel = yield* chat.channelByName(name);
        if (!channel) return yield* Effect.fail<ApiError>({ _tag: "ConnectorRefused", reason: `没有叫 ${name} 的频道` });
        return yield* Effect.tryPromise({
          try: () => b.setChannel(channel.id !== general ? channel.id : undefined),
          catch: (e): ApiError => ({ _tag: "ConnectorRefused", reason: message(e) }),
        });
      }),
    });
  });

export const layer = (options?: ConnectorOptions) => Layer.effect(Connectors, make(options));
