import { toolFailed } from "../core/errors.ts";
import { finished, type Todo } from "./todo.ts";

export interface TodoStore {
  readonly load: () => Promise<Todo[]>;
  /** f returning undefined changes nothing: nothing is written, and the answer is undefined. A failure (f's own, or the
   * store's) is a ToolFailed. */
  readonly change: <G extends Todo[] | undefined>(f: (g: Todo[]) => G) => Promise<G>;
}

/** For an agent with no farm behind it (the command line): the graph lasts as long as the process. */
export function memoryStore(): TodoStore {
  let g: Todo[] = [];
  return {
    load: async () => [...g],
    change: async (f) => {
      try {
        const next = f([...g]);
        if (next !== undefined) g = finished(next) ? [] : next;
        return next;
      } catch (e) {
        throw toolFailed(e);
      }
    },
  };
}
