// The chat apps: WeChat, Feishu and QQ, each tied to one farm channel; each app's protocol is
// its adapter's. Only outbound connections: no public HTTP endpoint. The bots' secrets never leave the database.
//
// Each app's account has one generation of work at a time (receiving, the inbox, the outbox); a login or logout cancels
// and waits for the generation before it replaces the account. What an app hands over is accepted into connector_inbound
// (a durable acceptance, with the page's cursor) and delivered to the orchestrator from there; a delivery the orchestrator took but
// whose mark was not written yet may come again after a restart. Some apps let a bot answer only on the context of the
// owner's latest message, and only so many times: what an app will not take waits in connector_outbox and goes when the
// owner next says something, several as one digest.

import { createHash, randomInt } from "node:crypto";

import {
  Cause,
  Clock,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Fiber,
  FiberSet,
  Layer,
  Option,
  Schedule,
  Schema,
  Semaphore,
  Stream,
  Predicate,
} from "effect";
import { HttpClient } from "effect/http";
import type { SqlClient, SqlError } from "effect/sql";

import { t } from "@vibevalley/i18n";
import type { ChatMessage, ConnectorID, ConnectorLogin, ConnectorStatus } from "@vibevalley/protocol";
import { type ApiError } from "@vibevalley/protocol/api";

import { causeMessage, Db } from "@/base/db.ts";
import { newId } from "@/base/ids.ts";
import { Channels } from "@/channel/chat.ts";
import { channelOf, defaultOf } from "@/channel/folded.ts";
import { Core } from "@/core/core.ts";
import { reasonOf } from "@/errors.ts";
import { Notices } from "@/notice/notice.ts";
import { Orchestrator } from "@/orchestrator/orchestrator.ts";

import * as accountQ from "../../db/generated/connector_account.sql.ts";
import * as inboundQ from "../../db/generated/connector_inbound.sql.ts";
import * as outboxQ from "../../db/generated/connector_outbox.sql.ts";
import { type Adapter, type AppFailed, failedWith, type Inbound, type Linked, type Progress, type Secrets } from "./adapter.ts";
import { digestOver, flushText, isPairing, maxChars, ownerLine, shortId, splitText } from "./digest.ts";
import { type FeishuApi, FeishuClient, feishuAdapter } from "./feishu.ts";
import { type QQApi, QQClient, qqAdapter } from "./qq.ts";
import { type WeixinApi, WeixinClient, weixinAdapter } from "./weixin.ts";

/** WeChat's official client rests this long too. */
const stalePauseMs = 60 * 60_000;

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

/** Why a step of the bridge did not go through: the database, the orchestrator, or an app. Said as the status's error. */
class BridgeError extends Data.TaggedError("BridgeError")<{ readonly message: string }> {}

/** A bridge's step that the database or the farm failed, in the words its status says. */
const bridgeError = (e: SqlError.SqlError | Schema.SchemaError | Cause.NoSuchElementError | ApiError) => new BridgeError({ message: causeMessage(e) });

const Secrets = Schema.Record(Schema.String, Schema.String);

export class Connectors extends Context.Service<
  Connectors,
  {
    readonly list: () => Effect.Effect<ConnectorStatus[]>;
    readonly login: (id: ConnectorID, input: ConnectorLogin) => Effect.Effect<ConnectorStatus>;
    readonly verify: (id: ConnectorID, code: string) => Effect.Effect<ConnectorStatus>;
    readonly logout: (id: ConnectorID) => Effect.Effect<ConnectorStatus>;
    readonly setChannel: (id: ConnectorID, name: string) => Effect.Effect<ConnectorStatus, ApiError>;
  }
>()("vibevalley/Connector") {
  static readonly layer = (options?: ConnectorOptions) => Layer.effect(Connectors, make(options));
}

export interface ConnectorOptions {
  readonly weixin?: WeixinApi;
  readonly feishu?: FeishuApi;
  readonly qq?: QQApi;
  /** Held messages are tried again after retryFirstMs, then twice as long after each try that fails, up to retryMostMs. */
  readonly retryFirstMs?: number;
  readonly retryMostMs?: number;
  /** What the owner said, to the orchestrator; the orchestrator's say when absent. */
  readonly say?: (text: string, channel: string | undefined, sendKey: string, chat: Channels["Service"]) => Effect.Effect<void, ApiError>;
}

/** Until woken or ms on the Clock: "wake" or "timeout". The wake is registered each time it runs. */
const sleepOrWake = (ms: number, register: (wake: () => void) => void) =>
  Effect.suspend(() => {
    const woke = Deferred.makeUnsafe<void>();
    register(() => Deferred.doneUnsafe(woke, Effect.void));
    return Effect.as(Deferred.await(woke), "wake" as const).pipe(
      Effect.timeoutOrElse({ duration: Math.max(0, ms), orElse: () => Effect.succeed("timeout" as const) }),
    );
  });

const make = (options: ConnectorOptions = {}) =>
  Effect.gen(function* () {
    // The farm's own waits and times (a pause, a retry, when a message went out) on the service's Clock.
    const clock = yield* Clock.Clock;
    const now = () => clock.currentTimeMillisUnsafe();
    const { attempt: db, attemptTx } = yield* Db;
    const chat = yield* Channels;
    const core = yield* Core;
    const notices = yield* Notices;
    const orchestrator = yield* Orchestrator;
    const retryFirst = options.retryFirstMs ?? 30_000;
    const retryMost = options.retryMostMs ?? 30 * 60_000;
    /** retryFirst, then twice as long after each try that fails, up to retryMost. */
    const outboxBackoff = Schedule.exponential(Duration.millis(retryFirst)).pipe(
      Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, Duration.millis(retryMost)))),
    );
    // The bridges' fibers (each account's generation, the status said to the core) belong to this service: they end with
    // it and keep its services (the logger, the Clock).
    const forkHere = yield* FiberSet.makeRuntime();
    /** The database's own failures stay failures here: the status says them. */
    const run = <A>(e: Effect.Effect<A, SqlError.SqlError | Schema.SchemaError | Cause.NoSuchElementError, SqlClient.SqlClient>) =>
      Effect.mapError(db(e), bridgeError);
    const inTx = <A>(work: Effect.Effect<A, SqlError.SqlError | Schema.SchemaError | Cause.NoSuchElementError>) =>
      Effect.mapError(attemptTx(work), bridgeError);
    let closing = false;
    const say = (text: string, channel: string | undefined, sendKey: string) =>
      options.say ? options.say(text, channel, sendKey, chat) : orchestrator.say(text, {}, channel, sendKey);

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
        const secrets = Schema.decodeOption(Schema.fromJsonString(Secrets))(r.secrets);
        if (Option.isNone(secrets)) {
          setErr(t("server.connector.unreadSecrets"));
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
        return run(Effect.map(outboxQ.countPendingOutbox({ connector: id }), (r) => r.n ?? 0)).pipe(
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
        yield* run(accountQ.pauseAccount({ paused_until: now() + stalePauseMs, connector: id }));
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
        const rows = yield* run(outboxQ.messageOfExt({ connector: id, ext_id: ext }));
        const message = rows[0]?.message_id;
        if (!message) return undefined;
        return (yield* Effect.mapError(chat.messageLocation(message), bridgeError))?.channel.id;
      });

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
              const sent = yield* Effect.result(adapter.send(a.secrets, a.owner, out.text, a.replyContext));
              if (sent._tag === "Success") {
                const marked = yield* Effect.result(
                  inTx(Effect.forEach(out.ids, (oid) => db(outboxQ.outboxSent({ sent_at: now(), ext_id: sent.success || null, id: oid })), { discard: true })),
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
              const refused = sent.failure;
              for (const oid of out.ids) yield* kept(run(outboxQ.outboxFailed({ error: refused.message || null, id: oid })));
              if (refused.kind === "stale") yield* pause;
              // The app would not take it now (WeChat's, QQ's reply window): tried again later, and with the owner's next message.
              else if (refused.kind === "restricted") setErr("");
              else setErr(refused.message);
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
            if (!place || place.top !== (a.channel ?? chat.defaultChannel())) return 0;
            const pieces = splitText(ownerLine(m, place.channel), maxChars[id]);
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
        // The waits between tries of what is held: a fresh one after a try that goes, the next one after a try that fails.
        const waits = Effect.map(Schedule.toStep(outboxBackoff), (step) => Effect.map(Effect.orDie(step(0, undefined)), ([delay]) => Duration.toMillis(delay)));
        let nextWait = yield* waits;
        let wait = yield* nextWait;
        for (;;) {
          if (outboxDirty) {
            outboxDirty = false;
            yield* drain(false);
            nextWait = yield* waits;
            wait = yield* nextWait;
            continue;
          }
          const result = yield* sleepOrWake(wait, (wake) => (wakeOutbox = wake)).pipe(Effect.ensuring(Effect.sync(() => (wakeOutbox = undefined))));
          if (result !== "timeout") continue;
          if (yield* drain(false)) nextWait = yield* waits;
          wait = yield* nextWait;
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
          yield* Effect.ignore(adapter.send(a.secrets, m.from, t("server.connector.paired"), m.reply), {
            log: "Warn",
            message: `vibevalley: ${id}: the pairing confirmation was not sent`,
          });
          told();
          return;
        }
        if (m.from !== a.owner) return;
        yield* run(accountQ.accountReply({ reply_context: m.reply || null, at: now(), connector: id }));
        yield* reload;
        // A fresh reply opens the platform's delivery window; older messages precede its answer.
        yield* drain(true);
        if (!m.text) return;
        const channel = (yield* quotedChannel(m.quoted)) ?? snapshot()?.channel;
        // Keyed by the app's message: one said but not yet marked delivered when the farm stopped is said once, not twice.
        const sendKey = createHash("sha256").update(`${id}:${m.id}`).digest("hex");
        yield* Effect.mapError(say(m.text, channel, sendKey), (e) => new BridgeError({ message: reasonOf(e) }));
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
          const m = Schema.decodeOption(Schema.fromJsonString(InboundSchema))(row.payload);
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

      /** Until the app's connection ends; what it hands over is kept durably before the app is told it is taken. Once it has
       * ended, acceptance is sealed: a late handover (an SDK callback that outlived it) must not land after a newer
       * account's work began. */
      const receive = (secrets: Secrets) =>
        Effect.gen(function* () {
          const row = yield* run(Effect.catchNoSuchElement(accountQ.connectorAccount({ connector: id })));
          const cursor = Option.match(row, { onNone: () => "", onSome: (a) => a.cursor });
          let sealed = false;
          const io = {
            cursor,
            accept: (messages: readonly Inbound[], c: string) =>
              Effect.suspend(() => (sealed ? Effect.fail(failedWith("canceled")) : Effect.mapError(accept(messages, c), (e) => failedWith(e.message)))),
          };
          return yield* adapter.receive(secrets, io).pipe(Effect.ensuring(Effect.sync(() => (sealed = true))));
        });
      // A loop, not a Schedule: each branch waits its own way (until the pause ends, a breath after a stale login, longer
      // after every third failure), and only a failure counts toward the longer wait.
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
                    yield* retire(t("server.connector.switched"));
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
        // The fiber reads itself: a login that settles at once runs before fork returns it.
        return generation(
          Effect.withFiber((g) =>
            Effect.flatMap(Effect.result(login), (r) => Effect.sync(() => void forkHere(loginResult(g, r._tag === "Success" ? r.success : r.failure)))),
          ),
        );
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
              if (progress && input.force !== true) return attempt;
              yield* stopGeneration;
              attempt++;
              setErr("");
              verifyCode = "";
              progress = { state: "waiting", qr: "" };
              current = loggingIn(input);
              told();
              return attempt;
            }),
          );
          // The answer carries the code when it shows within a moment.
          const shown = Deferred.makeUnsafe<void>();
          const done = () => {
            if (attempt !== started || !progress || progress.qr) Deferred.doneUnsafe(shown, Effect.void);
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
              const retired = yield* Effect.result(
                inTx(
                  Effect.gen(function* () {
                    yield* db(accountQ.disconnectAccount({ connector: id }));
                    yield* db(inboundQ.clearInbound({ connector: id }));
                    yield* retire(t("server.connector.disconnected"));
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

    const http = yield* HttpClient.HttpClient;
    const adapters = [
      weixinAdapter(options.weixin ?? new WeixinClient(http)),
      feishuAdapter(options.feishu ?? new FeishuClient(http)),
      qqAdapter(options.qq ?? new QQClient(http)),
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

    const off = (id: ConnectorID): ConnectorStatus => ({ id, state: "off", pending: 0, error: "", qr: "", pairCode: "" });
    return Connectors.of({
      list: Effect.fn("Connectors.list")(function* () {
        return yield* Effect.forEach(bridges, (b) => b.status);
      }),
      login: Effect.fn("Connectors.login")(function* (id, input) {
        const b = bridge(id);
        return b ? yield* b.login(input) : off(id);
      }),
      verify: Effect.fn("Connectors.verify")(function* (id, code) {
        const b = bridge(id);
        return b ? yield* b.verify(code) : off(id);
      }),
      logout: Effect.fn("Connectors.logout")(function* (id) {
        const b = bridge(id);
        return b ? yield* b.logout : off(id);
      }),
      setChannel: Effect.fn("Connectors.setChannel")(function* (id, name) {
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
