import { join } from "node:path";

import { defineRuntime, type McpServer as OarMcpServer, type SessionOptions, type TurnOutcome, UnsupportedOptionError } from "@botiverse/oar";
import { createSessionKernel, inputImagesRefusal, sealSession, withdrawHeld } from "@botiverse/oar/kernel";
import { z } from "zod";

import { type BrainEvent, makeBrain } from "@vibevalley/agent/brain";
import { codingTools } from "@vibevalley/agent/coding";
import { ToolFailed, toolFailed } from "@vibevalley/agent/core/errors";
import type { McpServer } from "@vibevalley/agent/mcp";
import { messageText, userMessage } from "@vibevalley/agent/messages";
import { finished, type Todo } from "@vibevalley/agent/todo";
import type { TodoStore } from "@vibevalley/agent/todoStore";
import { defaultModel, type ModelClient } from "@vibevalley/ai/client";
import { models } from "@vibevalley/ai/models";
import type { Clock, TaskGroup } from "@vibevalley/async";
import { homeOf } from "@vibevalley/home";
import { t } from "@vibevalley/i18n";
import { isOneOf } from "@vibevalley/protocol/rules";

import { messageOf } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import { storedJsonOrUndefined } from "#/base/json.ts";
import type { Db } from "#/infra/db.ts";
import type { Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import * as q from "#db/runtime_todo.sql.ts";

import { helperInstructions } from "./prompts.ts";

const vibevalleyRuntime = "vibevalley";

/** DeepSeek's two. */
const efforts = ["high", "max"] as const;

export { helperInstructions };

export interface RuntimeOptions {
  /** $VIBEVALLEY_HOME, else ~/.vibevalley, when absent. */
  readonly home?: () => string;
  /** Asked each session, so a key saved meanwhile is used. "" is the default model. */
  readonly llm: (model: string) => ModelClient;
  /** Where a session keeps its own todos; absent, it keeps none. */
  readonly todos?: (session: string) => TodoStore;
  /** The sessions' clock: the Runtime service's, or the wall clock on the command line. */
  readonly time: Time;
  /** The caller's tasks: each session's reader of its brain's events runs there, and closing them closes the brain. */
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

export function vibevalleyRuntimeOf(options: RuntimeOptions) {
  const home = options.home ?? (() => homeOf());
  const llmOf = options.llm;

  const start = async (_installation: unknown, o: SessionOptions) => {
    // oar's refusableOrder, for these two.
    for (const option of ["serviceTier", "launchArgs"] as const)
      if (o[option] !== undefined) throw new UnsupportedOptionError(option, t(`server.agent.refused.${option}`));
    const effort = o.effort && isOneOf(efforts, o.effort) ? o.effort : undefined;
    if (o.effort && !effort)
      throw new Error(t("server.agent.efforts", { runtime: vibevalleyRuntime, efforts: efforts.join(t("server.agent.effortsAnd")), asked: o.effort }));
    const llm = llmOf(o.model ?? "");
    const kernel = createSessionKernel(o.resume);
    const instructions = o.systemPrompt ?? [helperInstructions(), ...(o.appendSystemPrompt ? [o.appendSystemPrompt] : [])].join("\n\n");
    const todos = options.todos?.(kernel.sessionId);
    const { owner, log } = options;
    const agent = await makeBrain({
      name: "helper",
      instructions,
      llm,
      ...(effort ? { thinkingLevel: effort } : {}),
      home: join(home(), "helpers"),
      cwd: o.cwd,
      clock: options.time,
      log,
      tools: codingTools({ cwd: o.cwd, clock: options.time, ...(o.env ? { env: { ...o.env } } : {}) }),
      ...(o.disallowedTools ? { disallowedTools: o.disallowedTools } : {}),
      mcpServers: (o.mcpServers ?? []).map(toMcp),
      noMemory: true,
      session: kernel.sessionId,
      reminders: false,
      ...(todos ? { todos } : {}),
    });
    // Listening before the first input: the subscription keeps what comes until the reader takes it.
    const events = agent.events();
    try {
      // A session started as the server closes would have no reader to close its brain.
      if (owner.closed) throw new Error("vibevalley runtime: the server is closing");
      const queued: { input: string; inputId?: string }[] = [];
      const background = (what: string, p: Promise<void>) => void p.catch((e: unknown) => log.warn(`vibevalley runtime: ${what} failed`, e));
      let active = false;
      let disposed = false;
      const frame = (type: string, native: unknown, events: Parameters<typeof kernel.frame>[0]["events"] = []) => kernel.frame({ type, native, events });
      const begin = (input: string) => {
        active = true;
        background("a prompt", agent.send(userMessage(input, options.time.now())));
      };
      const end = (outcome: TurnOutcome) => {
        if (!active) return;
        active = false;
        const progress = agent.progress();
        const window = llm.model.contextWindow;
        const tokens = progress.current.contextTokens;
        frame("vibevalley/end", { outcome }, [
          { kind: "turn_ended", outcome },
          {
            kind: "usage",
            usage: {
              tokens: {
                input: progress.lifetime.input,
                output: progress.lifetime.output,
                cacheRead: progress.lifetime.cacheRead,
                cacheWrite: progress.lifetime.cacheWrite,
              },
              context: {
                tokens,
                contextWindow: window,
                percent: window > 0 ? (tokens / window) * 100 : 0,
              },
            },
          },
        ]);
        const next = queued.shift();
        if (next && !disposed) begin(next.input);
      };
      // Listening before the first input.
      const onBrainEvent = (e: BrainEvent) => {
        if (disposed) return;
        switch (e.type) {
          case "message_update": {
            const d = e.assistantMessageEvent;
            if (d.type === "text_delta") frame("vibevalley/text", { text: d.delta }, [{ kind: "text_delta", text: d.delta }]);
            if (d.type === "thinking_end" && d.content)
              frame("vibevalley/reasoning", { text: d.content }, [{ kind: "reasoning", content: { kind: "text", text: d.content } }]);
            break;
          }
          case "tool_execution_start": {
            const input = JSON.stringify(e.args ?? {});
            frame("vibevalley/tool_start", { callId: e.toolCallId, name: e.toolName, input }, [
              { kind: "tool_call_started", callId: e.toolCallId, tool: e.toolName, input },
            ]);
            break;
          }
          case "tool_execution_end": {
            const text = messageText({ role: "toolResult", toolCallId: "", toolName: "", content: e.result.content, isError: false, timestamp: 0 });
            const result = e.isError ? "failed" : "ok";
            frame("vibevalley/tool_end", { callId: e.toolCallId, output: text, result }, [
              {
                kind: "tool_call_ended",
                callId: e.toolCallId,
                result,
                content: [{ type: "text", text }],
              },
            ]);
            break;
          }
          case "compaction_start":
            frame("vibevalley/compaction", { phase: "start" }, [{ kind: "compaction_started", trigger: e.reason }]);
            break;
          case "compaction_end":
            frame("vibevalley/compaction", { phase: "end" }, [
              {
                kind: "compaction_ended",
                outcome: e.compaction ? "completed" : "failed",
                trigger: e.reason,
              },
            ]);
            break;
          case "todos_changed":
            // oar has no event for a todo: the graph goes in the raw record, where the session's trajectory keeps it.
            frame("vibevalley/todos", { todos: e.todos });
            break;
          case "agent_settled":
            end(
              e.run.aborted
                ? { kind: "aborted" }
                : e.run.failed
                  ? { kind: "failed", failure: "unknown", reason: e.run.error || t("server.agent.modelFailed") }
                  : { kind: "completed" },
            );
            break;
          default:
            break;
        }
      };
      // The reader drains the brain's events to the end (agent_closed), so the last usage is told before oar exits; the
      // owner closing closes the brain, which ends them.
      const reader = owner.spawn("vibevalley session events", async (signal) => {
        const closeOnAbort = () => background("closing a brain", agent.close());
        signal.addEventListener("abort", closeOnAbort, { once: true });
        try {
          for (;;) {
            const next = await events.next();
            if (next.done === true) return;
            onBrainEvent(next.value);
          }
        } finally {
          signal.removeEventListener("abort", closeOnAbort);
          events.close();
        }
      });
      let closing: Promise<void> | undefined;
      frame("vibevalley/model", { model: llm.model.id }, [{ kind: "model", model: llm.model.id }]);
      if (o.effort) frame("vibevalley/effort", { effort: o.effort }, [{ kind: "effort", effort: o.effort }]);

      const capabilities = { queue: { durable: false }, attribution: "none", images: false } as const;
      return sealSession({
        id: kernel.sessionId,
        capabilities,
        prompt: (input, inputOptions) =>
          kernel.control({ kind: "prompt", input, ...inputOptions }, () => {
            if (active) return { kind: "rejected", code: "busy", reason: "busy" };
            const refused = inputImagesRefusal(capabilities, inputOptions?.images);
            if (refused !== null) return refused;
            begin(input);
            return { kind: "accepted" };
          }),
        steer: (input, inputOptions) =>
          kernel.control({ kind: "steer", input, ...inputOptions }, () => {
            if (!active) return { kind: "rejected", code: "no_active_turn", reason: "no active turn" };
            const refused = inputImagesRefusal(capabilities, inputOptions?.images);
            if (refused !== null) return refused;
            background("a steer", agent.send(userMessage(input, options.time.now())));
            return { kind: "accepted" };
          }),
        queue: (input, inputOptions) =>
          kernel.control({ kind: "queue", input, ...inputOptions }, () => {
            const refused = inputImagesRefusal(capabilities, inputOptions?.images);
            if (refused !== null) return refused;
            if (active)
              queued.push({
                input,
                ...(inputOptions?.inputId ? { inputId: inputOptions.inputId } : {}),
              });
            else begin(input);
            return { kind: "accepted" };
          }),
        // The turn-end drain takes its entry off before running it, so an entry still here was never sent.
        withdraw: (inputId) => kernel.control({ kind: "withdraw", inputId }, () => withdrawHeld(queued, inputId)),
        abort: () =>
          kernel.control({ kind: "abort" }, () => {
            if (!active) return { kind: "rejected", code: "no_active_turn", reason: "no active turn" };
            // The turn ends aborted when the agent has stopped (agent_settled).
            background("a stop", agent.stop());
            return { kind: "accepted" };
          }),
        rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
        records: () => kernel.records(),
        graph: () => kernel.graph(),
        dispose: () =>
          (closing ??= (async () => {
            const request = kernel.request("toRuntime", { kind: "dispose" });
            queued.length = 0;
            await agent.stop();
            try {
              await agent.close();
              await reader.done;
            } finally {
              events.close();
            }
            disposed = true;
            end({ kind: "aborted" });
            kernel.respond(request.id, { kind: "exited", code: 0 });
          })()),
      });
    } catch (cause) {
      events.close();
      await agent.close();
      throw cause;
    }
  };

  const runtime = defineRuntime({
    id: vibevalleyRuntime,
    session: start,
    installation: async () => {
      try {
        llmOf("");
        return { kind: "available", via: "bundled" };
      } catch (e) {
        return { kind: "unsupported", reason: messageOf(e) };
      }
    },
    listModels: async () => ({
      kind: "ok",
      models: models.map((m) => ({
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
