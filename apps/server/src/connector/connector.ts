import { createHash, randomInt } from "node:crypto";

import {
  Cause,
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Fiber,
  FiberSet,
  Layer,
  Option,
  Predicate,
  Queue,
  Schedule,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { HttpClient } from "effect/http";
import type { SqlClient, SqlError } from "effect/sql";

import { t } from "@vibevalley/i18n";
import { type ChatMessage, type ConnectorID, type ConnectorLogin, type ConnectorStatus, dayMs } from "@vibevalley/protocol";
import { type ApiError } from "@vibevalley/protocol/api";
import { channelOf, defaultOf } from "@vibevalley/protocol/rules";
import { messageId } from "@vibevalley/protocol/schema";

import { newId } from "#/base/ids.ts";
import { Channel } from "#/channel/channel.ts";
import { Core } from "#/core/core.ts";
import { reasonOf } from "#/errors.ts";
import { Inbox } from "#/inbox/inbox.ts";
import { causeMessage, Db } from "#/infra/db.ts";
import { Ingress } from "#/ingress/ingress.ts";
import * as accountQ from "#db/connector_account.sql.ts";
import * as inboundQ from "#db/connector_inbound.sql.ts";
import * as outboxQ from "#db/connector_outbox.sql.ts";

import { type Adapter, type AppFailed, failedWith, type Inbound, type Linked, type Progress, type Secrets } from "./adapter.ts";
import { digestOver, flushText, isPairing, maxChars, ownerLine, shortId, splitText } from "./digest.ts";
import { type FeishuApi, FeishuClient, feishuAdapter } from "./feishu.ts";
import { type QQApi, QQClient, qqAdapter } from "./qq.ts";
import { type WeixinApi, WeixinClient, weixinAdapter } from "./weixin.ts";

/** WeChat's official client rests this long too. */
const stalePauseMs = 60 * 60_000;
/** How long a message in or out is kept after it went through, for a reply to point at. */
const keptDays = 30;

const InboundSchema: Schema.Codec<Inbound> = Schema.Struct({
  id: Schema.String,
  from: Schema.String,
  text: Schema.String,
  reply: Schema.String,
  quoted: Schema.String,
});

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

/** Why a step of the bridge did not go through: the database, the farm, or an app. Said as the status's error. */
class BridgeError extends Schema.TaggedError<BridgeError, { readonly brand: unique symbol }>()("BridgeError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** A bridge's step that the database or the farm failed, in the words its status says. */
const bridgeError = (e: SqlError.SqlError | Schema.SchemaError | Cause.NoSuchElementError | ApiError) =>
  new BridgeError({ message: causeMessage(e), cause: e });

const Secrets = Schema.Record(Schema.String, Schema.String);

export class Connector extends Context.Service<
  Connector,
  {
    readonly list: () => Effect.Effect<ConnectorStatus[]>;
    readonly login: (id: ConnectorID, input: ConnectorLogin) => Effect.Effect<ConnectorStatus>;
    readonly verify: (id: ConnectorID, code: string) => Effect.Effect<ConnectorStatus>;
    readonly logout: (id: ConnectorID) => Effect.Effect<ConnectorStatus>;
    readonly setChannel: (id: ConnectorID, name: string) => Effect.Effect<ConnectorStatus, ApiError>;
  }
>()("vibevalley/Connector") {
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
    /** retryFirst, then twice as long after each try that fails, up to retryMost. */
    const outboxBackoff = Schedule.exponential(Duration.millis(retryFirst)).pipe(
      Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, Duration.millis(retryMost)))),
    );
    // The bridges' fibers (each account's generation, the status said to the core) belong to this service.
    const forkHere = yield* FiberSet.makeRuntime();
    /** The database's own failures stay failures here: the status says them. */
    const tried = <A>(e: Effect.Effect<A, SqlError.SqlError | Schema.SchemaError | Cause.NoSuchElementError, SqlClient.SqlClient>) =>
      Effect.mapError(db.attempt(e), bridgeError);
    const inTx = <A>(work: Effect.Effect<A, SqlError.SqlError | Schema.SchemaError | Cause.NoSuchElementError>) =>
      Effect.mapError(db.attemptTx(work), bridgeError);
    let closing = false;
    const say = (text: string, channel: string | undefined, sendKey: string) =>
      ingress.owner({ source: "connector", text, ...(channel ? { channel } : {}), envelope: sendKey });

    // Each queue is a wake: holding one at most, so wakes while it works are one more look, never lost.
    const bridgeOf = (adapter: Adapter, mail: { readonly outbox: Queue.Queue<void>; readonly inbox: Queue.Queue<void> }) => {
      const id = adapter.id;
      let account: Account | undefined;
      let progress: Progress | undefined;
      let verifyCode = "";
      // A login stopped by a newer one leaves the newer one's progress alone.
      let loginTry = 0;
      let err = "";
      const progressed = new Set<() => void>();
      // The coordinator: one command at a time; only it replaces the account, after all work of the old one has ended.
      const commands = Semaphore.makeUnsafe(1);
      /** The account's work now: receiving, the inbox and the outbox; or a login. */
      let current: Fiber.Fiber<unknown> | undefined;

      // What the page and the tests see: the status, said to the core whenever a part of it may have changed. the core keeps it only when it differs.
      const telling = Semaphore.makeUnsafe(1);
      const told = () => {
        forkHere(telling.withPermits(1)(Effect.flatMap(status, (s) => core.apply({ type: "connectorChanged", status: s }))));
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
        const row = yield* tried(Effect.catchNoSuchElement(accountQ.connectorAccount({ connector: id })));
        if (Option.isNone(row)) {
          account = undefined;
          return;
        }
        const r = row.value;
        const secrets = Schema.decodeOption(Schema.fromJsonString(Secrets))(r.secrets);
        if (Option.isNone(secrets)) {
          setErr(t("server.connector.unreadSecrets"));
          yield* Effect.logError("vibevalley: the saved secrets cannot be read").pipe(Effect.annotateLogs({ connector: id }));
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
      const kept = <A>(e: Effect.Effect<A, BridgeError>) =>
        Effect.catch(e, (x) => Effect.logError("vibevalley: connector", x.message).pipe(Effect.annotateLogs({ connector: id })));
      const snapshot = () => (account ? { ...account } : undefined);

      // How many wait to go out, as the status says it: counted in the database when not known, then moved by each change that commits.
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
        return tried(Effect.map(outboxQ.countPendingOutbox({ connector: id }), (r) => r.n ?? 0)).pipe(
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
        const s: ConnectorStatus = { id, state: "off", pending, error: err, qr: "", pairCode: "" };
        const a = account;
        if (a) {
          const where = a.channel ? channelOf(state, a.channel) : defaultOf(state);
          if (where?.name) s.channel = where.name;
        }
        if (progress) return { ...s, state: progress.state, qr: progress.qr };
        if (!a) return s;
        if (!a.owner)
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
          owner: shortId(a.owner),
          since: a.connectedAt,
          ...(a.lastInbound !== 0 ? { lastInbound: a.lastInbound } : {}),
        };
      });

      /** Whether the pause was kept. */
      const pause = Effect.gen(function* () {
        yield* tried(accountQ.pauseAccount({ paused_until: now() + stalePauseMs, connector: id }));
        yield* reload;
        setErr(t("server.connector.expired"));
        return true;
      }).pipe(
        Effect.catch((e) =>
          Effect.as(
            Effect.sync(() => setErr(e.message)),
            false,
          ),
        ),
      );

      const quotedChannel = Effect.fnUntraced(function* (ext: string | undefined) {
        if (!ext) return undefined;
        const rows = yield* tried(outboxQ.messageOfExt({ connector: id, ext_id: ext }));
        const message = rows[0]?.message_id;
        if (!message) return undefined;
        return (yield* Effect.mapError(chat.messageLocation(messageId(message)), bridgeError))?.channel.id;
      });

      // The outbox: one drain at a time, in order, never cut off halfway (a message sent and not marked would go twice).
      const draining = Semaphore.makeUnsafe(1);
      const drain = (late: boolean) =>
        draining.withPermits(1)(
          Effect.gen(function* () {
            const a = snapshot();
            if (!a || !a.owner) return true;
            const listed = yield* tried(outboxQ.pendingOutbox({ connector: id })).pipe(
              Effect.catch((e) =>
                Effect.as(Effect.logError("vibevalley: the outbox could not be read", e.message).pipe(Effect.annotateLogs({ connector: id })), undefined),
              ),
            );
            if (!listed) return false;
            const allowed = new Set<string>();
            yield* Effect.forEach(
              new Set(listed.map((row) => row.message_id)),
              (message) =>
                Effect.gen(function* () {
                  if ((yield* inbox.handoffState(message)) === "unseen") allowed.add(message);
                  else yield* tried(outboxQ.dropPendingOutboxForMessage({ message_id: message }));
                }),
              { discard: true },
            );
            const pending = listed.filter((row) => allowed.has(row.message_id));
            if (pending.length !== listed.length) outboxChanged();
            if (paused(a, now())) return true;
            if (pending.length === 0) return true;
            const batches =
              late && pending.length > digestOver
                ? [{ ids: pending.map((r) => r.id), text: flushText(pending.map((r) => r.body))[0]! }]
                : pending.map((r) => ({ ids: [r.id], text: r.body }));
            for (const out of batches) {
              const sent = yield* adapter.send(a.secrets, a.owner, out.text, a.replyContext).pipe(
                Effect.flatMap((extId) =>
                  inTx(
                    Effect.forEach(out.ids, (oid) => db.attempt(outboxQ.outboxSent({ sent_at: now(), ext_id: extId || null, id: oid })), {
                      discard: true,
                    }),
                  ).pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        outboxChanged((n) => n - out.ids.length);
                        setErr("");
                      }),
                    ),
                    Effect.as(true),
                    Effect.catch((e) =>
                      Effect.sync(() => {
                        outboxChanged();
                        setErr(e.message);
                        return false;
                      }),
                    ),
                  ),
                ),
                Effect.catch((refused) =>
                  Effect.gen(function* () {
                    yield* Effect.forEach(out.ids, (oid) => kept(tried(outboxQ.outboxFailed({ error: refused.message || null, id: oid }))), { discard: true });
                    if (refused.kind === "stale") yield* pause;
                    // The app would not take it now (WeChat's, QQ's reply window): tried again later, and with the owner's next message.
                    else if (refused.kind === "restricted") setErr("");
                    else setErr(refused.message);
                    return false;
                  }),
                ),
              );
              if (!sent) return false;
            }
            return true;
          }),
        );
      const retire = (reason: string) => db.attempt(outboxQ.dropPendingOutbox({ error: reason, connector: id }));

      const offer = Effect.fnUntraced(function* (m: ChatMessage) {
        const a = snapshot();
        if (!a || !a.owner) return;
        if ((yield* inbox.handoffState(m.id)) !== "unseen") return;
        yield* Effect.gen(function* () {
          const place = yield* Effect.mapError(chat.messageLocation(m.id), bridgeError);
          if (!place || place.top !== (a.channel ?? chat.defaultChannel())) return 0;
          const pieces = splitText(ownerLine(m, place.channel), maxChars[id]);
          const at = now();
          yield* inTx(
            Effect.forEach(pieces, (piece) => db.attempt(outboxQ.addOutbox({ id: newId(), connector: id, message_id: m.id, body: piece, created_at: at })), {
              discard: true,
            }),
          );
          return pieces.length;
        }).pipe(
          Effect.match({
            onFailure: (e) => {
              outboxChanged();
              setErr(e.message);
            },
            onSuccess: (added) => {
              if (added === 0) return;
              outboxChanged((n) => n + added);
              Queue.offerUnsafe(mail.outbox, undefined);
            },
          }),
        );
      });

      // What is held is tried again after retryFirst, then on outboxBackoff while tries fail, until one sends all.
      const heldTried = Effect.retry(
        Effect.filterOrFail(
          Effect.uninterruptible(drain(false)),
          (done) => done,
          () => "held" as const,
        ),
        outboxBackoff,
      );
      const outboxRun = Effect.forever(
        // @effect-diagnostics-next-line raceFirstWithSleepToTimeout:off -- the timed arm is the held mail's next try, not a timeout
        Effect.raceFirst(Effect.andThen(Effect.sleep(retryFirst), heldTried), Effect.andThen(Queue.take(mail.outbox), Effect.uninterruptible(drain(false)))),
      );

      const got = Effect.fnUntraced(function* (m: Inbound) {
        const a = snapshot();
        if (!a) return;
        if (!a.owner) {
          if (!a.pairCode || !isPairing(m.text, a.pairCode)) return;
          const at = now();
          yield* inTx(
            Effect.gen(function* () {
              yield* db.attempt(accountQ.accountOwner({ owner_id: m.from || null, connector: id }));
              yield* db.attempt(accountQ.accountReply({ reply_context: m.reply || null, at, connector: id }));
              if (m.id) yield* db.attempt(inboundQ.deliverInbound({ connector: id, ext_id: m.id }));
            }),
          );
          // Told once the owner has the word: the status is not paired before the app's confirmation went out.
          yield* reloadAccount;
          yield* Effect.ignore(adapter.send(a.secrets, m.from, t("server.connector.paired"), m.reply), {
            log: "Warn",
            message: `vibevalley: ${id}: the pairing confirmation was not sent`,
          });
          told();
          return;
        }
        if (m.from !== a.owner) return;
        yield* tried(accountQ.accountReply({ reply_context: m.reply || null, at: now(), connector: id }));
        yield* reload;
        const channel = (yield* quotedChannel(m.quoted)) ?? snapshot()?.channel;
        if (m.text) {
          // Keyed by the app's message: one said but not yet marked delivered when the farm stopped is said once, not twice.
          const sendKey = createHash("sha256").update(`${id}:${m.id}`).digest("hex");
          yield* Effect.mapError(say(m.text, channel, sendKey), (e) => new BridgeError({ message: reasonOf(e), cause: e }));
        }
        // The owner's action withdraws stale handoffs before its fresh reply opens the platform's delivery window.
        yield* drain(true);
      });

      // The inbox: what the app handed over, delivered to the orchestrator in order.
      const accept = (messages: readonly Inbound[], cursor: string) =>
        inTx(
          Effect.gen(function* () {
            yield* db.attempt(accountQ.connectorAccount({ connector: id }));
            yield* Effect.forEach(
              messages,
              (m) =>
                Effect.gen(function* () {
                  const withId = m.id ? m : { ...m, id: newId() };
                  yield* db.attempt(
                    inboundQ.acceptInbound({
                      connector: id,
                      ext_id: withId.id,
                      payload: JSON.stringify(withId),
                      created_at: yield* Clock.currentTimeMillis,
                    }),
                  );
                }),
              { discard: true },
            );
            if (cursor) yield* db.attempt(accountQ.accountCursor({ connector: id, cursor }));
          }),
        ).pipe(
          Effect.tapError((e) => Effect.sync(() => (closing ? undefined : setErr(e.message)))),
          Effect.tap(() => Queue.offer(mail.inbox, undefined)),
        );
      const drainInbox = Effect.gen(function* () {
        const rows = yield* tried(inboundQ.pendingInbound({ connector: id }));
        for (const row of rows) {
          const m = Schema.decodeOption(Schema.fromJsonString(InboundSchema))(row.payload);
          if (Option.isNone(m) || m.value.id !== row.ext_id) {
            // A malformed row can never be delivered; settle it explicitly so later valid messages are not blocked.
            yield* Effect.logError(`vibevalley: discarding malformed durable inbound ${row.ext_id}`).pipe(Effect.annotateLogs({ connector: id }));
            yield* tried(inboundQ.deliverInbound({ connector: id, ext_id: row.ext_id }));
            continue;
          }
          yield* got(m.value);
          yield* tried(inboundQ.deliverInbound({ connector: id, ext_id: row.ext_id }));
        }
      });
      // Looked at once a second, or at once when something was accepted.
      const inboxRun = Effect.forever(
        Effect.andThen(
          Effect.catch(drainInbox, (e) => Effect.sync(() => setErr(e.message))),
          Effect.timeoutOrElse(Queue.take(mail.inbox), { duration: "1 second", orElse: () => Effect.void }),
        ),
      );

      /** Until the app's connection ends. what it hands over is kept durably before the app is told it is taken. */
      const receive = (secrets: Secrets) =>
        Effect.gen(function* () {
          const row = yield* tried(Effect.catchNoSuchElement(accountQ.connectorAccount({ connector: id })));
          const cursor = Option.match(row, { onNone: () => "", onSome: (a) => a.cursor });
          let sealed = false;
          const io = {
            cursor,
            accept: (messages: readonly Inbound[], c: string) =>
              Effect.suspend(() => (sealed ? Effect.fail(failedWith("canceled")) : Effect.mapError(accept(messages, c), (e) => failedWith(e.message)))),
          };
          return yield* adapter.receive(secrets, io).pipe(Effect.ensuring(Effect.sync(() => (sealed = true))));
        });
      // A loop, not a Schedule: each branch waits its own way, and only a failure counts toward the longer wait.
      const receiving = Effect.gen(function* () {
        let failures = 0;
        for (;;) {
          const a = snapshot();
          if (!a) return;
          if (paused(a, now())) {
            yield* Effect.sleep(Math.max(0, a.pausedUntil - now()));
            yield* Effect.andThen(tried(accountQ.pauseAccount({ paused_until: null, connector: id })), reload).pipe(
              Effect.catch((e) => {
                setErr(e.message);
                return Effect.sleep(Math.min(30_000, retryMost));
              }),
            );
            continue;
          }
          const stopped = yield* receive(a.secrets).pipe(
            Effect.as(failedWith(t("server.connector.stopped"))),
            Effect.catch((e) => Effect.succeed(Predicate.isTagged(e, "AppFailed") ? e : failedWith(e.message))),
          );
          if (stopped.kind === "stale") {
            if (!(yield* pause)) yield* Effect.sleep(Math.min(30_000, retryMost));
            continue;
          }
          setErr(stopped.message);
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
      const generation = <A, E>(work: Effect.Effect<A, E>) =>
        forkHere(
          work.pipe(
            Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError("vibevalley: connector", cause))),
            Effect.annotateLogs({ connector: id }),
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
      const loginResult = (g: Fiber.Fiber<unknown, unknown>, result: Linked | AppFailed) =>
        commands.withPermits(1)(
          Effect.gen(function* () {
            if (g !== current) return;
            yield* stopGeneration;
            let failure = Predicate.isTagged(result, "AppFailed") ? result.message : undefined;
            if (!Predicate.isTagged(result, "AppFailed") && !closing) {
              const linked = result;
              const pair = linked.owner ? null : String(100_000 + randomInt(900_000));
              const at = yield* Clock.currentTimeMillis;
              const failedConnect = yield* inTx(
                Effect.gen(function* () {
                  yield* db.attempt(
                    accountQ.connectAccount({
                      connector: id,
                      secrets: JSON.stringify(linked.secrets),
                      owner_id: linked.owner || null,
                      pair_code: pair,
                      connected_at: at,
                    }),
                  );
                  yield* db.attempt(inboundQ.clearInbound({ connector: id }));
                  yield* retire(t("server.connector.switched"));
                }),
              ).pipe(
                Effect.andThen(Effect.sync(() => outboxChanged(() => 0))),
                Effect.andThen(reload),
                Effect.as(undefined),
                Effect.catch((e) =>
                  Effect.sync(() => {
                    outboxChanged();
                    return e.message;
                  }),
                ),
              );
              if (failedConnect) failure = failedConnect;
            }
            setErr(failure ?? "");
            resetProgress();
            current = connected();
          }),
        );
      const loggingIn = (input: ConnectorLogin) => {
        // A login a newer one replaced is interrupted, so its progress cannot come after the newer one's.
        const login = adapter.login(
          input,
          (p) =>
            Effect.sync(() => {
              progress = p;
              changed();
            }),
          Effect.sync(() => verifyCode),
        );
        // The login's answer is taken by the coordinator, on its own fiber: replacing this generation must not cut it short.
        return generation(
          Effect.withFiber((g) =>
            login.pipe(
              Effect.catch(Effect.succeed),
              Effect.flatMap((r) => Effect.sync(() => void forkHere(loginResult(g, r)))),
            ),
          ),
        );
      };

      return {
        id,
        load: kept(reload),
        status,
        offer: (m: ChatMessage) => commands.withPermits(1)(Effect.suspend(() => (closing ? Effect.void : offer(m)))),
        changed: () => {
          outboxChanged();
          Queue.offerUnsafe(mail.outbox, undefined);
        },
        resume: commands.withPermits(1)(
          Effect.sync(() => {
            current ??= connected();
          }),
        ),
        login: Effect.fnUntraced(function* (input: ConnectorLogin) {
          const started = yield* commands.withPermits(1)(
            Effect.gen(function* () {
              if (progress && input.force !== true) return loginTry;
              yield* stopGeneration;
              loginTry++;
              setErr("");
              verifyCode = "";
              progress = { state: "waiting", qr: "" };
              current = loggingIn(input);
              told();
              return loginTry;
            }),
          );
          // The answer carries the code when it shows within a moment.
          const shown = Deferred.makeUnsafe<void>();
          const done = () => {
            if (loginTry !== started || !progress || progress.qr) Deferred.doneUnsafe(shown, Effect.void);
          };
          progressed.add(done);
          done();
          yield* Deferred.await(shown).pipe(Effect.timeoutOption(1_500), Effect.ensuring(Effect.sync(() => progressed.delete(done))));
          return yield* status;
        }),
        verify: (code: string) =>
          Effect.suspend(() => {
            verifyCode = code.trim();
            if (progress?.state === "verify") progress = { state: "scanned", qr: progress.qr };
            told();
            return status;
          }),
        logout: Effect.andThen(
          commands.withPermits(1)(
            Effect.gen(function* () {
              yield* stopGeneration;
              yield* inTx(
                Effect.gen(function* () {
                  yield* db.attempt(accountQ.disconnectAccount({ connector: id }));
                  yield* db.attempt(inboundQ.clearInbound({ connector: id }));
                  yield* retire(t("server.connector.disconnected"));
                }),
              ).pipe(
                Effect.match({
                  onFailure: (e) => {
                    outboxChanged();
                    resetProgress();
                    loginTry++;
                    setErr(e.message);
                    current = connected();
                  },
                  onSuccess: () => {
                    outboxChanged(() => 0);
                    resetProgress();
                    loginTry++;
                    account = undefined;
                    setErr("");
                  },
                }),
              );
              told();
            }),
          ),
          status,
        ),
        setChannel: (to: string | undefined) =>
          Effect.andThen(Effect.andThen(tried(accountQ.accountChannel({ channel_id: to ?? null, connector: id })), reload), status),
        stop: commands.withPermits(1)(stopGeneration),
        hasAccount: () => account !== undefined,
      };
    };

    const http = yield* HttpClient.HttpClient;
    const adapters = [
      weixinAdapter(options.weixin ?? new WeixinClient(http)),
      feishuAdapter(options.feishu ?? new FeishuClient(http)),
      qqAdapter(options.qq ?? new QQClient(http)),
    ];
    const bridges = yield* Effect.forEach(adapters, (a) =>
      Effect.map(Effect.all({ outbox: Queue.sliding<void>(1), inbox: Queue.sliding<void>(1) }), (mail) => bridgeOf(a, mail)),
    );
    yield* Effect.forEach(bridges, (b) => b.load, { discard: true });
    yield* Effect.forkScoped(
      Stream.runForEach(yield* inbox.externalChanges, () =>
        Effect.sync(() => {
          for (const bridge of bridges) bridge.changed();
        }),
      ),
    );
    const bridge = (id: ConnectorID) => bridges.find((b) => b.id === id);

    // What the owner hears off the farm (the inbox says what) goes out on every app the owner has, each checking it is
    // its owner's channel.
    yield* Effect.forkScoped(
      Stream.runForEach(yield* inbox.toOwner, (m) => Effect.forEach(bridges, (b) => b.offer(m), { concurrency: "unbounded", discard: true })),
    );
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
