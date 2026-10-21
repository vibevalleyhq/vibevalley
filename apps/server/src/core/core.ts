// The state changes in one place only: apply folds a fact in with reduce, then sends it.
// state.json keeps the state but the chat, progress, schedules and issues, whose home is the database. Each fact is sent
// on the side events, the facts and (as the page wants it) a frame stream; a transition carries the state each fact
// changed, so a reader that comes late needs no second fold.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CallState,
  CommitCount,
  CoreState,
  Fact,
  GameEffect,
  LiveEvent,
  ManagerState,
  NoticeLevel,
  RuntimeInfo,
  Session,
  SessionEvent,
  SideEvent,
  StateFrame,
} from "@vibevalley/protocol";
import { effectsOf, emptyCoreState, frameOf, reduce, sessionOf, withStations } from "@vibevalley/protocol/rules";
import { Context, Effect, Layer, PubSub, Queue, type Scope, Stream } from "effect";
import { Settings } from "../base/config.ts";
import { FileWriter } from "../base/files.ts";

/** A burst of facts is one write, and one frame. */
const saveAfterMs = 500;
export const stateEveryMs = 200;

/** A fact as a service says it: the time is core's. */
export type FactIn = Fact extends infer F ? (F extends Fact ? Omit<F, "at"> : never) : never;

/** A fact with exactly the state it changed, even when it is read late. */
export interface Transition {
  readonly before: CoreState;
  readonly fact: Fact;
  readonly after: CoreState;
}

/** What the owner did that changes no state (so it is no fact), said by the service it went through: the game counts some. */
export type OwnerDid = { readonly kind: "reviewed"; readonly session: string } | { readonly kind: "talked" };

export interface CoreShape {
  readonly state: () => CoreState;
  readonly session: (id: string) => Session | undefined;
  /** Folds the facts in as one commit: readers see the whole batch, each transition its own before and after. */
  readonly apply: (...facts: FactIn[]) => Effect.Effect<void>;
  readonly setCall: (state: CallState, reason?: string) => Effect.Effect<void>;
  readonly setManager: (state: ManagerState) => Effect.Effect<void>;
  readonly setCommits: (commits: CommitCount) => Effect.Effect<void>;
  /** The farm opens when the owner starts it or says something: the call goes live unless it is already. */
  readonly open: () => Effect.Effect<void>;
  readonly sessionEvent: (id: string, activity: SessionEvent) => Effect.Effect<void>;
  readonly notice: (level: NoticeLevel, text: string) => Effect.Effect<void>;
  readonly runtime: (info: RuntimeInfo) => Effect.Effect<void>;
  readonly did: (d: OwnerDid) => Effect.Effect<void>;
  /** The state now, then the transitions from here on. */
  readonly transitions: Effect.Effect<readonly [CoreState, Stream.Stream<Transition>], never, Scope.Scope>;
  /** A snapshot of the state, then every side event. */
  readonly events: Stream.Stream<SideEvent>;
  /** Every side event from now on, subscribed before this returns: none applied after it is missed. */
  readonly subscribe: Effect.Effect<Stream.Stream<SideEvent>, never, Scope.Scope>;
  readonly facts: Stream.Stream<Fact>;
  readonly live: Stream.Stream<LiveEvent>;
  readonly owner: Stream.Stream<OwnerDid>;
  readonly effects: Stream.Stream<GameEffect>;
  /** For the page, which folds no facts: the frame now, then one per burst of facts and effects. */
  readonly states: Stream.Stream<StateFrame>;
}

export class Core extends Context.Service<Core, CoreShape>()("vibevalley/Core") {}

/** What state.json keeps: the chat, progress, schedules and issues are the database's. */
const toKeep = ({ chat: _chat, progress: _progress, schedules: _schedules, issues: _issues, ...kept }: CoreState): CoreState => kept;

/** Started again, nobody is on the call and the manager is not mid-sentence. */
const restored = (kept: CoreState): CoreState => withStations({ ...toKeep(kept), call: "idle", callReason: undefined, manager: "idle" });

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

const isFact = (e: SideEvent): e is Fact => e.type !== "snapshot" && e.type !== "event" && e.type !== "notice" && e.type !== "runtime";

export const make = Effect.gen(function* () {
  const config = yield* Settings;
  const file = join(config.home, "state.json");
  let kept = emptyCoreState();
  if (existsSync(file)) {
    try {
      kept = { ...emptyCoreState(), ...(JSON.parse(readFileSync(file, "utf8")) as CoreState) };
    } catch (e) {
      yield* Effect.logWarning(`state.json unreadable, starting empty: ${String(e)}`);
    }
  }
  let state = restored(kept);
  const disk = new FileWriter(file);
  const body = () => JSON.stringify(toKeep(state));
  let pending: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  // A crash loses half a second at most.
  const save = () => {
    if (closed || pending) return;
    pending = setTimeout(() => {
      pending = undefined;
      disk.write(body);
    }, saveAfterMs);
  };
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
      clearTimeout(pending);
      disk.finish(body);
    }),
  );

  const events = yield* PubSub.unbounded<SideEvent>();
  const transitions = yield* PubSub.unbounded<Transition>();
  const effects = yield* PubSub.unbounded<GameEffect>();
  const owner = yield* PubSub.unbounded<OwnerDid>();
  /** Each fact and effect, for the frames: a frame waits for the burst it starts. */
  const changes = yield* PubSub.unbounded<GameEffect | undefined>();

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
        const f = { ...fact, at: Date.now() } as Fact;
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
        PubSub.publishUnsafe(effects, e);
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
    session: (id) => sessionOf(state, id),
    apply,
    setCall: (call, reason) => apply(reason ? { type: "call", state: call, reason } : { type: "call", state: call }),
    setManager: (manager) => apply({ type: "manager", state: manager }),
    setCommits: (commits) => apply({ type: "commits", commits }),
    open: () => (state.call === "live" ? Effect.void : apply({ type: "call", state: "live" })),
    sessionEvent: (id, activity) => side({ type: "event", at: Date.now(), id, activity }),
    notice: (level, text) => side({ type: "notice", at: Date.now(), level, text }),
    runtime: (info) => side({ type: "runtime", at: Date.now(), info }),
    did: (d) => Effect.sync(() => PubSub.publishUnsafe(owner, d)),
    transitions: Effect.gen(function* () {
      const sub = yield* PubSub.subscribe(transitions);
      return [state, Stream.fromSubscription(sub)] as const;
    }),
    events: Stream.unwrap(
      Effect.gen(function* () {
        const sub = yield* PubSub.subscribe(events);
        return Stream.concat(Stream.succeed<SideEvent>({ type: "snapshot", at: Date.now(), state }), Stream.fromSubscription(sub));
      }),
    ),
    subscribe: Effect.map(PubSub.subscribe(events), Stream.fromSubscription),
    facts: Stream.fromPubSub(events).pipe(Stream.filter(isFact)),
    live: Stream.fromPubSub(events).pipe(
      Stream.map(liveOf),
      Stream.filter((e): e is LiveEvent => e !== undefined),
    ),
    owner: Stream.fromPubSub(owner),
    effects: Stream.fromPubSub(effects),
    states,
  };
  return shape;
});

export const layer = Layer.effect(Core, make);
