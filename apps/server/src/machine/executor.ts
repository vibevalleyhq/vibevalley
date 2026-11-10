import { join } from "node:path";

import type { ControlOutcome, Event, Runtime as OarRuntime, Session as RuntimeSession, SessionOptions } from "@botiverse/oar";
import { createSubagents, type Subagent, type SubagentReport, type Subagents } from "@botiverse/oar/agents";
import { applyTaskEvent, initialStatus, initialTasks, observeSessionView, reduceStatus, stallOf, type TaskMap } from "@botiverse/oar/observe";
import { Clock, Config, Deferred, Effect, Exit, FiberMap, FiberSet, Metric, Schema } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { maxRunning } from "@vibevalley/protocol";

import { type ApiError, messageOf, reasonOf, refused } from "#/base/errors.ts";
import { reposDir, ServerConfig } from "#/infra/config.ts";
import { loopbackEnvironment, observeToolConnections } from "#/runtime/access.ts";
import { probeInstallation, Runtime } from "#/runtime/runtime.ts";

type ExecutionOwner = Pick<T.Session, "id" | "agent" | "runtime" | "repo" | "issue" | "channel">;

/** An acquired execution remains present until every runtime resource confirms disposal. */
export interface Execution {
  readonly owner: ExecutionOwner;
  readonly sessionId: string;
  readonly attached: boolean;
  readonly closing: boolean;
  readonly pendingTasks: number;
  readonly failure?: string;
}

export interface StartExecution {
  readonly agent: T.Agent;
  readonly owner: ExecutionOwner;
  readonly cwd: string;
  readonly input: string;
  readonly resume: string;
  readonly options: Partial<SessionOptions>;
}

export interface ExecutionObserver {
  readonly connection: (connection: T.ToolConnection) => void;
  readonly event: (event: Event) => void;
  readonly input: (input: ExecutionInput) => void;
  readonly report: (report: SubagentReport) => void;
  readonly tasksChanged: (pending: number) => void;
  readonly stalled: (silentForMs: number, at: number) => void;
  readonly stallMs: number;
}

export type ExecutionInput = { readonly kind: "consumed" | "returned"; readonly inputId: string };
export type DeliveredInput =
  | { readonly kind: "accepted"; readonly landed: "prompted" | "steered" | "queued"; readonly inputId?: string }
  | { readonly kind: "rejected"; readonly code: string; readonly reason: string };

export type StartFailure = { readonly execution?: never; readonly refused: string; readonly retained: boolean };
export type Started = { readonly execution: Execution; readonly refused?: never; readonly retained?: never } | StartFailure;

export interface Executions {
  readonly start: (input: StartExecution) => Effect.Effect<Started>;
  readonly deliver: (id: string, text: string, inputId: string) => Effect.Effect<DeliveredInput>;
  readonly interrupt: (id: string) => Effect.Effect<ControlOutcome | { readonly kind: "failed"; readonly reason: string }>;
  readonly close: (id: string) => Effect.Effect<void, ApiError>;
  readonly failed: (id: string, why: string) => Effect.Effect<StartFailure>;
  readonly observe: (id: string, observer: ExecutionObserver) => void;
  readonly detach: (id: string) => void;
  readonly find: (id: string) => Execution | undefined;
  readonly all: () => readonly Execution[];
}

class NotClosed extends Schema.TaggedError<NotClosed, { readonly brand: unique symbol }>()("NotClosed", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

type AllocationPhase =
  | { readonly _tag: "spawning" }
  | { readonly _tag: "unobserved"; readonly agent: Subagent }
  | { readonly _tag: "observing"; readonly agent: Subagent; readonly stop: () => void }
  | { readonly _tag: "detached"; readonly agent: Subagent }
  | { readonly _tag: "closing"; readonly attached: boolean; readonly wait: Deferred.Deferred<void, NotClosed>; readonly failure?: string };

interface Allocation {
  readonly owner: ExecutionOwner;
  tasks: TaskMap;
  readonly subagents: Subagents;
  readonly resources: Set<RuntimeSession>;
  readonly servers: readonly string[];
  sessionId: string;
  phase: AllocationPhase;
}

const agentOf = (phase: AllocationPhase): Subagent | undefined =>
  phase._tag === "unobserved" || phase._tag === "observing" || phase._tag === "detached" ? phase.agent : undefined;

const isAttached = (phase: AllocationPhase): boolean => phase._tag === "observing" || phase._tag === "detached" || (phase._tag === "closing" && phase.attached);

const failureOf = (phase: AllocationPhase): string | undefined => (phase._tag === "closing" ? phase.failure : undefined);

const notClosed = (cause: unknown) => NotClosed.make({ message: messageOf(cause), cause });
const running = Metric.gauge("vibevalley.sessions.running", { description: "Runtime sessions open now (the helpers' and the orchestrators')" });
const closeWaitMs = 15_000;

/** Calls onStall once a turn has had no record for stallMs, folded from the session's first record as its events are. */
export function watchStalls(
  session: RuntimeSession,
  stallMs: number,
  onStall: (silentForMs: number, at: number) => void,
  timer: (wait: Effect.Effect<void>) => void,
  now: () => number,
) {
  let status = initialStatus;
  // The timer is one keyed fiber of the service's: arming again replaces it, Effect.void disarms it.
  const disarm = () => timer(Effect.void);
  const stop = session.rawEvents(
    (record) => {
      status = reduceStatus(status, record, session.id);
      if (status.kind !== "running") return disarm();
      timer(
        Effect.sleep(stallMs).pipe(
          Effect.andThen(
            Effect.sync(() => {
              const at = now();
              const stall = stallOf(status, at, stallMs);
              if (stall !== null) onStall(stall.silentForMs, at);
            }),
          ),
        ),
      );
    },
    { sessionId: session.id, afterSeq: -1 },
  );
  return () => {
    disarm();
    stop();
  };
}

const pendingTasks = (allocation: Allocation) =>
  [...allocation.tasks.values()].filter((task) => task.ambient !== true && (task.status === "running" || task.status === "pending" || task.status === "paused"))
    .length;

const view = (allocation: Allocation): Execution => {
  const failure = failureOf(allocation.phase);
  return {
    owner: { ...allocation.owner },
    sessionId: allocation.sessionId,
    attached: isAttached(allocation.phase),
    closing: allocation.phase._tag === "closing",
    pendingTasks: pendingTasks(allocation),
    ...(failure === undefined ? {} : { failure }),
  };
};

export const makeExecutor = Effect.gen(function* (): Effect.fn.Return<Executions, never, ServerConfig | Runtime | Clock.Clock | import("effect").Scope.Scope> {
  const config = yield* ServerConfig;
  const inherited = {
    NO_PROXY: yield* Config.String("NO_PROXY").pipe(Config.withDefault("")),
    no_proxy: yield* Config.String("no_proxy").pipe(Config.withDefault("")),
  };
  const runtimes = yield* Runtime;
  const clock = yield* Clock.Clock;
  const forkHere = yield* FiberSet.makeRuntime();
  const timers = yield* FiberMap.make<string>();
  const later = yield* FiberMap.runtime(timers)();
  const allocations = new Map<string, Allocation>();

  const stopObserving = (allocation: Allocation) => {
    if (allocation.phase._tag !== "observing") return;
    const { agent, stop } = allocation.phase;
    allocation.phase = { _tag: "detached", agent };
    stop();
  };

  // Closing outlives an interrupted caller; all later callers receive the same disposal result.
  const closeAllocation = (allocation: Allocation): Effect.Effect<void, NotClosed> =>
    Effect.suspend(() => {
      if (allocation.phase._tag === "closing") return Deferred.await(allocation.phase.wait);
      const wait = Deferred.makeUnsafe<void, NotClosed>();
      const attached = isAttached(allocation.phase);
      if (allocation.phase._tag === "observing") allocation.phase.stop();
      allocation.phase = { _tag: "closing", attached, wait };
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
          Effect.onExit((exit) => Deferred.done(wait, exit)),
          Effect.ignore({ log: "Debug" }),
        ),
      );
      return Deferred.await(wait);
    });

  const setClosingFailure = (allocation: Allocation, failure: string) => {
    if (allocation.phase._tag === "closing") {
      allocation.phase = { ...allocation.phase, failure };
    }
  };

  const closeOwned = Effect.fnUntraced(function* (allocation: Allocation) {
    yield* closeAllocation(allocation).pipe(
      Effect.mapError((e) => {
        const failure = t("server.session.life.notStopped", { why: e.message });
        setClosingFailure(allocation, failure);
        return refused(failure);
      }),
    );
    stopObserving(allocation);
    if (allocations.get(allocation.owner.id) === allocation) allocations.delete(allocation.owner.id);
    yield* Metric.update(running, allocations.size);
  });

  const close = Effect.fn("Executions.close")(function* (id: string) {
    const allocation = allocations.get(id);
    if (allocation) yield* closeOwned(allocation);
  });

  const failedAllocation = Effect.fnUntraced(function* (allocation: Allocation, why: string): Effect.fn.Return<StartFailure> {
    return yield* closeOwned(allocation).pipe(
      Effect.match({
        onSuccess: () => ({ refused: why, retained: false }),
        onFailure: (e) => {
          const failure = t("shared.join.clauses", { a: why, b: reasonOf(e) });
          setClosingFailure(allocation, failure);
          return { refused: failure, retained: true };
        },
      }),
    );
  });

  const failed = Effect.fn("Executions.failed")(function* (id: string, why: string): Effect.fn.Return<StartFailure> {
    const allocation = allocations.get(id);
    return allocation ? yield* failedAllocation(allocation, why) : { refused: why, retained: false };
  });

  const detach = (id: string) => {
    const allocation = allocations.get(id);
    if (allocation) stopObserving(allocation);
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

  return {
    start: Effect.fn("Executions.start")(function* ({ agent, owner, cwd, input, resume, options }): Effect.fn.Return<Started> {
      const id = owner.id;
      const prior = allocations.get(id);
      if (prior) return { refused: failureOf(prior.phase) ?? t("server.session.life.notReturned"), retained: true };
      const resolved = yield* runtimes.resolve(agent).pipe(
        Effect.match({
          onFailure: (e) => ({ _tag: "refused" as const, refused: reasonOf(e) }),
          onSuccess: (value) => ({ _tag: "resolved" as const, value }),
        }),
      );
      if (resolved._tag === "refused") return { refused: resolved.refused, retained: false };
      const r = resolved.value;
      const raced = allocations.get(id);
      if (raced) return { refused: failureOf(raced.phase) ?? t("server.session.life.notReturned"), retained: true };
      const base = r.runtime;
      const resources = new Set<RuntimeSession>();
      const mine: OarRuntime = {
        ...base,
        installation: () => (r.installation ? Promise.resolve(r.installation) : probeInstallation(base, r.binPath)),
        session: (installation, opts) =>
          base
            .session(installation, {
              ...opts,
              ...options,
              env: loopbackEnvironment({ ...opts.env, ...options.env }, inherited, base.refusedSessionOptions?.env),
            })
            .then((session) => {
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
        cwd: reposDir(config),
        logDir: join(config.home, "logs"),
      });
      const allocation: Allocation = {
        tasks: initialTasks,
        owner: {
          id,
          agent: owner.agent,
          runtime: owner.runtime,
          ...(owner.repo === undefined ? {} : { repo: owner.repo }),
          ...(owner.issue === undefined ? {} : { issue: owner.issue }),
          ...(owner.channel === undefined ? {} : { channel: owner.channel }),
        },
        subagents,
        resources,
        servers: [...new Set(options.mcpServers?.map((server) => server.name) ?? [])],
        sessionId: "",
        phase: { _tag: "spawning" },
      };
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
        allocation.phase = { _tag: "unobserved", agent: spawned.agent };
        allocation.sessionId = spawned.agent.session.id;
        const verb = resume ? "woke" : "sent";
        const how = r.model ? ", model " + r.model : ", the runtime's default model";
        yield* Effect.logInfo(`vibevalley: ${verb} ${id} (${agent.name}): ${agent.runtime}${how}, in ${cwd}`);
        return { execution: view(allocation) };
      });
      return yield* opening.pipe(Effect.onExit((exit) => (exit._tag === "Failure" ? Effect.ignore(closeOwned(allocation), { log: "Warn" }) : Effect.void)));
    }),
    deliver: Effect.fn("Executions.deliver")(function* (id, text, inputId) {
      const allocation = allocations.get(id);
      const agent = allocation ? agentOf(allocation.phase) : undefined;
      if (!agent) return { kind: "rejected", code: "closed", reason: t("server.session.life.noHelper", { id }) };
      if (agent.session.status().value.kind === "idle") {
        return yield* Effect.tryPromise({
          try: () => agent.send(text, "followup"),
          catch: (cause) => ({ kind: "rejected", code: "send_failed", reason: messageOf(cause) }) as const,
        }).pipe(Effect.catch((rejected) => Effect.succeed(rejected)));
      }
      const attempted = yield* Effect.tryPromise({
        try: () => agent.session.deliver(text, { inputId }),
        catch: (cause) => ({ kind: "rejected", code: "send_failed", reason: messageOf(cause) }) as const,
      }).pipe(
        Effect.match({
          onFailure: (rejected) => ({ _tag: "Failed", rejected }) as const,
          onSuccess: (delivered) => ({ _tag: "Delivered", delivered }) as const,
        }),
      );
      if (attempted._tag === "Failed") return attempted.rejected;
      const delivered = attempted.delivered;
      return delivered.landed === "rejected"
        ? ({ kind: "rejected", code: delivered.code, reason: delivered.reason } as const)
        : ({ kind: "accepted", landed: delivered.landed, inputId: delivered.inputId } as const);
    }),
    interrupt: Effect.fn("Executions.interrupt")(function* (id) {
      const allocation = allocations.get(id);
      const agent = allocation ? agentOf(allocation.phase) : undefined;
      if (!agent) return { kind: "failed", reason: t("server.session.life.noHelper", { id }) };
      return yield* Effect.promise(() => agent.interrupt().catch((e: unknown) => ({ kind: "failed" as const, reason: String(e) })));
    }),
    close,
    failed,
    observe: (id, observer) => {
      const allocation = allocations.get(id);
      const agent = allocation ? agentOf(allocation.phase) : undefined;
      if (!allocation || !agent) return;
      stopObserving(allocation);
      const session = agent.session;
      // Observing before subscribing: a subscription hands over what it already has at once, and that belongs to this observer.
      const stops: (() => void)[] = [];
      const phase: AllocationPhase = { _tag: "observing", agent, stop: () => stops.forEach((stop) => stop()) };
      allocation.phase = phase;
      const isObserving = () => allocation.phase === phase;
      const stopEvents = session.events(
        (event) => {
          if (!isObserving()) return;
          const before = pendingTasks(allocation);
          switch (event.kind) {
            case "task_started":
            case "task_updated":
            case "task_ended":
              allocation.tasks = applyTaskEvent(allocation.tasks, event, event);
              break;
            case "exited":
              allocation.tasks = initialTasks;
              break;
            default:
              break;
          }
          observer.event(event);
          const after = pendingTasks(allocation);
          if (after !== before) observer.tasksChanged(after);
        },
        { cursor: { sessionId: session.id, afterSeq: -1 } },
      );
      const inputStates = new Map<string, ExecutionInput["kind"]>();
      const stopConnections = observeToolConnections(session, allocation.owner.runtime, allocation.servers, (connection) => {
        if (isObserving()) observer.connection(connection);
      });
      const stopInputs = observeSessionView(session, (view) => {
        if (!isObserving()) return;
        const placed = new Set(
          view.messages.flatMap((message) => (message.kind === "input" && message.input.inputId !== undefined ? [message.input.inputId] : [])),
        );
        for (const input of view.conversation.inputs.values()) {
          if (input.inputId === undefined) continue;
          const next =
            input.state === "dropped" || input.state === "withdrawn" || input.state === "rejected"
              ? "returned"
              : placed.has(input.inputId) && (input.state === "accepted" || input.state === "untracked")
                ? "consumed"
                : undefined;
          if (next === undefined || inputStates.get(input.inputId) === next) continue;
          inputStates.set(input.inputId, next);
          observer.input({ kind: next, inputId: input.inputId });
        }
      });
      // The turn's other event readers run before its report is folded into the domain.
      const stopReports = allocation.subagents.onReport((report) => {
        if (report.sessionId === session.id)
          queueMicrotask(() => {
            if (isObserving()) observer.report(report);
          });
      });
      const stopStalls = watchStalls(
        session,
        observer.stallMs,
        (silentForMs, at) => isObserving() && observer.stalled(silentForMs, at),
        (wait) => void later(id, wait),
        () => clock.currentTimeMillisUnsafe(),
      );
      stops.push(stopEvents, stopConnections, stopInputs, stopReports, stopStalls);
      // A turn can finish between spawn and observation; its unread report still belongs to this execution.
      void allocation.subagents.wait({ timeoutMs: 0 }).then((early) => {
        for (const report of early) if (report.sessionId === session.id && isObserving()) observer.report(report);
      });
    },
    detach,
    find: (id) => {
      const allocation = allocations.get(id);
      return allocation ? view(allocation) : undefined;
    },
    all: () => [...allocations.values()].map(view),
  };
});
