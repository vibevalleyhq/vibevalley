// The state changes in one place only: apply folds a fact in with reduce, then sends it.
// state.json keeps the state but the chat, progress, recurrences and issues, whose home is the database, and the chat apps'
// statuses, which their connectors say again when they start. Each fact is sent
// on the side events, the facts and (as the page wants it) a frame stream; a transition carries the state each fact
// changed, so a reader that comes late needs no second fold.

import { join } from "node:path";
import type {
  CommitCount,
  WorkspaceState,
  Fact,
  GameEffect,
  LiveEvent,
  OrchestratorState,
  NoticeLevel,
  RuntimeInfo,
  Session,
  SessionEvent,
  SideEvent,
  StateFrame,
  SessionId,
} from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";
import { Cause, Clock, Context, Effect, FiberMap, Layer, PubSub, Queue, type Scope, Stream } from "effect";
import { Settings } from "../base/config.ts";
import { FileWriter, readOrSetAside } from "../base/files.ts";
import { jsonOf } from "../base/json.ts";

export const emptyWorkspaceState = (): WorkspaceState => ({ call: "idle", orchestrator: "idle", sessions: [] });

/** How the state folds a fact and is shown: every module's rules, so it is given at assembly (projection/) and the core
 * reads none of the modules above it. */
export interface ProjectionShape {
  readonly reduce: (state: WorkspaceState, fact: Fact) => [WorkspaceState, boolean];
  /** What a fact sets off on the farm, from the state before it. */
  readonly effects: (before: WorkspaceState, fact: Fact) => GameEffect[];
  readonly frame: (state: WorkspaceState, effects?: GameEffect[]) => StateFrame;
  /** The state read back from state.json, made whole (the sessions' places on the farm). */
  readonly restore: (kept: WorkspaceState) => WorkspaceState;
}

export class Projection extends Context.Service<Projection, ProjectionShape>()("vibevalley/Projection") {}

/** A burst of facts is one write, and one frame. */
const saveAfterMs = 500;
export const stateEveryMs = 200;

/** A fact as a service says it: the time is core's. */
export type FactIn = Fact extends infer F ? (F extends Fact ? Omit<F, "at"> : never) : never;

/** A fact with exactly the state it changed, even when it is read late. */
export interface Transition {
  readonly before: WorkspaceState;
  readonly fact: Fact;
  readonly after: WorkspaceState;
}

/** What the owner did that changes no state (so it is no fact), said by the service it went through: the game counts some. */
export type OwnerDid = { readonly kind: "reviewed"; readonly session: SessionId } | { readonly kind: "talked" };

export interface CoreShape {
  readonly state: () => WorkspaceState;
  readonly session: (id: string) => Session | undefined;
  /** Folds the facts in as one commit: readers see the whole batch, each transition its own before and after. */
  readonly apply: (...facts: FactIn[]) => Effect.Effect<void>;
  readonly setOrchestrator: (state: OrchestratorState) => Effect.Effect<void>;
  readonly setCommits: (commits: CommitCount) => Effect.Effect<void>;
  /** The farm opens when the owner starts it or says something: the call goes live unless it is already. */
  readonly open: () => Effect.Effect<void>;
  readonly sessionEvent: (id: string, activity: SessionEvent) => Effect.Effect<void>;
  readonly notice: (level: NoticeLevel, text: string) => Effect.Effect<void>;
  readonly runtime: (info: RuntimeInfo) => Effect.Effect<void>;
  readonly did: (d: OwnerDid) => Effect.Effect<void>;
  /** The state now, then the transitions from here on. */
  readonly transitions: Effect.Effect<readonly [WorkspaceState, Stream.Stream<Transition>], never, Scope.Scope>;
  /** A snapshot of the state, then every side event. */
  readonly events: Stream.Stream<SideEvent>;
  /** Every side event from now on, subscribed before this returns: none applied after it is missed. */
  readonly subscribe: Effect.Effect<Stream.Stream<SideEvent>, never, Scope.Scope>;
  readonly facts: Stream.Stream<Fact>;
  readonly live: Stream.Stream<LiveEvent>;
  readonly owner: Stream.Stream<OwnerDid>;
  /** For the page, which folds no facts: the frame now, then one per burst of facts and effects. */
  readonly states: Stream.Stream<StateFrame>;
}

export class Core extends Context.Service<Core, CoreShape>()("vibevalley/Core") {}

/** What state.json keeps: the chat, progress, recurrences and issues are the database's, the chat apps' their connectors'. */
const toKeep = ({
  chat: _chat,
  progress: _progress,
  recurrences: _recurrences,
  issues: _issues,
  connectors: _connectors,
  ...kept
}: WorkspaceState): WorkspaceState => kept;

/** Started again, nobody is on the call and the orchestrator is not mid-sentence. */
const restarted = (kept: WorkspaceState): WorkspaceState => {
  const { callReason: _callReason, ...rest } = toKeep(kept);
  return { ...rest, call: "idle", orchestrator: "idle" };
};

const liveOf = (e: SideEvent): LiveEvent | undefined => {
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

const isFact = (e: SideEvent): e is Fact => {
  switch (e.type) {
    case "snapshot":
    case "event":
    case "notice":
    case "runtime":
      return false;
    default:
      return (e satisfies Fact) !== undefined;
  }
};

export const make = Effect.gen(function* () {
  const clock = yield* Clock.Clock;
  const config = yield* Settings;
  const { reduce, effects: effectsOf, frame: frameOf, restore } = yield* Projection;
  const file = join(config.home, "state.json");
  const read = jsonOf(S.WorkspaceState);
  const kept = { ...emptyWorkspaceState(), ...(yield* readOrSetAside(file, read, "the farm starts empty")) };
  let state = restore(restarted(kept));
  const disk = new FileWriter(file);
  const body = () => JSON.stringify(toKeep(state));
  let closed = false;
  // A crash loses half a second at most: a write waits that long after the first change, and the changes after it join
  // it rather than putting it off. The wait is a fiber of this service's, ended with it.
  const saves = yield* FiberMap.make<"save">();
  const later = yield* FiberMap.runtime(saves)<never>();
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

  const events = yield* PubSub.unbounded<SideEvent>();
  const transitions = yield* PubSub.unbounded<Transition>();
  const owner = yield* PubSub.unbounded<OwnerDid>();
  /** Each fact and effect, for the frames: a frame waits for the burst it starts. */
  const changes = yield* PubSub.unbounded<GameEffect | undefined>();
  yield* Effect.addFinalizer(() =>
    Effect.all([PubSub.shutdown(events), PubSub.shutdown(transitions), PubSub.shutdown(owner), PubSub.shutdown(changes)], { discard: true }),
  );

  const publish = (e: SideEvent) => {
    PubSub.publishUnsafe(events, e);
    if (isFact(e)) PubSub.publishUnsafe(changes, undefined);
  };

  const apply = (...facts: FactIn[]) =>
    Effect.sync(() => {
      let next = state;
      const done: Transition[] = [];
      const made: GameEffect[] = [];
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
      save();
      for (const t of done) {
        publish(t.fact);
        PubSub.publishUnsafe(transitions, t);
      }
      for (const e of made) {
        PubSub.publishUnsafe(changes, e);
      }
    });

  const side = (e: SideEvent) => Effect.sync(() => publish(e));

  const states = Stream.callback<StateFrame>((queue) =>
    Effect.gen(function* () {
      const sub = yield* PubSub.subscribe(changes);
      Queue.offerUnsafe(queue, frameOf(state));
      yield* Effect.forever(
        Effect.gen(function* () {
          const first = yield* PubSub.take(sub);
          yield* Effect.sleep(stateEveryMs);
          const rest = yield* PubSub.takeUpTo(sub, Number.MAX_SAFE_INTEGER);
          const gathered = [first, ...rest].filter((e): e is GameEffect => e !== undefined);
          Queue.offerUnsafe(queue, frameOf(state, gathered));
        }),
      );
    }),
  );

  const shape: CoreShape = {
    state: () => state,
    session: (id) => state.sessions.find((h) => h.id === id),
    apply,
    setOrchestrator: (orchestrator) => apply({ type: "orchestrator", state: orchestrator }),
    setCommits: (commits) => apply({ type: "commits", commits }),
    open: () => Effect.suspend(() => (state.call === "live" ? Effect.void : apply({ type: "call", state: "live" }))),
    sessionEvent: (id, activity) => Effect.suspend(() => side({ type: "event", at: clock.currentTimeMillisUnsafe(), id, activity })),
    notice: (level, text) => Effect.suspend(() => side({ type: "notice", at: clock.currentTimeMillisUnsafe(), level, text })),
    runtime: (info) => Effect.suspend(() => side({ type: "runtime", at: clock.currentTimeMillisUnsafe(), info })),
    did: (d) => Effect.asVoid(PubSub.publish(owner, d)),
    transitions: Effect.gen(function* () {
      const sub = yield* PubSub.subscribe(transitions);
      return [state, Stream.fromSubscription(sub)] as const;
    }),
    events: Stream.unwrap(
      Effect.gen(function* () {
        const sub = yield* PubSub.subscribe(events);
        return Stream.concat(Stream.succeed<SideEvent>({ type: "snapshot", at: yield* Clock.currentTimeMillis, state }), Stream.fromSubscription(sub));
      }),
    ),
    subscribe: Effect.map(PubSub.subscribe(events), Stream.fromSubscription),
    facts: Stream.fromPubSub(events).pipe(Stream.filter(isFact)),
    live: Stream.fromPubSub(events).pipe(
      Stream.map(liveOf),
      Stream.filter((e): e is LiveEvent => e !== undefined),
    ),
    owner: Stream.fromPubSub(owner),
    states,
  };
  return shape;
});

export const layer = Layer.effect(Core, make);
