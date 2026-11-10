import { type Cause, Clock, Context, Effect, Layer, PubSub, Queue, Scheduler, type Scope, Stream, SubscriptionRef } from "effect";

import type * as T from "@vibevalley/protocol";

import { scopedPubSub } from "#/base/pubsub.ts";

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
export class Projection extends Context.Service<
  Projection,
  {
    readonly reduce: (state: T.SpaceState, fact: T.Fact) => [T.SpaceState, boolean];
    /** What a fact sets off on the farm, from the state before it. */
    readonly effects: (before: T.SpaceState, fact: T.Fact) => T.GameEffect[];
    /** seq: the core's count of folds the state includes (StateFrame.seq). */
    readonly frame: (state: T.SpaceState, effects?: T.GameEffect[], seq?: number) => T.StateFrame;
  }
>()("@vibevalley/server/core/core/Projection") {}

/** The most changes one frame gathers: past it, the frame goes at once. */
const burstMost = 1_000;
export const stateEveryMs = 200;

/** A fact as a service says it: the time is core's. */
export type FactIn = T.Fact extends infer F ? (F extends T.Fact ? Omit<F, "at"> : never) : never;

/** A fact with exactly the state it changed, even when it is read late. */
interface Transition {
  readonly before: T.SpaceState;
  readonly fact: T.Fact;
  readonly after: T.SpaceState;
}

/** What the user did that changes no state (so it is no fact), said by the service it went through: the game counts some. */
type UserDid = { readonly kind: "reviewed"; readonly session: T.SessionId } | { readonly kind: "talked" };

export class Core extends Context.Service<
  Core,
  {
    readonly state: () => T.SpaceState;
    readonly session: (id: string) => T.Session | undefined;
    /** Folds the facts in as one commit: readers see the whole batch, each transition its own before and after. */
    readonly apply: (...facts: FactIn[]) => Effect.Effect<void>;
    /** How many commits apply has folded: one more with each that changed the state. */
    readonly seq: () => number;
    readonly setCommits: (commits: T.CommitCount) => Effect.Effect<void>;
    /** The farm opens when the user starts it or says something: the call goes live unless it is already. */
    readonly open: () => Effect.Effect<void>;
    readonly sessionEvent: (id: string, activity: T.SessionEvent) => Effect.Effect<void>;
    readonly notice: (level: T.NoticeLevel, text: string) => Effect.Effect<void>;
    readonly runtime: (info: T.RuntimeInfo) => Effect.Effect<void>;
    readonly did: (d: UserDid) => Effect.Effect<void>;
    /** The state now, then the transitions from here on. */
    readonly transitions: Effect.Effect<readonly [T.SpaceState, Stream.Stream<Transition>], never, Scope.Scope>;
    /** A snapshot of the state, then every side event. */
    readonly events: Stream.Stream<T.ServerEvent>;
    /** Every side event from now on, subscribed before this returns: none applied after it is missed. */
    readonly subscribe: Effect.Effect<Stream.Stream<T.ServerEvent>, never, Scope.Scope>;
    readonly facts: Stream.Stream<T.Fact>;
    readonly live: Stream.Stream<T.LiveEvent>;
    /** What the user did from now on, subscribed before this returns: none said after it is missed. */
    readonly user: Effect.Effect<Stream.Stream<UserDid>, never, Scope.Scope>;
    /** For the page, which folds no facts: the frame now, then one per burst of facts and effects. */
    readonly states: Stream.Stream<T.StateFrame>;
  }
>()("@vibevalley/server/core/core") {
  static readonly layer = Layer.effect(
    Core,
    Effect.suspend(() => make),
  );
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

const make = Effect.gen(function* () {
  const { reduce, effects: effectsOf, frame: frameOf } = yield* Projection;
  const held = yield* SubscriptionRef.make({ state: emptySpaceState(), seq: 0 });
  const current = () => SubscriptionRef.getUnsafe(held);

  const events = yield* scopedPubSub<T.ServerEvent>();
  const transitions = yield* scopedPubSub<Transition>();
  const user = yield* scopedPubSub<UserDid>();
  /** Each fact and effect, for the frames: a frame waits for the burst it starts. */
  const changes = yield* scopedPubSub<T.GameEffect | undefined>();

  const publish = (e: T.ServerEvent) => {
    PubSub.publishUnsafe(events, e);
    if (isFact(e)) PubSub.publishUnsafe(changes, undefined);
  };

  // Every fact goes through here: a span each would bury the traces in folds.
  const apply = Effect.fnUntraced(function* (...facts: FactIn[]) {
    const at = yield* Clock.currentTimeMillis;
    yield* SubscriptionRef.modify(held, (h) => {
      let next = h.state;
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
      if (done.length === 0) return [undefined, h] as const;
      const updated = { state: next, seq: h.seq + 1 };
      return [
        () => {
          for (const t of done) {
            publish(t.fact);
            PubSub.publishUnsafe(transitions, t);
          }
          for (const e of made) PubSub.publishUnsafe(changes, e);
        },
        updated,
      ] as const;
    }).pipe(
      Effect.map((tell) => tell?.()),
      // oar callbacks use runSync: do not yield with the permit held or before publishing the folded facts.
      Effect.provideService(Scheduler.PreventSchedulerYield, true),
    );
  });

  const side = (e: T.ServerEvent) => Effect.sync(() => publish(e));

  // A frame now, then one for each burst of changes: the state as it is then, with the burst's effects.
  const frameNow = (effects: readonly (T.GameEffect | undefined)[]) =>
    frameOf(
      current().state,
      effects.filter((e): e is T.GameEffect => e !== undefined),
      current().seq,
    );
  const states = Stream.unwrap(
    Effect.map(PubSub.subscribe(changes), (sub) =>
      Stream.concat(
        Stream.sync(() => frameNow([])),
        Stream.fromSubscription(sub).pipe(Stream.groupedWithin(burstMost, stateEveryMs), Stream.map(frameNow)),
      ),
    ),
  );

  const shape = Core.of({
    state: () => current().state,
    seq: () => current().seq,
    session: (id) => current().state.sessions.find((h) => h.id === id),
    apply,

    setCommits: Effect.fn("Core.setCommits")(function* (commits) {
      return yield* apply({ type: "progressChanged", commits });
    }),
    open: Effect.fn("Core.open")(function* () {
      if (current().state.call !== "live") yield* apply({ type: "callChanged", state: "live", reason: "" });
    }),
    // A session's every line of output comes through here: a span each would bury the traces.
    sessionEvent: Effect.fnUntraced(function* (id, activity) {
      return yield* side({ type: "event", at: yield* Clock.currentTimeMillis, id, activity });
    }),
    notice: Effect.fn("Core.notice")(function* (level, text) {
      return yield* side({ type: "notice", at: yield* Clock.currentTimeMillis, level, text });
    }),
    runtime: Effect.fn("Core.runtime")(function* (info) {
      return yield* side({ type: "runtime", at: yield* Clock.currentTimeMillis, info });
    }),
    did: Effect.fn("Core.did")(function* (d) {
      yield* PubSub.publish(user, d);
    }),
    transitions: Effect.gen(function* () {
      const sub = yield* PubSub.subscribe(transitions);
      return [current().state, Stream.fromSubscription(sub)] as const;
    }),
    events: Stream.unwrap(
      Effect.gen(function* () {
        const sub = yield* PubSub.subscribe(events);
        return Stream.concat(
          Stream.succeed<T.ServerEvent>({ type: "snapshot", at: yield* Clock.currentTimeMillis, state: current().state }),
          Stream.fromSubscription(sub),
        );
      }),
    ),
    subscribe: Effect.map(PubSub.subscribe(events), Stream.fromSubscription),
    facts: Stream.fromPubSub(events).pipe(Stream.filter(isFact)),
    live: Stream.fromPubSub(events).pipe(Stream.filter(isLive)),
    user: Effect.map(PubSub.subscribe(user), Stream.fromSubscription),
    states,
  });
  return shape;
});

export const bounded = <A>(source: Stream.Stream<A>, name: string, capacity = 64): Stream.Stream<A> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* Queue.bounded<A, Cause.Done>(capacity);
      let overflowed = false;
      yield* Effect.gen(function* () {
        yield* Stream.runDrain(
          source.pipe(
            Stream.tap((value) => {
              if (overflowed) return Effect.void;
              if (Queue.offerUnsafe(queue, value)) return Effect.void;
              overflowed = true;
              return Effect.logWarning(`vibevalley: ${name}: slow subscription closed`).pipe(Effect.andThen(Queue.shutdown(queue)));
            }),
          ),
        );
        yield* Queue.end(queue);
      }).pipe(Effect.forkScoped);
      return Stream.fromQueue(queue);
    }),
  );
