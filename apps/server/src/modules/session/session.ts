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
import type { Merged, Workplace, WorkplaceCleanup, WorkplaceRelease } from "#/modules/repo/workplace.ts";
import type { Runtime } from "#/modules/runtime/runtime.ts";

import type { Settle } from "./briefing.ts";
import type { ChannelHearers, ChannelRouteResult, Envelope } from "./envelope.ts";
import type { AgentHost, HostOptions } from "./host.ts";
import { type Lifecycle, makeLifecycle, type SessionNews, type SessionOptions } from "./lifecycle.ts";
import { type Machine, makeMachine } from "./machine.ts";
import { type DeliveryNews, type HireArrival, type HiredReceipt, type Mailbox, makeMailbox, type QueuedInput, type Withdrawal } from "./mailbox.ts";
import type { KnownGitHubEvent, SourceEvent, TriggerInput, TriggerResource } from "./payload.ts";
import { summaryOf } from "./report.ts";
import type { Trigger } from "./shapes.ts";

export type { QueuedInput, SessionOptions };
export type { Hired, HireOptions, RunFinished, RunStore, SessionNews } from "./lifecycle.ts";
export { DeliveryRefused, HireRefused, newsOf, NotRecorded, NotTakenIn, NotWorkFile, runOf } from "./lifecycle.ts";

type Tagged<U extends { readonly _tag: string }, K extends U["_tag"]> = Extract<U, { readonly _tag: K }>;

/** What arrives for the sessions: a trigger already recorded, one to record in the caller's transaction (routed later
 * as a Trigger), an event from a source (recorded unless it is the farm's own echo, then routed), or a hire. */
export type Arrival =
  | { readonly _tag: "Trigger"; readonly trigger: Trigger; readonly to?: ChannelHearers | { readonly session: string } }
  | { readonly _tag: "Record"; readonly input: TriggerInput }
  | { readonly _tag: "Event"; readonly event: SourceEvent; readonly to?: ChannelHearers | { readonly session: string } }
  | HireArrival;

/** An event's arrival: its trigger (none for the farm's own echo) and what its routing said. */
export interface Accepted extends ChannelRouteResult {
  readonly trigger?: Trigger;
}

/** Refusals are ApiErrors; a hire's is HireRefused. */
export interface Receive {
  (arrival: Tagged<Arrival, "Trigger">): Promise<ChannelRouteResult>;
  (arrival: Tagged<Arrival, "Record">): Promise<Trigger>;
  (arrival: Tagged<Arrival, "Event">): Promise<Accepted>;
  (arrival: HireArrival): Promise<HiredReceipt>;
}

/** What is taken back: an envelope, an issue's dispatches or a session's open deliveries (a Withdrawal); a session's
 * running turn (true when the stop was taken); or the helper itself (true when it was there to let go; work "discard"
 * resets its branch once the runtime stops writing). */
export type Taking =
  | Withdrawal
  | { readonly _tag: "Turn"; readonly session: string }
  | { readonly _tag: "Helper"; readonly session: string; readonly work?: "keep" | "discard"; readonly closed?: "dismissed" | "completed" };

export interface Withdraw {
  (what: Withdrawal): Promise<void>;
  (what: Tagged<Taking, "Turn" | "Helper">): Promise<boolean>;
}

/** A workplace and what is done in it: a session's own under its lock (idle: refused while it works, and its execution
 * rests first); an issue's checkout in its repo, when no helper holds it; a session's handed over (used, then the session
 * lets go as closed: throws NotTakenIn when use fails and the session stays, ApiError when it cannot hand over now); a
 * session's branch reset to main while it stays (Discard); an issue's checkout let go once no helper is on it (Clear). */
export type WorkplaceAt<A> =
  | { readonly _tag: "Session"; readonly session: string; readonly idle?: boolean; readonly use: (place: Workplace) => Promise<A> }
  | { readonly _tag: "Issue"; readonly repo: string; readonly number: number; readonly use: (place: Workplace) => Promise<A> }
  | {
      readonly _tag: "HandOver";
      readonly session: string;
      readonly closed: T.SessionClose;
      readonly settle?: Settle;
      readonly use: (place: Workplace, lastText: string) => Promise<Merged>;
    }
  | { readonly _tag: "Discard"; readonly session: string }
  | { readonly _tag: "Clear"; readonly issue: string; readonly repo: string; readonly number: number; readonly work?: WorkplaceCleanup };

export interface WorkplaceDoor {
  <A>(at: Tagged<WorkplaceAt<A>, "Session" | "Issue">): Promise<A>;
  (at: Tagged<WorkplaceAt<never>, "HandOver">): Promise<Merged>;
  (at: Tagged<WorkplaceAt<never>, "Discard">): Promise<void>;
  (at: Tagged<WorkplaceAt<never>, "Clear">): Promise<WorkplaceRelease>;
}

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

export interface LiveDoor {
  /** The helpers hired now. */
  (): readonly T.Session[];
  (id: string): Live;
}

/** What was and what waits: sessions (the ended too), an issue's runs, a session's events; the triggers recorded, an
 * issue's and every queued one (dispatches first, then routed order), a pull request's GitHub events, a trigger's owner
 * issue and whether it was routed; how many deliveries a message still waits in, and an orchestrator's digest. */
export type Query =
  | { readonly _tag: "Session"; readonly id: string }
  | { readonly _tag: "Sessions"; readonly agent?: string }
  | { readonly _tag: "Runs"; readonly issue: string }
  | { readonly _tag: "Events"; readonly session: string; readonly run?: string }
  | { readonly _tag: "Trigger"; readonly id: string }
  | { readonly _tag: "IssueTriggers"; readonly issue: string }
  | { readonly _tag: "Queued" }
  | { readonly _tag: "GitHub"; readonly repo: string; readonly pr: number }
  | { readonly _tag: "Owner"; readonly trigger: string }
  | { readonly _tag: "Routed"; readonly trigger: string }
  | { readonly _tag: "Waiting"; readonly envelope: string }
  | { readonly _tag: "Digest"; readonly agent: string };

export interface Read {
  (q: Tagged<Query, "Session">): Promise<T.Session | undefined>;
  (q: Tagged<Query, "Sessions">): Promise<T.Session[]>;
  (q: Tagged<Query, "Runs">): Promise<T.Run[]>;
  (q: Tagged<Query, "Events">): Promise<T.SessionEvent[] | undefined>;
  (q: Tagged<Query, "Trigger">): Promise<TriggerResource | undefined>;
  (q: Tagged<Query, "IssueTriggers">): Promise<readonly Trigger[]>;
  (q: Tagged<Query, "Queued">): Promise<readonly QueuedInput[]>;
  (q: Tagged<Query, "GitHub">): Promise<readonly KnownGitHubEvent[]>;
  (q: Tagged<Query, "Owner">): Promise<string | undefined>;
  (q: Tagged<Query, "Routed">): Promise<boolean>;
  (q: Tagged<Query, "Waiting">): Promise<number>;
  (q: Tagged<Query, "Digest">): Promise<Envelope[]>;
}

/** An agent profile doing a piece of work: what triggers it and its deliveries, the sessions and their runs, their
 * workplaces, and the executions on the machine they run on. */
export interface Session {
  readonly receive: Receive;
  readonly withdraw: Withdraw;
  /** A helper says an input is not its to take; the orchestrator is told why. */
  readonly decline: (session: string, envelope: string, reason: string) => Promise<void>;
  /** An orchestrator's host gives back an input it did not take. */
  readonly handBack: (session: string, envelope: string) => Promise<void>;
  readonly workplace: WorkplaceDoor;
  readonly live: LiveDoor;
  /** Why runtime has no room for one more helper on repo now; "" when it has. */
  readonly room: (runtime: string, repo: string) => string;
  readonly read: Read;
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

/** The door over the parts: what makeSession returns, and what a test that plays the sessions builds over its own. */
export function sessionOver(parts: {
  readonly lifecycle: Lifecycle;
  readonly mailbox: Mailbox;
  readonly repo: Pick<Repo, "checkout">;
  readonly close: () => Promise<void>;
}): Session {
  const { lifecycle, mailbox, repo, close } = parts;
  function receive(arrival: Tagged<Arrival, "Trigger">): Promise<ChannelRouteResult>;
  function receive(arrival: Tagged<Arrival, "Record">): Promise<Trigger>;
  function receive(arrival: Tagged<Arrival, "Event">): Promise<Accepted>;
  function receive(arrival: HireArrival): Promise<HiredReceipt>;
  async function receive(arrival: Arrival): Promise<ChannelRouteResult | Trigger | Accepted | HiredReceipt> {
    switch (arrival._tag) {
      case "Trigger":
        return mailbox.receive(arrival);
      case "Record":
        return mailbox.recordTrigger(arrival.input);
      case "Event": {
        const trigger = await mailbox.record(arrival.event);
        if (trigger === undefined) return { heldNotice: "" };
        const routed = await mailbox.receive({ _tag: "Trigger", trigger, ...(arrival.to ? { to: arrival.to } : {}) });
        return { ...routed, trigger };
      }
      case "Hire":
        return mailbox.receive(arrival);
    }
  }

  function withdraw(what: Withdrawal): Promise<void>;
  function withdraw(what: Tagged<Taking, "Turn" | "Helper">): Promise<boolean>;
  function withdraw(what: Taking): Promise<void | boolean> {
    switch (what._tag) {
      case "Turn":
        return lifecycle.stop(what.session);
      case "Helper":
        return lifecycle.dismiss(what.session, what.work, what.closed);
      default:
        return mailbox.withdraw(what);
    }
  }

  function workplace<A>(at: Tagged<WorkplaceAt<A>, "Session" | "Issue">): Promise<A>;
  function workplace(at: Tagged<WorkplaceAt<never>, "HandOver">): Promise<Merged>;
  function workplace(at: Tagged<WorkplaceAt<never>, "Discard">): Promise<void>;
  function workplace(at: Tagged<WorkplaceAt<never>, "Clear">): Promise<WorkplaceRelease>;
  async function workplace<A>(at: WorkplaceAt<A>): Promise<A | Merged | void | WorkplaceRelease> {
    switch (at._tag) {
      case "Session":
        return at.idle === true ? lifecycle.withIdleWorkplace(at.session, at.use) : lifecycle.withWorkplace(at.session, at.use);
      case "Issue":
        // No helper holds it: the issue's own checkout, kept for the next helper.
        return at.use(await repo.checkout({ _tag: "Open", repo: at.repo, issue: at.number, worktree: true, base: "" }));
      case "HandOver":
        return lifecycle.handOver(at.session, at.closed, at.use, at.settle);
      case "Discard":
        return lifecycle.discardWork(at.session);
      case "Clear":
        return lifecycle.clearWorkplace(at.issue, at.repo, at.number, at.work);
    }
  }

  function live(): readonly T.Session[];
  function live(id: string): Live;
  function live(id?: string): readonly T.Session[] | Live {
    if (id === undefined) return lifecycle.hired();
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
  }

  function read(q: Tagged<Query, "Session">): Promise<T.Session | undefined>;
  function read(q: Tagged<Query, "Sessions">): Promise<T.Session[]>;
  function read(q: Tagged<Query, "Runs">): Promise<T.Run[]>;
  function read(q: Tagged<Query, "Events">): Promise<T.SessionEvent[] | undefined>;
  function read(q: Tagged<Query, "Trigger">): Promise<TriggerResource | undefined>;
  function read(q: Tagged<Query, "IssueTriggers">): Promise<readonly Trigger[]>;
  function read(q: Tagged<Query, "Queued">): Promise<readonly QueuedInput[]>;
  function read(q: Tagged<Query, "GitHub">): Promise<readonly KnownGitHubEvent[]>;
  function read(q: Tagged<Query, "Owner">): Promise<string | undefined>;
  function read(q: Tagged<Query, "Routed">): Promise<boolean>;
  function read(q: Tagged<Query, "Waiting">): Promise<number>;
  function read(q: Tagged<Query, "Digest">): Promise<Envelope[]>;
  function read(q: Query): Promise<unknown> {
    switch (q._tag) {
      case "Session":
        return lifecycle.get(q.id);
      case "Sessions":
        return lifecycle.list(q.agent ?? "");
      case "Runs":
        return lifecycle.issueRuns(q.issue);
      case "Events":
        return lifecycle.events(q.session, q.run);
      case "Trigger":
        return mailbox.readTrigger(q.id);
      case "IssueTriggers":
        return mailbox.triggersOf(q.issue);
      case "Queued":
        return mailbox.queuedTriggers();
      case "GitHub":
        return mailbox.knownGitHubEvents(q.repo, q.pr);
      case "Owner":
        return mailbox.ownerOf(q.trigger);
      case "Routed":
        return mailbox.isRouted(q.trigger);
      case "Waiting":
        return mailbox.waitingOn(q.envelope);
      case "Digest":
        return mailbox.orchestratorDigest(q.agent);
    }
  }

  return {
    receive,
    withdraw,
    decline: mailbox.decline,
    handBack: mailbox.handBack,
    workplace,
    live,
    room: lifecycle.noRoom,
    read,
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
