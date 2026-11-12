import type { Context } from "@earendil-works/chord/context";
import {
  AgentDoc,
  configure,
  defineDoc,
  defineExtension,
  defineTool,
  type Extension,
  type PromptInput,
  section,
  type ToolExecutionApi,
  type ToolRegistration,
  type Tx,
  type ConversationId,
} from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { z } from "zod";

import type { Tool } from "@vibevalley/agent/core/tool";
import type { MemoryPort } from "@vibevalley/agent/memory";
import { selfTools, subagentInstructions, subagentTool } from "@vibevalley/agent/self";
import { defaultSkillDirs, scanSkills, skillIndex } from "@vibevalley/agent/skills";
import { finished, type Todo } from "@vibevalley/agent/todo";
import { memoryStore, type TodoStore } from "@vibevalley/agent/todoStore";
import { todoTools, watchedStore } from "@vibevalley/agent/todoTools";

import type { Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";

import { durableTool, entryMessage, messageText } from "./durable.ts";
import { helperWords } from "./prompts.ts";

/** The one extension every helper conversation selects, by this name. */
const helperExtensionName = "vibevalley.helper";

/** A command the model gives no time limit ends after it: two minutes, as the agent's own bash always had. */
const commandTimeoutSeconds = 120;

/** What a helper conversation runs with beyond its agent (model, working directory): kept with it, so a run the harness
 * goes on with before its session opens again has its prompt and tools as they were. */
interface HelperSpec {
  [key: string]: string | Record<string, string | null>;
  /** The oar session it is the conversation of: whose todos it keeps. */
  session: string;
  instructions: string;
  /** The session's variables over the server's environment; null takes one away. */
  env: Record<string, string | null>;
}

const HelperDoc = defineDoc<HelperSpec>({
  kind: "vibevalley.helper",
  version: 1,
  scope: "conversation",
  history: "latest",
  // A spawned helper's conversation is made, not forked: spawn_agent copies the spec itself.
  fork: "current",
  initial: () => ({ session: "", instructions: "", env: {} }),
  checkpointWhen: () => true,
});

export interface HelpersDeps {
  /** Where a session keeps its own todos; absent, it keeps none. */
  readonly todos?: (session: string) => TodoStore;
  /** What the agent remembers, with the tools to add to it; absent, it remembers nothing. */
  readonly memory?: MemoryPort;
  readonly time: Time;
  readonly log: Logger;
}

/** The helpers' side of a harness: their extension, installed before anything runs, and what an open session adds. */
export interface Helpers {
  readonly extension: Extension;
  /** Writes what conversation id runs with, in the commit that makes or configures it. */
  readonly keep: (
    tx: Tx,
    id: ConversationId,
    spec: { readonly session: string; readonly instructions: string; readonly env: Readonly<Record<string, string | null>> },
  ) => Promise<void>;
  /** Tells told each change of session's todos while it is open; the function returned stops. */
  readonly watch: (session: string, told: (todos: Todo[]) => void) => () => void;
}

/** The environment a command runs with: the server's, with the session's variables over it (null takes one away). */
function commandEnv(env: Readonly<Record<string, string | null>> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) out[k] = v;
  for (const [k, v] of Object.entries(env)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

const SpawnArgs = z.object({ brief: z.string(), label: z.exactOptional(z.string()) });

export function makeHelpers(deps: HelpersDeps): Helpers {
  const watchers = new Map<string, Set<(todos: Todo[]) => void>>();
  const specOf = async (read: Pick<ToolExecutionApi, "snapshot">, id: ConversationId, context: Context) => read.snapshot(HelperDoc, id, context);
  const cwdOf = async (api: ToolExecutionApi, context: Context) => (await api.agent(context)).cwd ?? "";

  // pi-durable's read, write and edit, in the conversation's working directory (the harness's env); bash with the
  // session's variables and a time limit when the model gives none.
  const bash = createBashTool({
    prepare: async (execution, api, context) => {
      execution.env = commandEnv((await specOf(api, api.conversationId, context))?.env);
      execution.inheritEnv = false;
    },
  });
  const timed: typeof bash = {
    ...bash,
    execute: (args, api, called) => bash.execute({ ...args, timeout: args.timeout ?? commandTimeoutSeconds }, api, called),
  };

  /** One of our tools whose doing is the calling conversation's own: declared once, made for each call. */
  const perCall = (declared: Tool, make: (api: ToolExecutionApi, context: Context) => Promise<readonly Tool[]>): ToolRegistration => ({
    ...durableTool(declared),
    execute: async (args, api, context) => {
      const tool = (await make(api, context)).find((t) => t.name === declared.name);
      if (!tool) throw new Error(`${declared.name}: this conversation has no such tool`);
      return durableTool(tool).execute(args, api, context);
    },
  });

  const ownTools = (cwd: string) =>
    selfTools({ now: () => deps.time.now(), home: cwd, skills: () => scanSkills(defaultSkillDirs(cwd)), memory: deps.memory ?? false, log: deps.log });
  const todosOf = (session: string): Tool[] => {
    const store = deps.todos?.(session);
    if (!store) return [];
    // oar has no event for a todo: an open session puts the graph in its raw record, where its trajectory keeps it.
    const told = (g: Todo[]) => {
      for (const f of watchers.get(session) ?? []) f(finished(g) ? [] : g);
    };
    return todoTools(watchedStore(store, told), async () => {});
  };

  const spawnAgent = (): ToolRegistration => {
    const shape = subagentTool(async () => "");
    const tool: ToolRegistration = defineTool({
      name: shape.name,
      description: shape.description,
      parameters: shape.parameters,
      replay: "safe",
      // A child conversation the call owns: it starts as a copy of the helper, without spawn_agent, and its answer is
      // the result. A restart finds the same child and the same input again.
      execute: async (args, api, called) => {
        const p = SpawnArgs.parse(args);
        const label = p.label ?? [...p.brief].slice(0, 20).join("");
        if (!p.brief.trim()) return { output: [{ type: "text", text: helperWords.emptyBrief }], isError: true };
        const parent = await api.snapshot(AgentDoc, api.conversationId, called);
        const spec = await specOf(api, api.conversationId, called);
        const removed = new Set([tool.name, ...(parent?.tools !== undefined && !Array.isArray(parent.tools) ? parent.tools.remove : [])]);
        const child = await api.commit(async (tx) => {
          const had = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
          if (had !== undefined) return had.id;
          const made = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
          const remove = api.registry
            .tools()
            .map((t) => t.tool)
            .filter((t) => removed.has(t.name));
          await configure(tx, made.id, { tools: { remove }, instructions: subagentInstructions("helper") });
          if (spec) Object.assign(await tx.doc(HelperDoc, made.id), structuredClone(spec));
          return made.id;
        }, called);
        const handle = await api.conversation(child, called);
        if (!handle) throw new Error(`spawn_agent: its conversation ${child} is gone`);
        const settled = await (await handle.submit({ type: "input", content: p.brief, requestId: `spawn:${api.taskId}` }, called)).wait(called);
        if (settled.status !== "done" || settled.answer === undefined)
          return { output: [{ type: "text", text: helperWords.noAnswer(label, settled.reason ?? settled.status) }], isError: true };
        const answer = settled.answer;
        const entry = await api.commit((tx) => tx.entry(answer), called);
        const said = entry === undefined ? undefined : entryMessage(entry);
        const text = said?.role === "assistant" ? messageText(said).trim() : "";
        return { output: [{ type: "text", text: text || helperWords.noAnswer(label, "") }], ...(text ? {} : { isError: true }) };
      },
    });
    return tool;
  };

  const promptCwd = (input: PromptInput) => input.agent.cwd ?? "";
  const memory = deps.memory;
  const extension = defineExtension({
    name: helperExtensionName,
    tools: [
      createReadTool(),
      createWriteTool(),
      createEditTool(),
      timed,
      ...(deps.todos ? todoTools(memoryStore(), async () => {}) : []).map((declared) =>
        perCall(declared, async (api, context) => todosOf((await specOf(api, api.conversationId, context))?.session ?? "")),
      ),
      ...ownTools("").map((declared) => perCall(declared, async (api, context) => ownTools(await cwdOf(api, context)))),
      spawnAgent(),
    ],
    sections: [
      section("helper", async (input, context) => (await specOf(input.read, input.conversationId, context))?.instructions.trim() || undefined, { tag: false }),
      section("env", (input) => helperWords.env(promptCwd(input)), { tag: false }),
      section(
        "skills",
        async (input) => {
          const found = await scanSkills(defaultSkillDirs(promptCwd(input)));
          return found.length > 0 ? helperWords.skills(skillIndex(found)) : undefined;
        },
        { tag: false },
      ),
      ...(memory
        ? [
            section(
              "memory",
              async () => {
                const read = await memory.read();
                return read.prompt ? helperWords.memory(read.prompt) : undefined;
              },
              { tag: false },
            ),
          ]
        : []),
    ],
  });

  return {
    extension,
    keep: async (tx, id, spec) => {
      Object.assign(await tx.doc(HelperDoc, id), { session: spec.session, instructions: spec.instructions, env: { ...spec.env } });
    },
    watch: (session, told) => {
      const set = watchers.get(session) ?? new Set();
      set.add(told);
      watchers.set(session, set);
      return () => {
        set.delete(told);
        if (set.size === 0) watchers.delete(session);
      };
    },
  };
}
