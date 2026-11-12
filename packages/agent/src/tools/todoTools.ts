import { z } from "zod";

import { todoToolWords as words } from "../base/prompts.ts";
import { schemaTool, type Tool } from "../core/tool.ts";
import * as engine from "./todo.ts";
import type { TodoStore } from "./todoStore.ts";

/** Every change, whoever makes it, is told to changed. */
export function watchedStore(store: TodoStore, changed: (g: engine.Todo[]) => void): TodoStore {
  return {
    load: store.load,
    change: async (f) => {
      const g = await store.change(f);
      if (g !== undefined) changed(g);
      return g;
    },
  };
}

/** The agent's own todos, done by itself; changed runs after every change the model makes. */
export function todoTools(store: TodoStore, changed: () => Promise<void>): Tool[] {
  const add = schemaTool({
    name: "todo_add",
    description: words.addDescription,
    parameters: z.object({
      tasks: z.array(
        z.object({
          id: z.string(),
          title: z.exactOptional(z.string()),
          brief: z.string(),
          after: z.exactOptional(z.array(z.string())),
          by: z.exactOptional(z.enum(["self"])),
        }),
      ),
    }),
    run: async (p) => {
      let problems: string[] = [];
      const g = await store.change((g) => {
        const [next, bad] = engine.add(g, p.tasks);
        problems = bad;
        return next;
      });
      if (problems.length > 0) return words.notRecorded(problems) + "\n\n" + engine.text(g);
      await changed();
      return engine.text(g);
    },
  });
  const update = schemaTool({
    name: "todo_update",
    description: words.updateDescription,
    parameters: z.object({
      id: z.string(),
      state: z.exactOptional(z.enum(["done", "failed", "skipped", "waiting"])),
      result: z.exactOptional(z.string()),
      brief: z.exactOptional(z.string()),
      after: z.exactOptional(z.array(z.string())),
    }),
    run: async (p) => {
      const c: engine.Change = {
        ...(p.state != null ? { state: p.state } : {}),
        ...(p.result != null ? { result: p.result } : {}),
        ...(p.brief != null ? { brief: p.brief } : {}),
        ...(p.after != null ? { after: p.after } : {}),
      };
      const g = await store.change((g) => engine.update(g, p.id, c));
      if (engine.finished(g)) return engine.text(g) + words.allDone;
      await changed();
      return engine.text(g);
    },
  });
  const list = schemaTool({
    name: "todo_list",
    description: words.graphDescription,
    parameters: z.object({}),
    run: async () => engine.text(await store.load()),
  });
  return [add, update, list];
}
