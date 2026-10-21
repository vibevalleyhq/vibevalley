// VibeValley's own agent as an oar runtime, built on oar's runtime-author SPI the way oar's scripted runtime is: one turn
// is one run of the agent until it settles.

import { defineRuntime, type McpServer as OarMcpServer, type SessionOptions, type TurnOutcome, UnsupportedOptionError } from "@botiverse/oar";
import { createSessionKernel, inputImagesRefusal, sealSession, withdrawHeld } from "@botiverse/oar/kernel";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { homedir } from "node:os";
import { join } from "node:path";
import { models } from "../../ai/models.ts";
import type { TaskStore } from "./taskStore.ts";
import { Brain, type BrainEvent } from "./agent.ts";
import { codingTools } from "./coding.ts";
import { deepseek, defaultModel, type LLM, type McpServer } from "./config.ts";
import { messageText, userMessage } from "./messages.ts";

export const vibevalleyRuntime = "vibevalley";

/** DeepSeek's two. */
export const efforts = ["high", "max"] as const;

export const helperInstructions = `你是一个编码 agent，在主人电脑上的一个项目目录里干活：读写代码、跑命令、查资料。
- 先弄清楚再动手：读相关的文件，看清现状；改完跑能跑的检查（lint、类型检查、测试）确认。
- 能自己查到的不问；真正要拿主意的才问，一次问清。
- 几件互不相干、各自要花工夫的事，用 spawn_agent 派帮手同时做。
- 回答用中文，简短，先说结论。`;

export interface RuntimeOptions {
  /** $VIBEVALLEY_HOME, else ~/.vibevalley, when absent. */
  readonly home?: () => string;
  /** Asked each session, so a key saved meanwhile is used; "" is the default model. Throws when there is no model to use. */
  readonly llm?: (model: string) => LLM;
  /** Where a session keeps its task graph; absent, it keeps none. */
  readonly tasks?: (session: string) => TaskStore;
}

const defaultHome = () => process.env.VIBEVALLEY_HOME || join(homedir(), ".vibevalley");

const toMcp = (s: OarMcpServer): McpServer =>
  "url" in s
    ? { name: s.name, url: s.url, ...(s.headers ? { headers: { ...s.headers } } : {}) }
    : { name: s.name, command: s.command, ...(s.args ? { args: [...s.args] } : {}), ...(s.env ? { env: { ...s.env } } : {}) };

const refusedOptions = {
  launchArgs: "VibeValley 跑在 server 进程里，没有命令行参数",
  serviceTier: "DeepSeek 没有服务档位",
} as const;

export function vibevalleyRuntimeOf(options: RuntimeOptions = {}) {
  const home = options.home ?? defaultHome;
  const llmOf = options.llm ?? ((model: string) => deepseek(model, process.env.DEEPSEEK_API_KEY ?? ""));

  const start = async (_installation: unknown, o: SessionOptions) => {
    // oar's refusableOrder, for these two.
    for (const option of ["serviceTier", "launchArgs"] as const) if (o[option] !== undefined) throw new UnsupportedOptionError(option, refusedOptions[option]);
    if (o.effort && !(efforts as readonly string[]).includes(o.effort))
      throw new Error(`${vibevalleyRuntime} 只有 ${efforts.join("、")} 两档思考强度，没有「${o.effort}」`);
    const llm = llmOf(o.model ?? "");
    const kernel = createSessionKernel(o.resume);
    const instructions = o.systemPrompt ?? [helperInstructions, ...(o.appendSystemPrompt ? [o.appendSystemPrompt] : [])].join("\n\n");
    const tasks = options.tasks?.(kernel.sessionId);
    const agent = await Brain.start({
      name: "worker",
      instructions,
      llm,
      ...(o.effort ? { thinkingLevel: o.effort as ThinkingLevel } : {}),
      home: join(home(), "workers"),
      cwd: o.cwd,
      tools: codingTools({ cwd: o.cwd, ...(o.env ? { env: { ...o.env } } : {}) }),
      ...(o.disallowedTools ? { disallowedTools: o.disallowedTools } : {}),
      mcpServers: (o.mcpServers ?? []).map(toMcp),
      noMemory: true,
      session: kernel.sessionId,
      schedules: false,
      ...(tasks ? { tasks } : {}),
    });
    const queued: { input: string; inputId?: string }[] = [];
    let active = false;
    let disposed = false;
    const frame = (type: string, native: unknown, events: Parameters<typeof kernel.frame>[0]["events"] = []) => kernel.frame({ type, native, events });
    const begin = (input: string) => {
      active = true;
      agent.send(userMessage(input));
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
            context: { tokens, contextWindow: window, percent: window > 0 ? (tokens / window) * 100 : 0 },
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
          const text = messageText({ role: "toolResult", toolCallId: "", toolName: "", content: e.result?.content ?? [], isError: false, timestamp: 0 });
          const result = e.isError ? "failed" : "ok";
          frame("vibevalley/tool_end", { callId: e.toolCallId, output: text, result }, [
            { kind: "tool_call_ended", callId: e.toolCallId, result, content: [{ type: "text", text }] },
          ]);
          break;
        }
        case "compaction_start":
          frame("vibevalley/compaction", { phase: "start" }, [{ kind: "compaction_started", trigger: e.reason }]);
          break;
        case "compaction_end":
          frame("vibevalley/compaction", { phase: "end" }, [{ kind: "compaction_ended", outcome: e.compaction ? "completed" : "failed", trigger: e.reason }]);
          break;
        case "tasks_changed":
          // oar has no event for a task: the graph goes in the raw record, where the session's trajectory keeps it.
          frame("vibevalley/tasks", { tasks: e.tasks });
          break;
        case "agent_settled":
          end(e.run.aborted ? { kind: "aborted" } : e.run.error ? { kind: "failed", failure: "unknown", reason: e.run.error } : { kind: "completed" });
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
          agent.send(userMessage(input));
          return { kind: "accepted" };
        }),
      queue: (input, inputOptions) =>
        kernel.control({ kind: "queue", input, ...inputOptions }, () => {
          const refused = inputImagesRefusal(capabilities, inputOptions?.images);
          if (refused !== null) return refused;
          if (active) queued.push({ input, ...(inputOptions?.inputId ? { inputId: inputOptions.inputId } : {}) });
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

  return defineRuntime({
    id: vibevalleyRuntime,
    session: start,
    refusedSessionOptions: refusedOptions,
    installation: async () => {
      try {
        llmOf("");
        return { kind: "available", via: "bundled" };
      } catch (e) {
        return { kind: "unsupported", reason: e instanceof Error ? e.message : String(e) };
      }
    },
    listModels: async () => ({
      kind: "ok",
      models: models.map((m) => ({ id: m.id, displayName: m.name, effortLevels: [...efforts], ...(m.id === defaultModel ? { default: true as const } : {}) })),
    }),
  });
}
