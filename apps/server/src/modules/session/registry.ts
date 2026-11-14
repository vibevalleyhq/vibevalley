import { Hub, Semaphore, TaskGroup } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { sessionId } from "@vibevalley/protocol/schema";

import { BizCode, refuseIn } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import { jsonText } from "#/base/json.ts";
import type { Core } from "#/core/core.ts";
import { serverAddress, type ServerConfig } from "#/infra/config.ts";
import { causeMessage, type Db, SqlError } from "#/infra/db.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Agent } from "#/modules/agent/agent.ts";
import * as qs from "#db/session.sql.ts";

import { type ExecutionInput } from "./executor.ts";
import { type Hand, makeHandRoster } from "./hands.ts";
import { restoredSession, sessionState } from "./history.ts";
import { NotRecorded, recording } from "./inProcessRun.ts";
import { type Journal, makeTrajectories } from "./journal.ts";
import type { Machine } from "./machine.ts";
import { isOnDuty } from "./roster.ts";
import type { DeliveryInput, Consumed, LaunchActivity, RunFinished, SessionIdentity, SessionNews } from "./signals.ts";

const refused = refuseIn(BizCode.SessionRefused);

export type { Hand };

const saveAfterMs = 300;

export interface RunStore {
  readonly start: (id: string, session: string, issue: string, trigger: T.RunTrigger) => Promise<void>;
  /** The run took an input of issue (told as IssueStarted). */
  readonly link: (run: string, issue: string) => void;
  readonly heard: (run: string, heard: readonly string[]) => Promise<void>;
  readonly unended: (session: string) => Promise<{ readonly id: string; readonly startedAt: number } | undefined>;
  readonly finish: (id: string, outcome: T.Outcome, summary: string, spent?: T.Spent) => Promise<void>;
  readonly finished: (r: RunFinished) => void;
  readonly consumed: (c: Consumed) => void;
  readonly register: (session: string, currentRun: () => string) => void;
}

export interface RegistryDeps {
  readonly config: ServerConfig;
  readonly clock: Time;
  readonly log: Logger;
  readonly db: Db;
  readonly core: Core;
  readonly agent: Agent;
  readonly machine: Machine;
}

export async function makeRegistry(deps: RegistryDeps) {
  const { config, core, db, clock } = deps;
  const log = deps.log;
  const store = deps.agent;
  const machines = deps.machine;
  const executor = machines.executions(machines.here());
  const tasks = new TaskGroup({ name: "session", onError: (task, e) => log.error(`${task} failed`, e) });
  /** Background work nobody waits for (a run's memories kept). */
  const fire = (name: string, work: () => Promise<unknown>) => void tasks.run(name, work);
  // Run records are written one at a time, in the order asked: a run's start before its end.
  let runWrites: Promise<void> = Promise.resolve();
  const recordRun = (what: string, write: () => Promise<unknown>) => {
    runWrites = runWrites.then(write).then(
      () => undefined,
      (e: unknown) => log.warn(what, e),
    );
  };
  /** Every run record asked for before this, written. */
  const flushRuns = () => runWrites;
  /** One timer per key (the save, each conversation's idle suspension): a new one stops the one before. */
  const later = (key: string, work: (signal: AbortSignal) => Promise<unknown>) => void tasks.keyed(key, work);
  const mcpEndpoint = { url: `http://${serverAddress(config)}/mcp` };
  const trajectories = makeTrajectories(config.home, (id, e) => core.sessionEvent(sessionId(id), e), { clock, log });
  const admission = new Semaphore(1);
  const roster = makeHandRoster(admission);

  const newsHub = new Hub<SessionNews>();
  const moves = core.transitions().changes;
  const tell = (news: SessionNews) => newsHub.publish(news);
  const signal = (a: LaunchActivity) => tell(a);

  const executions = new Map<string, () => string>();
  let launches = 0;
  const launchOf = (id: string) => `${id}#${++launches}`;
  let closing = false;

  const handRow = (h: Hand): qs.KeepHandParams => ({
    id: h.id,
    place: jsonText(h.place),
    oar_session: h.oarSessionId || null,
    last_text: h.lastText || null,
    recalled: h.recalled.size > 0 ? jsonText([...h.recalled].toSorted()) : null,
  });
  const keepHands = () =>
    bestEffort(log, "session: recovery state was not saved", () =>
      db.tx(async () => {
        for (const session of core.state().sessions) await qs.keepSessionState(db.sql, sessionState(session));
        for (const h of roster.values()) await qs.keepHand(db.sql, handRow(h));
      }),
    );

  const save = () => {
    if (closing) return;
    later("save", async (abort) => {
      await clock.sleep(saveAfterMs, abort);
      await keepHands();
    });
  };

  const changedSessions = core.transitions().changes;
  tasks.run("sessions saved", async () => {
    for await (const change of changedSessions) if (change.before.sessions !== change.after.sessions) save();
  });
  for (const row of await qs.activeSessions(db.sql)) core.apply({ type: "sessionChanged", session: restoredSession(row) });

  const keepRow = async (row: qs.KeepSessionParams) => {
    try {
      await qs.keepSession(db.sql, row);
    } catch (e) {
      if (e instanceof SqlError) throw new NotRecorded(causeMessage(e), { cause: e });
      throw e;
    }
  };

  const register = async (session: SessionIdentity) => {
    const hiredAt = clock.now();
    await keepRow({
      ...session,
      repo: null,
      issue: null,
      channel: null,
      hired_at: hiredAt,
      machine: null,
    });
    const kept = core.session(session.id);
    if (kept === undefined || kept.name !== session.name)
      core.apply({
        type: "sessionChanged",
        session:
          kept === undefined
            ? { ...session, id: sessionId(session.id), hiredAt, runs: 0, refining: false, phase: { _tag: "resting" } }
            : { ...kept, name: session.name },
      });
  };

  // Ensure on-duty orchestrators have a persisted `session` row before any Run foreign key or mailbox delivery references them.
  const keepOnDuty = async (profile: T.Agent) => {
    if (!isOnDuty(profile)) return;
    const name = profile.name.trim() || t("server.channel.name.orchestrator");
    if (core.session(profile.id)?.name === name) return;
    await register({ id: profile.id, agent: profile.id, name, role: profile.role, runtime: profile.runtime, brief: profile.duty });
  };
  for (const profile of store.all()) await keepOnDuty(profile);
  store.whenKept(async (profile) => {
    try {
      await keepOnDuty(profile);
    } catch (e) {
      if (e instanceof NotRecorded) throw refused(e.message);
      throw e;
    }
  });

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
    bestEffort(log, `vibevalley: session ${id}'s end not kept`, () => qs.endSession(db.sql, { ended_at: clock.now(), closed, id }));

  const forget = (id: string) => bestEffort(log, `vibevalley: unstarted session ${id} not forgotten`, () => qs.forgetSession(db.sql, { id }));

  const logOf = async (s: T.Session, journal: Journal) => {
    await keep(s);
    await qs.keepSessionState(db.sql, sessionState(s));
    return journal;
  };

  const runs = recording({ db, clock });

  /** Queued before dispatching to the runtime so `startRun` finds it if the turn opens synchronously. */
  const expect = (h: Hand, input: DeliveryInput, inputId?: string) =>
    void h.triggers.push({ trigger: input.trigger, envelopeIds: input.envelopeIds, ...(inputId === undefined ? {} : { inputId }) });
  const unexpect = (h: Hand) => void h.triggers.pop();

  const startRun = (h: Hand) => {
    if (h.goesOn !== undefined) {
      // Started before the restart, and recorded then: the turn takes it up as it was.
      h.run = h.goesOn;
      h.journal.runResumed(h.goesOn);
      delete h.goesOn;
      return;
    }
    const expected = h.triggers.shift();
    const by = expected?.trigger ?? { kind: "runtime" };
    const issue = core.session(h.id)?.issue ?? h.issue;
    const id = newId();
    const at = clock.now();
    // Assign `h.run` synchronously before async DB persistence so an immediate `report` finds it.
    h.run = id;
    h.heard = [];
    h.report = undefined;
    recordRun(`vibevalley: ${h.id}'s previous report was not cleared`, () => qs.clearPendingReport(db.sql, { id: h.id }));
    h.journal.runStarted(id);
    recordRun(`vibevalley: a run not kept (session ${h.id})`, () => runs.start(id, h.id, issue, by, at));
    if (expected?.inputId === undefined && expected !== undefined && expected.envelopeIds.length > 0) consume(h, expected.envelopeIds);
  };

  const consume = (h: Hand, envelopeIds: readonly string[]) => {
    const fresh = envelopeIds.filter((id) => !h.heard.includes(id));
    if (fresh.length === 0) return;
    h.heard.push(...fresh);
    if (h.run) {
      const run = h.run;
      const heard = [...h.heard];
      recordRun(`vibevalley: run ${run}`, () => runs.heard(run, heard));
    }
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
    recordRun(`vibevalley: run ${id}`, async () => {
      await db.tx(async () => {
        await runs.finish(id, outcome, summary, spent);
        const session = core.session(h.id);
        if (session) await qs.keepSessionState(db.sql, sessionState(session));
        await qs.clearPendingReport(db.sql, { id: h.id });
      });
      if (issue) tell({ _tag: "RunFinished", id, issue, outcome });
    });
  };

  const release = (h: Hand) => executor.detach(h.id);

  const closeExecution = (h: Hand) => executor.close(h.id);

  // Flush recovery state and detach before executor shutdown so interrupted turns reconcile on next startup rather than mid-exit.
  const close = async () => {
    closing = true;
    await tasks.stop("save");
    await flushRuns();
    await keepHands();
    for (const h of roster.values()) {
      h.journal.close();
      release(h);
      await h.stack.disposeAsync();
    }
    moves.close();
    changedSessions.close();
    newsHub.end();
    roster.clearTokens();
    await tasks.close();
    await flushRuns();
    await trajectories.close();
  };

  const runStore: RunStore = {
    ...runs,
    start: async (id, session, issue, trigger) => {
      await runs.start(id, session, issue, trigger);
      if (issue) tell({ _tag: "IssueStarted", issue, run: id });
    },
    link: (run, issue) => tell({ _tag: "IssueStarted", issue, run }),
    finished: (r) => tell({ _tag: "RunFinished", ...r }),
    consumed: (c) => tell({ _tag: "Consumed", ...c }),
    register: (session, current) => void executions.set(session, current),
  };
  return {
    tasks,
    fire,
    flushRuns,
    later,
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
    close,
  };
}

export type SessionRegistry = Awaited<ReturnType<typeof makeRegistry>>;
