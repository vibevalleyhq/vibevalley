// VibeValley's own agent as an oar runtime, built on oar's runtime-author SPI the way oar's scripted runtime is: one turn
// is one run of the agent until it settles.

import { homedir } from "node:os";
import { join } from "node:path";

import { defineRuntime, type McpServer as OarMcpServer, type SessionOptions, type TurnOutcome, UnsupportedOptionError } from "@botiverse/oar";
import { createSessionKernel, inputImagesRefusal, sealSession, withdrawHeld } from "@botiverse/oar/kernel";

import type { AgentTaskStore } from "@vibevalley/agent/agentTaskStore";
import { type BrainEvent, type BrainOwner, openBrain } from "@vibevalley/agent/brain";
import { codingTools } from "@vibevalley/agent/coding";
import type { McpServer } from "@vibevalley/agent/mcp";
import { messageText, userMessage } from "@vibevalley/agent/messages";
import { defaultModel, type ModelClient } from "@vibevalley/ai/client";
import { models } from "@vibevalley/ai/models";
import { t } from "@vibevalley/i18n";
import { isOneOf } from "@vibevalley/protocol/rules";

import type { Time } from "@/base/time.ts";
import { messageOf } from "@/errors.ts";

import { helperInstructions } from "./prompts.ts";

export const vibevalleyRuntime = "vibevalley";

/** DeepSeek's two. */
export const efforts = ["high", "max"] as const;

export { helperInstructions };

export interface RuntimeOptions {
  /** $VIBEVALLEY_HOME, else ~/.vibevalley, when absent. */
  readonly home?: () => string;
  /** Asked each session, so a key saved meanwhile is used; "" is the default model. Throws when there is no model to use. */
  readonly llm: (model: string) => ModelClient;
  /** Where a session keeps its own tasks; absent, it keeps none. */
  readonly tasks?: (session: string) => AgentTaskStore;
  /** The sessions' clock: the Runtimes service's, or the wall clock on the command line. */
  readonly time: Time;
  /** Where the sessions' brains run: the Runtimes service's fibers and scope, or standaloneOwner on the command line. */
  readonly owner: BrainOwner;
}

const defaultHome = () => process.env.VIBEVALLEY_HOME || join(homedir(), ".vibevalley");

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
  const home = options.home ?? defaultHome;
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
    const tasks = options.tasks?.(kernel.sessionId);
    const agent = await openBrain(options.owner, {
      name: "helper",
      instructions,
      llm,
      ...(effort ? { thinkingLevel: effort } : {}),
      home: join(home(), "helpers"),
      cwd: o.cwd,
      tools: codingTools({ cwd: o.cwd, ...(o.env ? { env: { ...o.env } } : {}) }),
      ...(o.disallowedTools ? { disallowedTools: o.disallowedTools } : {}),
      mcpServers: (o.mcpServers ?? []).map(toMcp),
      noMemory: true,
      session: kernel.sessionId,
      reminders: false,
      ...(tasks ? { tasks } : {}),
    });
    const queued: { input: string; inputId?: string }[] = [];
    let active = false;
    let disposed = false;
    const frame = (type: string, native: unknown, events: Parameters<typeof kernel.frame>[0]["events"] = []) => kernel.frame({ type, native, events });
    const begin = (input: string) => {
      active = true;
      void agent.send(userMessage(input, options.time.now()));
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
    agent.subscribe((e: BrainEvent) => {
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
        case "tasks_changed":
          // oar has no event for a task: the graph goes in the raw record, where the session's trajectory keeps it.
          frame("vibevalley/tasks", { tasks: e.tasks });
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
    });
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
          void agent.send(userMessage(input, options.time.now()));
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
          void agent.stop();
          return { kind: "accepted" };
        }),
      rawEvents: (observer, cursor) => kernel.rawEvents(observer, cursor),
      records: () => kernel.records(),
      graph: () => kernel.graph(),
      dispose: async () => {
        if (disposed) return;
        const request = kernel.request("toRuntime", { kind: "dispose" });
        queued.length = 0;
        await agent.stop();
        await agent.close();
        disposed = true;
        end({ kind: "aborted" });
        kernel.respond(request.id, { kind: "exited", code: 0 });
      },
    });
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
