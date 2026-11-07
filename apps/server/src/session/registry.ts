import { randomBytes } from "node:crypto";

import { type SubagentReport } from "@botiverse/oar/agents";
import { Clock, Deferred, Effect, FiberMap, FiberSet, Queue, PubSub, Semaphore, Stream } from "effect";

import type * as T from "@vibevalley/protocol";
import { sessionId } from "@vibevalley/protocol/schema";

import { Agent } from "#/agent/agent.ts";
import { newId } from "#/base/ids.ts";
import { scopedPubSub } from "#/base/pubsub.ts";
import { Core, type FactIn } from "#/core/core.ts";
import { Executor, type ExecutionInput } from "#/executor/executor.ts";
import { serverAddress, ServerConfig } from "#/infra/config.ts";
import { causeMessage, Db } from "#/infra/db.ts";
import { bestEffort } from "#/infra/log.ts";
import { type Workplace } from "#/repo/workplace.ts";
import * as qs from "#db/session.sql.ts";

import { restoredSession, sessionState } from "./history.ts";
import { NotRecorded, recording } from "./inProcessRun.ts";
import { type Journal, makeTrajectories } from "./journal.ts";
import { type Tracking } from "./reaction.ts";
import type { DeliveryInput, InputConsumed, InputReturned, LaunchActivity, SessionIdentity, SessionNews } from "./signals.ts";

/** A burst of changes is one write. */
const saveAfterMs = 300;

export interface RunFinished {
  readonly id: string;
  readonly issues: T.IssueId[];
  readonly outcome: T.Outcome;
}

export interface Hand {
  readonly id: T.SessionId;
  readonly place: Workplace;
  /** The issue it was opened for: the run keeps it even while the session is between assignments. */
  readonly issue: string;
  readonly access: Semaphore.Semaphore;
  readonly journal: Journal;
  /** The oar session it is attached to; undefined between launches. */
  oarSessionId: string;
  lastText: string;
  tracking: Tracking;
  /** As the chat names it: <id>#<n>; "" when it has none. */
  launch: string;
  spoke: boolean;
  /** What its tools carry to say whose they are. "" once it leaves. */
  token: string;
  recalled: Set<string>;
  /** The inputs of the turns asked for and not opened yet, oldest first. */
  triggers: { readonly trigger: T.RunTrigger; readonly envelopeIds: readonly string[]; readonly inputId?: string }[];
  /** Runtime input ids waiting for evidence that their envelopes entered or were returned. */
  readonly inputs: Map<string, readonly string[]>;
  /** The open turn's run and what it heard. */
  run: string;
  heard: string[];
  report: T.IssueReport | undefined;
  settling?: { readonly report: SubagentReport; readonly completedBefore: number };
}

/** What inProcessRun.ts keeps runs with; a write that fails is an error the run retries. */
export interface RunStore {
  readonly start: (id: string, session: string, issue: string, trigger: T.RunTrigger) => Effect.Effect<void, NotRecorded>;
  readonly link: (run: string, issue: string) => Effect.Effect<void, NotRecorded>;
  readonly heard: (run: string, heard: readonly string[]) => Effect.Effect<void, NotRecorded>;
  readonly issues: (run: string) => Effect.Effect<T.IssueId[], NotRecorded>;
  readonly finish: (id: string, outcome: T.Outcome, summary: string, spent?: T.Spent) => Effect.Effect<void, NotRecorded>;
  readonly finished: (r: RunFinished) => void;
  readonly consumed: (c: InputConsumed) => void;
  readonly register: (session: string, currentRun: () => string) => void;
}

export const sessionRegistry = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const core = yield* Core;
  const store = yield* Agent;
  const executor = yield* Executor;
  const db = yield* Db;
  const clock = yield* Clock.Clock;
  const runSync = Effect.runSyncWith(yield* Effect.context());
  // Fibers started from callbacks belong to this service: they end with it and keep its services (the logger).
  const forkHere = yield* FiberSet.makeRuntime();
  const fire = <A, E>(e: Effect.Effect<A, E>) => void forkHere(e);
  const pendingRuns = yield* Queue.unbounded<Effect.Effect<void>>();
  yield* Effect.forkScoped(Effect.forever(Effect.flatten(Queue.take(pendingRuns))));
  const recordRun = (write: Effect.Effect<void>) => void Queue.offerUnsafe(pendingRuns, write);
  const flushRuns = Effect.gen(function* () {
    const done = yield* Deferred.make<void>();
    recordRun(Effect.asVoid(Deferred.succeed(done, undefined)));
    yield* Deferred.await(done);
  });
  // Waits started from callbacks (the save, each session's stall): one fiber per key, a new one replacing the last,
  // all ended with the service.
  const timers = yield* FiberMap.make<string>();
  const later = yield* FiberMap.runtime(timers)();
  // For oar's callbacks (a session's events, its report, a stall), which run outside any fiber and must land in the order oar gives them.
  const apply = (...facts: FactIn[]) => runSync(core.apply(...facts));
  const notice = (level: "info" | "warn" | "error", text: string) => runSync(core.notice(level, text));
  /** Where sessions reach the farm's tools; the server says its real address once it listens (setAddress). */
  const mcpEndpoint = { url: `http://${serverAddress(config)}/mcp` };
  const trajectories = yield* makeTrajectories(config.home, (id, e) => runSync(core.sessionEvent(id, e)));
  // A hand is acquired before admission; no path holding admission waits for a hand.
  const admission = yield* Semaphore.make(1);

  const launchesHub = yield* scopedPubSub<LaunchActivity>();
  // The sessions' own facts, told as news in the order they were applied.
  const newsHub = yield* scopedPubSub<SessionNews>();
  const [, moves] = yield* core.transitions;
  const startedIssuesHub = yield* scopedPubSub<string>();
  const finishedHub = yield* scopedPubSub<RunFinished>();
  const consumedHub = yield* scopedPubSub<InputConsumed>();
  const returnedHub = yield* scopedPubSub<InputReturned>();
  const signal = (a: LaunchActivity) => PubSub.publishUnsafe(launchesHub, a);

  const hands = new Map<string, Hand>();
  const executions = new Map<string, () => string>();
  let launches = 0;
  const launchOf = (id: string) => `${id}#${++launches}`;
  let closing = false;

  const tokens = new Map<string, string>();
  yield* Effect.addFinalizer(() => Effect.sync(() => tokens.clear()));
  const revokeToken = (h: Hand) => {
    tokens.delete(h.token);
    h.token = "";
  };
  const issueToken = (h: Hand) => {
    revokeToken(h);
    const token = "hb_" + h.id + "_" + randomBytes(18).toString("base64url");
    h.token = token;
    tokens.set(token, h.id);
    return token;
  };
  const who = (token: string) => tokens.get(token) ?? "";

  // A session's own row keeps what taking it up again needs, so it goes with the database.
  const handRow = (h: Hand) => {
    const oar = h.oarSessionId;
    return {
      id: h.id,
      place: JSON.stringify(h.place),
      oar_session: oar || null,
      last_text: h.lastText || null,
      recalled: h.recalled.size > 0 ? JSON.stringify([...h.recalled].toSorted()) : null,
    };
  };
  const keepHands = Effect.suspend(() =>
    db.inTx(
      Effect.gen(function* () {
        yield* Effect.forEach(core.state().sessions, (session) => db.run(qs.keepSessionState(sessionState(session))), { discard: true });
        yield* Effect.forEach([...hands.values()], (h) => db.run(qs.keepHand(handRow(h))), { discard: true });
      }),
    ),
  ).pipe(bestEffort("session: recovery state was not saved"));

  const save = () => {
    if (closing) return;
    later("save", Effect.delay(keepHands, saveAfterMs));
  };

  const [, changedSessions] = yield* core.transitions;
  yield* Effect.forkScoped(
    Stream.runForEach(changedSessions, (change) =>
      Effect.sync(() => {
        if (change.before.sessions !== change.after.sessions) save();
      }),
    ),
  );
  yield* Effect.forEach(
    yield* db.run(qs.activeSessions()),
    (row) =>
      Effect.gen(function* () {
        const session = restoredSession(row);
        yield* core.apply({ type: "sessionChanged", session });
      }),
    { discard: true },
  );

  const keepRow = (row: qs.KeepSessionParams) =>
    db.attempt(qs.keepSession(row)).pipe(Effect.mapError((cause) => new NotRecorded({ message: causeMessage(cause), cause })));

  const register = Effect.fn("Session.register")(function* (session: SessionIdentity) {
    const hiredAt = yield* Clock.currentTimeMillis;
    yield* keepRow({
      ...session,
      repo: null,
      issue: null,
      channel: null,
      hired_at: hiredAt,
    });
    if (!core.session(session.id))
      yield* core.apply({
        type: "sessionChanged",
        session: {
          ...session,
          id: sessionId(session.id),
          hiredAt,
          runs: 0,
          refining: false,
          phase: { _tag: "resting" },
        },
      });
  });

  yield* Effect.forEach(
    store.orchestrators(),
    (agent) => register({ id: agent.id, role: "orchestrator", agent: agent.id, name: agent.name, runtime: agent.runtime, brief: agent.duty }),
    { discard: true },
  );

  const keep = (s: T.Session) =>
    keepRow({
      id: s.id,
      role: s.role,
      agent: s.agent,
      name: s.name,
      runtime: s.runtime,
      brief: s.brief,
      repo: s.repo ?? null,
      issue: s.issue ?? null,
      channel: s.channel ?? null,
      hired_at: s.hiredAt,
    });

  const ended = (id: string, closed: T.SessionClose) =>
    db.attempt(qs.endSession({ ended_at: clock.currentTimeMillisUnsafe(), closed, id })).pipe(bestEffort(`vibevalley: session ${id}'s end not kept`));

  const forget = (id: string) => db.attempt(qs.forgetSession({ id })).pipe(bestEffort(`vibevalley: unstarted session ${id} not forgotten`));

  /** The session kept, with its log. */
  const logOf = (s: T.Session, journal: Journal) => Effect.as(Effect.andThen(keep(s), db.run(qs.keepSessionState(sessionState(s)))), journal);

  const runs = yield* recording;

  /** Called before the input goes out, so the turn it opens finds it. */
  const expect = (h: Hand, input: DeliveryInput, inputId?: string) =>
    void h.triggers.push({ trigger: input.trigger, envelopeIds: input.envelopeIds, ...(inputId === undefined ? {} : { inputId }) });
  /** Undoes expect when the input did not open a turn. */
  const unexpect = (h: Hand) => void h.triggers.pop();

  const startRun = (h: Hand) => {
    const expected = h.triggers.shift();
    const by = expected?.trigger ?? { kind: "runtime" };
    const issue = core.session(h.id)?.issue ?? h.issue;
    const id = newId();
    // Known at once, so a report that follows closely finds the run; its row follows.
    h.run = id;
    h.heard = [];
    h.report = undefined;
    recordRun(db.run(qs.clearPendingReport({ id: h.id })).pipe(bestEffort(`vibevalley: ${h.id}'s previous report was not cleared`)));
    h.journal.runStarted(id);
    recordRun(runs.start(id, h.id, issue, by).pipe(bestEffort("vibevalley: a run not kept"), Effect.annotateLogs({ session: h.id })));
    if (expected?.inputId === undefined && expected !== undefined && expected.envelopeIds.length > 0) consume(h, expected.envelopeIds);
  };

  const consume = (h: Hand, envelopeIds: readonly string[]) => {
    const fresh = envelopeIds.filter((id) => !h.heard.includes(id));
    if (fresh.length === 0) return;
    h.heard.push(...fresh);
    if (h.run) recordRun(runs.heard(h.run, h.heard).pipe(bestEffort(`vibevalley: run ${h.run}`)));
    PubSub.publishUnsafe(consumedHub, { session: h.id, envelopeIds: fresh });
  };

  const inputChanged = (h: Hand, input: ExecutionInput) => {
    const envelopeIds = h.inputs.get(input.inputId);
    if (envelopeIds === undefined) return;
    h.inputs.delete(input.inputId);
    if (input.kind === "consumed") consume(h, envelopeIds);
    else PubSub.publishUnsafe(returnedHub, { session: h.id, envelopeIds });
  };

  const endRun = (h: Hand, outcome: T.Outcome, summary: string, spent?: T.Spent) => {
    const id = h.run;
    h.run = "";
    h.heard = [];
    if (!id) return;
    h.journal.runEnded(id, outcome);
    const issue = core.session(h.id)?.issue;
    recordRun(
      db
        .inTx(
          Effect.gen(function* () {
            yield* runs.finish(id, outcome, summary, spent);
            const session = core.session(h.id);
            if (session) yield* db.run(qs.keepSessionState(sessionState(session)));
            yield* db.run(qs.clearPendingReport({ id: h.id }));
          }),
        )
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (issue) PubSub.publishUnsafe(finishedHub, { id, issues: [issue], outcome });
            }),
          ),
          bestEffort(`vibevalley: run ${id}`),
        ),
    );
  };

  const release = (h: Hand) => executor.detach(h.id);

  const closeExecution = (h: Hand) => executor.close(h.id);

  // The sessions are let go first: a turn cut off by the shutdown is reported when the farm comes back, not on the way out.
  yield* Effect.addFinalizer(() =>
    Effect.andThen(
      Effect.suspend(() => {
        closing = true;
        return Effect.andThen(FiberMap.remove(timers, "save"), Effect.andThen(flushRuns, keepHands));
      }),
      Effect.sync(() => {
        for (const h of [...hands.values()]) {
          h.journal.close();
          release(h);
        }
      }),
    ),
  );

  const runStore: RunStore = {
    ...runs,
    start: Effect.fn("Session.startHostedRun")(function* (id, session, issue, trigger) {
      yield* runs.start(id, session, issue, trigger);
      if (issue) PubSub.publishUnsafe(startedIssuesHub, issue);
    }),
    link: Effect.fn("Session.linkHostedIssue")(function* (run, issue) {
      yield* runs.link(run, issue);
      PubSub.publishUnsafe(startedIssuesHub, issue);
    }),
    finished: (r) => PubSub.publishUnsafe(finishedHub, r),
    consumed: (c) => PubSub.publishUnsafe(consumedHub, c),
    register: (session, current) => void executions.set(session, current),
  };
  return {
    fire,
    flushRuns,
    timers,
    later,
    apply,
    notice,
    mcpEndpoint,
    trajectories,
    admission,
    launchesHub,
    newsHub,
    moves,
    startedIssuesHub,
    finishedHub,
    consumedHub,
    returnedHub,
    signal,
    hands,
    executions,
    launchOf,
    issueToken,
    revokeToken,
    who,
    keepHands,
    save,
    register,
    ended,
    forget,
    logOf,
    runs,
    expect,
    unexpect,
    startRun,
    consume,
    inputChanged,
    endRun,
    release,
    closeExecution,
    runStore,
  };
});

export type SessionRegistry = Effect.Success<typeof sessionRegistry>;
