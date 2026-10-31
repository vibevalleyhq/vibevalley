// The agent's own todos (todo.ts): it lists the steps of one piece of work, marks them as it goes, and reads
// the whole graph back after each call. The runner moves it along: a subagent's task whose waits are settled goes to a
// subagent in the background, at most max at once; what the subagent says comes back to the agent as an input. The agent's
// own todos are its to do; nothing here does them.

import { Effect, FiberSet, Schema, type Scope } from "effect";

import type { Tool } from "./core/loop.ts";
import { schemaEffectTool } from "./core/tool.ts";
import { head } from "./head.ts";
import { todoToolWords as words } from "./prompts.ts";
import type { Subagent } from "./self.ts";
import * as engine from "./todo.ts";
import type { TodoStore } from "./todoStore.ts";

/** Every change, whoever makes it, is told to changed. */
export function watchedStore(store: TodoStore, changed: (g: engine.Todo[]) => Effect.Effect<void>): TodoStore {
  return {
    load: store.load,
    change: (f) => Effect.tap(store.change(f), (g) => (g === undefined ? Effect.void : changed(g))),
  };
}

/** changed runs after every change the model makes, so that what became ready goes out. */
export function todoTools(store: TodoStore, canHelp: boolean, changed: Effect.Effect<void>): Tool[] {
  const add = schemaEffectTool({
    name: "todo_add",
    description: words.addDescription,
    parameters: Schema.Struct({
      tasks: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          title: Schema.optionalKey(Schema.String),
          brief: Schema.String,
          after: Schema.optionalKey(Schema.Array(Schema.String)),
          by: Schema.optionalKey(Schema.Literals(canHelp ? (["self", "subagent"] as const) : (["self"] as const))),
        }),
      ),
    }),
    run: (p) =>
      Effect.gen(function* () {
        let problems: string[] = [];
        const g = yield* store.change((g) => {
          const [next, bad] = engine.add(g, p.tasks);
          problems = bad;
          return next;
        });
        if (problems.length > 0) return words.notRecorded(problems) + "\n\n" + engine.text(g);
        yield* changed;
        return engine.text(g);
      }),
  });
  const update = schemaEffectTool({
    name: "todo_update",
    description: words.updateDescription,
    parameters: Schema.Struct({
      id: Schema.String,
      state: Schema.optionalKey(Schema.Literals(["done", "failed", "skipped", "waiting"])),
      result: Schema.optionalKey(Schema.String),
      brief: Schema.optionalKey(Schema.String),
      after: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
    run: (p) =>
      Effect.gen(function* () {
        const c: engine.Change = {
          ...(p.state != null ? { state: p.state } : {}),
          ...(p.result != null ? { result: p.result } : {}),
          ...(p.brief != null ? { brief: p.brief } : {}),
          ...(p.after != null ? { after: p.after } : {}),
        };
        const g = yield* store.change((g) => engine.update(g, p.id, c));
        if (engine.finished(g)) return engine.text(g) + words.allDone;
        yield* changed;
        return engine.text(g);
      }),
  });
  const list = schemaEffectTool({
    name: "todo_list",
    description: words.graphDescription,
    parameters: Schema.Struct({}),
    run: () => Effect.map(store.load, engine.text),
  });
  return [add, update, list];
}

export interface TodoRunner {
  /** Sends out what is ready and fits. Run after the graph changes and when a subagent comes back. */
  readonly advance: Effect.Effect<void>;
  /** Calls the subagents back; their tasks wait again. The graph stays as it is otherwise. */
  readonly stop: Effect.Effect<void>;
  /** Calls the subagents back and sends no more; their tasks stay working, for recover. */
  readonly close: Effect.Effect<void>;
  /** At start: a task left working by a process that went is waiting again, and goes out once more. */
  readonly recover: Effect.Effect<void>;
  /** The open graph for a fold's summary: what the turns it replaces showed. */
  readonly summary: Effect.Effect<string>;
  /** What to remind a run that stopped of: its own todos that are ready, unless the graph has not moved through
   * maxNudges reminders already (it is stuck; the owner or another input will move it). "" for nothing. */
  readonly nudge: Effect.Effect<string>;
}

/** subagent undefined: this agent cannot send subagents (a subagent itself, or the orchestrator). The subagents out are
 * fibers of the scope. */
export const makeTodoRunner = (
  store: TodoStore,
  subagent: Subagent | undefined,
  tell: (text: string) => Effect.Effect<void>,
  max = 3,
  maxNudges = 3,
): Effect.Effect<TodoRunner, never, Scope.Scope> =>
  Effect.gen(function* () {
    const fibers = yield* FiberSet.make();
    /** The tasks a subagent is out on, until it answers. */
    const out = new Set<string>();
    let closed = false;
    /** The graph as last reminded of, and how many times running it stayed so. */
    let nudged = "";
    let nudges = 0;

    const advance: Effect.Effect<void> = Effect.suspend(() => {
      if (!subagent || closed) return Effect.void;
      return Effect.gen(function* () {
        let picked: engine.Todo[] = [];
        const moved = yield* store
          .change((g) => {
            picked = [];
            let room = max - out.size;
            let next = g;
            for (const t of engine.readyTodos(g)) {
              if (room <= 0) break;
              if (t.by !== "subagent" || out.has(t.id)) continue;
              next = engine.begin(next, t.id);
              picked.push(t);
              room--;
            }
            return picked.length === 0 ? undefined : next;
          })
          .pipe(
            Effect.as(true),
            Effect.catch((e) => Effect.as(Effect.logError("agent: cannot move its tasks:", e), false)),
          );
        if (!moved) return;
        yield* Effect.forEach(
          picked,
          (t) =>
            Effect.gen(function* () {
              out.add(t.id);
              yield* FiberSet.run(fibers, send(t));
            }),
          { discard: true },
        );
      });
    });

    // Called back (stop, close), its fiber is interrupted before anything is recorded: stop puts the task back to waiting.
    const send = (t: engine.Todo): Effect.Effect<void> =>
      Effect.gen(function* () {
        const { said, failed } = yield* subagent!(t.brief, t.title).pipe(
          Effect.map((said) => ({ said, failed: false })),
          Effect.catch((e) => Effect.succeed({ said: e.message, failed: true })),
          Effect.ensuring(Effect.sync(() => out.delete(t.id))),
        );
        const g = yield* store
          .change((g) => engine.settle(g, t.id, said, failed))
          .pipe(Effect.catch((e) => Effect.as(Effect.logError(`agent: cannot record task ${t.id}:`, e), undefined)));
        if (!g) return;
        const state = g.find((x) => x.id === t.id)?.state ?? "failed";
        if (state === "done") yield* tell(words.done(t.id, t.title, said.trim()) + "\n\n" + engine.text(g));
        else if (state === "failed") yield* tell(words.failed(t.id, t.title, head(said, 400)) + words.retryNote + engine.text(g));
        yield* advance;
      });

    const stop = Effect.gen(function* () {
      const ids = [...out];
      yield* FiberSet.clear(fibers);
      if (ids.length === 0) return;
      yield* store.change((g) => engine.requeue(g, ids)).pipe(Effect.catch((e) => Effect.logError("agent: cannot put stopped tasks back:", e)));
    });

    const recover = Effect.gen(function* () {
      const read = yield* store
        .change((g) => {
          const next = engine.requeue(g);
          return engine.states(next).join() === engine.states(g).join() ? undefined : next;
        })
        .pipe(
          Effect.as(true),
          Effect.catch((e) => Effect.as(Effect.logError("agent: cannot read its tasks:", e), false)),
        );
      if (read) yield* advance;
    });

    return {
      advance,
      stop,
      close: Effect.suspend(() => {
        closed = true;
        return FiberSet.clear(fibers);
      }),
      recover,
      summary: Effect.map(store.load, (g) => (g.length === 0 ? "" : words.foldedSummary(engine.text(g)))),
      nudge: Effect.map(store.load, (g) => {
        const own = engine
          .readyTodos(g)
          .filter((t) => t.by === "self")
          .map((t) => t.id);
        if (own.length === 0) {
          nudged = "";
          nudges = 0;
          return "";
        }
        const seen = engine.text(g);
        if (seen !== nudged) {
          nudged = seen;
          nudges = 0;
        }
        if (nudges >= maxNudges) return "";
        nudges++;
        return words.nudge(own.length, own, seen);
      }),
    };
  });
