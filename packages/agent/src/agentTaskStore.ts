// Where an agent keeps its own tasks (agentTask.ts). change answers the graph as kept, then puts a finished one away:
// the caller can still say how it ended. The farm keeps them in its database (apps/server, agent/taskStore.ts).

import { Effect } from "effect";

import { finished, type AgentTask } from "./agentTask.ts";
import { type ToolFailed, toolFailed } from "./core/errors.ts";

export interface AgentTaskStore {
  readonly load: Effect.Effect<AgentTask[]>;
  /** f returning undefined changes nothing: nothing is written, and the answer is undefined. A throw from f (the words
   * the model is answered with) leaves the graph as it was and is the failure. */
  readonly change: <G extends AgentTask[] | undefined>(f: (g: AgentTask[]) => G) => Effect.Effect<G, ToolFailed>;
}

/** For an agent with no farm behind it (the command line): the graph lasts as long as the process. */
export function memoryStore(): AgentTaskStore {
  let g: AgentTask[] = [];
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
