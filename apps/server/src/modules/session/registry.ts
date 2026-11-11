import { Clock, Deferred, Effect, Exit, FiberMap, FiberSet, Queue, PubSub, Scope, Semaphore, Stream, String as Str } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { sessionId } from "@vibevalley/protocol/schema";

import { BizCode, refuseIn } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import { jsonText } from "#/base/json.ts";
import { scopedPubSub } from "#/base/pubsub.ts";
import { Core, type FactIn } from "#/core/core.ts";
import { serverAddress, ServerConfig } from "#/infra/config.ts";
import { causeMessage, Db } from "#/infra/db.ts";
import { bestEffort } from "#/infra/log.ts";
import { Agent } from "#/modules/agent/agent.ts";
import { type ExecutionInput } from "#/modules/machine/executor.ts";
import { Machine } from "#/modules/machine/machine.ts";
import * as qs from "#db/session.sql.ts";

import { type Hand, makeHandRoster } from "./hands.ts";
import { restoredSession, sessionState } from "./history.ts";
import { NotRecorded, recording } from "./inProcessRun.ts";
import { type Journal, makeTrajectories } from "./journal.ts";
import { isOnDuty } from "./roster.ts";
import type { DeliveryInput, Consumed, LaunchActivity, RunFinished, SessionIdentity, SessionNews } from "./signals.ts";

const refused = refuseIn(BizCode.SessionRefused);

export type { Hand };

const saveAfterMs = 300;

export interface RunStore {
  readonly start: (id: string, session: string, issue: string, trigger: T.RunTrigger) => Effect.Effect<void, NotRecorded>;
  readonly link: (run: string, issue: string) => Effect.Effect<void, NotRecorded>;
  readonly heard: (run: string, heard: readonly string[]) => Effect.Effect<void, NotRecorded>;
  readonly issues: (run: string) => Effect.Effect<T.IssueId[], NotRecorded>;
  readonly finish: (id: string, outcome: T.Outcome, summary: string, spent?: T.Spent) => Effect.Effect<void, NotRecorded>;
  readonly finished: (r: RunFinished) => void;
  readonly consumed: (c: Consumed) => void;
  readonly register: (session: string, currentRun: () => string) => void;
}

export const sessionRegistry = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const core = yield* Core;
  const store = yield* Agent;
  const machines = yield* Machine;
  const executor = machines.executions(machines.here());
  const db = yield* Db;
  const clock = yield* Clock.Clock;
  const context2 = yield* Effect.context();
  const runSync = Effect.runSyncWith(context2);
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
  const timers = yield* FiberMap.make<string>();
  const later = yield* FiberMap.runtime(timers)();
  // Synchronous bridge for non-Effect `oar` observer callbacks so facts commit in callback order.
  const apply = (...facts: FactIn[]) => runSync(core.apply(...facts));
  const notice = (level: "info" | "warn" | "error", text: string) => runSync(core.notice(level, text));
  const mcpEndpoint = { url: `http://${serverAddress(config)}/mcp` };
  const trajectories = yield* makeTrajectories(config.home, (id, e) => runSync(core.sessionEvent(sessionId(id), e)));
  const admission = yield* Semaphore.make(1);
  const roster = makeHandRoster(admission);
  yield* Effect.addFinalizer(() => Effect.sync(() => roster.clearTokens()));

  const newsHub = yield* scopedPubSub<SessionNews>();
  const [, moves] = yield* core.transitions;
  const tell = (news: SessionNews) => void PubSub.publishUnsafe(newsHub, news);
  const signal = (a: LaunchActivity) => tell(a);

  const executions = new Map<string, () => string>();
  let launches = 0;
  const launchOf = (id: string) => `${id}#${++launches}`;
  let closing = false;

  const handRow = (h: Hand) =>
    Effect.map(
      Effect.all({ place: jsonText(h.place), recalled: h.recalled.size > 0 ? jsonText([...h.recalled].toSorted()) : Effect.succeed(null) }),
      ({ place, recalled }) => ({ id: h.id, place, oar_session: h.oarSessionId || null, last_text: h.lastText || null, recalled }),
    );
  const keepHands = Effect.suspend(() =>
    db.inTx(
      Effect.gen(function* () {
        yield* Effect.forEach(core.state().sessions, (session) => db.run(Effect.flatMap(sessionState(session), qs.keepSessionState)), { discard: true });
        yield* Effect.forEach(roster.values(), (h) => db.run(Effect.flatMap(handRow(h), qs.keepHand)), { discard: true });
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
  const activeSessions2 = yield* db.run(qs.activeSessions());
  yield* Effect.forEach(
    activeSessions2,
    (row) =>
      Effect.gen(function* () {
        const session = restoredSession(row);
        yield* core.apply({ type: "sessionChanged", session });
      }),
    { discard: true },
  );

  const keepRow = (row: qs.KeepSessionParams) =>
    db.attempt(qs.keepSession(row)).pipe(Effect.mapError((cause) => NotRecorded.make({ message: causeMessage(cause), cause })));

  const register = Effect.fn("Session.register")(function* (session: SessionIdentity) {
    const hiredAt = yield* Clock.currentTimeMillis;
    yield* keepRow({
      ...session,
      repo: null,
      issue: null,
      channel: null,
      hired_at: hiredAt,
      machine: null,
    });
    const kept = core.session(session.id);
    if (kept === undefined || kept.name !== session.name)
      yield* core.apply({
        type: "sessionChanged",
        session:
          kept === undefined
            ? { ...session, id: sessionId(session.id), hiredAt, runs: 0, refining: false, phase: { _tag: "resting" } }
            : { ...kept, name: session.name },
      });
  });

  // Ensure on-duty orchestrators have a persisted `session` row before any Run foreign key or mailbox delivery references them.
  const keepOnDuty = Effect.fn("Session.keepOnDuty")(function* (profile: T.Agent) {
    if (!isOnDuty(profile)) return;
    const name = Str.trim(profile.name) || t("server.channel.name.orchestrator");
    if (core.session(profile.id)?.name === name) return;
    yield* register({ id: profile.id, agent: profile.id, name, role: profile.role, runtime: profile.runtime, brief: profile.duty });
  });
  yield* Effect.forEach(store.all(), keepOnDuty, { discard: true });
  store.whenKept((profile) => keepOnDuty(profile).pipe(Effect.mapError((error) => refused(error.message))));

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
      machine: s.machine ?? null,
    });

  const ended = (id: string, closed: T.SessionClose) =>
    db.attempt(qs.endSession({ ended_at: clock.currentTimeMillisUnsafe(), closed, id })).pipe(bestEffort(`vibevalley: session ${id}'s end not kept`));

  const forget = (id: string) => db.attempt(qs.forgetSession({ id })).pipe(bestEffort(`vibevalley: unstarted session ${id} not forgotten`));

  const logOf = (s: T.Session, journal: Journal) => Effect.as(Effect.andThen(keep(s), db.run(Effect.flatMap(sessionState(s), qs.keepSessionState))), journal);

  const runs = yield* recording;

  /** Queued before dispatching to the runtime so `startRun` finds it if the turn opens synchronously. */
  const expect = (h: Hand, input: DeliveryInput, inputId?: string) =>
    void h.triggers.push({ trigger: input.trigger, envelopeIds: input.envelopeIds, ...(inputId === undefined ? {} : { inputId }) });
  const unexpect = (h: Hand) => void h.triggers.pop();

  const startRun = (h: Hand) => {
    const expected = h.triggers.shift();
    const by = expected?.trigger ?? { kind: "runtime" };
    const issue = core.session(h.id)?.issue ?? h.issue;
    const id = newId();
    // Assign `h.run` synchronously before async DB persistence so an immediate `report` finds it.
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
    tell({ _tag: "Consumed", session: h.id, envelopeIds: fresh });
  };

  const inputChanged = (h: Hand, input: ExecutionInput) => {
    const envelopeIds = h.inputs.get(input.inputId);
    if (envelopeIds === undefined) return;
    h.inputs.delete(input.inputId);
    if (input.kind === "consumed") consume(h, envelopeIds);
    else tell({ _tag: "Returned", session: h.id, envelopeIds });
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
            if (session) yield* db.run(Effect.flatMap(sessionState(session), qs.keepSessionState));
            yield* db.run(qs.clearPendingReport({ id: h.id }));
          }),
        )
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (issue) tell({ _tag: "RunFinished", id, issues: [issue], outcome });
            }),
          ),
          bestEffort(`vibevalley: run ${id}`),
        ),
    );
  };

  const release = (h: Hand) => executor.detach(h.id);

  const closeExecution = (h: Hand) => executor.close(h.id);

  // Flush recovery state and detach before executor shutdown so interrupted turns reconcile on next startup rather than mid-exit.
  yield* Effect.addFinalizer(() =>
    Effect.andThen(
      Effect.suspend(() => {
        closing = true;
        return Effect.andThen(FiberMap.remove(timers, "save"), Effect.andThen(flushRuns, keepHands));
      }),
      Effect.forEach(
        roster.values(),
        (h) =>
          Effect.andThen(
            Effect.sync(() => {
              h.journal.close();
              release(h);
            }),
            Scope.close(h.scope, Exit.void),
          ),
        { discard: true },
      ),
    ),
  );

  const runStore: RunStore = {
    ...runs,
    start: Effect.fn("Session.startHostedRun")(function* (id, session, issue, trigger) {
      yield* runs.start(id, session, issue, trigger);
      if (issue) tell({ _tag: "IssueStarted", issue });
    }),
    link: Effect.fn("Session.linkHostedIssue")(function* (run, issue) {
      yield* runs.link(run, issue);
      tell({ _tag: "IssueStarted", issue });
    }),
    finished: (r) => tell({ _tag: "RunFinished", ...r }),
    consumed: (c) => tell({ _tag: "Consumed", ...c }),
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
    newsHub,
    tell,
    moves,
    signal,
    roster,
    executions,
    launchOf,
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
