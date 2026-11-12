import { z } from "zod";

import { type Task, TaskGroup } from "@vibevalley/async";

import { todoToolWords as words } from "../base/prompts.ts";
import { messageOf } from "../core/errors.ts";
import type { Tool } from "../core/loop.ts";
import { schemaEffectTool } from "../core/tool.ts";
import { type AgentLog, consoleLog } from "../infra/log.ts";
import type { Subagent } from "./self.ts";
import * as engine from "./todo.ts";
import type { TodoStore } from "./todoStore.ts";

const { head } = engine;

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

/** changed runs after every change the model makes, so that what became ready goes out. */
export function todoTools(store: TodoStore, canHelp: boolean, changed: () => Promise<void>): Tool[] {
  const add = schemaEffectTool({
    name: "todo_add",
    description: words.addDescription,
    parameters: z.object({
      tasks: z.array(
        z.object({
          id: z.string(),
          title: z.exactOptional(z.string()),
          brief: z.string(),
          after: z.exactOptional(z.array(z.string())),
          by: z.exactOptional(canHelp ? z.enum(["self", "subagent"]) : z.enum(["self"])),
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
  const update = schemaEffectTool({
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
  const list = schemaEffectTool({
    name: "todo_list",
    description: words.graphDescription,
    parameters: z.object({}),
    run: async () => engine.text(await store.load()),
  });
  return [add, update, list];
}

export interface TodoRunner {
  /** Sends out what is ready and fits. Run after the graph changes and when a subagent comes back. */
  readonly advance: () => Promise<void>;
  /** Calls the subagents back. their tasks wait again. */
  readonly stop: () => Promise<void>;
  /** Calls the subagents back and sends no more; their tasks stay working, for recover. */
  readonly close: () => Promise<void>;
  /** At start: a task left working by a process that went is waiting again, and goes out once more. */
  readonly recover: () => Promise<void>;
  /** The open graph for a fold's summary: what the turns it replaces showed. */
  readonly summary: () => Promise<string>;
  /** What to remind a run that stopped of: its own todos that are ready, unless the graph has not moved through maxNudges reminders already (it is stuck. */
  readonly nudge: () => Promise<string>;
}

/** subagent undefined: this agent cannot send subagents (a subagent itself, or the orchestrator). The subagents out are
 * tasks of the runner's own group. */
export function makeTodoRunner(
  store: TodoStore,
  subagent: Subagent | undefined,
  tell: (text: string) => Promise<void>,
  max = 3,
  maxNudges = 3,
  log: AgentLog = consoleLog,
): TodoRunner {
  const tasks = new TaskGroup({ name: "todo runner", onError: (task, e) => log.error(`agent: ${task} failed:`, e) });
  const sent = new Set<Task<unknown>>();
  /** The tasks a subagent is out on, until it answers. */
  const out = new Set<string>();
  let closed = false;
  /** The graph as last reminded of, and how many times running it stayed so. */
  let nudged = "";
  let nudges = 0;

  const advance = async (): Promise<void> => {
    if (!subagent || closed) return;
    let picked: engine.Todo[] = [];
    try {
      await store.change((g) => {
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
      });
    } catch (e) {
      log.error("agent: cannot move its tasks:", e);
      return;
    }
    for (const t of picked) {
      out.add(t.id);
      const task = tasks.run(`task ${t.id}`, (signal) => send(subagent, t, signal));
      sent.add(task);
      void task.done.then(() => sent.delete(task));
    }
  };

  // Called back (stop, close), its signal aborts before anything is recorded: stop puts the task back to waiting.
  const send = async (runSubagent: Subagent, t: engine.Todo, signal: AbortSignal): Promise<void> => {
    let said: string;
    let failed: boolean;
    try {
      said = await runSubagent(t.brief, t.title, signal);
      failed = false;
    } catch (e) {
      if (signal.aborted) return;
      said = messageOf(e);
      failed = true;
    } finally {
      out.delete(t.id);
    }
    if (signal.aborted) return;
    let g: engine.Todo[] | undefined;
    try {
      g = await store.change((g) => engine.settle(g, t.id, said, failed));
    } catch (e) {
      log.error(`agent: cannot record task ${t.id}:`, e);
    }
    if (!g) return;
    const state = g.find((x) => x.id === t.id)?.state ?? "failed";
    if (state === "done") await tell(words.done(t.id, t.title, said.trim()) + "\n\n" + engine.text(g));
    else if (state === "failed") await tell(words.failed(t.id, t.title, head(said, 400)) + words.retryNote + engine.text(g));
    await advance();
  };

  const callBack = () => Promise.all([...sent].map((task) => task.abort()));

  const stop = async () => {
    const ids = [...out];
    await callBack();
    if (ids.length === 0) return;
    try {
      await store.change((g) => engine.requeue(g, ids));
    } catch (e) {
      log.error("agent: cannot put stopped tasks back:", e);
    }
  };

  const recover = async () => {
    try {
      await store.change((g) => {
        const next = engine.requeue(g);
        return engine.states(next).join() === engine.states(g).join() ? undefined : next;
      });
    } catch (e) {
      log.error("agent: cannot read its tasks:", e);
      return;
    }
    await advance();
  };

  return {
    advance,
    stop,
    close: async () => {
      closed = true;
      await tasks.close();
    },
    recover,
    summary: async () => {
      const g = await store.load();
      return g.length === 0 ? "" : words.foldedSummary(engine.text(g));
    },
    nudge: async () => {
      const g = await store.load();
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
    },
  };
}
