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
import { RepoError, type WorkplaceCleanup, type WorkplaceRelease } from "#/modules/repo/workplace.ts";
import type { Runtime } from "#/modules/runtime/runtime.ts";

import type { Accepted, AgentWakes, ChatView, Envelope, Hearer, IssueView } from "./envelope.ts";
import type { AgentHost, HostOptions } from "./host.ts";
import { HireRefused, type Lifecycle, makeLifecycle, type SessionNews, type SessionOptions } from "./lifecycle.ts";
import { type Machine, makeMachine } from "./machine.ts";
import { type DeliveryNews, type Dispatch, type HireArrival, type HiredReceipt, type Mailbox, makeMailbox, type QueuedInput } from "./mailbox.ts";
import type { SourceEvent, TriggerInput, TriggerResource } from "./payload.ts";
import { summaryOf } from "./report.ts";
import type { Trigger } from "./shapes.ts";

export type { Accepted, QueuedInput, SessionOptions };
export type { Hired, HireOptions, RunFinished, RunStore, SessionNews } from "./lifecycle.ts";
export { DeliveryRefused, HireRefused, newsOf, NotRecorded, NotTakenIn, NotWorkFile, runOf } from "./lifecycle.ts";

/** A hire: the helper, its brief and where it works, and the inputs it starts with. parent: the issue in that repo
 * whose branch its branch forks from; that issue's checkout is made first. */
export type HireOrder = HireArrival & { readonly parent?: number };

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
  /** A trigger already recorded, routed to who hears it: the hearers when given, as the layer above braked them; else
   * the issue whose threads it is in, or the orchestrator of its place. */
  readonly route: (trigger: Trigger, hearers?: readonly Hearer[]) => Promise<void>;
  /** A trigger recorded in the caller's transaction; route it after. */
  readonly recordTrigger: (input: TriggerInput) => Promise<Trigger>;
  /** A dispatch held for the issue's next helper: recorded in the caller's transaction, routed once it commits. */
  readonly queueDispatch: (dispatch: Dispatch) => Promise<void>;
  /** A source's event recorded as a trigger and routed; the farm's own echo is neither. */
  readonly receive: (event: SourceEvent) => Promise<Accepted>;
  /** A helper hired with its first inputs; throws HireRefused (also when the parent's checkout cannot be made). */
  readonly hireWith: (order: HireOrder) => Promise<HiredReceipt>;
  /** A channel message's envelope taken back from every delivery that still waits on it. */
  readonly withdrawEnvelope: (envelope: string) => Promise<void>;
  /** A session's open deliveries dropped: it left. */
  readonly withdrawDeliveries: (session: string, why: string) => Promise<void>;
  /** An issue's dispatches recorded before `at` taken back; in its own transaction. */
  readonly withdrawDispatches: (issue: string, at: number) => Promise<void>;
  /** The chat the deliveries read their places from (the default channel, a place's orchestrator, a participant's unread),
   * told by the layer above the sessions; until then, an empty one. */
  readonly useChat: (view: ChatView) => void;
  /** The issues the deliveries read (those on the board, whether one is kept), told by the issues above the sessions;
   * until then, none. */
  readonly useIssues: (view: IssueView) => void;
  /** A session's pending inputs kept from waking it, or let wake it again (and it is woken): the wake breaker's call. */
  readonly holdWakes: (session: string, held: boolean) => Promise<void>;
  /** What agents' words woke since the user last spoke, as the deliveries kept it. */
  readonly agentWakes: () => Promise<AgentWakes>;
  /** A helper says an input is not its to take; the orchestrator is told why. */
  readonly decline: (session: string, envelope: string, reason: string) => Promise<void>;
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
  readonly runsOf: (issue: string) => Promise<T.Run[]>;
  /** Undefined when the session is unknown; one run's when given. */
  readonly eventsOf: (session: string, run?: string) => Promise<T.SessionEvent[] | undefined>;
  readonly trigger: (id: string) => Promise<TriggerResource | undefined>;
  readonly triggersOf: (issue: string) => Promise<readonly Trigger[]>;
  /** Every queued trigger: dispatches first, then routed order. */
  readonly queuedTriggers: () => Promise<readonly QueuedInput[]>;
  /** The issue a trigger belongs to. */
  readonly ownerOf: (trigger: string) => Promise<string | undefined>;
  readonly isRouted: (trigger: string) => Promise<boolean>;
  /** How many deliveries a message still waits in. */
  readonly waitingOn: (envelope: string) => Promise<number>;
  /** What an orchestrator has not read yet. */
  readonly digest: (agent: string) => Promise<Envelope[]>;
  /** A helper's report for its run's issue; refused when it has none. */
  readonly report: (id: string, report: T.IssueReport) => Promise<void>;
  /** Rejects `..` segments and symlinks escaping the session's working directory; throws NotWorkFile. */
  readonly workFile: (id: string, path: string, max: number) => Promise<{ readonly name: string; readonly bytes: Uint8Array }>;
  /** The threads whose words reach the issue's helper. */
  readonly subscribe: (issue: string, threads: readonly string[]) => Promise<void>;
  /** Each cron trigger recorded and not routed, in order. */
  readonly replayCronTriggers: (consume: (trigger: Trigger, data: unknown) => Promise<void>) => Promise<void>;
  /** Everything the sessions tell, subscribed before it returns: nothing told after is missed. */
  readonly news: () => Subscription<SessionNews>;
  /** What the deliveries tell, subscribed before it returns. */
  readonly deliveries: () => Subscription<DeliveryNews>;
  /** Session id owning `token`, or `""` when unrecognized. */
  readonly who: (token: string) => string;
  readonly setAddress: (address: string) => void;
  /** An in-process agent's host; the caller owns it and closes it (`await using`). Throws NotRecorded. */
  readonly host: <R>(options: HostOptions<R>) => Promise<AgentHost<R>>;
  /** At startup, after the modules below it started: the sessions back. */
  readonly boot: () => Promise<void>;
  /** At startup, after the channels restored their threads: the open deliveries restored, what was left routed, who
   * waits woken. */
  readonly wake: () => Promise<void>;
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
  };

const insides = new WeakMap<Session, Inside>();

/** The parts behind a session module, for tests only (modules.test.ts keeps it so). */
export function insideOf(session: Session): Inside {
  const inside = insides.get(session);
  if (inside === undefined) throw new Error("not a session module makeSession made");
  return inside;
}

/** A source's event recorded as a trigger and routed; the farm's own echo is neither. */
const receiving =
  (mailbox: Pick<Mailbox, "record" | "route">) =>
  async (event: SourceEvent): Promise<Accepted> => {
    const trigger = await mailbox.record(event);
    if (trigger === undefined) return {};
    await mailbox.route(trigger);
    return { trigger };
  };

/** The door over the parts: what makeSession returns, and what a test that plays the sessions builds over its own. */
export function sessionOver(parts: {
  readonly lifecycle: Lifecycle;
  readonly mailbox: Mailbox;
  readonly repo: Pick<Repo, "checkout">;
  readonly close: () => Promise<void>;
}): Session {
  const { lifecycle, mailbox, repo, close } = parts;
  return {
    route: mailbox.route,
    recordTrigger: mailbox.recordTrigger,
    receive: receiving(mailbox),
    queueDispatch: mailbox.queueDispatch,
    hireWith: async ({ parent, ...order }) => {
      if (parent !== undefined)
        try {
          await repo.checkout({ repo: order.where, issue: parent, worktree: true, base: "" });
        } catch (e) {
          if (e instanceof RepoError) throw new HireRefused(e.message, undefined, { cause: e });
          throw e;
        }
      return mailbox.hireWith(order);
    },
    withdrawEnvelope: mailbox.withdrawEnvelope,
    withdrawDeliveries: mailbox.withdrawDeliveries,
    withdrawDispatches: mailbox.withdrawDispatches,
    useChat: mailbox.useChat,
    useIssues: mailbox.useIssues,
    holdWakes: mailbox.holdWakes,
    agentWakes: mailbox.agentWakes,
    decline: mailbox.decline,
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
    runsOf: lifecycle.issueRuns,
    eventsOf: lifecycle.events,
    trigger: mailbox.readTrigger,
    triggersOf: mailbox.triggersOf,
    queuedTriggers: mailbox.queuedTriggers,
    ownerOf: mailbox.ownerOf,
    isRouted: mailbox.isRouted,
    waitingOn: mailbox.waitingOn,
    digest: mailbox.orchestratorDigest,
    report: lifecycle.report,
    workFile: lifecycle.workFile,
    subscribe: mailbox.subscribe,
    replayCronTriggers: mailbox.replayCronTriggers,
    news: lifecycle.news,
    deliveries: mailbox.news,
    who: lifecycle.who,
    setAddress: lifecycle.setAddress,
    host: lifecycle.host,
    boot: lifecycle.boot,
    wake: mailbox.boot,
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
  readonly runtime: Runtime;
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

    const session = sessionOver({ lifecycle, mailbox, repo: deps.repo, close });
    insides.set(session, {
      ...lifecycle,
      ...mailbox,
      ...session,
      here: machine.here,
      executions: machine.executions,
      restore: lifecycle.restore,
      restoreDeliveries: mailbox.restore,
    });
    return session;
  } catch (e) {
    await close();
    throw e;
  }
}
