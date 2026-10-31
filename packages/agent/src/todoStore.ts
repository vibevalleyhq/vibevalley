// Where an agent keeps its own todos (todo.ts). change answers the graph as kept, then puts a finished one away:
// the caller can still say how it ended. The farm keeps them in its database (apps/server, runtime/todoStore.ts).

import { Effect } from "effect";

import { type ToolFailed, toolFailed } from "./core/errors.ts";
import { finished, type Todo } from "./todo.ts";

export interface TodoStore {
  readonly load: Effect.Effect<Todo[]>;
  /** f returning undefined changes nothing: nothing is written, and the answer is undefined. A throw from f (the words
   * the model is answered with) leaves the graph as it was and is the failure. */
  readonly change: <G extends Todo[] | undefined>(f: (g: Todo[]) => G) => Effect.Effect<G, ToolFailed>;
}

/** For an agent with no farm behind it (the command line): the graph lasts as long as the process. */
export function memoryStore(): TodoStore {
  let g: Todo[] = [];
  return {
    load: Effect.sync(() => [...g]),
    change: (f) =>
      Effect.try({
        try: () => {
          const next = f([...g]);
          if (next !== undefined) g = finished(next) ? [] : next;
          return next;
        },
        catch: toolFailed,
      }),
  };
}
