import { join, resolve } from "node:path";

import type { ControlOutcome, Event, Runtime as OarRuntime, Session as RuntimeSession, SessionOptions } from "@botiverse/oar";
import { createSubagents, type SendResult, type Subagent, type SubagentReport, type Subagents } from "@botiverse/oar/agents";
import { Clock, Context, Deferred, Effect, Exit, FiberMap, FiberSet, Layer, Metric, Schema } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { maxRunning } from "@vibevalley/protocol";

import { type ApiError, messageOf, reasonOf, refused } from "@/errors.ts";
import { projectsDir, ServerConfig } from "@/infra/config.ts";
import { probeInstallation, Runtime } from "@/runtime/runtime.ts";

import { watchStalls } from "./stalls.ts";

/** An acquired execution remains present until every runtime resource confirms disposal. */
export interface Execution {
  readonly owner: T.Session;
  readonly sessionId: string;
  readonly attached: boolean;
  readonly closing: boolean;
  readonly failure?: string;
}

export interface StartExecution {
  readonly agent: T.Agent;
  readonly owner: T.Session;
  readonly cwd: string;
  readonly input: string;
  readonly resume: string;
  readonly options: Partial<SessionOptions>;
}

export interface ExecutionObserver {
  readonly event: (event: Event) => void;
  readonly report: (report: SubagentReport) => void;
  readonly stalled: (silentForMs: number, at: number) => void;
  readonly stallMs: number;
}

export type StartFailure = { readonly execution?: never; readonly refused: string; readonly retained: boolean };
export type Started = { readonly execution: Execution; readonly refused?: never; readonly retained?: never } | StartFailure;

class NotClosed extends Schema.TaggedError<NotClosed, { readonly brand: unique symbol }>()("NotClosed", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

interface Allocation extends Execution {
  readonly subagents: Subagents;
  readonly resources: Set<RuntimeSession>;
  agent?: Subagent;
  sessionId: string;
  attached: boolean;
  detached: boolean;
  closing: boolean;
  failure?: string;
  closingWait?: Deferred.Deferred<void, NotClosed>;
  stop?: () => void;
}

const notClosed = (cause: unknown) => new NotClosed({ message: messageOf(cause), cause });
const running = Metric.gauge("vibevalley.sessions.running", { description: "Runtime sessions open now (the helpers' and the orchestrators')" });
const closeWaitMs = 15_000;

export class Executor extends Context.Service<
  Executor,
  {
    readonly start: (input: StartExecution) => Effect.Effect<Started>;
    readonly deliver: (id: string, text: string) => Effect.Effect<SendResult>;
    readonly interrupt: (id: string) => Effect.Effect<ControlOutcome | { readonly kind: "failed"; readonly reason: string }>;
    readonly close: (id: string) => Effect.Effect<void, ApiError>;
    readonly failed: (id: string, why: string) => Effect.Effect<StartFailure>;
    readonly observe: (id: string, observer: ExecutionObserver) => void;
    readonly detach: (id: string) => void;
    readonly find: (id: string) => Execution | undefined;
    readonly all: () => readonly Execution[];
  }
>()("vibevalley/Executor") {
  static readonly layer = Layer.effect(
    Executor,
    Effect.suspend(() => make),
  );
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const runtimes = yield* Runtime;
  const clock = yield* Clock.Clock;
  const forkHere = yield* FiberSet.makeRuntime();
  const timers = yield* FiberMap.make<string>();
  const later = yield* FiberMap.runtime(timers)();
  const allocations = new Map<string, Allocation>();

  // Closing outlives an interrupted caller; all later callers receive the same disposal result.
  const closeAllocation = (allocation: Allocation): Effect.Effect<void, NotClosed> =>
    Effect.suspend(() => {
      if (allocation.closingWait) return Deferred.await(allocation.closingWait);
      const closing = Deferred.makeUnsafe<void, NotClosed>();
      allocation.closingWait = closing;
      allocation.closing = true;
      const close = Effect.gen(function* () {
        const crew = yield* Effect.exit(Effect.tryPromise({ try: () => allocation.subagents.close(), catch: notClosed }));
        // oar may already have closed its Subagent after a failed prompt; that no-op does not confirm disposal.
        const resources = yield* Effect.forEach(
          [...allocation.resources],
          (session) => Effect.exit(Effect.tryPromise({ try: () => session.dispose(), catch: notClosed })),
          { concurrency: "unbounded" },
        );
        const failed = [crew, ...resources].find(Exit.isFailure);
        if (failed) return yield* failed;
      });
      forkHere(
        close.pipe(
          Effect.onExit((exit) => Deferred.done(closing, exit)),
          Effect.ignore,
        ),
      );
      return Deferred.await(closing);
    });

  const closeOwned = Effect.fnUntraced(function* (allocation: Allocation) {
    yield* closeAllocation(allocation).pipe(
      Effect.mapError((e) => {
        allocation.failure = t("server.session.life.notStopped", { why: e.message });
        return refused(allocation.failure);
      }),
    );
    allocation.detached = true;
    allocation.stop?.();
    delete allocation.stop;
    if (allocations.get(allocation.owner.id) === allocation) allocations.delete(allocation.owner.id);
    yield* Metric.update(running, allocations.size);
  });

  const close = Effect.fn("Executor.close")(function* (id: string) {
    const allocation = allocations.get(id);
    if (allocation) yield* closeOwned(allocation);
  });

  const failedAllocation = Effect.fnUntraced(function* (allocation: Allocation, why: string): Effect.fn.Return<StartFailure> {
    return yield* closeOwned(allocation).pipe(
      Effect.match({
        onSuccess: () => ({ refused: why, retained: false }),
        onFailure: (e) => {
          const failure = t("shared.join.clauses", { a: why, b: reasonOf(e) });
          allocation.failure = failure;
          return { refused: failure, retained: true };
        },
      }),
    );
  });

  const failed = Effect.fn("Executor.failed")(function* (id: string, why: string): Effect.fn.Return<StartFailure> {
    const allocation = allocations.get(id);
    return allocation ? yield* failedAllocation(allocation, why) : { refused: why, retained: false };
  });

  const detach = (id: string) => {
    const allocation = allocations.get(id);
    if (!allocation) return;
    allocation.detached = true;
    allocation.stop?.();
    delete allocation.stop;
  };

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const id of allocations.keys()) detach(id);
    }).pipe(
      Effect.andThen(
        Effect.forEach(
          [...allocations],
          ([id, allocation]) =>
            closeAllocation(allocation).pipe(
              Effect.catch((e) => Effect.logWarning("an execution did not close", e).pipe(Effect.annotateLogs({ session: id }))),
            ),
          { concurrency: "unbounded", discard: true },
        ).pipe(Effect.timeoutOption(closeWaitMs)),
      ),
    ),
  );

  return Executor.of({
    start: Effect.fn("Executor.start")(function* ({ agent, owner, cwd, input, resume, options }): Effect.fn.Return<Started> {
      const id = owner.id;
      const prior = allocations.get(id);
      if (prior) return { refused: prior.failure ?? t("server.session.life.notReturned"), retained: true };
      const resolved = yield* Effect.result(runtimes.resolve(agent));
      if (resolved._tag === "Failure") return { refused: reasonOf(resolved.failure), retained: false };
      const raced = allocations.get(id);
      if (raced) return { refused: raced.failure ?? t("server.session.life.notReturned"), retained: true };
      const r = resolved.success;
      const base = r.runtime;
      const resources = new Set<RuntimeSession>();
      const mine: OarRuntime = {
        ...base,
        installation: () => (r.installation ? Promise.resolve(r.installation) : probeInstallation(base, r.binPath)),
        session: (installation, opts) =>
          base.session(installation, { ...opts, ...options }).then((session) => {
            let disposing: Promise<void> | undefined;
            const tracked: RuntimeSession = { ...session, dispose: () => (disposing ??= Promise.resolve().then(() => session.dispose())) };
            resources.add(tracked);
            return tracked;
          }),
      };
      const subagents = createSubagents({
        runtimes: { get: (rid) => (rid === base.id ? mine : undefined) },
        maxRunning,
        maxDepth: 1,
        cwd: resolve(projectsDir(config)),
        logDir: join(config.home, "logs"),
      });
      const allocation: Allocation = { owner, subagents, resources, sessionId: "", attached: false, detached: false, closing: false };
      allocations.set(id, allocation);
      yield* Metric.update(running, allocations.size);
      const opening = Effect.gen(function* () {
        const spawned = yield* Effect.promise(() =>
          subagents
            .spawn({
              runtime: base.id,
              name: id,
              task: input,
              cwd,
              ...(r.model ? { model: r.model } : {}),
              ...(r.effort ? { effort: r.effort } : {}),
              ...(resume ? { resume } : {}),
              env: r.env,
            })
            .catch((e: unknown) => ({ kind: "refused" as const, code: "open_failed" as const, reason: messageOf(e) })),
        );
        if (spawned.kind !== "spawned") return yield* failedAllocation(allocation, t("shared.join.aside", { text: spawned.reason, aside: spawned.code }));
        allocation.agent = spawned.agent;
        allocation.sessionId = spawned.agent.session.id;
        const verb = resume ? "woke" : "sent";
        const how = r.model ? ", model " + r.model : ", the runtime's default model";
        yield* Effect.logInfo(`vibevalley: ${verb} ${id} (${agent.name}): ${agent.runtime}${how}, in ${cwd}`);
        return { execution: allocation };
      });
      return yield* opening.pipe(Effect.onExit((exit) => (exit._tag === "Failure" ? Effect.ignore(closeOwned(allocation)) : Effect.void)));
    }),
    deliver: Effect.fn("Executor.deliver")(function* (id, text) {
      const agent = allocations.get(id)?.agent;
      if (!agent) return { kind: "rejected", code: "closed", reason: t("server.session.life.noHelper", { id }) };
      return yield* Effect.promise(() =>
        agent.send(text, "followup").catch((e: unknown) => ({ kind: "rejected" as const, code: "send_failed", reason: messageOf(e) })),
      );
    }),
    interrupt: Effect.fn("Executor.interrupt")(function* (id) {
      const agent = allocations.get(id)?.agent;
      if (!agent) return { kind: "failed", reason: t("server.session.life.noHelper", { id }) };
      return yield* Effect.promise(() => agent.interrupt().catch((e: unknown) => ({ kind: "failed" as const, reason: String(e) })));
    }),
    close,
    failed,
    observe: (id, observer) => {
      const allocation = allocations.get(id);
      if (!allocation?.agent) return;
      detach(id);
      allocation.detached = false;
      allocation.attached = true;
      const session = allocation.agent.session;
      const stopEvents = session.events((event) => !allocation.detached && observer.event(event), { cursor: { sessionId: session.id, afterSeq: -1 } });
      // The turn's other event readers run before its report is folded into the domain.
      const stopReports = allocation.subagents.onReport((report) => {
        if (report.sessionId === session.id) queueMicrotask(() => !allocation.detached && observer.report(report));
      });
      // A turn can finish between spawn and observation; its unread report still belongs to this execution.
      void allocation.subagents.wait({ timeoutMs: 0 }).then((early) => {
        for (const report of early) if (report.sessionId === session.id && !allocation.detached) observer.report(report);
      });
      const stopStalls = watchStalls(
        session,
        observer.stallMs,
        (silentForMs, at) => !allocation.detached && observer.stalled(silentForMs, at),
        (wait) => void later(id, wait),
        () => clock.currentTimeMillisUnsafe(),
      );
      allocation.stop = () => {
        stopEvents();
        stopReports();
        stopStalls();
      };
    },
    detach,
    find: (id) => allocations.get(id),
    all: () => [...allocations.values()],
  });
});
