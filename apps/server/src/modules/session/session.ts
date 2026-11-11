import { Array as Arr, Clock, Context, Effect, Exit, FileSystem, Layer, Option, PubSub, Schema, Scope, Semaphore, Stream, String as Str } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { dayMs, maxRunning } from "@vibevalley/protocol";
import { isBusy } from "@vibevalley/protocol/rules";
import { sessionId } from "@vibevalley/protocol/schema";

import { worker as sessionActor } from "#/base/actor.ts";
import { type ApiError, BizCode, reasonOf, refuseIn } from "#/base/errors.ts";
import { jsonText } from "#/base/json.ts";
import { Core } from "#/core/core.ts";
import { ServerConfig } from "#/infra/config.ts";
import { causeMessage, Db } from "#/infra/db.ts";
import { bestEffort } from "#/infra/log.ts";
import { Machine } from "#/modules/machine/machine.ts";
import type { Trigger } from "#/modules/mailbox/shapes.ts";
import { Memory } from "#/modules/memory/memory.ts";
import { Repo } from "#/modules/repo/repo.ts";
import { type Merged, type MergeFailure, type RepoError, type Workplace, type WorkplaceCleanup, type WorkplaceRelease } from "#/modules/repo/workplace.ts";

import { sessionName, type Settle, whoMakesRoom, withRecall } from "./briefing.ts";
import { type AgentHost, type HostOptions, makeHost } from "./host.ts";
import { NotRecorded } from "./inProcessRun.ts";
import { sourceBrief } from "./prompts.ts";
import { handsToUser, summaryOf } from "./report.ts";
import { isHired, isOnDuty, sessionOnIssue } from "./roster.ts";
import { contextPlace, releaseContextPlace } from "./shell.ts";
import { type Delivered, type DeliveryInput, DeliveryRefused, type RunFinished, type SessionNews } from "./signals.ts";

export type { SessionNews };
export type { RunFinished, RunStore };
export { DeliveryRefused, NotRecorded, NotTakenIn };
import * as qs from "#db/session.sql.ts";
import * as qr from "#db/session_run.sql.ts";

const endedListed = 200;

export class HireRefused extends Schema.TaggedError<HireRefused, { readonly brand: unique symbol }>()("HireRefused", {
  reason: Schema.String,
  retainedWork: Schema.optionalKey(Schema.Boolean),
}) {}

export interface Hired {
  readonly session: T.Session;
  readonly evicted?: string;
}

export interface HireOptions {
  readonly inputs?: readonly Trigger[];
  /** Base branch to fork from; "" uses the repo's main branch. */
  readonly base?: string;
  readonly worktree?: boolean;
  readonly channel?: string;
  readonly issue?: string;
  readonly trigger?: T.RunTrigger;
  readonly refining?: boolean;
  /** Runs after the session row is written, before any report or hired fact is visible. */
  readonly hiring?: (s: T.Session, launch: string) => Effect.Effect<void, NotRecorded>;
}

interface SendOptions extends Omit<HireOptions, "issue"> {
  readonly envelopeIds?: readonly string[];
  readonly context:
    | { readonly kind: "issue"; readonly issue: Pick<T.Issue, "id" | "number"> & { readonly mandate?: T.IssueMandate } }
    | { readonly kind: "channel"; readonly channel: string };
  readonly hiring?: (s: T.Session, launch: string) => Effect.Effect<void, NotRecorded>;
}

export class Session extends Context.Service<
  Session,
  {
    readonly noRoom: (runtime: string, repo: string) => string;
    /** Evicts the longest-idle session when at capacity; fails with `HireRefused` when runtime or repo limits block admission. */
    readonly makeRoom: (runtime: string, repo: string) => Effect.Effect<{ readonly evicted?: string }, HireRefused>;
    readonly hire: (agent: T.Agent, brief: string, where: string, opt: SendOptions) => Effect.Effect<{ readonly session: T.Session }, HireRefused>;
    readonly deliver: (id: string, text: string, input: DeliveryInput) => Effect.Effect<Delivered, DeliveryRefused>;
    readonly stop: (id: string) => Effect.Effect<boolean>;
    /** Closes an idle execution while preserving native session continuity for the next input. */
    readonly suspend: (id: string) => Effect.Effect<boolean, ApiError>;
    readonly withIdleWorkplace: <A, E>(id: string, use: (place: Workplace) => Effect.Effect<A, E>) => Effect.Effect<A, E | ApiError>;
    readonly withWorkplace: <A, E>(id: string, use: (place: Workplace) => Effect.Effect<A, E>) => Effect.Effect<A, E | ApiError>;
    /** `work: "discard"` resets the branch only after the runtime stops writing. */
    readonly dismiss: (id: string, work?: "keep" | "discard", closed?: "dismissed" | "completed") => Effect.Effect<boolean, ApiError>;
    /** Resets a read-only turn's worktree back to main while keeping the session open. */
    readonly discardWork: (id: string) => Effect.Effect<void, ApiError>;
    readonly clearWorkplace: (issue: string, repo: string, number: number, work?: WorkplaceCleanup) => Effect.Effect<WorkplaceRelease, ApiError>;
    readonly sessionOf: (id: string) => T.Session | undefined;
    readonly hired: () => readonly T.Session[];
    /** True when this process holds the session's `Hand` (including between launches). */
    readonly isReachable: (id: string) => boolean;
    readonly lastTextOf: (id: string) => string;
    readonly cwdOf: (id: string) => string | undefined;
    /** Rejects `..` segments and symlinks escaping the session's working directory. */
    readonly workFile: (id: string, path: string, max: number) => Effect.Effect<{ readonly name: string; readonly bytes: Uint8Array }, NotWorkFile>;
    readonly runOf: (id: string) => string | undefined;
    readonly reportOf: (id: string) => string;
    readonly report: (id: string, report: T.IssueReport) => Effect.Effect<void, ApiError>;
    readonly onIssue: (issue: string) => string | undefined;
    readonly handOver: (
      id: string,
      closed: T.SessionClose,
      use: (place: Workplace, lastText: string) => Effect.Effect<Merged, MergeFailure | RepoError>,
      settle?: Settle,
    ) => Effect.Effect<Merged, ApiError | NotTakenIn>;
    /** Pass `""` for all agents. */
    readonly list: (agent: string) => Effect.Effect<T.Session[]>;
    readonly get: (id: string) => Effect.Effect<T.Session | undefined>;
    readonly issueRuns: (issue: string) => Effect.Effect<T.Run[]>;
    readonly events: (id: string, run?: string) => Effect.Effect<T.SessionEvent[] | undefined>;
    /** Everything Session tells, subscribed before it returns: nothing told after is missed. */
    readonly news: Effect.Effect<Stream.Stream<SessionNews>, never, Scope.Scope>;
    /** Session id owning `token`, or `""` when unrecognized. */
    readonly who: (token: string) => string;
    readonly setAddress: (address: string) => void;
    readonly host: <R>(options: HostOptions<R>) => Effect.Effect<AgentHost<R>, NotRecorded, Scope.Scope>;
    readonly restore: Effect.Effect<void, NotRecorded>;
  }
>()("@vibevalley/server/modules/session/session") {
  static readonly layer = Layer.effect(
    Session,
    Effect.suspend(() => make),
  );
}

export function newsOf(fact: T.Fact, after: T.SpaceState): SessionNews | undefined {
  switch (fact.type) {
    case "sessionChanged": {
      const session = after.sessions.find((h) => h.id === fact.session.id);
      return session !== undefined && isHired(session) ? { _tag: "Hired", session } : undefined;
    }
    case "sessionReported": {
      const session = after.sessions.find((h) => h.id === fact.id);
      return session !== undefined && isHired(session) ? { _tag: "Reported", report: fact, session } : undefined;
    }
    case "sessionLeft":
      return { _tag: "Left", left: fact };
    default:
      return undefined;
  }
}

import { restoredSession, sessionState, runOf, endedSession, placeOf, heardOf, pendingReportOf } from "./history.ts";
import { NotTakenIn, reasonText, sessionLaunch } from "./launch.ts";
import { type Hand, type RunStore, sessionRegistry } from "./registry.ts";
import { sessionWatch } from "./watch.ts";

const refused = refuseIn(BizCode.SessionRefused);
export { runOf } from "./history.ts";

export class NotWorkFile extends Schema.TaggedError<NotWorkFile, { readonly brand: unique symbol }>()("NotWorkFile", {
  reason: Schema.Literals(["noPlace", "notFile", "outside", "tooBig", "unreadable"]),
  message: Schema.String,
}) {}

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
    newsHub,
    tell,
    moves,
    roster,
    executions,
    launchOf,
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
  const machines = yield* Machine;
  const executor = machines.executions(machines.here());
  const db = yield* Db;
  yield* Effect.forkScoped(
    Stream.runForEach(moves, ({ fact, after }) => {
      const news = newsOf(fact, after);
      if (news?._tag === "Reported" && news.session !== undefined && isHired(news.session) && news.session.issue === undefined) {
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
    yield* Effect.forEach(
      runs2,
      (r) =>
        Effect.gen(function* () {
          yield* runs.finish(r.id, "interrupted", t("server.session.log.restarted"));
          const linked = yield* runs.issues(r.id);
          tell({ _tag: "RunFinished", id: r.id, issues: linked, outcome: "interrupted" });
        }).pipe(bestEffort(`vibevalley: run ${r.id}`)),
      { discard: true },
    );
    const kept = yield* db.run(qs.activeSessions());
    // Continue numbering past the highest historical session id so trajectory files are never reused.
    hired = Math.max(
      0,
      (yield* db.run(qs.highestSessionNumber())).n ?? 0,
      ...core
        .state()
        .sessions.map((s) => Number.parseInt(s.id.replace(/^w/u, ""), 10))
        .filter((n) => Number.isFinite(n)),
    );
    for (const row of kept) {
      if (isOnDuty(row)) continue;
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
      const handScope = yield* Scope.make();
      const trajectory = yield* Scope.provide(
        Effect.acquireRelease(trajectories.openLog(session.id), () => trajectories.finish(session.id)),
        handScope,
      );
      const journal = yield* logOf(session, trajectory);
      const hand: Hand = {
        id: session.id,
        scope: handScope,
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
      };
      yield* Scope.addFinalizer(handScope, l.revokeAccess(hand));
      roster.set(hand);
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
    if (roster.size > 0) yield* Effect.logInfo(`vibevalley: brought back ${roster.size} helpers`);
  });
  const workFile = Effect.fn("Session.workFile")(function* (id: string, path: string, max: number) {
    const cwd = roster.get(id)?.place.cwd;
    if (cwd === undefined) return yield* NotWorkFile.make({ reason: "noPlace", message: path });
    const unreadable = (e: { readonly message: string }) => NotWorkFile.make({ reason: "unreadable", message: e.message });
    const root = yield* Effect.mapError(fs.realPath(cwd), unreadable);
    // Resolve `..` and symlinks via realPath before checking prefix containment.
    const full = yield* Effect.mapError(fs.realPath(root + "/" + path), () => NotWorkFile.make({ reason: "notFile", message: path }));
    if (full !== root && !Str.startsWith(root + "/")(full)) return yield* NotWorkFile.make({ reason: "outside", message: path });
    const info = yield* Effect.mapError(fs.stat(full), unreadable);
    if (info.type !== "File") return yield* NotWorkFile.make({ reason: "notFile", message: path });
    if (Number(info.size) > max) return yield* NotWorkFile.make({ reason: "tooBig", message: path });
    const bytes = yield* Effect.mapError(fs.readFile(full), unreadable);
    return { name: Arr.lastNonEmpty(Str.split("/")(full)), bytes };
  });

  const shape = Session.of({
    noRoom: roomFor,
    makeRoom: Effect.fn("Session.makeRoom")(function* (runtime, repo): Effect.fn.Return<{ readonly evicted?: string }, HireRefused> {
      const full = roomFor(runtime, repo);
      if (full) return yield* HireRefused.make({ reason: full });
      const oldest = whoMakesRoom(
        core.state().sessions.filter((s) => executor.find(s.id) !== undefined),
        maxRunning,
      );
      if (!oldest) return {};
      const freeing = oldest.issue ? shape.dismiss(oldest.id) : shape.suspend(oldest.id);
      return yield* freeing.pipe(
        Effect.mapError((e) => HireRefused.make({ reason: reasonOf(e) })),
        Effect.as({ evicted: oldest.name }),
      );
    }),
    hire: Effect.fn("Session.hire")(function* (agent, brief, where, opt): Effect.fn.Return<{ readonly session: T.Session }, HireRefused, Scope.Scope> {
      const callerScope = yield* Effect.scope;
      const permit = yield* Scope.fork(callerScope);
      yield* Scope.provide(
        Effect.acquireRelease(Effect.interruptible(admission.take(1)), (taken) => admission.release(taken)),
        permit,
      );
      const issue = opt.context.kind === "issue" ? opt.context.issue : undefined;
      const channel = opt.context.kind === "channel" ? opt.context.channel : opt.channel;
      const repo = issue ? where : "";
      const unclosed = executor
        .all()
        .find((a) => (issue ? a.owner.issue === issue.id : !a.owner.issue && a.owner.agent === agent.id && a.owner.channel === channel));
      if (unclosed)
        return yield* HireRefused.make({
          reason: unclosed.failure ?? t(issue ? "server.session.life.issueNotReturned" : "server.session.life.notReturned"),
          retainedWork: true,
        });
      const full = roomFor(agent.runtime, repo);
      if (full) return yield* HireRefused.make({ reason: full });
      hired++;
      const id = sessionId(`w${hired}`);
      const place = yield* (
        issue && repo ? repos.workplace(repo, issue.number, opt.worktree ?? agent.worktree, opt.base ?? "") : contextPlace(fs, config.workRoot, id)
      ).pipe(Effect.mapError((e) => HireRefused.make({ reason: t("server.session.life.noPlace", { name: agent.name, why: e.message }) })));
      const releasePlace = place.repo ? repos.release(place) : releaseContextPlace(fs, place);
      const handScope = yield* Scope.make();
      const startupScope = yield* Scope.make();
      const startup: { phase: "opening" | "retained" | "committed"; releaseKept: boolean } = {
        phase: "opening",
        releaseKept: false,
      };
      yield* Scope.addFinalizer(
        startupScope,
        Effect.suspend(() => {
          if (startup.phase !== "opening") return Effect.void;
          return Effect.flatMap(releasePlace, (result) => {
            if (!result.kept) return Effect.void;
            startup.releaseKept = true;
            return core.notice("warn", result.reason);
          });
        }),
      );
      const recalled = new Set<string>();
      const journal = yield* Scope.provide(
        Effect.acquireRelease(trajectories.openLog(id), () => trajectories.finish(id)),
        handScope,
      );
      const initial = opt.inputs ?? [];
      const h: Hand = {
        id,
        scope: handScope,
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
      yield* Scope.addFinalizer(
        handScope,
        Effect.suspend(() => (startup.phase === "retained" ? Effect.void : l.revokeAccess(h))),
      );
      yield* Scope.addFinalizer(
        startupScope,
        Effect.suspend(() => (startup.phase === "committed" ? Effect.void : Scope.close(handScope, Exit.void))),
      );
      yield* Scope.addFinalizer(
        startupScope,
        Effect.suspend(() => {
          if (startup.phase !== "opening") return Effect.void;
          return Effect.gen(function* () {
            const allocation = executor.find(id);
            if (allocation?.attached === true) {
              startup.phase = "retained";
              return;
            }
            if (allocation) {
              const stopFailed = yield* executor.close(id).pipe(
                Effect.as(false),
                Effect.catch((e) => Effect.as(core.notice("error", allocation.failure ?? reasonOf(e)), true)),
              );
              if (stopFailed) {
                startup.phase = "retained";
                return;
              }
            }
            yield* forget(id);
          });
        }),
      );
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
          machine: machines.here().id,
        };
        const initialText = initial.map((input) => `${input.id}\n${input.card.summary}\n${input.card.readUri}`).join("\n\n");
        const source = issue?.mandate?.originTriggerId;
        const prompt = [brief, source ? sourceBrief(source) : "", initialText].filter(Boolean).join("\n\n");
        const opened = yield* open(agent, session, h, place, withRecall(recall, prompt), "");
        if (!opened.execution) {
          if (opened.retained) startup.phase = "retained";
          yield* Scope.close(startupScope, Exit.void);
          return yield* HireRefused.make({
            reason: t("server.session.life.cannotSend", { name: agent.name, why: opened.refused }),
            ...(opened.retained || startup.releaseKept ? { retainedWork: true } : {}),
          });
        }
        // Release admission before `opt.hiring`, which may acquire channel locks whose delivery path waits on admission.
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
          if (opt.hiring) yield* opt.hiring(session, launch);
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              roster.set(h);
              yield* core.apply({ type: "sessionChanged", session });
              attach(h, opened.execution, agent.runtime, launch);
              startup.phase = "committed";
            }),
          );
          yield* Scope.close(startupScope, Exit.void);
          return { session };
        }).pipe(
          Effect.catchTag("NotRecorded", (error) =>
            Effect.gen(function* () {
              const failed = yield* failedOpening(id, t("server.session.life.notRecorded", { name: agent.name, why: reasonText(error) }));
              if (failed.retained) startup.phase = "retained";
              yield* Scope.close(startupScope, Exit.fail(error));
              return yield* HireRefused.make({
                reason: failed.refused,
                ...(failed.retained || startup.releaseKept ? { retainedWork: true } : {}),
              });
            }),
          ),
        );
      });
      return yield* starting.pipe(Effect.onExit((exit) => Scope.close(startupScope, exit)));
    }, Effect.scoped),
    deliver,
    stop: Effect.fn("Session.stop")(function* (id) {
      const execution = executor.find(id);
      const hand = roster.get(id);
      if (!hand || execution?.attached !== true || execution.closing || core.session(id)?.phase._tag !== "working") return false;
      if (hand.settling)
        return yield* roster
          .withHand(
            id,
            () => Effect.succeed(false),
            (locked) =>
              Effect.gen(function* () {
                const pending = locked.settling;
                if (!pending) return false;
                executor.detach(id);
                yield* executor.close(id);
                delete locked.settling;
                finishReport(locked, { ...pending.report, outcome: { kind: "aborted" } }, pending.completedBefore);
                closedLaunch(locked);
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
      return yield* roster.withHand(
        id,
        () => Effect.succeed(false),
        (h) =>
          Effect.gen(function* () {
            const session = core.session(id);
            if (!session || isBusy(session) || h.triggers.length > 0) return false;
            yield* rest(h);
            yield* keepHands;
            return true;
          }),
      );
    }),
    dismiss: Effect.fn("Session.dismiss")(function* (id, work = "keep", closed = "dismissed") {
      return yield* roster.withHand(
        id,
        () => Effect.succeed(false),
        (h) =>
          Effect.gen(function* () {
            const current = core.session(id);
            const name = current?.name ?? id;
            if (work === "discard" && !current?.issue) return yield* refused(t("server.session.life.noIssue"));
            yield* closeExecution(h);
            if (work === "discard" && h.place.branch)
              yield* repos.reset(h.place).pipe(Effect.catch((e) => core.notice("warn", t("server.session.life.notReset", { name, why: e.message }))));
            yield* leave(h, closed, 0);
            const kept = h.place.repo ? yield* repos.release(h.place) : yield* releaseContextPlace(fs, h.place);
            if (kept.kept) yield* core.notice("info", t("server.session.life.left", { name, why: kept.reason }));
            return true;
          }),
      );
    }),
    discardWork: Effect.fn("Session.discardWork")(function* (id) {
      if (!core.session(id)?.issue) return yield* refused(t("server.session.life.noIssue"));
      if (!roster.get(id)?.place.branch) return;
      yield* roster.withHand(
        id,
        () => Effect.void,
        (h) =>
          Effect.gen(function* () {
            const s = core.session(id);
            if (!s || isBusy(s) || !h.place.branch) return;
            yield* repos.reset(h.place).pipe(Effect.catch((e) => core.notice("warn", t("server.session.life.notReset", { name: s.name, why: e.message }))));
          }),
      );
    }),
    clearWorkplace: Effect.fn("Session.clearWorkplace")(function* (issue, repo, number, work) {
      const unclosed = executor.all().find((a) => a.owner.issue === issue);
      if (unclosed) return yield* refused(unclosed.failure ?? t("server.session.life.issueNotReturned"));
      if (core.state().sessions.some((s) => s.issue === issue)) return yield* refused(t("server.session.life.stillHasHelper"));
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
    hired: () => core.state().sessions.filter(isHired),
    isReachable: (id) => roster.has(id),
    lastTextOf: (id) => roster.get(id)?.lastText ?? "",
    cwdOf: (id) => roster.get(id)?.place.cwd,
    workFile,
    runOf: (id) => {
      const run = roster.get(id)?.run ?? executions.get(id)?.() ?? "";
      return run === "" ? undefined : run;
    },
    reportOf: (id) => summaryOf(roster.get(id)?.lastText ?? ""),
    report: Effect.fn("Session.report")(function* (id, report) {
      const noReport = () => Effect.fail(refused(t("server.session.life.noHelper", { id })));
      if (!core.session(id)?.issue) return yield* noReport();
      yield* roster.withHand(id, noReport, (h) =>
        Effect.gen(function* () {
          if (!core.session(id)?.issue || !h.run) return yield* noReport();
          yield* flushRuns;
          yield* db
            .attempt(Effect.flatMap(jsonText(report), (text) => qs.setPendingReport({ id, report: text })))
            .pipe(Effect.mapError((error) => error.pipe(causeMessage, refused)));
          h.report = report;
          if (h.settling && handsToUser(report)) {
            const pending = h.settling;
            delete h.settling;
            finishReport(h, pending.report, pending.completedBefore);
          }
        }),
      );
    }),
    onIssue: (issue) => sessionOnIssue(core.state(), issue)?.id,
    news: Effect.map(PubSub.subscribe(newsHub), Stream.fromSubscription),
    who: roster.who,
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
      return yield* makeHost({ ...o, memory: memories.forAgent(o.session.agent, o.session.id) }, journal, hostedRuns, { core, fs });
    }),
    restore,
  });
  return shape;
});

export const ready = Layer.effectDiscard(Effect.flatMap(Session, (s) => s.restore));
