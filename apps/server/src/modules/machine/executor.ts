import { join } from "node:path";

import type { ControlOutcome, Event, Runtime as OarRuntime, Session as RuntimeSession, SessionOptions } from "@botiverse/oar";
import { createSubagents, type Subagent, type SubagentReport, type Subagents } from "@botiverse/oar/agents";
import { applyTaskEvent, initialStatus, initialTasks, observeSessionView, reduceStatus, stallOf, type TaskMap } from "@botiverse/oar/observe";

import { abortable, type Clock, TaskGroup, withTimeout } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { maxRunning } from "@vibevalley/protocol";

import { BizCode, messageOf, refuseIn } from "#/base/errors.ts";
import { reposDir, type ServerConfig } from "#/infra/config.ts";
import type { Logger } from "#/infra/log.ts";
import { gauge } from "#/infra/metrics.ts";
import { loopbackEnvironment, observeToolConnections } from "#/modules/runtime/access.ts";
import { probeInstallation, type Runtime } from "#/modules/runtime/runtime.ts";

const refused = refuseIn(BizCode.SessionRefused);

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
  readonly start: (input: StartExecution) => Promise<Started>;
  readonly deliver: (id: string, text: string, inputId: string) => Promise<DeliveredInput>;
  readonly interrupt: (id: string) => Promise<ControlOutcome | { readonly kind: "failed"; readonly reason: string }>;
  /** Refused (an ApiError) when the runtime does not confirm disposal. Aborting signal stops the caller's wait, not the
   * closing: that belongs to the executor, and a later close waits for the same end. */
  readonly close: (id: string, signal?: AbortSignal) => Promise<void>;
  readonly failed: (id: string, why: string) => Promise<StartFailure>;
  readonly observe: (id: string, observer: ExecutionObserver) => void;
  readonly detach: (id: string) => void;
  readonly find: (id: string) => Execution | undefined;
  readonly all: () => readonly Execution[];
}

class NotClosed extends Error {
  override readonly name = "NotClosed";
}

type AllocationPhase =
  | { readonly _tag: "spawning" }
  | { readonly _tag: "unobserved"; readonly agent: Subagent }
  | { readonly _tag: "observing"; readonly agent: Subagent; readonly stop: () => void }
  | { readonly _tag: "detached"; readonly agent: Subagent }
  | { readonly _tag: "closing"; readonly attached: boolean; readonly wait: Promise<void>; readonly failure?: string };

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

const notClosed = (cause: unknown) => new NotClosed(messageOf(cause), { cause });
/** Runtime sessions open now (the helpers' and the orchestrators'). */
const running = gauge("vibevalley.sessions.running");
const closeWaitMs = 15_000;

/** Calls onStall once a turn has had no record for stallMs, folded from the session's first record as its events are. */
export function watchStalls(
  session: RuntimeSession,
  stallMs: number,
  onStall: (silentForMs: number, at: number) => void,
  timer: (wait: (signal: AbortSignal) => Promise<void>) => void,
  clock: Pick<Clock, "now" | "sleep">,
) {
  let status = initialStatus;
  // The timer is one keyed task of the service's: arming again replaces it, a wait that does nothing disarms it.
  const disarm = () => timer(() => Promise.resolve());
  const stop = session.rawEvents(
    (record) => {
      status = reduceStatus(status, record, session.id);
      if (status.kind !== "running") return disarm();
      timer(async (signal) => {
        await clock.sleep(stallMs, signal);
        const at = clock.now();
        const stall = stallOf(status, at, stallMs);
        if (stall !== null) onStall(stall.silentForMs, at);
      });
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

export interface ExecutorDeps {
  readonly config: ServerConfig;
  readonly runtime: Runtime;
  readonly clock: Clock;
  readonly log: Logger;
}

/** The executions on this machine, and close(): it lets go of every one, waiting closeWaitMs at most for them to confirm. */
export function makeExecutor(deps: ExecutorDeps): Executions & { readonly closeAll: () => Promise<void> } {
  const { config, clock } = deps;
  const log = deps.log.child("executor");
  const inherited = {
    NO_PROXY: process.env.NO_PROXY ?? "",
    no_proxy: process.env.no_proxy ?? "",
  };
  const runtimes = deps.runtime;
  const tasks = new TaskGroup({ name: "executor", onError: (task, e) => log.warn(`${task} failed`, e) });
  const allocations = new Map<string, Allocation>();

  const stopObserving = (allocation: Allocation) => {
    if (allocation.phase._tag !== "observing") return;
    const { agent, stop } = allocation.phase;
    allocation.phase = { _tag: "detached", agent };
    stop();
  };

  // Closing outlives an interrupted caller; all later callers receive the same disposal result.
  const closeAllocation = (allocation: Allocation): Promise<void> => {
    if (allocation.phase._tag === "closing") return allocation.phase.wait;
    const { promise: wait, resolve, reject } = Promise.withResolvers<void>();
    // Each caller awaits it; one that has gone (aborted) must not leave it unhandled.
    wait.catch(() => {});
    const attached = isAttached(allocation.phase);
    if (allocation.phase._tag === "observing") allocation.phase.stop();
    allocation.phase = { _tag: "closing", attached, wait };
    const close = async () => {
      const crew = await Promise.allSettled([allocation.subagents.close()]);
      // oar may already have closed its Subagent after a failed prompt; that no-op does not confirm disposal.
      const resources = await Promise.allSettled([...allocation.resources].map((session) => session.dispose()));
      const failed = [...crew, ...resources].find((r) => r.status === "rejected");
      if (failed) throw notClosed(failed.reason);
    };
    // Not under the caller's signal, nor the group's: disposal runs to its end once begun.
    close().then(resolve, (e: unknown) => {
      log.debug("an execution did not close", e);
      reject(e instanceof NotClosed ? e : notClosed(e));
    });
    return wait;
  };

  const setClosingFailure = (allocation: Allocation, failure: string) => {
    if (allocation.phase._tag === "closing") {
      allocation.phase = { ...allocation.phase, failure };
    }
  };

  const closeOwned = async (allocation: Allocation, signal?: AbortSignal) => {
    try {
      await abortable(closeAllocation(allocation), signal);
    } catch (e) {
      if (!(e instanceof NotClosed)) throw e;
      const failure = t("server.session.life.notStopped", { why: e.message });
      setClosingFailure(allocation, failure);
      throw refused(failure);
    }
    stopObserving(allocation);
    if (allocations.get(allocation.owner.id) === allocation) allocations.delete(allocation.owner.id);
    running.set(allocations.size);
  };

  const close = async (id: string, signal?: AbortSignal) => {
    const allocation = allocations.get(id);
    if (allocation) await closeOwned(allocation, signal);
  };

  const failedAllocation = async (allocation: Allocation, why: string): Promise<StartFailure> => {
    try {
      await closeOwned(allocation);
      return { refused: why, retained: false };
    } catch (e) {
      const failure = t("shared.join.clauses", { a: why, b: messageOf(e) });
      setClosingFailure(allocation, failure);
      return { refused: failure, retained: true };
    }
  };

  const failed = async (id: string, why: string): Promise<StartFailure> => {
    const allocation = allocations.get(id);
    return allocation ? failedAllocation(allocation, why) : { refused: why, retained: false };
  };

  const detach = (id: string) => {
    const allocation = allocations.get(id);
    if (allocation) stopObserving(allocation);
  };

  const closeAll = async () => {
    for (const id of allocations.keys()) detach(id);
    try {
      await withTimeout(
        () =>
          Promise.all(
            [...allocations].map(async ([id, allocation]) => {
              try {
                await closeAllocation(allocation);
              } catch (e) {
                log.warn(`an execution did not close (session ${id})`, e);
              }
            }),
          ),
        closeWaitMs,
        { clock },
      );
    } catch (e) {
      // Past the wait the server goes on closing: what has not confirmed by then is left to the runtime.
      log.warn("executions still closing after the wait", e);
    }
    await tasks.close();
  };

  return {
    closeAll,
    start: async ({ agent, owner, cwd, input, resume, options }): Promise<Started> => {
      const id = owner.id;
      const prior = allocations.get(id);
      if (prior) return { refused: failureOf(prior.phase) ?? t("server.session.life.notReturned"), retained: true };
      let r: Awaited<ReturnType<Runtime["resolve"]>>;
      try {
        r = await runtimes.resolve(agent);
      } catch (e) {
        return { refused: messageOf(e), retained: false };
      }
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
      running.set(allocations.size);
      const opening = async (): Promise<Started> => {
        const spawned = await subagents
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
          .catch((e: unknown) => ({ kind: "refused" as const, code: "open_failed" as const, reason: messageOf(e) }));
        if (spawned.kind !== "spawned") return failedAllocation(allocation, t("shared.join.aside", { text: spawned.reason, aside: spawned.code }));
        allocation.phase = { _tag: "unobserved", agent: spawned.agent };
        allocation.sessionId = spawned.agent.session.id;
        const verb = resume ? "woke" : "sent";
        const how = r.model ? ", model " + r.model : ", the runtime's default model";
        log.info(`vibevalley: ${verb} ${id} (${agent.name}): ${agent.runtime}${how}, in ${cwd}`);
        return { execution: view(allocation) };
      };
      try {
        return await opening();
      } catch (e) {
        try {
          await closeOwned(allocation);
        } catch (closing) {
          log.warn("an execution that failed to open did not close", closing);
        }
        throw e;
      }
    },
    deliver: async (id, text, inputId): Promise<DeliveredInput> => {
      const allocation = allocations.get(id);
      const agent = allocation ? agentOf(allocation.phase) : undefined;
      if (!agent) return { kind: "rejected", code: "closed", reason: t("server.session.life.noHelper", { id }) };
      if (agent.session.status().value.kind === "idle") {
        try {
          return await agent.send(text, "followup");
        } catch (cause) {
          return { kind: "rejected", code: "send_failed", reason: messageOf(cause) };
        }
      }
      let delivered: Awaited<ReturnType<typeof agent.session.deliver>>;
      try {
        delivered = await agent.session.deliver(text, { inputId });
      } catch (cause) {
        return { kind: "rejected", code: "send_failed", reason: messageOf(cause) };
      }
      return delivered.landed === "rejected"
        ? { kind: "rejected", code: delivered.code, reason: delivered.reason }
        : { kind: "accepted", landed: delivered.landed, inputId: delivered.inputId };
    },
    interrupt: async (id) => {
      const allocation = allocations.get(id);
      const agent = allocation ? agentOf(allocation.phase) : undefined;
      if (!agent) return { kind: "failed", reason: t("server.session.life.noHelper", { id }) };
      return agent.interrupt().catch((e: unknown) => ({ kind: "failed" as const, reason: String(e) }));
    },
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
        (wait) => {
          tasks.keyed(id, wait);
        },
        clock,
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
}
