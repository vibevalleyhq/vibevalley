import { failedMessage, type Llm, LlmError } from "@vibevalley/ai/llm";
import type { AssistantMessage, Context, ImageContent, Message, TextContent, ToolCall, ToolResultMessage } from "@vibevalley/ai/messages";
import { zeroUsage } from "@vibevalley/ai/messages";
import type { Model, ThinkingLevel } from "@vibevalley/ai/models";
import type { AssistantMessageEvent } from "@vibevalley/ai/response";
import { type JsonSchema, toolArguments } from "@vibevalley/ai/tools";
import { abortable, type Clock, isAbort, mapConcurrent, systemClock, TaskGroup } from "@vibevalley/async";

import { isRecord } from "../base/json.ts";
import { AgentBusy, CannotContinue, messageOf, ToolFailed } from "./errors.ts";

type Ended = { readonly _tag: "ended"; readonly message: AssistantMessage } | { readonly _tag: "failed"; readonly failure: LlmError };

export interface ToolResult {
  readonly content: readonly (TextContent | ImageContent)[];
  readonly isError?: boolean;
  /** Ends the run after the turn when every tool call in the batch sets `terminate: true`. */
  readonly terminate?: boolean;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  /** A ToolFailed it throws is the failed result the model reads; anything else it throws ends the run as failed. The
   * signal aborts when the run is stopped. */
  readonly execute: (args: unknown, call: { readonly id: string }, signal?: AbortSignal) => Promise<ToolResult>;
}

export type AgentMessage<A> = Message | A;

export type AgentEvent<A> =
  | { readonly type: "agent_start" }
  | { readonly type: "agent_end"; readonly messages: readonly AgentMessage<A>[] }
  | { readonly type: "turn_start" }
  | { readonly type: "turn_end"; readonly message: AssistantMessage; readonly toolResults: readonly ToolResultMessage[] }
  | { readonly type: "message_start" | "message_end"; readonly message: AgentMessage<A> }
  | { readonly type: "message_update"; readonly message: AssistantMessage; readonly assistantMessageEvent: AssistantMessageEvent }
  | { readonly type: "tool_execution_start"; readonly toolCallId: string; readonly toolName: string; readonly args: unknown }
  | {
      readonly type: "tool_execution_end";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly result: ToolResult;
      readonly isError: boolean;
      readonly durationMs?: number;
    };

export interface Turn<A> {
  readonly message: AssistantMessage;
  readonly toolResults: readonly ToolResultMessage[];
  readonly messages: readonly AgentMessage<A>[];
  readonly stopped: boolean;
}

export interface AgentOptions<A> {
  readonly llm: Llm;
  readonly model: Model;
  readonly thinkingLevel?: ThinkingLevel;
  readonly tools: readonly Tool[];
  /** Maximum tool calls executed concurrently within one turn; 8 when absent. */
  readonly toolConcurrency?: number;
  readonly messages: readonly AgentMessage<A>[];
  /** Asked before each request, so a key changed meanwhile is used at once. */
  readonly apiKey: () => string;
  readonly toLlm: (messages: readonly AgentMessage<A>[]) => Context;
  /** The signal aborts when the run is stopped: the run does not wait for it then. */
  readonly prepareRequest?: (messages: readonly AgentMessage<A>[], stopped: boolean, signal: AbortSignal) => Promise<readonly AgentMessage<A>[] | undefined>;
  /** `"end"` stops the run; `"continue"` forces another turn even with no tool calls. */
  readonly finishTurn?: (turn: Turn<A>) => "end" | "continue" | undefined | Promise<"end" | "continue" | undefined>;
  /** Each event is awaited before the run goes on. */
  readonly onEvent: (event: AgentEvent<A>) => void | Promise<void>;
  readonly stoppedText: string;
  /** Timestamps and durations. Default: the system clock. */
  readonly clock?: Clock;
}

export interface Agent<A> {
  /** Starts a run with these messages; the agent must be idle (else AgentBusy). Resolves once the run has started. */
  readonly prompt: (messages: readonly AgentMessage<A>[]) => Promise<void>;
  /** AgentBusy, or CannotContinue when there is nothing to go on from. */
  readonly continue: () => Promise<void>;
  readonly steer: (message: AgentMessage<A>) => Promise<void>;
  /** Taken when the run would stop, one at a time. */
  readonly followUp: (message: AgentMessage<A>) => Promise<void>;
  readonly clearQueues: () => Promise<void>;
  readonly hasQueued: () => Promise<boolean>;
  readonly abort: () => Promise<void>;
  /** Settles once no run is under way. */
  readonly idle: () => Promise<void>;
  readonly running: () => Promise<boolean>;
  readonly messages: () => readonly AgentMessage<A>[];
  readonly setMessages: (messages: readonly AgentMessage<A>[]) => void;
  /** Stops a run under way and waits for it to end. */
  readonly close: () => Promise<void>;
}

const errorResult = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const truncated = (name: string) =>
  `Tool call "${name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`;
const operationAborted = "Operation aborted";
const defaultToolConcurrency = 8;

interface Run {
  readonly stop: AbortController;
  /** Resolves when stop aborts. */
  readonly stopped: Promise<void>;
  readonly done: Promise<void>;
}

/** The source's values until the signal aborts: then it ends at once, though the source may not have answered yet. */
async function* untilAborted<A>(source: AsyncIterable<A>, signal: AbortSignal): AsyncGenerator<A> {
  const it = source[Symbol.asyncIterator]();
  let finished = false;
  try {
    while (!signal.aborted) {
      const r = await abortable(it.next(), signal);
      if (r.done === true) {
        finished = true;
        return;
      }
      yield r.value;
    }
  } finally {
    // An async generator's return waits for the step it is on; the source was given the signal, so it ends soon after.
    if (!finished) void it.return?.().then(undefined, () => undefined);
  }
}

export const make = <A>(options: AgentOptions<A>): Agent<A> => {
  const clock = options.clock ?? systemClock;
  const tasks = new TaskGroup({ name: "agent loop" });
  let messages: readonly AgentMessage<A>[] = options.messages;
  let steering: readonly AgentMessage<A>[] = [];
  let followUps: readonly AgentMessage<A>[] = [];
  let active: Run | undefined;
  const reasoning = options.thinkingLevel && options.thinkingLevel !== "off" ? options.thinkingLevel : undefined;

  const takeOneFollowUp = () => {
    const taken = followUps.slice(0, 1);
    followUps = followUps.slice(1);
    return taken;
  };
  const takeAllSteering = () => {
    const taken = steering;
    steering = [];
    return taken;
  };

  const emit = async (event: AgentEvent<A>) => {
    if (event.type === "message_end") messages = [...messages, event.message];
    await options.onEvent(event);
  };

  const answer = async (asked: readonly AgentMessage<A>[], run: Run): Promise<AssistantMessage> => {
    const stop = run.stop.signal;
    const started = clock.now();
    const thinkingLevel = reasoning ?? "off";
    const finished = (m: AssistantMessage): AssistantMessage => ({ ...m, thinkingLevel, durationMs: clock.now() - started });
    let partial: AssistantMessage | undefined;
    let end: Ended | undefined;
    const told = options.llm.stream(options.model, options.toLlm(asked), { apiKey: options.apiKey(), ...(reasoning ? { reasoning } : {}) }, stop);
    // A failure of the stream is kept as its end, so the partial output that came before it stays.
    try {
      for await (const e of untilAborted(told, stop)) {
        switch (e.type) {
          case "start":
            await options.onEvent({ type: "message_start", message: e.partial });
            partial = e.partial;
            break;
          case "done":
            end = { _tag: "ended", message: finished(e.message) };
            break;
          case "error":
            end = { _tag: "ended", message: finished(e.error) };
            break;
          default:
            await options.onEvent({ type: "message_update", assistantMessageEvent: e, message: e.partial });
            partial = e.partial;
        }
      }
    } catch (e) {
      if (e instanceof LlmError) end ??= { _tag: "failed", failure: e };
      else if (!isAbort(e, stop) && !stop.aborted) throw e;
    }
    const base = partial ?? {
      role: "assistant" as const,
      content: [],
      api: options.model.api,
      provider: options.model.provider,
      model: options.model.id,
      usage: zeroUsage(),
      stopReason: "error" as const,
      timestamp: started,
    };
    const ended =
      end?._tag === "ended"
        ? end.message
        : finished(
            end?._tag === "failed"
              ? failedMessage(options.model, started, end.failure)
              : { ...base, stopReason: "aborted", errorMessage: "Request was aborted" },
          );
    if (partial === undefined) await options.onEvent({ type: "message_start", message: ended });
    await emit({ type: "message_end", message: ended });
    return ended;
  };

  const toolResultMessage = (call: ToolCall, result: ToolResult, isError: boolean, durationMs?: number): ToolResultMessage => ({
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: result.content,
    isError,
    ...(durationMs === undefined ? {} : { durationMs }),
    timestamp: clock.now(),
  });

  const ended = (call: ToolCall, result: ToolResult, isError: boolean, durationMs?: number) =>
    options.onEvent({
      type: "tool_execution_end",
      toolCallId: call.id,
      toolName: call.name,
      result,
      isError,
      ...(durationMs === undefined ? {} : { durationMs }),
    });

  interface Outcome {
    readonly call: ToolCall;
    readonly result: ToolResult;
    readonly isError: boolean;
    readonly durationMs?: number;
  }

  /** Validates arguments sequentially, executes valid calls concurrently, and emits results in call order. */
  const runTools = async (calls: readonly ToolCall[], run: Run) => {
    const stop = run.stop.signal;
    const entries: (Outcome | (() => Promise<Outcome>))[] = [];
    for (const call of calls) {
      await options.onEvent({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
      const tool = options.tools.find((t) => t.name === call.name);
      const read = tool
        ? call.argumentsError
          ? { refused: `Invalid arguments for tool "${call.name}": ${call.argumentsError}` }
          : toolArguments(call.name, call.arguments, tool.parameters)
        : { refused: `Tool ${call.name} not found` };
      if ("refused" in read) {
        const outcome: Outcome = { call, result: errorResult(read.refused), isError: true };
        await ended(call, outcome.result, true);
        entries.push(outcome);
        if (stop.aborted) break;
        continue;
      }
      if (stop.aborted) {
        const outcome: Outcome = { call, result: errorResult(operationAborted), isError: true };
        await ended(call, outcome.result, true);
        entries.push(outcome);
        break;
      }
      if (!tool) continue;
      const args = read.ok;
      entries.push(async () => {
        if (stop.aborted) {
          const outcome: Outcome = { call, result: errorResult(operationAborted), isError: true };
          await ended(call, outcome.result, true);
          return outcome;
        }
        const started = clock.now();
        const cutOff = { result: errorResult(options.stoppedText), isError: true };
        // The stop wins over whatever the tool does after it: the tool is told by its signal and not waited for.
        const ran = await Promise.race([
          tool.execute(args, { id: call.id }, stop).then(
            (r) => (stop.aborted ? cutOff : { result: r, isError: r.isError === true }),
            (e: unknown) => {
              if (stop.aborted) return cutOff;
              if (e instanceof ToolFailed) return { result: errorResult(e.message), isError: true };
              throw e;
            },
          ),
          run.stopped.then(() => cutOff),
        ]);
        const outcome: Outcome = { call, ...ran, durationMs: clock.now() - started };
        await ended(call, outcome.result, outcome.isError, outcome.durationMs);
        return outcome;
      });
      if (stop.aborted) break;
    }
    const outcomes = await mapConcurrent(entries, options.toolConcurrency ?? defaultToolConcurrency, (e) =>
      typeof e === "function" ? e() : Promise.resolve(e),
    );
    const results: ToolResultMessage[] = [];
    for (const o of outcomes) {
      const m = toolResultMessage(o.call, o.result, o.isError, o.durationMs);
      await options.onEvent({ type: "message_start", message: m });
      await emit({ type: "message_end", message: m });
      results.push(m);
    }
    return { results, terminate: outcomes.length > 0 && outcomes.every((o) => o.result.terminate === true) };
  };

  const refuseTruncated = async (calls: readonly ToolCall[]) => {
    const results: ToolResultMessage[] = [];
    for (const call of calls) {
      await options.onEvent({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
      const result = errorResult(truncated(call.name));
      await ended(call, result, true);
      const m = toolResultMessage(call, result, true);
      await options.onEvent({ type: "message_start", message: m });
      await emit({ type: "message_end", message: m });
      results.push(m);
    }
    return { results, terminate: false };
  };

  const loop = async (context: AgentMessage<A>[], fresh: AgentMessage<A>[], run: Run, steered: boolean) => {
    const stop = run.stop.signal;
    let asked: readonly AgentMessage<A>[] = context;
    // Skip draining `steering` on the first turn when `continue` already consumed it to open the run.
    let pending = steered ? [] : takeAllSteering();
    let first = true;
    let continuing = false;
    outer: while (true) {
      let more = true;
      // oxlint-disable-next-line oxc/no-accumulating-spread -- immutable message snapshot passed to prepareRequest/toLlm each turn
      while (more || pending.length > 0) {
        if (!first) {
          if (pending.length === 0) pending = takeAllSteering();
          await options.onEvent({ type: "turn_start" });
        }
        first = false;
        for (const m of pending) {
          await options.onEvent({ type: "message_start", message: m });
          await emit({ type: "message_end", message: m });
          fresh.push(m);
        }
        asked = [...asked, ...pending];
        pending = [];
        if (options.prepareRequest) {
          const prepared = await Promise.race([options.prepareRequest(asked, stop.aborted, stop), run.stopped.then(() => undefined)]);
          if (prepared) asked = prepared;
        }
        const message = await answer(asked, run);
        asked = [...asked, message];
        fresh.push(message);
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          await options.finishTurn?.({ message, toolResults: [], messages: asked, stopped: stop.aborted });
          await options.onEvent({ type: "turn_end", message, toolResults: [] });
          return;
        }
        const calls = message.content.filter((c): c is ToolCall => c.type === "toolCall");
        let results: readonly ToolResultMessage[] = [];
        more = false;
        if (calls.length > 0) {
          const batch = message.stopReason === "length" ? await refuseTruncated(calls) : await runTools(calls, run);
          results = batch.results;
          more = !batch.terminate;
          asked = [...asked, ...results];
          fresh.push(...results);
        }
        const decision = options.finishTurn ? await options.finishTurn({ message, toolResults: results, messages: asked, stopped: stop.aborted }) : undefined;
        await options.onEvent({ type: "turn_end", message, toolResults: results });
        if (decision === "end") return;
        continuing = decision === "continue";
        pending = takeAllSteering();
        if (more || pending.length > 0) continuing = false;
      }
      const later = takeOneFollowUp();
      if (later.length > 0) {
        continuing = false;
        pending = later;
        first = false;
        continue outer;
      }
      if (continuing) {
        continuing = false;
        first = false;
        continue outer;
      }
      break;
    }
  };

  const start = async (prompts: readonly AgentMessage<A>[], steered = false): Promise<void> => {
    if (active !== undefined) throw new AgentBusy("the agent is already running");
    const stop = new AbortController();
    const done = Promise.withResolvers<void>();
    const run: Run = {
      stop,
      stopped: new Promise<void>((resolve) => stop.signal.addEventListener("abort", () => resolve(), { once: true })),
      done: done.promise,
    };
    active = run;
    const body = async () => {
      try {
        const context = [...messages];
        const fresh: AgentMessage<A>[] = [...prompts];
        await options.onEvent({ type: "agent_start" });
        await options.onEvent({ type: "turn_start" });
        for (const m of prompts) {
          await options.onEvent({ type: "message_start", message: m });
          await emit({ type: "message_end", message: m });
        }
        await loop([...context, ...prompts], fresh, run, steered);
        await options.onEvent({ type: "agent_end", messages: fresh });
      } catch (e) {
        const failure: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text: "" }],
          api: options.model.api,
          provider: options.model.provider,
          model: options.model.id,
          usage: zeroUsage(),
          stopReason: stop.signal.aborted ? "aborted" : "error",
          errorMessage: messageOf(e),
          timestamp: clock.now(),
        };
        await options.onEvent({ type: "message_start", message: failure });
        await emit({ type: "message_end", message: failure });
        await options.onEvent({ type: "turn_end", message: failure, toolResults: [] });
        await options.onEvent({ type: "agent_end", messages: [failure] });
      } finally {
        active = undefined;
        done.resolve();
      }
    };
    tasks.run("run", async (signal) => {
      // Closing the agent stops its run the way abort does.
      const onClose = () => stop.abort();
      signal.addEventListener("abort", onClose, { once: true });
      try {
        await body();
      } finally {
        signal.removeEventListener("abort", onClose);
      }
    });
  };

  return {
    prompt: (m) => start(m),
    continue: async () => {
      const last: unknown = messages.at(-1);
      if (last === undefined) throw new CannotContinue("No messages to continue from");
      if (isRecord(last) && last.role === "assistant") {
        const steered = takeAllSteering();
        if (steered.length > 0) return start(steered, true);
        const later = takeOneFollowUp();
        if (later.length > 0) return start(later);
        throw new CannotContinue("Cannot continue from message role: assistant");
      }
      return start([]);
    },
    steer: async (m) => {
      steering = [...steering, m];
    },
    followUp: async (m) => {
      followUps = [...followUps, m];
    },
    clearQueues: async () => {
      steering = [];
      followUps = [];
    },
    hasQueued: async () => steering.length > 0 || followUps.length > 0,
    abort: async () => {
      active?.stop.abort();
    },
    idle: () => active?.done ?? Promise.resolve(),
    running: async () => active !== undefined,
    messages: () => messages,
    setMessages: (all) => {
      messages = all;
    },
    close: () => tasks.close(),
  };
};
