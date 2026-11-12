import {
  type Api,
  type ApiStreamOptions,
  type AssistantMessage as PiAssistantMessage,
  type AssistantMessageEvent as PiEvent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Model as PiModel,
  type Provider,
  type SimpleStreamOptions,
  type TranscriptContext,
  type Usage as PiUsage,
} from "@earendil-works/pi-ai";
import { z } from "zod";

import type { ModelClient } from "@vibevalley/ai/client";
import { failedMessage, LlmError } from "@vibevalley/ai/llm";
import {
  type AssistantMessage,
  AssistantMessageSchema,
  type Context,
  type Message,
  ToolResultMessageSchema,
  type Usage,
  UserMessageSchema,
  zeroUsage,
} from "@vibevalley/ai/messages";
import type { AssistantMessageEvent } from "@vibevalley/ai/response";
import { abortable, isAbort, TaskGroup } from "@vibevalley/async";

import { messageOf } from "#/base/errors.ts";
import type { Time } from "#/infra/time.ts";
import { noDeepSeekKey } from "#/modules/agent/agent.ts";
import { deepseekId, deepseekModels, type ModelAccess } from "#/modules/runtime/durable.ts";

/** DeepSeek as a test farm's harness asks it: pi-ai's DeepSeek models, answered by the scripted model the test seats
 * (packages/agent's scriptedLLM), whichever conversation asks. With none seated it is a farm without a key. */
export interface ScriptedDeepSeek extends AsyncDisposable {
  readonly models: ModelAccess;
  /** From now on, every request of every conversation is answered by llm. */
  readonly use: (llm: ModelClient) => void;
  readonly close: () => Promise<void>;
}

export function scriptedDeepSeek(clock: Time): ScriptedDeepSeek {
  const tasks = new TaskGroup({ name: "scripted DeepSeek" });
  let seated: ModelClient | undefined;

  const answer = async (out: AssistantMessageEventStream, model: PiModel<Api>, transcript: TranscriptContext, options: SimpleStreamOptions) => {
    const asked = clock.now();
    const failed = (why: string, stopReason: "error" | "aborted"): PiAssistantMessage => ({
      role: "assistant",
      content: [],
      api: model.api,
      provider: deepseekId,
      model: model.id,
      usage: piUsage(zeroUsage()),
      stopReason,
      errorMessage: why,
      timestamp: asked,
    });
    const client = seated;
    if (client === undefined) {
      out.push({ type: "error", reason: "error", error: failed(noDeepSeekKey(), "error") });
      out.end();
      return;
    }
    const reasoning = options.reasoning;
    try {
      const events = client.service.stream(
        client.model,
        requestOf(transcript),
        { apiKey: client.apiKey?.() ?? "", ...(reasoning ? { reasoning } : {}), ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }) },
        options.signal,
      );
      // A stream that takes no notice of the stop is let go of, not waited for: the run ends aborted at once.
      const reading = events[Symbol.asyncIterator]();
      for (let next = await abortable(reading.next(), options.signal); next.done !== true; next = await abortable(reading.next(), options.signal)) {
        out.push(piEvent(next.value));
        if (next.value.type === "done" || next.value.type === "error") {
          out.end();
          return;
        }
      }
      // A stream that ends without its last event says nothing more: the answer it gave is over, stopped or failed.
      if (options.signal?.aborted === true) out.push({ type: "error", reason: "aborted", error: failed(messageOf(options.signal.reason), "aborted") });
      else out.push({ type: "error", reason: "error", error: failed("the model's answer ended without its end", "error") });
    } catch (e) {
      if (e instanceof LlmError) out.push({ type: "error", reason: "error", error: piMessage(failedMessage(client.model, asked, e)) });
      else if (isAbort(e, options.signal)) out.push({ type: "error", reason: "aborted", error: failed(messageOf(e), "aborted") });
      else out.push({ type: "error", reason: "error", error: failed(messageOf(e), "error") });
    }
    out.end();
  };

  const stream = (model: PiModel<Api>, transcript: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream => {
    const out = createAssistantMessageEventStream();
    tasks.run("a scripted answer", () => answer(out, model, transcript, options ?? {}));
    return out;
  };

  const provider: Provider = {
    id: deepseekId,
    name: "DeepSeek (scripted)",
    auth: { apiKey: { name: "scripted", resolve: async () => ({ auth: {} }) } },
    getModels: () => deepseekModels,
    // A request without the simple options: only how it stops and how long it may answer carry over.
    stream: <A extends Api>(model: PiModel<A>, transcript: TranscriptContext, options?: ApiStreamOptions<A>) =>
      stream(model, transcript, {
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
        ...(options?.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      }),
    streamSimple: stream,
  };

  const close = () => tasks.close();
  return {
    models: { provider, cannotAsk: () => (seated === undefined ? noDeepSeekKey() : undefined) },
    use: (llm) => {
      seated = llm;
    },
    close,
    [Symbol.asyncDispose]: close,
  };
}

/** What pi-durable asks, as packages/ai's request: the replayed prompt and tools lead, the rest in order. */
function requestOf(transcript: TranscriptContext): Context {
  const messages: Message[] = [];
  for (const m of transcript.messages) {
    switch (m.role) {
      case "system":
        break;
      case "user":
        messages.push(UserMessageSchema.parse(m));
        break;
      case "assistant":
        messages.push(AssistantMessageSchema.parse(m));
        break;
      case "toolResult":
        messages.push(ToolResultMessageSchema.parse(m));
        break;
    }
  }
  const tools = getCurrentTools(transcript.messages).map((t) => ({ name: t.name, description: t.description, parameters: JsonObject.parse(t.parameters) }));
  return { system: getCurrentSystemPrompt(transcript.messages), tools, messages };
}

const JsonObject = z.record(z.string(), z.json());

const piUsage = (u: Usage): PiUsage => ({
  input: u.input,
  output: u.output,
  cacheRead: u.cacheRead,
  cacheWrite: u.cacheWrite,
  ...(u.reasoning === undefined ? {} : { reasoning: u.reasoning }),
  totalTokens: u.totalTokens,
  cost: { ...u.cost },
});

function piMessage(m: AssistantMessage): PiAssistantMessage {
  return {
    role: "assistant",
    content: m.content.map((c) => {
      switch (c.type) {
        case "text":
          return { type: "text", text: c.text };
        case "thinking":
          return { type: "thinking", thinking: c.thinking, ...(c.thinkingSignature === undefined ? {} : { thinkingSignature: c.thinkingSignature }) };
        case "toolCall":
          return {
            type: "toolCall",
            id: c.id,
            name: c.name,
            arguments: JsonObject.parse(c.arguments),
            ...(c.argumentsError === undefined ? {} : { argumentsError: c.argumentsError }),
          };
      }
    }),
    api: m.api,
    provider: m.provider,
    model: m.model,
    usage: piUsage(m.usage),
    stopReason: m.stopReason,
    timestamp: m.timestamp,
    ...(m.responseId === undefined ? {} : { responseId: m.responseId }),
    ...(m.responseModel === undefined ? {} : { responseModel: m.responseModel }),
    ...(m.rawStopReason === undefined ? {} : { rawStopReason: m.rawStopReason }),
    ...(m.errorMessage === undefined ? {} : { errorMessage: m.errorMessage }),
    ...(m.durationMs === undefined ? {} : { durationMs: m.durationMs }),
  };
}

function piEvent(e: AssistantMessageEvent): PiEvent {
  switch (e.type) {
    case "start":
      return { type: "start", partial: piMessage(e.partial) };
    case "text_start":
    case "thinking_start":
    case "toolcall_start":
      return { type: e.type, contentIndex: e.contentIndex, partial: piMessage(e.partial) };
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta":
      return { type: e.type, contentIndex: e.contentIndex, delta: e.delta, partial: piMessage(e.partial) };
    case "text_end":
    case "thinking_end":
      return { type: e.type, contentIndex: e.contentIndex, content: e.content, partial: piMessage(e.partial) };
    case "toolcall_end": {
      const partial = piMessage(e.partial);
      const call = partial.content[e.contentIndex];
      if (call?.type !== "toolCall") throw new Error(`toolcall_end at ${e.contentIndex} is not a tool call`);
      return { type: "toolcall_end", contentIndex: e.contentIndex, toolCall: call, partial };
    }
    case "done":
      return { type: "done", reason: e.reason, message: piMessage(e.message) };
    case "error":
      return { type: "error", reason: e.reason, error: piMessage(e.error) };
  }
}
