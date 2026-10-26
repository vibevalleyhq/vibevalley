// The agent's own tasks (agentTask.ts): it tasks the steps of one piece of work, marks them as it goes, and reads
// the whole graph back after each call. The runner moves it along: a subagent's task whose waits are settled goes to a
// subagent in the background, at most max at once; what the subagent says comes back to the agent as an input. The agent's
// own tasks are its to do; nothing here does them.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { head } from "../../base/text.ts";
import * as engine from "./agentTask.ts";
import type { AgentTaskStore } from "./agentTaskStore.ts";
import type { Subagent } from "./self.ts";
import { objectSchema, type Schema, stringSchema, textTool } from "./tool.ts";

/** Every change, whoever makes it, is told to changed. */
export function watchedStore(store: AgentTaskStore, changed: (g: engine.AgentTask[]) => void): AgentTaskStore {
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
export function taskTools(store: AgentTaskStore, canHelp: boolean, changed: () => void): AgentTool[] {
  const ids: Schema = { type: "array", items: stringSchema() };
  const task = textTool<{
    tasks: { id: string; title?: string; brief: string; after?: string[]; by?: engine.By }[];
  }>({
    name: "task_add",
    description:
      "把一件要分几步、有先后的活写成任务：每件一个简短的英文 id、要做什么（brief：在哪、做到什么程度算完、交回什么）、要等哪几件做完（after）、谁做（by：self 你自己做；subagent 交给帮手，等的做完了就自动派、几件同时做，做完把结果交回给你；帮手看不到你们的对话，brief 要写全）。" +
      "可以一次写一张图，也可以往已有的图里加；有一件不对（id 重复、等的不存在、互相等成了圈）整批都不收，回答里说哪条错。做完一件用 task_update 标上。",
    parameters: objectSchema(
      {
        tasks: {
          type: "array",
          items: objectSchema(
            {
              id: stringSchema(),
              title: stringSchema(),
              brief: stringSchema(),
              after: ids,
              by: { type: "string", enum: canHelp ? ["self", "subagent"] : ["self"] },
            },
            "id",
            "brief",
          ),
        },
      },
      "tasks",
    ),
    run: async (p) => {
      let problems: string[] = [];
      const g = await store.change((g) => {
        const [next, bad] = engine.add(g, p.tasks ?? []);
        problems = bad;
        return next;
      });
      if (problems.length > 0) return "没收：" + problems.join("；") + "\n\n" + engine.text(g);
      changed();
      return engine.text(g);
    },
  });
  const update = textTool<{
    id: string;
    state?: engine.State;
    result?: string;
    brief?: string;
    after?: string[];
  }>({
    name: "task_update",
    description:
      "改一件任务：做完了 state 写 done、result 写结果（改了什么、结论、关键的数字）；做不成写 failed 和原因；不用做了写 skipped。" +
      "没做的可以改 brief 和 after；没做成的改了 brief 再把 state 写回 waiting 重来。全部做完，这张图就收起来了。",
    parameters: objectSchema(
      {
        id: stringSchema(),
        state: { type: "string", enum: ["done", "failed", "skipped", "waiting"] },
        result: stringSchema(),
        brief: stringSchema(),
        after: ids,
      },
      "id",
    ),
    run: async (p) => {
      const c: engine.Change = {
        ...(p.state != null ? { state: p.state } : {}),
        ...(p.result != null ? { result: p.result } : {}),
        ...(p.brief != null ? { brief: p.brief } : {}),
        ...(p.after != null ? { after: p.after } : {}),
      };
      const g = await store.change((g) => engine.update(g, p.id, c));
      if (engine.finished(g)) return engine.text(g) + "\n\n都做完了，这张图收起来了。";
      changed();
      return engine.text(g);
    },
  });
  const list = textTool<object>({
    name: "task_graph",
    description: "看现在的任务：每件在等、可以做、做完还是没做成，要等谁，结果的开头。",
    parameters: objectSchema(),
    run: async () => engine.text(await store.load()),
  });
  return [task, update, list];
}

export class AgentTaskRunner {
  /** The subagents out now, by task id. */
  private readonly out = new Map<string, AbortController>();
  private readonly running = new Set<Promise<void>>();
  /** The graph as last reminded of, and how many times running it stayed so. */
  private nudged = "";
  private nudges = 0;

  constructor(
    private readonly store: AgentTaskStore,
    /** Undefined: this agent cannot send subagents (a subagent itself, or the orchestrator). */
    private readonly subagent: Subagent | undefined,
    private readonly life: AbortSignal,
    private readonly tell: (text: string) => void,
    private readonly max = 3,
    private readonly maxNudges = 3,
  ) {}

  /** Sends out what is ready and fits. Called after the graph changes and when a subagent comes back. */
  async advance() {
    if (!this.subagent || this.life.aborted) return;
    let picked: engine.AgentTask[] = [];
    try {
      await this.store.change((g) => {
        picked = [];
        let room = this.max - this.out.size;
        let next = g;
        for (const t of engine.readyTasks(g)) {
          if (room <= 0) break;
          if (t.by !== "subagent" || this.out.has(t.id)) continue;
          next = engine.begin(next, t.id);
          picked.push(t);
          room--;
        }
        return picked.length === 0 ? undefined : next;
      });
    } catch (e) {
      console.error("agent: cannot move its tasks:", e);
      return;
    }
    for (const t of picked) {
      const c = new AbortController();
      this.out.set(t.id, c);
      const p = this.send(c, t).finally(() => this.running.delete(p));
      this.running.add(p);
    }
  }

  private async send(c: AbortController, t: engine.AgentTask) {
    const stop = () => c.abort();
    this.life.addEventListener("abort", stop);
    let said = "";
    let failed = false;
    try {
      said = await this.subagent!(t.brief, t.title, c.signal);
    } catch (e) {
      said = e instanceof Error ? e.message : String(e);
      failed = true;
    } finally {
      this.life.removeEventListener("abort", stop);
      this.out.delete(t.id);
    }
    // Stopped: stop puts it back to waiting.
    if (c.signal.aborted) return;
    let g: engine.AgentTask[];
    try {
      g = await this.store.change((g) => engine.settle(g, t.id, said, failed));
    } catch (e) {
      console.error(`agent: cannot record task ${t.id}:`, e);
      return;
    }
    const state = g.find((x) => x.id === t.id)?.state ?? "failed";
    if (state === "done") this.tell("〔任务〕" + t.id + "（" + t.title + "）帮手做完了：\n" + said.trim() + "\n\n" + engine.text(g));
    else if (state === "failed")
      this.tell(
        "〔任务〕" + t.id + "（" + t.title + "）帮手没做成：" + head(said, 400) + "\n改了 brief 把它写回 waiting 重来，或者标 skipped。\n\n" + engine.text(g),
      );
    await this.advance();
  }

  /** Calls the subagents back; their tasks wait again. The graph stays as it is otherwise. */
  async stop() {
    const ids = [...this.out.keys()];
    for (const c of this.out.values()) c.abort();
    this.out.clear();
    await this.settled();
    if (ids.length === 0) return;
    try {
      await this.store.change((g) => engine.requeue(g, ids));
    } catch (e) {
      console.error("agent: cannot put stopped tasks back:", e);
    }
  }

  /** Every subagent out has come back. */
  async settled() {
    while (this.running.size > 0) await Promise.allSettled(this.running);
  }

  /** At start: a task left working by a process that went is waiting again, and goes out once more. */
  async recover() {
    try {
      await this.store.change((g) => {
        const next = engine.requeue(g);
        return engine.states(next).join() === engine.states(g).join() ? undefined : next;
      });
    } catch (e) {
      console.error("agent: cannot read its tasks:", e);
      return;
    }
    await this.advance();
  }

  /** The open graph for a fold's summary: what the turns it replaces showed. */
  async summary(): Promise<string> {
    try {
      const g = await this.store.load();
      return g.length === 0 ? "" : "【整理对话时的任务，以 tasks 为准】\n" + engine.text(g);
    } catch {
      return "";
    }
  }

  /** What to remind a run that stopped of: its own tasks that are ready, unless the graph has not moved through
   * maxNudges reminders already (it is stuck; the owner or another input will move it). "" for nothing. */
  async nudge(): Promise<string> {
    let g: engine.AgentTask[];
    try {
      g = await this.store.load();
    } catch {
      return "";
    }
    const own = engine
      .readyTasks(g)
      .filter((t) => t.by === "self")
      .map((t) => t.id);
    if (own.length === 0) {
      this.nudged = "";
      this.nudges = 0;
      return "";
    }
    const seen = engine.text(g);
    if (seen !== this.nudged) {
      this.nudged = seen;
      this.nudges = 0;
    }
    if (this.nudges >= this.maxNudges) return "";
    this.nudges++;
    return `〔任务〕这一轮停了，还有 ${own.length} 件你可以做：${own.join("、")}。接着做；做不了的用 task_update 标 failed 或 skipped，写明原因。\n\n${seen}`;
  }
}
