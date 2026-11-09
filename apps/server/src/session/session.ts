import { Clock, Context, Effect, Exit, FileSystem, Layer, Option, PubSub, Scope, Semaphore, Stream } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { dayMs, maxRunning } from "@vibevalley/protocol";
import { isBusy } from "@vibevalley/protocol/rules";
import { sessionId } from "@vibevalley/protocol/schema";

import { session as sessionActor } from "#/base/actor.ts";
import { type ApiError, reasonOf, refused } from "#/base/errors.ts";
import { jsonText } from "#/base/json.ts";
import { Core } from "#/core/core.ts";
import { Executor } from "#/executor/executor.ts";
import { ServerConfig } from "#/infra/config.ts";
import { causeMessage, Db } from "#/infra/db.ts";
import { bestEffort } from "#/infra/log.ts";
import { Memory } from "#/memory/memory.ts";
import { Repo } from "#/repo/repo.ts";
import { type Merged, type MergeFailure, type RepoError, type Workplace, type WorkplaceCleanup, type WorkplaceRelease } from "#/repo/workplace.ts";

import { sessionName, type Settle, whoMakesRoom, withRecall } from "./briefing.ts";
import { type AgentHost, type HostOptions, makeHost } from "./host.ts";
import { NotRecorded } from "./inProcessRun.ts";
import { sourceBrief } from "./prompts.ts";
import { handsToOwner, summaryOf } from "./report.ts";
import { sessionOnIssue } from "./roster.ts";
import { contextPlace, releaseContextPlace } from "./shell.ts";
import type { Delivered, DeliveryInput, InputConsumed, InputReturned, LaunchActivity, SessionIdentity, SessionNews } from "./signals.ts";

export type { SessionNews };
export type { RunFinished, RunStore };
export { NotTakenIn };
export { NotRecorded };
import * as qs from "#db/session.sql.ts";
import * as qr from "#db/session_run.sql.ts";

/** The ended sessions a list shows, newest first: their trajectories expire after days anyway. */
const endedListed = 200;

export interface Hired {
  readonly session?: T.Session;
  readonly refused?: string;
  /** Who was sent home to make room. */
  readonly evicted?: string;
  /** A refused dispatch left work behind: its issue identity must be kept. */
  readonly retainedWork?: true;
}

export interface HireOptions {
  readonly inputs?: readonly T.Trigger[];
  /** The branch its own branch starts from; empty: the repo's main branch. */
  readonly base?: string;
  readonly worktree?: boolean;
  readonly channel?: string;
  /** Empty: the Issue service writes one from the issue before opening its session. */
  readonly issue?: string;
  /** What its first run is for; the issue sent out when none. */
  readonly trigger?: T.RunTrigger;
  /** It drafts the issue rather than works it. */
  readonly refining?: boolean;
  /** The caller's transaction after the session row is kept, before any report can be seen. */
  readonly hiring?: (s: T.Session, launch: string) => Effect.Effect<void, NotRecorded>;
}

interface SendOptions extends Omit<HireOptions, "issue"> {
  readonly envelopeIds?: readonly string[];
  readonly context:
    | { readonly kind: "issue"; readonly issue: Pick<T.Issue, "id" | "number"> & { readonly mandate?: T.IssueMandate } }
    | { readonly kind: "channel"; readonly channel: string };
  /** Registers source routing before the hired fact or any report can be seen. */
  readonly hiring?: (s: T.Session, launch: string) => Effect.Effect<void, NotRecorded>;
}

export class Session extends Context.Service<
  Session,
  {
    readonly noRoom: (runtime: string, repo: string) => string;
    /** Room for one more on runtime in repo: refused when either is at its limit; a full farm sends home whoever has
     * been idle longest, and says who. */
    readonly makeRoom: (runtime: string, repo: string) => Effect.Effect<{ readonly refused: string } | { readonly evicted?: string }>;
    readonly hire: (agent: T.Agent, brief: string, where: string, opt: SendOptions) => Effect.Effect<Hired>;
    readonly deliver: (id: string, text: string, input: DeliveryInput) => Effect.Effect<Delivered>;
    readonly stop: (id: string) => Effect.Effect<boolean>;
    /** Closes an idle execution, keeping the context and native session identity for its next input. */
    readonly suspend: (id: string) => Effect.Effect<boolean, ApiError>;
    readonly withIdleWorkplace: <A, E>(id: string, use: (place: Workplace) => Effect.Effect<A, E>) => Effect.Effect<A, E | ApiError>;
    readonly withWorkplace: <A, E>(id: string, use: (place: Workplace) => Effect.Effect<A, E>) => Effect.Effect<A, E | ApiError>;
    /** Discard resets its branch only after the runtime has stopped writing. */
    /** closed: how it leaves, "dismissed" unless its issue was completed without a merge ("completed"). */
    readonly dismiss: (id: string, work?: "keep" | "discard", closed?: "dismissed" | "completed") => Effect.Effect<boolean, ApiError>;
    /** A read-only round's leftovers go: its worktree back to the main branch, what it changed or committed gone. the session stays. */
    readonly discardWork: (id: string) => Effect.Effect<void, ApiError>;
    /** Removes an issue's unused workplace; an active or unclosed startup still owns it. */
    readonly clearWorkplace: (issue: string, repo: string, number: number, work?: WorkplaceCleanup) => Effect.Effect<WorkplaceRelease, ApiError>;
    /** A session on the farm now, as the core state has it: what another module reads a session by. */
    readonly sessionOf: (id: string) => T.Session | undefined;
    readonly presentSessions: () => readonly T.Session[];
    /** On the farm now: it can be handed a message. */
    readonly present: (id: string) => boolean;
    /** Its complete last answer, kept out of the core frame. */
    readonly lastTextOf: (id: string) => string;
    /** Its host-local working directory, kept out of the protocol shape. */
    readonly cwdOf: (id: string) => string | undefined;
    /** The run it is in now; undefined between runs. */
    readonly runOf: (id: string) => string | undefined;
    /** Its report, from what it last said in full. */
    readonly reportOf: (id: string) => string;
    /** The structure the worker explicitly hands back for its current run. */
    readonly report: (id: string, report: T.IssueReport) => Effect.Effect<void, ApiError>;
    /** The helper working the issue now, if one is. */
    readonly onIssue: (issue: string) => string | undefined;
    /** The session hands its workplace over and leaves as closed says. Refused while it works. */
    readonly handOver: (
      id: string,
      closed: T.SessionClose,
      use: (place: Workplace, lastText: string) => Effect.Effect<Merged, MergeFailure | RepoError>,
      settle?: Settle,
    ) => Effect.Effect<Merged, ApiError | NotTakenIn>;
    /** Every session of the agent, or of every agent when it is empty: on the farm and ended, newest first. */
    readonly list: (agent: string) => Effect.Effect<T.Session[]>;
    /** A session on the farm, or one that has ended. */
    readonly get: (id: string) => Effect.Effect<T.Session | undefined>;
    readonly issueRuns: (issue: string) => Effect.Effect<T.Run[]>;
    /** A session's log, oldest first; a run's only when run is given. */
    readonly events: (id: string, run?: string) => Effect.Effect<T.SessionEvent[] | undefined>;
    /** These four are subscribed before they return: nothing published after is missed. */
    readonly launches: Effect.Effect<Stream.Stream<LaunchActivity>, never, Scope.Scope>;
    /** A session hired, reported or gone, with the session as it stood after: what the issues and their child issues follow. */
    readonly news: Effect.Effect<Stream.Stream<SessionNews>, never, Scope.Scope>;
    readonly startedIssues: Effect.Effect<Stream.Stream<string>, never, Scope.Scope>;
    readonly finishedRuns: Effect.Effect<Stream.Stream<RunFinished>, never, Scope.Scope>;
    readonly inputsConsumed: Effect.Effect<Stream.Stream<InputConsumed>, never, Scope.Scope>;
    readonly inputsReturned: Effect.Effect<Stream.Stream<InputReturned>, never, Scope.Scope>;
    /** Persists an Agent's Session identity before anything can record a Run or address its mailbox. */
    readonly register: (session: SessionIdentity) => Effect.Effect<void, NotRecorded>;
    /** Whose token it is; "" when nobody's. */
    readonly who: (token: string) => string;
    /** For a farm listening on a free port: sessions opened from now on reach /mcp there. */
    readonly setAddress: (address: string) => void;
    /** An agent run in this process (the orchestrator), in the caller's scope: its log and its runs are kept as a session's are. */
    readonly host: <R>(options: HostOptions<R>) => Effect.Effect<AgentHost<R>, NotRecorded, Scope.Scope>;
    /** Brings back the sessions the farm had when it stopped, once every service is ready. */
    readonly restore: Effect.Effect<void, NotRecorded>;
  }
>()("@vibevalley/server/session/session") {
  static readonly layer = Layer.effect(
    Session,
    Effect.suspend(() => make),
  );
}

/** A session's own fact as news; the rest are not the sessions'. */
export function newsOf(fact: T.Fact, after: T.SpaceState): SessionNews | undefined {
  switch (fact.type) {
    case "sessionChanged": {
      const session = after.sessions.find((h) => h.id === fact.session.id);
      return session?.role === "worker" ? { _tag: "hired", session } : undefined;
    }
    case "sessionReported": {
      const session = after.sessions.find((h) => h.id === fact.id);
      return session?.role === "worker" ? { _tag: "reported", report: fact, session } : undefined;
    }
    case "sessionLeft":
      return { _tag: "left", left: fact };
    default:
      return undefined;
  }
}

import { restoredSession, sessionState, runOf, endedSession, placeOf, heardOf, pendingReportOf } from "./history.ts";
import { NotTakenIn, reasonText, sessionLaunch } from "./launch.ts";
import { type Hand, type RunFinished, type RunStore, sessionRegistry } from "./registry.ts";
import { sessionWatch } from "./watch.ts";
export { runOf } from "./history.ts";
const make = Effect.gen(function* () {
  const r = yield* sessionRegistry;
  const wt = yield* sessionWatch(r);
  const l = yield* sessionLaunch(r, wt);
  const {
    flushRuns,
    later,
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
    hands,
    executions,
    launchOf,
    who,
    keepHands,
    register,
    ended,
    forget,
    logOf,
    runs,
    closeExecution,
    runStore,
  } = r;
  const { open, leave, rest, accessWorkplace, capacity, roomFor, remind, deliver, handOver } = l;
  const { closedLaunch, finishReport, attach, failedOpening } = wt;
  const config = yield* ServerConfig;
  const core = yield* Core;
  const fs = yield* FileSystem.FileSystem;
  const memories = yield* Memory;
  const repos = yield* Repo;
  const executor = yield* Executor;
  const db = yield* Db;
  yield* Effect.forkScoped(
    Stream.runForEach(moves, ({ fact, after }) => {
      const news = newsOf(fact, after);
      if (news?._tag === "reported" && news.session?.role === "worker" && news.session.issue === undefined) {
        const id = news.session.id;
        const deadline = fact.at + 10 * 60_000;
        void later(
          `idle:${id}`,
          Effect.gen(function* () {
            yield* Effect.sleep(Math.max(0, deadline - (yield* Clock.currentTimeMillis)));
            yield* shape.suspend(id);
          }).pipe(bestEffort(`vibevalley: suspending conversation ${id}`)),
        );
      }
      return news ? PubSub.publish(newsHub, news) : Effect.void;
    }),
  );
  let hired = 0;

  const expireLogs = Effect.fn("Session.expireLogs")(function* (days: number) {
    if (days <= 0) return;
    const ids = yield* db.run(qs.sessionsEndedBefore({ before: (yield* Clock.currentTimeMillis) - days * dayMs }));
    yield* Effect.forEach(ids, (r) => trajectories.forget(r.id), { discard: true });
  });

  const restore = Effect.gen(function* () {
    yield* expireLogs(config.session.trajectoryDays);
    const runs2 = yield* db.run(qr.openRuns());
    // The runs still going when the server stopped stopped with it.
    yield* Effect.forEach(
      runs2,
      (r) =>
        Effect.gen(function* () {
          yield* runs.finish(r.id, "interrupted", t("server.session.log.restarted"));
          const linked = yield* runs.issues(r.id);
          PubSub.publishUnsafe(finishedHub, { id: r.id, issues: linked, outcome: "interrupted" } satisfies RunFinished);
        }).pipe(bestEffort(`vibevalley: run ${r.id}`)),
      { discard: true },
    );
    const kept = yield* db.run(qs.activeSessions());
    // Numbering goes on from the highest id seen, so a new session never takes an old one's steps.
    hired = Math.max(
      0,
      (yield* db.run(qs.highestSessionNumber())).n ?? 0,
      ...core
        .state()
        .sessions.map((s) => Number.parseInt(s.id.replace(/^w/u, ""), 10))
        .filter((n) => Number.isFinite(n)),
    );
    for (const row of kept) {
      if (row.role === "orchestrator") continue;
      const session = core.session(row.id) ?? restoredSession(row);
      const place = row.place ? placeOf(row.place) : undefined;
      if (!place || !(yield* Effect.orElseSucceed(fs.exists(place.cwd), () => false))) {
        yield* core.apply({ type: "sessionLeft", id: session.id, closed: "lost" });
        yield* trajectories.finish(session.id);
        yield* ended(session.id, "lost");
        yield* core.notice(
          "warn",
          t("server.session.life.notBack", {
            name: session.name,
            why: place ? t("server.session.life.placeGone", { cwd: place.cwd }) : t("server.session.life.noRecord"),
          }),
        );
        continue;
      }
      const s = {
        place,
        oarSessionId: row.oar_session ?? "",
        lastText: row.last_text ?? "",
        recalled: heardOf(row.recalled) ?? [],
        report: pendingReportOf(row.pending_report),
      };
      const trajectory = yield* trajectories.openLog(session.id);
      const journal = yield* logOf(session, trajectory);
      hands.set(session.id, {
        id: session.id,
        place: s.place,
        issue: session.issue ?? "",
        access: Semaphore.makeUnsafe(1),
        journal,
        oarSessionId: s.oarSessionId,
        lastText: s.lastText,
        tracking: {},
        launch: "",
        spoke: false,
        token: "",
        recalled: new Set(s.recalled),
        triggers: [],
        inputs: new Map(),
        run: "",
        heard: [],
        report: s.report,
      });
      if (isBusy(session)) {
        yield* core.apply({
          type: "sessionReported",
          id: session.id,
          outcome: "interrupted",
          summary: s.report?.summary ?? t("server.session.log.restarted"),
          runs: session.runs,
          questions: s.report?.questions ?? [],
          checks: s.report?.checks ?? [],
          ...(s.report?.answer ? { answer: s.report.answer } : {}),
        });
        const restoredReport = s.report;
        if (restoredReport && restoredReport.remember.length > 0)
          yield* Effect.forEach(
            restoredReport.remember,
            (memory) =>
              memories.write({ agent: session.agent, text: memory.text, repo: memory.scope === "all" ? "" : place.repo, by: sessionActor(session.id) }),
            { discard: true },
          ).pipe(bestEffort(`vibevalley: ${session.id}'s restored memories were not kept`));
        yield* db.inTx(
          Effect.gen(function* () {
            const restored = core.session(session.id);
            if (restored) yield* db.run(Effect.flatMap(sessionState(restored), qs.keepSessionState));
            yield* db.run(qs.clearPendingReport({ id: session.id }));
          }),
        );
        yield* core.notice("info", t("server.session.life.restartedNotice", { name: session.name }));
      }
    }
    if (hands.size > 0) yield* Effect.logInfo(`vibevalley: brought back ${hands.size} helpers`);
  });
  const shape = Session.of({
    noRoom: roomFor,
    makeRoom: Effect.fn("Session.makeRoom")(function* (runtime, repo): Effect.fn.Return<{ readonly refused: string } | { readonly evicted?: string }> {
      const full = roomFor(runtime, repo);
      if (full) return { refused: full };
      const oldest = whoMakesRoom(
        core.state().sessions.filter((s) => executor.find(s.id) !== undefined),
        maxRunning,
      );
      if (!oldest) return {};
      const freeing = oldest.issue ? shape.dismiss(oldest.id) : shape.suspend(oldest.id);
      return yield* freeing.pipe(Effect.match({ onFailure: (e) => ({ refused: reasonOf(e) }), onSuccess: () => ({ evicted: oldest.name }) }));
    }),
    hire: Effect.fn("Session.hire")(function* (agent, brief, where, opt) {
      const scope2 = yield* Effect.scope;
      const permit = yield* Scope.fork(scope2);
      yield* Effect.acquireRelease(Effect.interruptible(admission.take(1)), (taken) => admission.release(taken)).pipe(
        Effect.provideService(Scope.Scope, permit),
      );
      const issue = opt.context.kind === "issue" ? opt.context.issue : undefined;
      const channel = opt.context.kind === "channel" ? opt.context.channel : opt.channel;
      const repo = issue ? where : "";
      const unclosed = executor
        .all()
        .find((a) => (issue ? a.owner.issue === issue.id : !a.owner.issue && a.owner.agent === agent.id && a.owner.channel === channel));
      if (unclosed)
        return {
          refused: unclosed.failure ?? t(issue ? "server.session.life.issueNotReturned" : "server.session.life.notReturned"),
          retainedWork: true as const,
        };
      const full = roomFor(agent.runtime, repo);
      if (full) return { refused: full };
      hired++;
      const id = sessionId(`w${hired}`);
      const openedPlace = yield* (
        issue && repo
          ? repos.workplace(repo, issue.number, opt.worktree ?? agent.worktree, opt.base ?? "")
          : contextPlace(config.workRoot, id).pipe(Effect.provideService(FileSystem.FileSystem, fs))
      ).pipe(
        Effect.match({
          onFailure: (e) => ({ ok: false as const, refused: t("server.session.life.noPlace", { name: agent.name, why: e.message }) }),
          onSuccess: (place) => ({ ok: true as const, place }),
        }),
      );
      if (!openedPlace.ok) return { refused: openedPlace.refused };
      const place = openedPlace.place;
      const releasePlace = place.repo ? repos.release(place) : releaseContextPlace(place).pipe(Effect.provideService(FileSystem.FileSystem, fs));
      let committed = false;
      let released = false;
      let registeredRow = false;
      const recalled = new Set<string>();
      const journal = yield* trajectories.openLog(id);
      const initial = opt.inputs ?? [];
      const h: Hand = {
        id,
        place,
        issue: issue?.id ?? "",
        access: Semaphore.makeUnsafe(1),
        journal,
        oarSessionId: "",
        lastText: "",
        tracking: {},
        launch: "",
        spoke: false,
        token: "",
        recalled,
        triggers: [
          {
            trigger: opt.trigger ?? (issue ? { kind: "issue" } : { kind: "comment", ...(channel ? { channel } : {}) }),
            envelopeIds: [...new Set([...(opt.envelopeIds ?? []), ...initial.map((input) => input.id)])],
          },
        ],
        inputs: new Map(),
        run: "",
        heard: [],
        report: undefined,
      };
      const starting = Effect.gen(function* () {
        const recall = yield* remind(agent.id, id, place.repo, brief, recalled);
        const hiredAt = yield* Clock.currentTimeMillis;
        const session: T.Session = {
          id,
          role: "worker",
          name: sessionName(capacity(), agent.id, agent.name),
          agent: agent.id,
          runtime: agent.runtime,
          brief,
          ...(place.repo ? { repo: place.repo } : {}),
          hiredAt,
          runs: 0,
          phase: { _tag: "working", since: hiredAt, doing: { action: "none", label: "" } },
          ...(channel ? { channel } : {}),
          refining: issue ? (opt.refining ?? false) : false,
          ...(issue ? { issue: issue.id } : {}),
          ...(place.branch ? { branch: place.branch, worktree: place.cwd } : {}),
        };
        const refuseStart = (why: string, retained: boolean): Effect.Effect<Hired> =>
          Effect.gen(function* () {
            yield* trajectories.finish(id);
            if (retained) return { refused: why, retainedWork: true };
            yield* l.revokeAccess(h);
            const result = yield* releasePlace;
            released = true;
            if (result.kept) yield* core.notice("warn", result.reason);
            return { refused: why, ...(result.kept ? { retainedWork: true as const } : {}) };
          });
        const initialText = initial.map((input) => `${input.id}\n${input.card.summary}\n${input.card.readUri}`).join("\n\n");
        const source = issue?.mandate?.originTriggerId;
        const prompt = [brief, source ? sourceBrief(source) : "", initialText].filter(Boolean).join("\n\n");
        const opened = yield* open(agent, session, h, place, withRecall(recall, prompt), "");
        if (!opened.execution) return yield* refuseStart(t("server.session.life.cannotSend", { name: agent.name, why: opened.refused }), opened.retained);
        // The execution now reserves capacity; source registration may take the channel lock, whose delivery waits on admission.
        yield* Scope.close(permit, Exit.void);
        const launch = launchOf(id);
        return yield* Effect.gen(function* () {
          yield* db.inTx(
            Effect.gen(function* () {
              yield* logOf(session, journal);
              yield* db
                .attempt(
                  Effect.flatMap(
                    Effect.all({ placeJson: jsonText(place), recalledJson: recalled.size > 0 ? jsonText([...recalled]) : Effect.succeed(null) }),
                    ({ placeJson, recalledJson }) =>
                      qs.keepHand({
                        id,
                        place: placeJson,
                        oar_session: opened.execution.sessionId ?? null,
                        last_text: null,
                        recalled: recalledJson,
                      }),
                  ),
                )
                .pipe(Effect.mapError((cause) => NotRecorded.make({ message: causeMessage(cause), cause })));
            }),
          );
          registeredRow = true;
          if (opt.hiring) yield* opt.hiring(session, launch);
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              hands.set(id, h);
              yield* core.apply({ type: "sessionChanged", session });
              attach(h, opened.execution, agent.runtime, launch);
              committed = true;
            }),
          );
          return { session };
        }).pipe(
          Effect.catchTag("NotRecorded", (error) =>
            Effect.gen(function* () {
              const failed = yield* failedOpening(id, t("server.session.life.notRecorded", { name: agent.name, why: reasonText(error) }));
              if (!failed.retained) {
                yield* forget(id);
                registeredRow = false;
              }
              return yield* refuseStart(failed.refused, failed.retained);
            }),
          ),
        );
      });
      return yield* starting.pipe(
        Effect.onExit((exit) => {
          if (exit._tag === "Success" || committed || released) return Effect.void;
          return Effect.gen(function* () {
            yield* trajectories.finish(id);
            const allocation = executor.find(id);
            if (allocation?.attached === true) return;
            if (allocation) {
              const stopFailed = yield* executor.close(id).pipe(
                Effect.as(false),
                Effect.catch((e) => Effect.as(core.notice("error", allocation.failure ?? reasonOf(e)), true)),
              );
              if (stopFailed) return;
            }
            if (registeredRow) yield* forget(id);
            yield* l.revokeAccess(h);
            const result = yield* releasePlace;
            if (result.kept) yield* core.notice("warn", result.reason);
          });
        }),
      );
    }, Effect.scoped),
    deliver,
    stop: Effect.fn("Session.stop")(function* (id) {
      const execution = executor.find(id);
      const hand = hands.get(id);
      if (!hand || execution?.attached !== true || execution.closing || core.session(id)?.phase._tag !== "working") return false;
      if (hand.settling)
        return yield* hand.access
          .withPermits(1)(
            Effect.gen(function* () {
              const pending = hand.settling;
              if (!pending) return false;
              executor.detach(id);
              yield* executor.close(id);
              delete hand.settling;
              finishReport(hand, { ...pending.report, outcome: { kind: "aborted" } }, pending.completedBefore);
              closedLaunch(hand);
              return true;
            }),
          )
          .pipe(Effect.catch((error) => Effect.as(Effect.logWarning(`vibevalley: background work did not close: ${reasonOf(error)}`), false)));
      const outcome = yield* executor.interrupt(id);
      if (outcome.kind !== "accepted") {
        yield* Effect.logWarning(`vibevalley: the stop was not taken: ${"reason" in outcome ? outcome.reason : ""}`).pipe(Effect.annotateLogs({ session: id }));
        return false;
      }
      return true;
    }),
    suspend: Effect.fn("Session.suspend")(function* (id) {
      const h = hands.get(id);
      if (!h) return false;
      return yield* h.access.withPermits(1)(
        Effect.gen(function* () {
          const session = core.session(id);
          if (hands.get(id) !== h || !session || isBusy(session) || h.triggers.length > 0) return false;
          yield* rest(h);
          yield* keepHands;
          return true;
        }),
      );
    }),
    dismiss: Effect.fn("Session.dismiss")(function* (id, work = "keep", closed = "dismissed") {
      const h = hands.get(id);
      if (!h) return false;
      return yield* h.access.withPermits(1)(
        Effect.gen(function* () {
          if (hands.get(id) !== h) return false;
          const current = core.session(id);
          const name = current?.name ?? id;
          if (work === "discard" && !current?.issue) return yield* Effect.fail(refused(t("server.session.life.noIssue")));
          yield* closeExecution(h);
          if (work === "discard" && h.place.branch)
            yield* repos.reset(h.place).pipe(Effect.catch((e) => core.notice("warn", t("server.session.life.notReset", { name, why: e.message }))));
          yield* leave(h, closed, 0);
          const kept = h.place.repo
            ? yield* repos.release(h.place)
            : yield* releaseContextPlace(h.place).pipe(Effect.provideService(FileSystem.FileSystem, fs));
          if (kept.kept) yield* core.notice("info", t("server.session.life.left", { name, why: kept.reason }));
          return true;
        }),
      );
    }),
    discardWork: Effect.fn("Session.discardWork")(function* (id) {
      const h = hands.get(id);
      if (!core.session(id)?.issue) return yield* Effect.fail(refused(t("server.session.life.noIssue")));
      if (!h?.place.branch) return;
      yield* h.access.withPermits(1)(
        Effect.gen(function* () {
          const s = core.session(id);
          if (hands.get(id) !== h || !s || isBusy(s)) return;
          yield* repos.reset(h.place).pipe(Effect.catch((e) => core.notice("warn", t("server.session.life.notReset", { name: s.name, why: e.message }))));
        }),
      );
    }),
    clearWorkplace: Effect.fn("Session.clearWorkplace")(function* (issue, repo, number, work) {
      const unclosed = executor.all().find((a) => a.owner.issue === issue);
      if (unclosed) return yield* Effect.fail(refused(unclosed.failure ?? t("server.session.life.issueNotReturned")));
      if (core.state().sessions.some((s) => s.issue === issue)) return yield* Effect.fail(refused(t("server.session.life.stillHasHelper")));
      return yield* repos.clear(repo, number, work);
    }, admission.withPermits(1)),
    handOver,
    withIdleWorkplace: Effect.fn("Session.withIdleWorkplace")(function* <A, E>(id: string, use: (place: Workplace) => Effect.Effect<A, E>) {
      return yield* accessWorkplace(id, use, true);
    }),
    withWorkplace: Effect.fn("Session.withWorkplace")(function* <A, E>(id: string, use: (place: Workplace) => Effect.Effect<A, E>) {
      return yield* accessWorkplace(id, use, false);
    }),
    list: Effect.fn("Session.list")(function* (agent) {
      const out = core.state().sessions.filter((s) => !agent || s.agent === agent);
      const rows = yield* db.run(qs.endedSessions({ agent, n: endedListed }));
      const runs = yield* db.run(qr.runsOfSessions({ sessions: rows.map((r) => r.id) }));
      const bySession = Map.groupBy(runs, (r) => r.session);
      for (const r of rows) if (!out.some((s) => s.id === r.id)) out.push(endedSession(r, bySession.get(r.id) ?? []));
      return out.toSorted((a, b) => b.hiredAt - a.hiredAt);
    }),
    get: Effect.fn("Session.get")(function* (id) {
      const live = core.session(id);
      if (live) return live;
      const r = yield* db.run(Effect.catchNoSuchElement(qs.sessionByID({ id })));
      if (Option.isNone(r) || r.value.ended_at === null) return undefined;
      const runsOfSession2 = yield* db.run(qr.runsOfSession({ session: id }));
      return endedSession(r.value, runsOfSession2);
    }),
    issueRuns: Effect.fn("Session.issueRuns")(function* (issue) {
      const rows = yield* db.run(qr.runsOfIssue({ issue_id: issue }));
      return rows.map(runOf);
    }),
    events: (id, r) => trajectories.events(id, r),
    sessionOf: (id) => core.session(id),
    presentSessions: () => core.state().sessions.filter((s) => s.role === "worker"),
    present: (id) => hands.has(id),
    lastTextOf: (id) => hands.get(id)?.lastText ?? "",
    cwdOf: (id) => hands.get(id)?.place.cwd,
    runOf: (id) => {
      const run = hands.get(id)?.run ?? executions.get(id)?.() ?? "";
      return run === "" ? undefined : run;
    },
    reportOf: (id) => summaryOf(hands.get(id)?.lastText ?? ""),
    report: Effect.fn("Session.report")(function* (id, report) {
      const h = hands.get(id);
      const session = core.session(id);
      if (!h || !session?.issue || !h.run) return yield* Effect.fail(refused(t("server.session.life.noHelper", { id })));
      yield* h.access.withPermits(1)(
        Effect.gen(function* () {
          yield* flushRuns;
          yield* db
            .attempt(Effect.flatMap(jsonText(report), (text) => qs.setPendingReport({ id, report: text })))
            .pipe(Effect.mapError((error) => error.pipe(causeMessage, refused)));
          h.report = report;
          if (h.settling && handsToOwner(report)) {
            const pending = h.settling;
            delete h.settling;
            finishReport(h, pending.report, pending.completedBefore);
          }
        }),
      );
    }),
    onIssue: (issue) => sessionOnIssue(core.state(), issue)?.id,
    launches: Effect.map(PubSub.subscribe(launchesHub), Stream.fromSubscription),
    news: Effect.map(PubSub.subscribe(newsHub), Stream.fromSubscription),
    startedIssues: Effect.map(PubSub.subscribe(startedIssuesHub), Stream.fromSubscription),
    finishedRuns: Effect.map(PubSub.subscribe(finishedHub), Stream.fromSubscription),
    inputsConsumed: Effect.map(PubSub.subscribe(consumedHub), Stream.fromSubscription),
    inputsReturned: Effect.map(PubSub.subscribe(returnedHub), Stream.fromSubscription),
    register,
    who,
    setAddress: (address) => void (mcpEndpoint.url = `http://${address}/mcp`),
    host: Effect.fn("Session.host")(function* <R>(o: HostOptions<R>) {
      yield* register(o.session);
      const hostedRuns: RunStore = {
        ...runStore,
        finish: Effect.fn("Session.finishHostedRun")(function* (run, outcome, summary, spent) {
          yield* runStore.finish(run, outcome, summary, spent);
          const session = core.session(o.session.id);
          if (session)
            yield* core.apply({
              type: "sessionReported",
              id: session.id,
              run,
              outcome,
              summary,
              runs: session.runs + 1,
              questions: [],
              checks: [],
              ...(spent ? { spent } : {}),
            });
        }),
      };
      const journal = yield* trajectories.openLog(o.session.id, o.keepEvents);
      return yield* makeHost({ ...o, memory: memories.forAgent(o.session.agent, o.session.id) }, journal, hostedRuns).pipe(
        Effect.provideService(Core, core),
        Effect.provideService(FileSystem.FileSystem, fs),
      );
    }),
    restore,
  });
  return shape;
});

/** Brings the sessions back once every service is built. */
export const ready = Layer.effectDiscard(Effect.flatMap(Session, (s) => s.restore));
