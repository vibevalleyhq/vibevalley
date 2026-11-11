import { createHash, randomInt } from "node:crypto";

import { Cause, Clock, type Context, Deferred, Duration, Effect, Fiber, Option, Predicate, Queue, Schedule, Schema, Semaphore } from "effect";
import type { SqlClient, SqlError } from "effect/sql";

import { t } from "@vibevalley/i18n";
import { type ChatMessage, type ConnectorLogin, type ConnectorStatus } from "@vibevalley/protocol";
import { type ApiError } from "@vibevalley/protocol/api";
import { channelOf, defaultOf } from "@vibevalley/protocol/rules";
import { messageId } from "@vibevalley/protocol/schema";

import { reasonOf } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import type { Core } from "#/core/core.ts";
import { causeMessage } from "#/infra/db.ts";
import type { Channel } from "#/modules/channel/channel.ts";
import type { Inbox } from "#/modules/inbox/inbox.ts";
import * as accountQ from "#db/connector_account.sql.ts";
import * as inboundQ from "#db/connector_inbound.sql.ts";
import * as outboxQ from "#db/connector_outbox.sql.ts";

import { type Adapter, type AppFailed, failedWith, Inbound, type Linked, type Progress, type Secrets } from "./adapter.ts";
import { digestOver, flushText, isPairing, maxChars, userLine, shortId, splitText } from "./digest.ts";

/** WeChat's official client rests this long too. */
const stalePauseMs = 60 * 60_000;

const SecretsSchema = Schema.Record(Schema.String, Schema.String);
const encodeSecrets = Schema.encodeEffect(Schema.fromJsonString(SecretsSchema));
const encodeInbound = Schema.encodeEffect(Schema.fromJsonString(Inbound));

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
export class BridgeError extends Schema.TaggedError<BridgeError, { readonly brand: unique symbol }>()("BridgeError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** A bridge's step that the database or the farm failed, in the words its status says. */
export const bridgeError = (e: SqlError.SqlError | Schema.SchemaError | Cause.NoSuchElementError | ApiError) =>
  BridgeError.make({ message: causeMessage(e), cause: e });

export type SqlFailure = SqlError.SqlError | Schema.SchemaError | Cause.NoSuchElementError;

interface BridgeEnv {
  readonly now: () => number;
  readonly chat: Context.Service.Shape<typeof Channel>;
  readonly core: Context.Service.Shape<typeof Core>;
  readonly inbox: Context.Service.Shape<typeof Inbox>;
  readonly retryFirst: number;
  readonly retryMost: number;
  readonly forkHere: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
  readonly tried: <A>(e: Effect.Effect<A, SqlFailure, SqlClient.SqlClient>) => Effect.Effect<A, BridgeError>;
  readonly inTx: <A>(work: Effect.Effect<A, BridgeError>) => Effect.Effect<A, BridgeError>;
  readonly isClosing: () => boolean;
}

export const makeBridge = (env: BridgeEnv, adapter: Adapter, mail: { readonly outbox: Queue.Queue<void>; readonly inbox: Queue.Queue<void> }) => {
  const { now, chat, core, inbox, retryFirst, retryMost, forkHere, tried, inTx, isClosing } = env;
  const id = adapter.id;
  const outboxBackoff = Schedule.exponential(Duration.millis(retryFirst)).pipe(
    Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, Duration.millis(retryMost)))),
  );
  const say = (text: string, channel: string | undefined, sendKey: string) =>
    chat.user({ source: "connector", text, ...(channel ? { channel } : {}), envelope: sendKey });

  let account: Account | undefined;
  /** A login going on: how far it is, and the code the user typed for it. None when no login is. */
  let signingIn: { readonly progress: Progress; readonly code: string } | undefined;
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
    const secrets = Schema.decodeOption(Schema.fromJsonString(SecretsSchema))(r.secrets);
    if (Option.isNone(secrets)) {
      setErr(t("server.connector.unreadSecrets"));
      yield* Effect.logError("vibevalley: the saved secrets cannot be read").pipe(Effect.annotateLogs({ connector: id }));
    }
    account = {
      secrets: Option.getOrElse(secrets, () => ({})),
      user: r.user_id ?? "",
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
        if (!a || !a.user) return true;
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
            ? [{ ids: pending.map((r) => r.id), text: flushText(pending.map((r) => r.body))[0] ?? "" }]
            : pending.map((r) => ({ ids: [r.id], text: r.body }));
        for (const out of batches) {
          const sent = yield* adapter.send(a.secrets, a.user, out.text, a.replyContext).pipe(
            Effect.flatMap((extId) =>
              inTx(
                Effect.forEach(out.ids, (oid) => tried(outboxQ.outboxSent({ sent_at: now(), ext_id: extId || null, id: oid })), {
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
                // The app would not take it now (WeChat's, QQ's reply window): tried again later, and with the user's next message.
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
  const retire = (reason: string) => outboxQ.dropPendingOutbox({ error: reason, connector: id });

  const offer = Effect.fnUntraced(function* (m: ChatMessage) {
    const a = snapshot();
    if (!a || !a.user) return;
    if ((yield* inbox.handoffState(m.id)) !== "unseen") return;
    yield* Effect.gen(function* () {
      const place = yield* Effect.mapError(chat.messageLocation(m.id), bridgeError);
      if (!place || place.top !== (a.channel ?? chat.defaultChannel())) return 0;
      const pieces = splitText(userLine(m, place.channel), maxChars[id]);
      const at = now();
      yield* inTx(
        Effect.forEach(pieces, (piece) => tried(outboxQ.addOutbox({ id: newId(), connector: id, message_id: m.id, body: piece, created_at: at })), {
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
    if (!a.user) {
      if (!a.pairCode || !isPairing(m.text, a.pairCode)) return;
      const at = now();
      yield* inTx(
        Effect.gen(function* () {
          yield* tried(accountQ.accountUser({ user_id: m.from || null, connector: id }));
          yield* tried(accountQ.accountReply({ reply_context: m.reply || null, at, connector: id }));
          if (m.id) yield* tried(inboundQ.deliverInbound({ connector: id, ext_id: m.id }));
        }),
      );
      // Told once the user has the word: the status is not paired before the app's confirmation went out.
      yield* reloadAccount;
      yield* Effect.ignore(adapter.send(a.secrets, m.from, t("server.connector.paired"), m.reply), {
        log: "Warn",
        message: `vibevalley: ${id}: the pairing confirmation was not sent`,
      });
      told();
      return;
    }
    if (m.from !== a.user) return;
    yield* tried(accountQ.accountReply({ reply_context: m.reply || null, at: now(), connector: id }));
    yield* reload;
    const channel = (yield* quotedChannel(m.quoted)) ?? snapshot()?.channel;
    if (m.text) {
      // Keyed by the app's message: one said but not yet marked delivered when the farm stopped is said once, not twice.
      const sendKey = createHash("sha256").update(`${id}:${m.id}`).digest("hex");
      yield* Effect.mapError(say(m.text, channel, sendKey), (e) => BridgeError.make({ message: reasonOf(e), cause: e }));
    }
    // The user's action withdraws stale handoffs before its fresh reply opens the platform's delivery window.
    yield* drain(true);
  });

  // The inbox: what the app handed over, delivered to the orchestrator in order.
  const accept = (messages: readonly Inbound[], cursor: string) =>
    inTx(
      Effect.gen(function* () {
        yield* tried(accountQ.connectorAccount({ connector: id }));
        yield* Effect.forEach(
          messages,
          (m) =>
            Effect.gen(function* () {
              const withId = m.id ? m : { ...m, id: newId() };
              const payload = yield* Effect.mapError(encodeInbound(withId), bridgeError);
              yield* tried(
                inboundQ.acceptInbound({
                  connector: id,
                  ext_id: withId.id,
                  payload,
                  created_at: yield* Clock.currentTimeMillis,
                }),
              );
            }),
          { discard: true },
        );
        if (cursor) yield* tried(accountQ.accountCursor({ connector: id, cursor }));
      }),
    ).pipe(
      Effect.tapError((e) => Effect.sync(() => (isClosing() ? undefined : setErr(e.message)))),
      Effect.tap(() => Queue.offer(mail.inbox, undefined)),
    );
  const drainInbox = Effect.gen(function* () {
    const rows = yield* tried(inboundQ.pendingInbound({ connector: id }));
    for (const row of rows) {
      const m = Schema.decodeOption(Schema.fromJsonString(Inbound))(row.payload);
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
    account && !isClosing() ? generation(Effect.all([receiving, inboxRun, outboxRun], { concurrency: "unbounded", discard: true })) : undefined;
  const resetProgress = () => {
    signingIn = undefined;
    changed();
  };
  const loginResult = (g: Fiber.Fiber<unknown, unknown>, result: Linked | AppFailed) =>
    commands.withPermits(1)(
      Effect.gen(function* () {
        if (g !== current) return;
        yield* stopGeneration;
        let failure = Predicate.isTagged(result, "AppFailed") ? result.message : undefined;
        if (!Predicate.isTagged(result, "AppFailed") && !isClosing()) {
          const linked = result;
          const pair = linked.user ? null : String(100_000 + randomInt(900_000));
          const at = yield* Clock.currentTimeMillis;
          const failedConnect = yield* Effect.gen(function* () {
            const secretsJson = yield* Effect.mapError(encodeSecrets(linked.secrets), bridgeError);
            yield* inTx(
              Effect.gen(function* () {
                yield* tried(
                  accountQ.connectAccount({
                    connector: id,
                    secrets: secretsJson,
                    user_id: linked.user || null,
                    pair_code: pair,
                    connected_at: at,
                  }),
                );
                yield* tried(inboundQ.clearInbound({ connector: id }));
                yield* tried(retire(t("server.connector.switched")));
              }),
            );
            outboxChanged(() => 0);
            yield* reload;
            return undefined;
          }).pipe(
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
          signingIn = { progress: p, code: signingIn?.code ?? "" };
          changed();
        }),
      Effect.sync(() => signingIn?.code ?? ""),
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
    offer: (m: ChatMessage) => commands.withPermits(1)(Effect.suspend(() => (isClosing() ? Effect.void : offer(m)))),
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
          if (signingIn !== undefined && input.force !== true) return loginTry;
          yield* stopGeneration;
          loginTry++;
          setErr("");
          signingIn = { progress: { state: "waiting", qr: "" }, code: "" };
          current = loggingIn(input);
          told();
          return loginTry;
        }),
      );
      // The answer carries the code when it shows within a moment.
      const shown = Deferred.makeUnsafe<void>();
      const done = () => {
        if (loginTry !== started || signingIn === undefined || signingIn.progress.qr) Deferred.doneUnsafe(shown, Effect.void);
      };
      progressed.add(done);
      done();
      yield* Deferred.await(shown).pipe(Effect.timeoutOption(1_500), Effect.ensuring(Effect.sync(() => progressed.delete(done))));
      return yield* status;
    }),
    verify: (code: string) =>
      Effect.suspend(() => {
        // A code with no login going on is for none: the next login starts with none.
        if (signingIn !== undefined)
          signingIn = {
            progress: signingIn.progress.state === "verify" ? { state: "scanned", qr: signingIn.progress.qr } : signingIn.progress,
            code: code.trim(),
          };
        told();
        return status;
      }),
    logout: Effect.andThen(
      commands.withPermits(1)(
        Effect.gen(function* () {
          yield* stopGeneration;
          yield* inTx(
            Effect.gen(function* () {
              yield* tried(accountQ.disconnectAccount({ connector: id }));
              yield* tried(inboundQ.clearInbound({ connector: id }));
              yield* tried(retire(t("server.connector.disconnected")));
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
