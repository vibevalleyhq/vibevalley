import type { Subscription } from "@vibevalley/async";
import type * as T from "@vibevalley/protocol";

import type { Core } from "#/core/core.ts";
import type { ServerConfig } from "#/infra/config.ts";
import type { Db } from "#/infra/db.ts";
import type { Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { Agent } from "#/modules/agent/agent.ts";
import type { Memory } from "#/modules/memory/memory.ts";
import type { Repo } from "#/modules/repo/repo.ts";
import type { WorkplaceCleanup, WorkplaceRelease } from "#/modules/repo/workplace.ts";

import type { AgentWakes, ChatView, Delivery, Envelope, Readiness } from "./envelope.ts";
import type { AgentHost, HostOptions } from "./host.ts";
import { type Lifecycle, makeLifecycle, type SessionNews, type SessionOptions } from "./lifecycle.ts";
import { type Machine, makeMachine } from "./machine.ts";
import { type DeliveryNews, type HireArrival, type HiredReceipt, type Mailbox, makeMailbox } from "./mailbox.ts";
import type { TriggerInput, TriggerResource } from "./payload.ts";
import { summaryOf } from "./report.ts";
import type { Trigger } from "./shapes.ts";

export type { SessionOptions };
export type { Hired, HireOptions, RunFinished, RunStore, SessionNews } from "./lifecycle.ts";
export { DeliveryRefused, HireRefused, newsOf, NotRecorded, NotTakenIn, NotWorkFile, runOf } from "./lifecycle.ts";

/** A session as this process has it now. */
export interface Live {
  /** In the core state: a helper hired, or an agent on duty. */
  readonly session?: T.Session;
  /** This process holds the helper (between launches too): it can be told, stopped, handed over. */
  readonly reachable: boolean;
  /** What its latest turn said, and its report's summary of that. */
  readonly lastText: string;
  readonly summary: string;
  /** The run it is in, an in-process agent's too. */
  readonly run?: string;
  /** Its working directory. */
  readonly cwd?: string;
}

/** An agent profile doing a piece of work: what triggers it and its deliveries, the sessions and their runs, their
 * workplaces, and the executions on the machine they run on. Refusals are ApiErrors unless a member says otherwise. */
export interface Session {
  /** A trigger already recorded, delivered to the sessions the layer above picked (each woken), then kept as routed:
   * where scope says when it went to no one (payload.ts deliveryScope), else where it is delivered. */
  readonly route: (trigger: Trigger, to: readonly Delivery[], scope?: string) => Promise<void>;
  /** A trigger recorded in the caller's transaction; route it after. */
  readonly recordTrigger: (input: TriggerInput) => Promise<Trigger>;
  /** A helper hired with its first inputs; throws HireRefused. */
  readonly hireWith: (order: HireArrival) => Promise<HiredReceipt>;
  /** A channel message's envelope taken back from every delivery that still waits on it. */
  readonly withdrawEnvelope: (envelope: string) => Promise<void>;
  /** The chat the deliveries read their places from (the default channel, a place's orchestrator, a participant's unread),
   * told by the layer above the sessions; until then, an empty one. */
  readonly useChat: (view: ChatView) => void;
  /** Which of a session's waiting inputs may be handed to it now, told by the issues above the sessions; until then, all. */
  readonly useReadiness: (ready: Readiness) => void;
  /** A session's pending inputs kept from waking it, or let wake it again (and it is woken): the wake breaker's call. */
  readonly holdWakes: (session: string, held: boolean) => Promise<void>;
  /** What agents' words woke since the user last spoke, as the deliveries kept it. */
  readonly agentWakes: () => Promise<AgentWakes>;
  /** An orchestrator's host gives back an input it did not take. */
  readonly handBack: (session: string, envelope: string) => Promise<void>;
  /** A session's running turn stopped; true when the stop was taken. */
  readonly stop: (session: string) => Promise<boolean>;
  /** The helper let go; true when it was there. Work "discard" resets its branch once the runtime stops writing. */
  readonly dismiss: (session: string, work?: "keep" | "discard", closed?: "dismissed" | "completed") => Promise<boolean>;
  /** The helper's work taken in by use under its workplace lock, then the helper lets go (it stays when use gives a
   * pull request). Throws NotTakenIn when use fails (the helper stays), ApiError when it cannot hand over now. */
  readonly handOver: Lifecycle["handOver"];
  /** use run on the session's workplace under its lock. */
  readonly withWorkplace: Lifecycle["withWorkplace"];
  /** use run on the session's workplace under its lock once its execution rests; refused while it works. */
  readonly withIdleWorkplace: Lifecycle["withIdleWorkplace"];
  /** A session's branch reset to main while it stays. */
  readonly discardWork: (session: string) => Promise<void>;
  /** An issue's checkout let go once no helper is on it. */
  readonly clearWorkplace: (issue: string, repo: string, number: number, work?: WorkplaceCleanup) => Promise<WorkplaceRelease>;
  /** The helpers hired now. */
  readonly hired: () => readonly T.Session[];
  readonly live: (session: string) => Live;
  /** Why runtime has no room for one more helper on repo now; "" when it has. */
  readonly room: (runtime: string, repo: string) => string;
  /** A session, the ended too. */
  readonly get: (session: string) => Promise<T.Session | undefined>;
  /** The sessions, the ended too; every agent's when none is given. */
  readonly list: (agent?: string) => Promise<T.Session[]>;
  /** Undefined when the session is unknown; one run's when given. */
  readonly eventsOf: (session: string, run?: string) => Promise<T.SessionEvent[] | undefined>;
  readonly trigger: (id: string) => Promise<TriggerResource | undefined>;
  readonly isRouted: (trigger: string) => Promise<boolean>;
  /** Each trigger recorded and not routed but the chat's (the watch reads those again), in order, with its source's data:
   * what a restart or a failed route left for the layer above to route again. */
  readonly unrouted: (consume: (trigger: Trigger, data: unknown) => Promise<void>) => Promise<void>;
  /** How many deliveries a message still waits in. */
  readonly waitingOn: (envelope: string) => Promise<number>;
  /** What an orchestrator has not read yet. */
  readonly digest: (agent: string) => Promise<Envelope[]>;
  /** A helper's report for its run's issue; refused when it has none. */
  readonly report: (id: string, report: T.IssueReport) => Promise<void>;
  /** Rejects `..` segments and symlinks escaping the session's working directory; throws NotWorkFile. */
  readonly workFile: (id: string, path: string, max: number) => Promise<{ readonly name: string; readonly bytes: Uint8Array }>;
  /** Everything the sessions tell, subscribed before it returns: nothing told after is missed. */
  readonly news: () => Subscription<SessionNews>;
  /** What the deliveries tell, subscribed before it returns. */
  readonly deliveries: () => Subscription<DeliveryNews>;
  /** Session id owning `token`, or `""` when unrecognized. */
  readonly who: (token: string) => string;
  readonly setAddress: (address: string) => void;
  /** An in-process agent's host; the caller owns it and closes it (`await using`). Throws NotRecorded. */
  readonly host: <R>(options: HostOptions<R>) => Promise<AgentHost<R>>;
  /** At startup, after the modules below it started: the sessions back, then their open deliveries restored and who
   * waits woken. */
  readonly boot: () => Promise<void>;
  /** The deliveries stop, then the sessions save what a restart needs, then every execution is let go. */
  readonly close: () => Promise<void>;
}

/** The parts behind Session, for the tests that drive them: the sessions, the deliveries and the machine. */
export type Inside = Session &
  Omit<Lifecycle, keyof Session | "restore"> &
  Omit<Mailbox, keyof Session | "news" | "restore"> &
  Omit<Machine, "close"> & {
    readonly restore: Lifecycle["restore"];
    readonly restoreDeliveries: Mailbox["restore"];
    /** The deliveries' part of boot alone: restored, what was left routed, who waits woken. */
    readonly bootDeliveries: Mailbox["boot"];
  };

const insides = new WeakMap<Session, Inside>();

/** The parts behind a session module, for tests only (modules.test.ts keeps it so). */
export function insideOf(session: Session): Inside {
  const inside = insides.get(session);
  if (inside === undefined) throw new Error("not a session module makeSession made");
  return inside;
}

/** The door over the parts: what makeSession returns, and what a test that plays the sessions builds over its own. */
export function sessionOver(parts: { readonly lifecycle: Lifecycle; readonly mailbox: Mailbox; readonly close: () => Promise<void> }): Session {
  const { lifecycle, mailbox, close } = parts;
  return {
    route: mailbox.route,
    recordTrigger: mailbox.recordTrigger,
    hireWith: mailbox.hireWith,
    withdrawEnvelope: mailbox.withdrawEnvelope,
    useChat: mailbox.useChat,
    useReadiness: mailbox.useReadiness,
    holdWakes: mailbox.holdWakes,
    agentWakes: mailbox.agentWakes,
    handBack: mailbox.handBack,
    stop: lifecycle.stop,
    dismiss: lifecycle.dismiss,
    handOver: lifecycle.handOver,
    withWorkplace: lifecycle.withWorkplace,
    withIdleWorkplace: lifecycle.withIdleWorkplace,
    discardWork: lifecycle.discardWork,
    clearWorkplace: lifecycle.clearWorkplace,
    hired: lifecycle.hired,
    live: (id) => {
      const session = lifecycle.sessionOf(id);
      const lastText = lifecycle.lastTextOf(id);
      const run = lifecycle.runOf(id);
      const cwd = lifecycle.cwdOf(id);
      return {
        ...(session ? { session } : {}),
        reachable: lifecycle.isReachable(id),
        lastText,
        summary: summaryOf(lastText),
        ...(run === undefined ? {} : { run }),
        ...(cwd === undefined ? {} : { cwd }),
      };
    },
    room: lifecycle.noRoom,
    get: lifecycle.get,
    list: (agent) => lifecycle.list(agent ?? ""),
    eventsOf: lifecycle.events,
    trigger: mailbox.readTrigger,
    isRouted: mailbox.isRouted,
    unrouted: mailbox.unrouted,
    waitingOn: mailbox.waitingOn,
    digest: mailbox.orchestratorDigest,
    report: lifecycle.report,
    workFile: lifecycle.workFile,
    news: lifecycle.news,
    deliveries: mailbox.news,
    who: lifecycle.who,
    setAddress: lifecycle.setAddress,
    host: lifecycle.host,
    boot: async () => {
      await lifecycle.boot();
      await mailbox.boot();
    },
    close,
  };
}

export interface SessionDeps {
  readonly config: ServerConfig;
  readonly clock: Time;
  readonly log: Logger;
  readonly db: Db;
  readonly core: Core;
  readonly agent: Agent;
  readonly memory: Memory;
  readonly repo: Repo;
}

export async function makeSession(deps: SessionDeps, options: SessionOptions = {}): Promise<Session> {
  const closes: (() => Promise<void>)[] = [];
  // The last built first; one failing does not keep the others open.
  const close = async () => {
    const failures: unknown[] = [];
    for (const c of closes.splice(0).toReversed())
      try {
        await c();
      } catch (e) {
        failures.push(e);
      }
    if (failures.length > 0) throw failures.length === 1 ? failures[0] : new AggregateError(failures, "the sessions did not close cleanly");
  };
  try {
    const machine = await makeMachine(deps);
    closes.push(machine.close);
    const lifecycle = await makeLifecycle({ ...deps, machine }, options);
    closes.push(lifecycle.close);
    const mailbox = await makeMailbox({ ...deps, session: lifecycle });
    closes.push(mailbox.close);

    const session = sessionOver({ lifecycle, mailbox, close });
    insides.set(session, {
      ...lifecycle,
      ...mailbox,
      ...session,
      here: machine.here,
      executions: machine.executions,
      restore: lifecycle.restore,
      restoreDeliveries: mailbox.restore,
      bootDeliveries: mailbox.boot,
    });
    return session;
  } catch (e) {
    await close();
    throw e;
  }
}
