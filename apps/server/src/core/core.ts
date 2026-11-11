import { type Clock, Hub, Queue, type Subscription } from "@vibevalley/async";
import type * as T from "@vibevalley/protocol";

import type { Logger } from "#/infra/log.ts";

export const emptySpaceState = (): T.SpaceState => ({
  call: "idle",
  callReason: "",
  sessions: [],
  plays: {},
  crons: [],
  issues: [],
  connectors: [],
  machines: [],
});

/** How the state folds a fact and is shown: every module's rules, so it is given at assembly (projection/) and the core
 * reads none of the modules above it. */
export interface Projection {
  readonly reduce: (state: T.SpaceState, fact: T.Fact) => [T.SpaceState, boolean];
  /** What a fact sets off on the farm, from the state before it. */
  readonly effects: (before: T.SpaceState, fact: T.Fact) => T.GameEffect[];
  /** seq: the core's count of folds the state includes (StateFrame.seq). */
  readonly frame: (state: T.SpaceState, effects?: T.GameEffect[], seq?: number) => T.StateFrame;
}

export const stateEveryMs = 200;

/** A fact as a service says it: the time is core's. */
export type FactIn = T.Fact extends infer F ? (F extends T.Fact ? Omit<F, "at"> : never) : never;

/** A fact with exactly the state it changed, even when it is read late. */
export interface Transition {
  readonly before: T.SpaceState;
  readonly fact: T.Fact;
  readonly after: T.SpaceState;
}

/** What the user did that changes no state (so it is no fact), said by the service it went through: the game counts some. */
export type UserDid = { readonly kind: "reviewed"; readonly session: T.SessionId } | { readonly kind: "talked" };

/** The farm's one state: only apply changes it, and every reader hears each change. Everything here is synchronous: a
 * fact is folded and told before apply returns, so an oar callback can apply one where it is. */
export interface Core {
  readonly state: () => T.SpaceState;
  readonly session: (id: string) => T.Session | undefined;
  /** Folds the facts in as one commit: readers see the whole batch, each transition its own before and after. */
  readonly apply: (...facts: FactIn[]) => void;
  /** How many commits apply has folded: one more with each that changed the state. */
  readonly seq: () => number;
  readonly setCommits: (commits: T.CommitCount) => void;
  /** The farm opens when the user starts it or says something: the call goes live unless it is already. */
  readonly open: () => void;
  readonly sessionEvent: (id: T.SessionId, activity: T.SessionEvent) => void;
  readonly notice: (level: Extract<T.LiveEvent, { type: "notice" }>["level"], text: string) => void;
  readonly runtime: (info: T.RuntimeInfo) => void;
  readonly did: (d: UserDid) => void;
  /** The state now, and the transitions from here on: none applied after this returns is missed. */
  readonly transitions: () => { readonly state: T.SpaceState; readonly changes: Subscription<Transition> };
  /** A snapshot of the state, then every side event. */
  readonly events: (signal?: AbortSignal) => AsyncIterable<T.ServerEvent>;
  /** Every side event from now on: none applied after this returns is missed. */
  readonly subscribe: () => Subscription<T.ServerEvent>;
  readonly facts: (signal?: AbortSignal) => AsyncIterable<T.Fact>;
  readonly live: (signal?: AbortSignal) => AsyncIterable<T.LiveEvent>;
  /** What the user did from now on: none said after this returns is missed. */
  readonly user: () => Subscription<UserDid>;
  /** For the page, which folds no facts: the frame now, then one per burst of facts and effects (within stateEveryMs). */
  readonly states: (signal?: AbortSignal) => AsyncIterable<T.StateFrame>;
  /** Every reader's subscription ends. */
  readonly close: () => void;
}

const isLive = (e: T.ServerEvent): e is T.LiveEvent => {
  switch (e.type) {
    case "event":
    case "notice":
    case "runtime":
      return true;
    default:
      return false;
  }
};

const isFact = (e: T.ServerEvent): e is T.Fact => {
  switch (e.type) {
    case "snapshot":
    case "event":
    case "notice":
    case "runtime":
      return false;
    default:
      return (e satisfies T.Fact) !== undefined;
  }
};

async function* following<A, B extends A>(sub: Subscription<A>, keep: (a: A) => a is B, signal?: AbortSignal): AsyncGenerator<B> {
  try {
    for (let r = await sub.next(signal); r.done !== true; r = await sub.next(signal)) if (keep(r.value)) yield r.value;
  } finally {
    sub.close();
  }
}

export function makeCore(deps: { readonly projection: Projection; readonly clock: Clock }): Core {
  const { reduce, effects: effectsOf, frame: frameOf } = deps.projection;
  let held = { state: emptySpaceState(), seq: 0 };

  const events = new Hub<T.ServerEvent>();
  const transitions = new Hub<Transition>();
  const user = new Hub<UserDid>();
  /** Each fact and effect, for the frames: a frame waits for the burst it starts. */
  const changes = new Hub<T.GameEffect | undefined>();

  const publish = (e: T.ServerEvent) => {
    events.publish(e);
    if (isFact(e)) changes.publish(undefined);
  };

  const apply = (...facts: FactIn[]) => {
    const at = deps.clock.now();
    let next = held.state;
    const done: Transition[] = [];
    const made: T.GameEffect[] = [];
    for (const fact of facts) {
      const f = { ...fact, at };
      const [after, changed] = reduce(next, f);
      if (!changed) continue;
      done.push({ before: next, fact: f, after });
      made.push(...effectsOf(next, f));
      next = after;
    }
    if (done.length === 0) return;
    held = { state: next, seq: held.seq + 1 };
    for (const t of done) {
      publish(t.fact);
      transitions.publish(t);
    }
    for (const e of made) changes.publish(e);
  };

  const frameNow = (effects: readonly (T.GameEffect | undefined)[]) =>
    frameOf(
      held.state,
      effects.filter((e): e is T.GameEffect => e !== undefined),
      held.seq,
    );

  async function* states(signal?: AbortSignal): AsyncGenerator<T.StateFrame> {
    const sub = changes.subscribe();
    try {
      yield frameNow([]);
      for (let r = await sub.next(signal); r.done !== true; r = await sub.next(signal)) {
        // A burst is what comes in the next stateEveryMs: one frame for all of it.
        await deps.clock.sleep(stateEveryMs, signal);
        yield frameNow([r.value, ...sub.drain()]);
      }
    } finally {
      sub.close();
    }
  }

  async function* withSnapshot(signal?: AbortSignal): AsyncGenerator<T.ServerEvent> {
    const sub = events.subscribe();
    try {
      yield { type: "snapshot", at: deps.clock.now(), state: held.state };
      for (let r = await sub.next(signal); r.done !== true; r = await sub.next(signal)) yield r.value;
    } finally {
      sub.close();
    }
  }

  return {
    state: () => held.state,
    seq: () => held.seq,
    session: (id) => held.state.sessions.find((h) => h.id === id),
    apply,
    setCommits: (commits) => apply({ type: "progressChanged", commits }),
    open: () => {
      if (held.state.call !== "live") apply({ type: "callChanged", state: "live", reason: "" });
    },
    sessionEvent: (id, activity) => publish({ type: "event", at: deps.clock.now(), id, activity }),
    notice: (level, text) => publish({ type: "notice", at: deps.clock.now(), level, text }),
    runtime: (info) => publish({ type: "runtime", at: deps.clock.now(), info }),
    did: (d) => user.publish(d),
    transitions: () => ({ state: held.state, changes: transitions.subscribe() }),
    events: withSnapshot,
    subscribe: () => events.subscribe(),
    facts: (signal) => following(events.subscribe(), isFact, signal),
    live: (signal) => following(events.subscribe(), isLive, signal),
    user: () => user.subscribe(),
    states,
    close: () => {
      for (const hub of [events, transitions, user, changes]) hub.end();
    },
  };
}

/** source through a queue of capacity: a reader that falls that far behind is told so in the log and its stream ends,
 * instead of holding the farm's memory. */
export async function* bounded<A>(source: AsyncIterable<A>, name: string, log: Logger, capacity = 64, signal?: AbortSignal): AsyncGenerator<A> {
  const queue = new Queue<A>({ capacity, overflow: "dropping" });
  const it = source[Symbol.asyncIterator]();
  const pump = (async () => {
    try {
      for (let r = await it.next(); r.done !== true; r = await it.next()) {
        if (!queue.offer(r.value)) {
          log.warn(`${name}: slow subscription closed`);
          break;
        }
      }
    } finally {
      queue.end();
      await it.return?.();
    }
  })();
  try {
    for (let r = await queue.next(signal); r.done !== true; r = await queue.next(signal)) yield r.value;
  } finally {
    queue.end();
    await it.return?.();
    await pump.catch(() => undefined);
  }
}
