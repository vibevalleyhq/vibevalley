// The state changes in one place only: apply folds a fact in with reduce, then sends it.
// state.json keeps the state but the chat, progress, crons and issues, whose home is the database, and the chat apps'
// statuses, which their connectors say again when they start. Each fact is sent
// on the side events, the facts and (as the page wants it) a frame stream; a transition carries the state each fact
// changed, so a reader that comes late needs no second fold.

import { join } from "node:path";

import { Cause, Clock, Context, Effect, FiberMap, Layer, PubSub, Queue, type Scope, Stream } from "effect";

import type * as T from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { jsonOf } from "@/base/json.ts";
import { scopedPubSub } from "@/base/pubsub.ts";
import { ServerConfig } from "@/infra/config.ts";
import { FileWriter, readOrSetAside } from "@/infra/files.ts";

export const emptyWorkspaceState = (): T.WorkspaceState => ({
  call: "idle",
  callReason: "",
  sessions: [],
  orchestrators: {},
  crons: [],
  issues: [],
  connectors: [],
});

/** How the state folds a fact and is shown: every module's rules, so it is given at assembly (projection/) and the core
 * reads none of the modules above it. */
export class Projection extends Context.Service<
  Projection,
  {
    readonly reduce: (state: T.WorkspaceState, fact: T.Fact) => [T.WorkspaceState, boolean];
    /** What a fact sets off on the farm, from the state before it. */
    readonly effects: (before: T.WorkspaceState, fact: T.Fact) => T.GameEffect[];
    /** seq: the core's count of folds the state includes (StateFrame.seq). */
    readonly frame: (state: T.WorkspaceState, effects?: T.GameEffect[], seq?: number) => T.StateFrame;
    /** The state read back from state.json, made whole (the sessions' places on the farm). */
    readonly restore: (kept: T.WorkspaceState) => T.WorkspaceState;
  }
>()("vibevalley/Projection") {}

/** A burst of facts is one write, and one frame. */
const saveAfterMs = 500;
export const stateEveryMs = 200;

/** A fact as a service says it: the time is core's. */
export type FactIn = T.Fact extends infer F ? (F extends T.Fact ? Omit<F, "at"> : never) : never;

/** A fact with exactly the state it changed, even when it is read late. */
export interface Transition {
  readonly before: T.WorkspaceState;
  readonly fact: T.Fact;
  readonly after: T.WorkspaceState;
}

/** What the owner did that changes no state (so it is no fact), said by the service it went through: the game counts some. */
export type OwnerDid = { readonly kind: "reviewed"; readonly session: T.SessionId } | { readonly kind: "talked" };

export class Core extends Context.Service<
  Core,
  {
    readonly state: () => T.WorkspaceState;
    readonly session: (id: string) => T.Session | undefined;
    /** Folds the facts in as one commit: readers see the whole batch, each transition its own before and after. */
    readonly apply: (...facts: FactIn[]) => Effect.Effect<void>;
    /** How many commits apply has folded: one more with each that changed the state. A reply read after its service
     * applied its facts carries it, and the first frame whose seq is at least it shows the change. */
    readonly seq: () => number;
    /** channel: where it thinks or writes, while it does. */
    readonly setOrchestrator: (agent: string, state: T.OrchestratorState, channel?: string) => Effect.Effect<void>;
    readonly setCommits: (commits: T.CommitCount) => Effect.Effect<void>;
    /** The farm opens when the owner starts it or says something: the call goes live unless it is already. */
    readonly open: () => Effect.Effect<void>;
    readonly sessionEvent: (id: string, activity: T.SessionEvent) => Effect.Effect<void>;
    readonly notice: (level: T.NoticeLevel, text: string) => Effect.Effect<void>;
    readonly runtime: (info: T.RuntimeInfo) => Effect.Effect<void>;
    readonly did: (d: OwnerDid) => Effect.Effect<void>;
    /** The state now, then the transitions from here on. */
    readonly transitions: Effect.Effect<readonly [T.WorkspaceState, Stream.Stream<Transition>], never, Scope.Scope>;
    /** A snapshot of the state, then every side event. */
    readonly events: Stream.Stream<T.SideEvent>;
    /** Every side event from now on, subscribed before this returns: none applied after it is missed. */
    readonly subscribe: Effect.Effect<Stream.Stream<T.SideEvent>, never, Scope.Scope>;
    readonly facts: Stream.Stream<T.Fact>;
    readonly live: Stream.Stream<T.LiveEvent>;
    /** What the owner did from now on, subscribed before this returns: none said after it is missed. */
    readonly owner: Effect.Effect<Stream.Stream<OwnerDid>, never, Scope.Scope>;
    /** For the page, which folds no facts: the frame now, then one per burst of facts and effects. */
    readonly states: Stream.Stream<T.StateFrame>;
  }
>()("vibevalley/Core") {
  static readonly layer = Layer.effect(
    Core,
    Effect.suspend(() => make),
  );
}

/** What state.json keeps: the chat, progress, crons and issues are the database's, the chat apps' their connectors'
 * (kept empty: they are filled from their homes). */
const toKeep = ({ chat: _chat, progress: _progress, ...kept }: T.WorkspaceState): T.WorkspaceState => ({ ...kept, crons: [], issues: [], connectors: [] });

/** Started again, nobody is on the call and the orchestrator is not mid-sentence. */
const restarted = (kept: T.WorkspaceState): T.WorkspaceState => {
  return { ...toKeep(kept), orchestrators: {}, call: "idle", callReason: "" };
};

const liveOf = (e: T.SideEvent): T.LiveEvent | undefined => {
  switch (e.type) {
    case "event":
      return { type: "event", at: e.at, id: e.id, activity: e.activity };
    case "notice":
      return { type: "notice", at: e.at, level: e.level, text: e.text };
    case "runtime":
      return { type: "runtime", at: e.at, info: e.info };
    default:
      return undefined;
  }
};

const isFact = (e: T.SideEvent): e is T.Fact => {
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
  const clock = yield* Clock.Clock;
  const config = yield* ServerConfig;
  const { reduce, effects: effectsOf, frame: frameOf, restore } = yield* Projection;
  const file = join(config.home, "state.json");
  const read = jsonOf(S.WorkspaceState);
  const kept = { ...emptyWorkspaceState(), ...(yield* readOrSetAside(file, read, "the farm starts empty")) };
  let state = restore(restarted(kept));
  let seq = 0;
  const disk = new FileWriter(file);
  const body = () => JSON.stringify(toKeep(state));
  let closed = false;
  // A crash loses half a second at most: a write waits that long after the first change, and the changes after it join
  // it rather than putting it off. The wait is a fiber of this service's, ended with it.
  const saves = yield* FiberMap.make<"save">();
  const later = yield* FiberMap.runtime(saves)();
  const save = () => {
    if (!closed)
      later(
        "save",
        Effect.delay(
          Effect.sync(() => disk.write(body)).pipe(
            Effect.onError((cause) => (Cause.hasInterrupts(cause) ? Effect.void : Effect.logError("vibevalley: state.json could not be saved", cause))),
          ),
          saveAfterMs,
        ),
        { onlyIfMissing: true },
      );
  };
  yield* Effect.addFinalizer(() =>
    Effect.suspend(() => {
      closed = true;
      return FiberMap.clear(saves);
    }).pipe(Effect.andThen(Effect.sync(() => disk.finish(body)))),
  );

  const events = yield* scopedPubSub<T.SideEvent>();
  const transitions = yield* scopedPubSub<Transition>();
  const owner = yield* scopedPubSub<OwnerDid>();
  /** Each fact and effect, for the frames: a frame waits for the burst it starts. */
  const changes = yield* scopedPubSub<T.GameEffect | undefined>();

  const publish = (e: T.SideEvent) => {
    PubSub.publishUnsafe(events, e);
    if (isFact(e)) PubSub.publishUnsafe(changes, undefined);
  };

  // Every fact goes through here: a span each would bury the traces in folds.
  const apply = Effect.fnUntraced(function* (...facts: FactIn[]) {
    yield* Effect.sync(() => {
      let next = state;
      const done: Transition[] = [];
      const made: T.GameEffect[] = [];
      for (const fact of facts) {
        const f = { ...fact, at: clock.currentTimeMillisUnsafe() };
        const [after, changed] = reduce(next, f);
        if (!changed) continue;
        done.push({ before: next, fact: f, after });
        made.push(...effectsOf(next, f));
        next = after;
      }
      if (done.length === 0) return;
      state = next;
      seq += 1;
      save();
      for (const t of done) {
        publish(t.fact);
        PubSub.publishUnsafe(transitions, t);
      }
      for (const e of made) {
        PubSub.publishUnsafe(changes, e);
      }
    });
  });

  const side = (e: T.SideEvent) => Effect.sync(() => publish(e));

  const states = Stream.callback<T.StateFrame>((queue) =>
    Effect.gen(function* () {
      const sub = yield* PubSub.subscribe(changes);
      Queue.offerUnsafe(queue, frameOf(state, [], seq));
      return yield* Effect.forever(
        Effect.gen(function* () {
          const first = yield* PubSub.take(sub);
          yield* Effect.sleep(stateEveryMs);
          const rest = yield* PubSub.takeUpTo(sub, Number.MAX_SAFE_INTEGER);
          const gathered = [first, ...rest].filter((e): e is T.GameEffect => e !== undefined);
          Queue.offerUnsafe(queue, frameOf(state, gathered, seq));
        }),
      );
    }),
  );

  const shape = Core.of({
    state: () => state,
    seq: () => seq,
    session: (id) => state.sessions.find((h) => h.id === id),
    apply,
    setOrchestrator: Effect.fn("Core.setOrchestrator")(function* (agent, orchestrator, channel) {
      return yield* apply({ type: "orchestrator", agent, state: orchestrator, ...(channel ? { channel } : {}) });
    }),
    setCommits: Effect.fn("Core.setCommits")(function* (commits) {
      return yield* apply({ type: "commits", commits });
    }),
    open: Effect.fn("Core.open")(function* () {
      if (state.call !== "live") yield* apply({ type: "call", state: "live", reason: "" });
    }),
    // A session's every line of output comes through here: a span each would bury the traces.
    sessionEvent: Effect.fnUntraced(function* (id, activity) {
      return yield* side({ type: "event", at: clock.currentTimeMillisUnsafe(), id, activity });
    }),
    notice: Effect.fn("Core.notice")(function* (level, text) {
      return yield* side({ type: "notice", at: clock.currentTimeMillisUnsafe(), level, text });
    }),
    runtime: Effect.fn("Core.runtime")(function* (info) {
      return yield* side({ type: "runtime", at: clock.currentTimeMillisUnsafe(), info });
    }),
    did: Effect.fn("Core.did")(function* (d) {
      yield* PubSub.publish(owner, d);
    }),
    transitions: Effect.gen(function* () {
      const sub = yield* PubSub.subscribe(transitions);
      return [state, Stream.fromSubscription(sub)] as const;
    }),
    events: Stream.unwrap(
      Effect.gen(function* () {
        const sub = yield* PubSub.subscribe(events);
        return Stream.concat(Stream.succeed<T.SideEvent>({ type: "snapshot", at: yield* Clock.currentTimeMillis, state }), Stream.fromSubscription(sub));
      }),
    ),
    subscribe: Effect.map(PubSub.subscribe(events), Stream.fromSubscription),
    facts: Stream.fromPubSub(events).pipe(Stream.filter(isFact)),
    live: Stream.fromPubSub(events).pipe(
      Stream.map(liveOf),
      Stream.filter((e): e is T.LiveEvent => e !== undefined),
    ),
    owner: Effect.map(PubSub.subscribe(owner), Stream.fromSubscription),
    states,
  });
  return shape;
});
