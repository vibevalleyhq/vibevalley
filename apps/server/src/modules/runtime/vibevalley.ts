import { defineRuntime, type McpServer as OarMcpServer, type SessionOptions, type TurnOutcome, UnsupportedOptionError } from "@botiverse/oar";
import { createSessionKernel, inputImagesRefusal, sealSession, withdrawHeld } from "@botiverse/oar/kernel";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  configure,
  ConversationBusy,
  ConversationIdle,
  type ConversationView,
  defineExtension,
  defineTool,
  type EntryId,
  type EntryRecord,
  section,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { z } from "zod";

import { ToolFailed, toolFailed } from "@vibevalley/agent/core/errors";
import { connectAll, type McpServer } from "@vibevalley/agent/mcp";
import type { MemoryPort } from "@vibevalley/agent/memory";
import { messageText } from "@vibevalley/agent/messages";
import { selfTools, subagentInstructions, subagentTool } from "@vibevalley/agent/self";
import { defaultSkillDirs, scanSkills, skillIndex } from "@vibevalley/agent/skills";
import { finished, type Todo } from "@vibevalley/agent/todo";
import type { TodoStore } from "@vibevalley/agent/todoStore";
import { todoTools, watchedStore } from "@vibevalley/agent/todoTools";
import type { AssistantMessage, ToolResultMessage } from "@vibevalley/ai/messages";
import { abortable, type Clock, isAbort, type TaskGroup } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import { isOneOf } from "@vibevalley/protocol/rules";

import { newId } from "#/base/ids.ts";
import { storedJsonOrUndefined } from "#/base/json.ts";
import type { Db } from "#/infra/db.ts";
import type { Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import * as q from "#db/runtime_todo.sql.ts";

import { deepseekModels, defaultModel, type Durable, durableTool, entryMessage } from "./durable.ts";
import { helperInstructions, helperWords } from "./prompts.ts";

const vibevalleyRuntime = "vibevalley";

/** DeepSeek's two. */
const efforts = ["high", "max"] as const;

/** A command the model gives no time limit ends after it: two minutes, as the agent's own bash always had. */
const commandTimeoutSeconds = 120;
/** The tool rounds one turn takes at most, as the agent's own loop had. */
const maxTurns = 40;

const context = BACKGROUND_CONTEXT;

export { helperInstructions };

/** The conversation an oar session of this runtime is kept as, in the harness. */
export const helperKey = (session: string) => `helper:${session}`;

export interface RuntimeOptions {
  /** The harness the sessions' conversations are kept in, and the model they ask. */
  readonly durable: Durable;
  /** Where a session keeps its own todos; absent, it keeps none. */
  readonly todos?: (session: string) => TodoStore;
  /** What the agent remembers, with the tools to add to it; absent, it remembers nothing. */
  readonly memory?: MemoryPort;
  /** The sessions' clock: the Runtime service's, or the wall clock on the command line. */
  readonly time: Time;
  /** The caller's tasks: closing them stops each session's turn and lets the session go. */
  readonly owner: TaskGroup;
  /** Where a send or a stop that fails in the background is said. */
  readonly log: Logger;
}

const toMcp = (s: OarMcpServer): McpServer =>
  "url" in s
    ? { name: s.name, url: s.url, ...(s.headers ? { headers: { ...s.headers } } : {}) }
    : {
        name: s.name,
        command: s.command,
        ...(s.args ? { args: [...s.args] } : {}),
        ...(s.env ? { env: { ...s.env } } : {}),
      };

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

/** pi-durable's read, write, edit and bash, in the conversation's working directory; bash with the session's variables
 * and a time limit when the model gives none. */
function codingTools(env: Readonly<Record<string, string | null>> | undefined): ToolRegistration[] {
  const vars = commandEnv(env);
  const bash = createBashTool({
    prepare: (execution) => {
      execution.env = { ...vars };
      execution.inheritEnv = false;
    },
  });
  const timed: typeof bash = {
    ...bash,
    execute: (args, api, called) => bash.execute({ ...args, timeout: args.timeout ?? commandTimeoutSeconds }, api, called),
  };
  return [createReadTool(), createWriteTool(), createEditTool(), timed];
}

const SpawnArgs = z.object({ brief: z.string(), label: z.exactOptional(z.string()) });

/** spawn_agent as a child conversation the call owns: it starts as a copy of the helper, without spawn_agent, and its
 * answer is the result. A restart finds the same child and the same input again. */
function spawnAgentTool(): ToolRegistration {
  const shape = subagentTool(async () => "");
  const tool: ToolRegistration = defineTool({
    name: shape.name,
    description: shape.description,
    parameters: shape.parameters,
    replay: "safe",
    execute: async (args, api, called) => {
      const p = SpawnArgs.parse(args);
      const label = p.label ?? [...p.brief].slice(0, 20).join("");
      if (!p.brief.trim()) return { output: [{ type: "text", text: helperWords.emptyBrief }], isError: true };
      const child = await api.commit(async (tx) => {
        const had = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
        if (had !== undefined) return had.id;
        const made = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
        await configure(tx, made.id, { tools: { remove: [tool] }, instructions: subagentInstructions("helper") });
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
}

/** As much of pi.live as a session follows. */
const LiveView = z.object({
  run: z.exactOptional(z.object({})),
  generation: z.exactOptional(
    z.object({ message: z.exactOptional(z.object({ content: z.array(z.object({ type: z.string(), text: z.exactOptional(z.string()) })) })) }),
  ),
  runFailure: z.exactOptional(z.object({ reason: z.string(), detail: z.exactOptional(z.string()) })),
  compactions: z.exactOptional(z.array(z.object({ trigger: z.string() }))),
});
type LiveView = z.infer<typeof LiveView>;

const Tokens = z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number() });
type Tokens = z.infer<typeof Tokens>;
const UsageView = z.object({ models: z.record(z.string(), Tokens), tools: z.record(z.string(), Tokens) });

const noTokens: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
/** What the conversation spent, its own and its tools'. */
const spent = (view: ConversationView): Tokens => {
  const raw = view.docs["pi.usage"];
  if (raw === undefined) return noTokens;
  const usage = UsageView.parse(raw);
  return [...Object.values(usage.models), ...Object.values(usage.tools)].reduce(
    (a, b) => ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite }),
    noTokens,
  );
};

/** The newest request's context, as the agent's own loop counted it. */
const contextOf = (m: AssistantMessage) => m.usage.input + m.usage.cacheRead + m.usage.output;

export function vibevalleyRuntimeOf(options: RuntimeOptions) {
  const { durable, owner, log } = options;

  const start = async (_installation: unknown, o: SessionOptions) => {
    // oar's refusableOrder, for these two.
    for (const option of ["serviceTier", "launchArgs"] as const)
      if (o[option] !== undefined) throw new UnsupportedOptionError(option, t(`server.agent.refused.${option}`));
    const effort = o.effort && isOneOf(efforts, o.effort) ? o.effort : undefined;
    if (o.effort && !effort)
      throw new Error(t("server.agent.efforts", { runtime: vibevalleyRuntime, efforts: efforts.join(t("server.agent.effortsAnd")), asked: o.effort }));
    const cannot = durable.cannotAsk();
    if (cannot !== undefined) throw new Error(cannot);
    const model = durable.model(o.model ?? "");
    const kernel = createSessionKernel(o.resume);
    const key = helperKey(kernel.sessionId);
    const instructions = o.systemPrompt ?? [helperInstructions(), ...(o.appendSystemPrompt ? [o.appendSystemPrompt] : [])].join("\n\n");
    // A session started as the server closes would have no one to let it go.
    if (owner.closed) throw new Error("vibevalley runtime: the server is closing");
    const frame = (type: string, native: unknown, events: Parameters<typeof kernel.frame>[0]["events"] = []) => kernel.frame({ type, native, events });

    const mcp = await connectAll((o.mcpServers ?? []).map(toMcp), log);
    for (const why of mcp.failed) log.warn(`vibevalley runtime: an MCP server of ${kernel.sessionId} did not connect: ${why}`);
    try {
      const store = options.todos?.(kernel.sessionId);
      // oar has no event for a todo: the graph goes in the raw record, where the session's trajectory keeps it.
      const todos = store
        ? todoTools(
            watchedStore(store, (g) => frame("vibevalley/todos", { todos: finished(g) ? [] : g })),
            false,
            async () => {},
          )
        : [];
      const skills = () => scanSkills(defaultSkillDirs(o.cwd));
      const own = selfTools({ now: () => options.time.now(), home: o.cwd, skills, memory: options.memory ?? false, log }).filter(
        (s) => s.name !== "search_archive",
      );
      const disallowed = new Set(o.disallowedTools ?? []);
      const tools = [...codingTools(o.env), ...[...mcp.tools, ...todos, ...own].map(durableTool), spawnAgentTool()].filter((s) => !disallowed.has(s.name));
      const memory = options.memory;
      const extension = defineExtension({
        name: `vibevalley.${key}`,
        tools,
        sections: [
          section("helper", () => instructions.trim() || undefined, { tag: false }),
          section("env", () => helperWords.env(o.cwd), { tag: false }),
          section(
            "skills",
            async () => {
              const found = await skills();
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
      durable.registry.install(extension);
      const conversation = await durable.conversation(key, {
        model: model.ref,
        extensions: [extension],
        // DeepSeek's own two: pi-ai sends high and max as themselves.
        thinkingLevel: effort ?? "off",
        cwd: o.cwd,
        maxTurns,
      });
      const watch = await conversation.watch(context);

      /** A turn this session tells of is under way: from the input it took (or the run it found going) to the run's end. */
      let active = false;
      /** The turn's input, or its run, has been seen in the conversation: the run's end, when it comes, ends the turn. */
      let placed = false;
      /** The turn's newest answer. */
      let last: AssistantMessage | undefined;
      /** The newest answer of the session, whose request is the context's size. */
      let newest: AssistantMessage | undefined;
      /** How much of the answer being written was told. */
      let shown = 0;
      let compacting = false;
      let disposed = false;
      let seen: EntryId | undefined = watch.value.entries.at(-1)?.id;
      const baseline = spent(watch.value);
      let total = baseline;
      const queued: { input: string; inputId?: string }[] = [];
      const background = (what: string, p: Promise<unknown>) => void p.catch((e: unknown) => log.warn(`vibevalley runtime: ${what} failed`, e));

      const end = (outcome: TurnOutcome) => {
        if (!active) return;
        active = false;
        placed = false;
        last = undefined;
        shown = 0;
        const window = model.contextWindow;
        const tokens = newest ? contextOf(newest) : 0;
        frame("vibevalley/end", { outcome }, [
          { kind: "turn_ended", outcome },
          {
            kind: "usage",
            usage: {
              tokens: {
                input: total.input - baseline.input,
                output: total.output - baseline.output,
                cacheRead: total.cacheRead - baseline.cacheRead,
                cacheWrite: total.cacheWrite - baseline.cacheWrite,
              },
              context: { tokens, contextWindow: window, percent: window > 0 ? (tokens / window) * 100 : 0 },
            },
          },
        ]);
        const next = queued.shift();
        if (next && !disposed) background("a queued input", begin(next.input));
      };

      const outcomeOf = (live: LiveView): TurnOutcome => {
        const failure = live.runFailure;
        if (failure?.reason === "aborted" || last?.stopReason === "aborted") return { kind: "aborted" };
        if (failure !== undefined || last?.stopReason === "error")
          return { kind: "failed", failure: "unknown", reason: last?.errorMessage || failure?.detail || failure?.reason || t("server.agent.modelFailed") };
        return { kind: "completed" };
      };

      const tell = (text: string) => {
        if (text.length <= shown) return;
        const delta = text.slice(shown);
        shown = text.length;
        frame("vibevalley/text", { text: delta }, [{ kind: "text_delta", text: delta }]);
      };

      const answered = (m: AssistantMessage) => {
        last = m;
        newest = m;
        for (const c of m.content)
          if (c.type === "thinking" && c.thinking)
            frame("vibevalley/reasoning", { text: c.thinking }, [{ kind: "reasoning", content: { kind: "text", text: c.thinking } }]);
        tell(m.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join(""));
        shown = 0;
        for (const c of m.content) {
          if (c.type !== "toolCall") continue;
          const input = JSON.stringify(c.arguments);
          frame("vibevalley/tool_start", { callId: c.id, name: c.name, input }, [{ kind: "tool_call_started", callId: c.id, tool: c.name, input }]);
        }
      };

      const toolEnded = (r: ToolResultMessage) => {
        const text = messageText(r);
        const result = r.isError ? "failed" : "ok";
        frame("vibevalley/tool_end", { callId: r.toolCallId, output: text, result }, [
          { kind: "tool_call_ended", callId: r.toolCallId, result, content: [{ type: "text", text }] },
        ]);
      };

      /** The entries after the newest taken, oldest first: those the window holds, and those it dropped before them. */
      const fresh = async (view: ConversationView): Promise<EntryRecord[]> => {
        const after = (e: EntryRecord) => seen === undefined || e.id > seen;
        const missed =
          view.before !== undefined && seen !== undefined && view.before > seen
            ? (await conversation.entries({ order: "ascending", minEntryId: seen, maxEntryId: view.before }, 10_000, undefined, context)).items
            : [];
        return [...missed, ...view.entries].filter(after);
      };

      const follow = async (view: ConversationView) => {
        if (disposed) return;
        const live = LiveView.parse(view.docs["pi.live"] ?? {});
        total = spent(view);
        const entries = await fresh(view);
        for (const [i, e] of entries.entries()) {
          seen = e.id;
          switch (e.kind) {
            case "pi.user":
              placed = true;
              break;
            case "pi.assistant": {
              const m = entryMessage(e);
              if (m?.role !== "assistant") break;
              // A partial a restart cut off: the run asks the model again, and the answer that comes is the one told.
              const askedAgain = m.stopReason === "aborted" && (live.run !== undefined || entries.slice(i + 1).some((later) => later.kind === "pi.assistant"));
              if (askedAgain) shown = 0;
              else answered(m);
              break;
            }
            case "pi.tool-result": {
              const r = entryMessage(e);
              if (r?.role === "toolResult") toolEnded(r);
              break;
            }
            case "pi.compaction":
              if (!compacting) frame("vibevalley/compaction", { phase: "start" }, [{ kind: "compaction_started" }]);
              compacting = false;
              frame("vibevalley/compaction", { phase: "end" }, [{ kind: "compaction_ended", outcome: "completed" }]);
              break;
            default:
              break;
          }
        }
        const compaction = live.compactions?.[0];
        if (compaction && !compacting) {
          compacting = true;
          frame("vibevalley/compaction", { phase: "start" }, [{ kind: "compaction_started", trigger: compaction.trigger }]);
        } else if (!compaction && compacting) {
          compacting = false;
          frame("vibevalley/compaction", { phase: "end" }, [{ kind: "compaction_ended", outcome: "failed" }]);
        }
        if (live.run === undefined) {
          if (active && placed) end(outcomeOf(live));
          return;
        }
        // A run going on that this session did not start (one a restart cut off) is told as a turn too.
        active = true;
        placed = true;
        tell(live.generation?.message?.content.flatMap((c) => (c.type === "text" && c.text ? [c.text] : [])).join("") ?? "");
      };

      watch.start(async (call) => {
        if (call.kind !== "value") return;
        try {
          await follow(call.value);
        } catch (e) {
          log.error(`vibevalley runtime: ${kernel.sessionId} could not follow its conversation`, e);
        }
      });

      const begin = async (input: string): Promise<{ kind: "accepted" } | { kind: "rejected"; code: "busy"; reason: string }> => {
        active = true;
        placed = false;
        try {
          await conversation.submit({ type: "input", content: input, whenBusy: "reject" }, context);
          return { kind: "accepted" };
        } catch (e) {
          active = false;
          if (e instanceof ConversationBusy) return { kind: "rejected", code: "busy", reason: "busy" };
          throw e;
        }
      };

      const stop = async () => {
        await conversation.abort(context);
        // An input taken back before it was placed started no run: nothing else ends its turn.
        if (!placed) end({ kind: "aborted" });
      };

      const released = Promise.withResolvers<void>();
      let closing: Promise<void> | undefined;
      const dispose = () =>
        (closing ??= (async () => {
          const request = kernel.request("toRuntime", { kind: "dispose" });
          queued.length = 0;
          released.resolve();
          try {
            if (active) await conversation.abort(context);
          } catch (e) {
            log.warn(`vibevalley runtime: ${kernel.sessionId}'s turn was not stopped`, e);
          }
          await watch.stop();
          disposed = true;
          if (durable.registry.snapshot().extension(extension.name) === extension) durable.registry.uninstall(extension);
          await mcp.close();
          end({ kind: "aborted" });
          kernel.respond(request.id, { kind: "exited", code: 0 });
        })());
      // The owner closing (the server stopping) stops the turn and lets the session go.
      owner.run(`vibevalley session ${kernel.sessionId}`, async (signal) => {
        try {
          await abortable(released.promise, signal);
        } catch (e) {
          if (!isAbort(e, signal)) throw e;
          await dispose();
        }
      });

      frame("vibevalley/model", { model: model.ref.modelId }, [{ kind: "model", model: model.ref.modelId }]);
      if (o.effort) frame("vibevalley/effort", { effort: o.effort }, [{ kind: "effort", effort: o.effort }]);
      // A run a restart cut off goes on: the conversation is the one it was, and its turn is told as this session's.
      if (o.resume !== undefined && LiveView.parse(watch.value.docs["pi.live"] ?? {}).run !== undefined) durable.harness.resume();

      const capabilities = { queue: { durable: false }, attribution: "none", images: false } as const;
      return sealSession({
        id: kernel.sessionId,
        capabilities,
        prompt: (input, inputOptions) =>
          kernel.control({ kind: "prompt", input, ...inputOptions }, async () => {
            if (active) return { kind: "rejected", code: "busy", reason: "busy" };
            const refused = inputImagesRefusal(capabilities, inputOptions?.images);
            if (refused !== null) return refused;
            return begin(input);
          }),
        steer: (input, inputOptions) =>
          kernel.control({ kind: "steer", input, ...inputOptions }, async () => {
            if (!active) return { kind: "rejected", code: "no_active_turn", reason: "no active turn" };
            const refused = inputImagesRefusal(capabilities, inputOptions?.images);
            if (refused !== null) return refused;
            try {
              await conversation.submit({ type: "input", content: input, whenBusy: "steer", whenIdle: "reject" }, context);
            } catch (e) {
              if (e instanceof ConversationIdle) return { kind: "rejected", code: "no_active_turn", reason: "no active turn" };
              throw e;
            }
            return { kind: "accepted" };
          }),
        queue: (input, inputOptions) =>
          kernel.control({ kind: "queue", input, ...inputOptions }, async () => {
            const refused = inputImagesRefusal(capabilities, inputOptions?.images);
            if (refused !== null) return refused;
            if (!active) return begin(input);
            queued.push({ input, ...(inputOptions?.inputId ? { inputId: inputOptions.inputId } : {}) });
            return { kind: "accepted" };
          }),
        // The turn-end drain takes its entry off before sending it, so an entry still here was never sent.
        withdraw: (inputId) => kernel.control({ kind: "withdraw", inputId }, () => withdrawHeld(queued, inputId)),
        abort: () =>
          kernel.control({ kind: "abort" }, () => {
            if (!active) return { kind: "rejected", code: "no_active_turn", reason: "no active turn" };
            // The turn ends aborted when the run has stopped.
            background("a stop", stop());
            return { kind: "accepted" };
          }),
        rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
        records: () => kernel.records(),
        graph: () => kernel.graph(),
        dispose,
      });
    } catch (cause) {
      await mcp.close();
      throw cause;
    }
  };

  const runtime = defineRuntime({
    id: vibevalleyRuntime,
    session: start,
    installation: async () => {
      const cannot = durable.cannotAsk();
      return cannot === undefined ? { kind: "available", via: "bundled" } : { kind: "unsupported", reason: cannot };
    },
    listModels: async () => ({
      kind: "ok",
      models: deepseekModels.map((m) => ({
        id: m.id,
        displayName: m.name,
        effortLevels: [...efforts],
        ...(m.id === defaultModel ? { default: true as const } : {}),
      })),
    }),
  });
  // Read when shown, so the words follow the farm's language; defineRuntime copies its input, a getter there would be read once.
  Object.defineProperty(runtime, "refusedSessionOptions", {
    get: () => ({ launchArgs: t("server.agent.refused.launchArgs"), serviceTier: t("server.agent.refused.serviceTier") }),
    enumerable: true,
  });
  return runtime;
}

const afterOf = storedJsonOrUndefined(z.array(z.string()), "runtime_todo.after");
const fromRow = (r: q.OpenTodosResult): Todo => ({
  id: r.id,
  title: r.title,
  brief: r.brief,
  after: afterOf(r.after) ?? [],
  by: r.executor,
  state: r.state,
  ...(r.result ? { result: r.result } : {}),
  ...(r.tries !== 0 ? { tries: r.tries } : {}),
});

/** A finished graph stays, stamped finished_at: putting it away only empties the keeper's open graph. */
export const dbTodoStores =
  (deps: { readonly db: Db; readonly clock: Clock }) =>
  (keeper: string): TodoStore => {
    const { db, clock } = deps;
    return {
      load: async () => (await q.openTodos(db.sql, { keeper })).map(fromRow),
      change: async <G extends Todo[] | undefined>(f: (g: Todo[]) => G): Promise<G> => {
        try {
          return await db.tx(async () => {
            const rows = await q.openTodos(db.sql, { keeper });
            const g = f(rows.map(fromRow));
            if (g === undefined) return g;
            // The graph keeps its id while it is open; a new one starts when the keeper had none.
            const graph = rows[0]?.graph ?? newId();
            await q.clearOpenTodos(db.sql, { keeper });
            const at = clock.now();
            for (const [position, todo] of g.entries())
              await q.addTodo(db.sql, {
                graph,
                keeper,
                id: todo.id,
                position,
                title: todo.title,
                brief: todo.brief,
                after: JSON.stringify(todo.after),
                executor: todo.by,
                state: todo.state,
                result: todo.result ?? "",
                tries: todo.tries ?? 0,
                updated_at: at,
              });
            if (finished(g)) await q.finishTodos(db.sql, { finished_at: at, keeper });
            return g;
          });
        } catch (e) {
          throw e instanceof ToolFailed ? e : toolFailed(e);
        }
      },
    };
  };
