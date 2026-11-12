import { createHash, randomInt } from "node:crypto";

import { z } from "zod";

import { anySignal, exponential, isAbort, type Queue, retry, Semaphore, type Task, type TaskGroup } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import { type ChatMessage, type ConnectorLogin, type ConnectorStatus } from "@vibevalley/protocol";
import { channelOf, defaultOf } from "@vibevalley/protocol/rules";
import { messageId } from "@vibevalley/protocol/schema";

import { ApiError } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import { jsonOrNone } from "#/base/json.ts";
import type { Core } from "#/core/core.ts";
import type { Sql } from "#/infra/db.ts";
import type { Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Channel } from "#/modules/channel/channel.ts";
import type { Inbox } from "#/modules/inbox/inbox.ts";
import * as accountQ from "#db/connector_account.sql.ts";
import * as inboundQ from "#db/connector_inbound.sql.ts";
import * as outboxQ from "#db/connector_outbox.sql.ts";

import { type Adapter, AppFailed, failedWith, Inbound, type Linked, type Progress, type Secrets } from "./adapter.ts";
import { digestOver, flushText, isPairing, maxChars, userLine, shortId, splitText } from "./digest.ts";

/** WeChat's official client rests this long too. */
const stalePauseMs = 60 * 60_000;

const secretsOf = jsonOrNone(z.record(z.string(), z.string()));
const inboundOf = jsonOrNone(Inbound);

interface Account {
  secrets: Record<string, string>;
  user: string;
  pairCode: string;
  cursor: string;
  replyContext: string;
  lastInbound: number;
  pausedUntil: number;
  connectedAt: number;
  channel?: string;
}

const paused = (a: Account, now: number) => a.pausedUntil !== 0 && a.pausedUntil > now;

/** Why a step of the bridge did not go through: the database, the farm, or an app. Said as the status's error. */
export class BridgeError extends Error {
  override readonly name = "BridgeError";
}

/** The farm refused a bridge's step: in the words its status says. */
const refusedStep = (e: unknown): unknown => (e instanceof ApiError ? new BridgeError(e.message, { cause: e }) : e);

/** Runs every one of works with one signal; the first that fails stops the others, and all have ended before it throws. */
async function together(signal: AbortSignal, works: readonly ((signal: AbortSignal) => Promise<void>)[]): Promise<void> {
  const stop = new AbortController();
  const each = anySignal(signal, stop.signal);
  const settled = await Promise.allSettled(
    works.map(async (work) => {
      try {
        await work(each);
      } catch (e) {
        stop.abort(e);
        throw e;
      }
    }),
  );
  stop.abort();
  const failed = settled.find((r) => r.status === "rejected");
  if (failed) throw failed.reason;
}

interface BridgeEnv {
  readonly clock: Time;
  readonly sql: Sql;
  readonly log: Logger;
  readonly chat: Channel;
  readonly core: Core;
  readonly inbox: Inbox;
  readonly retryFirst: number;
  readonly retryMost: number;
  /** The service's tasks: each account's generation, the status said to the core. */
  readonly tasks: TaskGroup;
  /** A query whose own failure (the database's) is a BridgeError here: the status says it. */
  readonly tried: <A>(work: () => Promise<A>) => Promise<A>;
  /** work in one transaction; the database's failure is a BridgeError, as tried's. */
  readonly inTx: <A>(work: () => Promise<A>) => Promise<A>;
  readonly isClosing: () => boolean;
}

export const makeBridge = (env: BridgeEnv, adapter: Adapter, mail: { readonly outbox: Queue<void>; readonly inbox: Queue<void> }) => {
  const { clock, sql, chat, core, inbox, retryFirst, retryMost, tasks, tried, inTx, isClosing } = env;
  const now = () => clock.now();
  const id = adapter.id;
  const log = env.log.child(id);
  const say = async (text: string, channel: string | undefined, sendKey: string) => {
    try {
      await chat.user({ source: "connector", text, ...(channel ? { channel } : {}), envelope: sendKey });
    } catch (e) {
      throw refusedStep(e);
    }
  };

  let account: Account | undefined;
  /** A login going on: how far it is, and the code the user typed for it. None when no login is. */
  let signingIn: { readonly progress: Progress; readonly code: string } | undefined;
  // A login stopped by a newer one leaves the newer one's progress alone.
  let loginTry = 0;
  let err = "";
  const progressed = new Set<() => void>();
  // The coordinator: one command at a time; only it replaces the account, after all work of the old one has ended.
  const commands = new Semaphore(1);
  /** The account's work now: receiving, the inbox and the outbox; or a login. */
  let current: Task<unknown> | undefined;

  // What the page and the tests see: the status, said to the core whenever a part of it may have changed. the core keeps it only when it differs.
  const telling = new Semaphore(1);
  const told = () => {
    tasks.run(`${id} status`, () => telling.with(async () => core.apply({ type: "connectorChanged", status: await status() })));
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

  const reloadAccount = async () => {
    const r = await tried(() => accountQ.connectorAccount(sql, { connector: id }));
    if (r === undefined) {
      account = undefined;
      return;
    }
    const secrets = secretsOf(r.secrets);
    if (secrets === undefined) {
      setErr(t("server.connector.unreadSecrets"));
      log.error("vibevalley: the saved secrets cannot be read");
    }
    account = {
      secrets: secrets ?? {},
      user: r.user_id ?? "",
      pairCode: r.pair_code ?? "",
      cursor: r.cursor,
      replyContext: r.reply_context ?? "",
      lastInbound: r.last_inbound ?? 0,
      pausedUntil: r.paused_until ?? 0,
      connectedAt: r.connected_at,
      ...(r.channel_id ? { channel: r.channel_id } : {}),
    };
  };
  const reload = async () => {
    await reloadAccount();
    told();
  };
  /** A write the bridge goes on without. */
  const kept = async (work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (e) {
      if (!(e instanceof BridgeError)) throw e;
      log.error("vibevalley: connector", e.message);
    }
  };
  const snapshot = () => (account ? { ...account } : undefined);

  // How many wait to go out, as the status says it: counted in the database when not known, then moved by each change that commits.
  let pendingOut: number | undefined;
  let outChanges = 0;
  const outboxChanged = (by?: (n: number) => number) => {
    outChanges++;
    pendingOut = by && pendingOut !== undefined ? by(pendingOut) : undefined;
    told();
  };
  const pendingNow = async () => {
    if (pendingOut !== undefined) return pendingOut;
    const at = outChanges;
    try {
      const n = (await tried(() => outboxQ.countPendingOutbox(sql, { connector: id })))?.n ?? 0;
      if (at === outChanges) pendingOut = n;
      return n;
    } catch (e) {
      if (!(e instanceof BridgeError)) throw e;
      return 0;
    }
  };

  const status = async (): Promise<ConnectorStatus> => {
    const pending = await pendingNow();
    const state = chat.now();
    const s: ConnectorStatus = { id, state: "off", pending, error: err, qr: "", pairCode: "" };
    const a = account;
    if (a) {
      const where = a.channel ? channelOf(state, a.channel) : defaultOf(state);
      if (where?.name) s.channel = where.name;
    }
    if (signingIn !== undefined) return { ...s, state: signingIn.progress.state, qr: signingIn.progress.qr };
    if (!a) return s;
    if (!a.user)
      return {
        ...s,
        state: "pairing",
        pairCode: a.pairCode,
        since: a.connectedAt,
      };
    const stopped = paused(a, now());
    return {
      ...s,
      state: stopped ? "paused" : "connected",
      ...(stopped ? { pausedUntil: a.pausedUntil } : {}),
      user: shortId(a.user),
      since: a.connectedAt,
      ...(a.lastInbound !== 0 ? { lastInbound: a.lastInbound } : {}),
    };
  };

  /** Whether the pause was kept. */
  const pause = async () => {
    try {
      await tried(() => accountQ.pauseAccount(sql, { paused_until: now() + stalePauseMs, connector: id }));
      await reload();
      setErr(t("server.connector.expired"));
      return true;
    } catch (e) {
      if (!(e instanceof BridgeError)) throw e;
      setErr(e.message);
      return false;
    }
  };

  const located = async (message: ChatMessage["id"]) => {
    try {
      return await chat.messageLocation(message);
    } catch (e) {
      throw refusedStep(e);
    }
  };

  const quotedChannel = async (ext: string | undefined) => {
    if (!ext) return undefined;
    const rows = await tried(() => outboxQ.messageOfExt(sql, { connector: id, ext_id: ext }));
    const message = rows[0]?.message_id;
    if (!message) return undefined;
    return (await located(messageId(message)))?.channel.id;
  };

  // The outbox: one drain at a time, in order, never cut off halfway (a message sent and not marked would go twice): it
  // takes no signal, and a stop waits for it to end.
  const draining = new Semaphore(1);
  const drain = (late: boolean) =>
    draining.with(async () => {
      const a = snapshot();
      if (!a || !a.user) return true;
      let listed: outboxQ.PendingOutboxResult[];
      try {
        listed = await tried(() => outboxQ.pendingOutbox(sql, { connector: id }));
      } catch (e) {
        if (!(e instanceof BridgeError)) throw e;
        log.error("vibevalley: the outbox could not be read", e.message);
        return false;
      }
      const allowed = new Set<string>();
      for (const message of new Set(listed.map((row) => row.message_id))) {
        if ((await inbox.handoffState(message)) === "unseen") allowed.add(message);
        else await tried(() => outboxQ.dropPendingOutboxForMessage(sql, { message_id: message }));
      }
      const pending = listed.filter((row) => allowed.has(row.message_id));
      if (pending.length !== listed.length) outboxChanged();
      if (paused(a, now())) return true;
      if (pending.length === 0) return true;
      const batches =
        late && pending.length > digestOver
          ? [{ ids: pending.map((r) => r.id), text: flushText(pending.map((r) => r.body))[0] ?? "" }]
          : pending.map((r) => ({ ids: [r.id], text: r.body }));
      for (const out of batches) {
        let extId: string;
        try {
          extId = await adapter.send(a.secrets, a.user, out.text, a.replyContext);
        } catch (refused) {
          if (!(refused instanceof AppFailed)) throw refused;
          for (const oid of out.ids) await kept(() => tried(() => outboxQ.outboxFailed(sql, { error: refused.message || null, id: oid })));
          if (refused.kind === "stale") await pause();
          // The app would not take it now (WeChat's, QQ's reply window): tried again later, and with the user's next message.
          else if (refused.kind === "restricted") setErr("");
          else setErr(refused.message);
          return false;
        }
        try {
          await inTx(async () => {
            for (const oid of out.ids) await tried(() => outboxQ.outboxSent(sql, { sent_at: now(), ext_id: extId || null, id: oid }));
          });
        } catch (e) {
          if (!(e instanceof BridgeError)) throw e;
          outboxChanged();
          setErr(e.message);
          return false;
        }
        outboxChanged((n) => n - out.ids.length);
        setErr("");
      }
      return true;
    });
  const retire = (reason: string) => outboxQ.dropPendingOutbox(sql, { error: reason, connector: id });

  const offer = async (m: ChatMessage) => {
    const a = snapshot();
    if (!a || !a.user) return;
    if ((await inbox.handoffState(m.id)) !== "unseen") return;
    let added = 0;
    try {
      const place = await located(m.id);
      if (place && place.top === (a.channel ?? chat.defaultChannel())) {
        const pieces = splitText(userLine(m, place.channel), maxChars[id]);
        const at = now();
        await inTx(async () => {
          for (const piece of pieces) await tried(() => outboxQ.addOutbox(sql, { id: newId(), connector: id, message_id: m.id, body: piece, created_at: at }));
        });
        added = pieces.length;
      }
    } catch (e) {
      if (!(e instanceof BridgeError)) throw e;
      outboxChanged();
      setErr(e.message);
      return;
    }
    if (added === 0) return;
    outboxChanged((n) => n + added);
    mail.outbox.offer(undefined);
  };

  /** A wake on queue, or ms gone by: whether it was the wake. */
  const wokeWithin = async (queue: Queue<void>, ms: number, signal: AbortSignal) => {
    const settle = new AbortController();
    const both = anySignal(signal, settle.signal);
    try {
      return await Promise.race([queue.take(both).then(() => true), clock.sleep(ms, both).then(() => false)]);
    } finally {
      settle.abort();
    }
  };

  // What is held is tried again after retryFirst, then twice as long after each try that fails (up to retryMost), until
  // one sends all.
  const held = new Error("held");
  const heldTried = (signal: AbortSignal) =>
    retry(
      async () => {
        if (!(await drain(false))) throw held;
      },
      { retries: Number.POSITIVE_INFINITY, delay: exponential(retryFirst, 2, retryMost), clock, signal },
    );
  const outboxRun = async (signal: AbortSignal) => {
    for (;;) {
      if (await wokeWithin(mail.outbox, retryFirst, signal)) await drain(false);
      else await heldTried(signal);
    }
  };

  const got = async (m: Inbound) => {
    const a = snapshot();
    if (!a) return;
    if (!a.user) {
      if (!a.pairCode || !isPairing(m.text, a.pairCode)) return;
      const at = now();
      await inTx(async () => {
        await tried(() => accountQ.accountUser(sql, { user_id: m.from || null, connector: id }));
        await tried(() => accountQ.accountReply(sql, { reply_context: m.reply || null, at, connector: id }));
        if (m.id) await tried(() => inboundQ.deliverInbound(sql, { connector: id, ext_id: m.id }));
      });
      // Told once the user has the word: the status is not paired before the app's confirmation went out.
      await reloadAccount();
      try {
        await adapter.send(a.secrets, m.from, t("server.connector.paired"), m.reply);
      } catch (e) {
        if (!(e instanceof AppFailed)) throw e;
        log.warn(`vibevalley: ${id}: the pairing confirmation was not sent`, e.message);
      }
      told();
      return;
    }
    if (m.from !== a.user) return;
    await tried(() => accountQ.accountReply(sql, { reply_context: m.reply || null, at: now(), connector: id }));
    await reload();
    const channel = (await quotedChannel(m.quoted)) ?? snapshot()?.channel;
    if (m.text) {
      // Keyed by the app's message: one said but not yet marked delivered when the farm stopped is said once, not twice.
      const sendKey = createHash("sha256").update(`${id}:${m.id}`).digest("hex");
      await say(m.text, channel, sendKey);
    }
    // The user's action withdraws stale handoffs before its fresh reply opens the platform's delivery window.
    await drain(true);
  };

  // The inbox: what the app handed over, delivered to the orchestrator in order.
  const accept = async (messages: readonly Inbound[], cursor: string) => {
    try {
      await inTx(async () => {
        if ((await tried(() => accountQ.connectorAccount(sql, { connector: id }))) === undefined) throw new BridgeError(t("server.connector.stopped"));
        for (const m of messages) {
          const withId = Inbound.parse(m.id ? m : { ...m, id: newId() });
          await tried(() => inboundQ.acceptInbound(sql, { connector: id, ext_id: withId.id, payload: JSON.stringify(withId), created_at: now() }));
        }
        if (cursor) await tried(() => accountQ.accountCursor(sql, { connector: id, cursor }));
      });
    } catch (e) {
      if (e instanceof BridgeError && !isClosing()) setErr(e.message);
      throw e;
    }
    mail.inbox.offer(undefined);
  };
  const drainInbox = async () => {
    const rows = await tried(() => inboundQ.pendingInbound(sql, { connector: id }));
    for (const row of rows) {
      const m = inboundOf(row.payload);
      if (m === undefined || m.id !== row.ext_id) {
        // A malformed row can never be delivered; settle it explicitly so later valid messages are not blocked.
        log.error(`vibevalley: discarding malformed durable inbound ${row.ext_id}`);
        await tried(() => inboundQ.deliverInbound(sql, { connector: id, ext_id: row.ext_id }));
        continue;
      }
      await got(m);
      await tried(() => inboundQ.deliverInbound(sql, { connector: id, ext_id: row.ext_id }));
    }
  };
  // Looked at once a second, or at once when something was accepted.
  const inboxRun = async (signal: AbortSignal) => {
    for (;;) {
      try {
        await drainInbox();
      } catch (e) {
        if (!(e instanceof BridgeError)) throw e;
        setErr(e.message);
      }
      await wokeWithin(mail.inbox, 1_000, signal);
    }
  };

  /** Until the app's connection ends. what it hands over is kept durably before the app is told it is taken. */
  const receive = async (secrets: Secrets, signal: AbortSignal) => {
    const row = await tried(() => accountQ.connectorAccount(sql, { connector: id }));
    let sealed = false;
    const io = {
      cursor: row?.cursor ?? "",
      accept: async (messages: readonly Inbound[], c: string) => {
        if (sealed) throw failedWith("canceled");
        try {
          await accept(messages, c);
        } catch (e) {
          if (e instanceof BridgeError) throw failedWith(e.message);
          throw e;
        }
      },
    };
    try {
      await adapter.receive(secrets, io, signal);
    } finally {
      sealed = true;
    }
  };
  // A loop, not a retry: each branch waits its own way, and only a failure counts toward the longer wait.
  const receiving = async (signal: AbortSignal) => {
    let failures = 0;
    for (;;) {
      const a = snapshot();
      if (!a) return;
      if (paused(a, now())) {
        await clock.sleep(Math.max(0, a.pausedUntil - now()), signal);
        try {
          await tried(() => accountQ.pauseAccount(sql, { paused_until: null, connector: id }));
          await reload();
        } catch (e) {
          if (!(e instanceof BridgeError)) throw e;
          setErr(e.message);
          await clock.sleep(Math.min(30_000, retryMost), signal);
        }
        continue;
      }
      let stopped: AppFailed;
      try {
        await receive(a.secrets, signal);
        stopped = failedWith(t("server.connector.stopped"));
      } catch (e) {
        if (isAbort(e, signal)) throw e;
        if (e instanceof AppFailed) stopped = e;
        else if (e instanceof BridgeError) stopped = failedWith(e.message);
        else throw e;
      }
      if (stopped.kind === "stale") {
        if (!(await pause())) await clock.sleep(Math.min(30_000, retryMost), signal);
        continue;
      }
      setErr(stopped.message);
      failures++;
      let wait = 2_000;
      if (failures >= 3) {
        wait = 30_000;
        failures = 0;
      }
      await clock.sleep(wait, signal);
    }
  };

  /** Starts work as the account's generation, on the service's tasks: a failure is logged, an abort is the stop. */
  const generation = (work: (signal: AbortSignal) => Promise<void>): Task<unknown> =>
    tasks.run(`${id} generation`, async (signal) => {
      try {
        await work(signal);
      } catch (e) {
        if (isAbort(e, signal)) return;
        log.error("vibevalley: connector", e);
      }
    });
  const stopGeneration = async () => {
    const g = current;
    current = undefined;
    await g?.abort();
  };
  const connected = () => (account && !isClosing() ? generation((signal) => together(signal, [receiving, inboxRun, outboxRun])) : undefined);
  const resetProgress = () => {
    signingIn = undefined;
    changed();
  };
  const loginResult = (g: Task<unknown>, result: Linked | AppFailed) =>
    commands.with(async () => {
      if (g !== current) return;
      await stopGeneration();
      let failure = result instanceof AppFailed ? result.message : undefined;
      if (!(result instanceof AppFailed) && !isClosing()) {
        const linked = result;
        const pair = linked.user ? null : String(100_000 + randomInt(900_000));
        const at = now();
        try {
          await inTx(async () => {
            await tried(() =>
              accountQ.connectAccount(sql, {
                connector: id,
                secrets: JSON.stringify(linked.secrets),
                user_id: linked.user || null,
                pair_code: pair,
                connected_at: at,
              }),
            );
            await tried(() => inboundQ.clearInbound(sql, { connector: id }));
            await tried(() => retire(t("server.connector.switched")));
          });
          outboxChanged(() => 0);
          await reload();
        } catch (e) {
          if (!(e instanceof BridgeError)) throw e;
          outboxChanged();
          failure = e.message;
        }
      }
      setErr(failure ?? "");
      resetProgress();
      current = connected();
    });
  const loggingIn = (input: ConnectorLogin) => {
    // A login a newer one replaced is aborted, so its progress cannot come after the newer one's.
    const g: Task<unknown> = generation(async (signal) => {
      let result: Linked | AppFailed;
      try {
        result = await adapter.login(
          input,
          (p) => {
            signingIn = { progress: p, code: signingIn?.code ?? "" };
            changed();
          },
          () => signingIn?.code ?? "",
          signal,
        );
      } catch (e) {
        if (!(e instanceof AppFailed) || isAbort(e, signal)) throw e;
        result = e;
      }
      // The login's answer is taken by the coordinator, on its own task: replacing this generation must not cut it short.
      tasks.run(`${id} login`, () => loginResult(g, result));
    });
    return g;
  };

  return {
    id,
    load: () => kept(reload),
    status,
    offer: (m: ChatMessage) => commands.with(async () => (isClosing() ? undefined : offer(m))),
    changed: () => {
      outboxChanged();
      mail.outbox.offer(undefined);
    },
    resume: () =>
      commands.with(async () => {
        current ??= connected();
      }),
    login: async (input: ConnectorLogin) => {
      const started = await commands.with(async () => {
        if (signingIn !== undefined && input.force !== true) return loginTry;
        await stopGeneration();
        loginTry++;
        setErr("");
        signingIn = { progress: { state: "waiting", qr: "" }, code: "" };
        current = loggingIn(input);
        told();
        return loginTry;
      });
      // The answer carries the code when it shows within a moment.
      const shown = Promise.withResolvers<void>();
      const done = () => {
        if (loginTry !== started || signingIn === undefined || signingIn.progress.qr) shown.resolve();
      };
      progressed.add(done);
      done();
      const moment = new AbortController();
      try {
        await Promise.race([shown.promise, clock.sleep(1_500, moment.signal)]);
      } finally {
        moment.abort();
        progressed.delete(done);
      }
      return status();
    },
    verify: (code: string) => {
      // A code with no login going on is for none: the next login starts with none.
      if (signingIn !== undefined)
        signingIn = {
          progress: signingIn.progress.state === "verify" ? { state: "scanned", qr: signingIn.progress.qr } : signingIn.progress,
          code: code.trim(),
        };
      told();
      return status();
    },
    logout: async () => {
      await commands.with(async () => {
        await stopGeneration();
        try {
          await inTx(async () => {
            await tried(() => accountQ.disconnectAccount(sql, { connector: id }));
            await tried(() => inboundQ.clearInbound(sql, { connector: id }));
            await tried(() => retire(t("server.connector.disconnected")));
          });
          outboxChanged(() => 0);
          resetProgress();
          loginTry++;
          account = undefined;
          setErr("");
        } catch (e) {
          if (!(e instanceof BridgeError)) throw e;
          outboxChanged();
          resetProgress();
          loginTry++;
          setErr(e.message);
          current = connected();
        }
        told();
      });
      return status();
    },
    /** Throws BridgeError when the database did not take it. */
    setChannel: async (to: string | undefined) => {
      await tried(() => accountQ.accountChannel(sql, { channel_id: to ?? null, connector: id }));
      await reload();
      return status();
    },
    stop: () => commands.with(stopGeneration),
    hasAccount: () => account !== undefined,
  };
};
