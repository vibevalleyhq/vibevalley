import { Option, Predicate } from "effect";

import { type DeepSeekChunk, decodeDeepSeekChunk, SseData } from "@vibevalley/provider/deepseek/response";

import { parsedJson } from "./json.ts";
import type { AssistantMessage, StopReason, TextContent, ThinkingContent, ToolCall, Usage } from "./messages.ts";
import { zeroUsage } from "./messages.ts";
import type { Model } from "./models.ts";

/** pi-ai's AssistantMessageEvent; partial is the message so far, a copy each time. */
export type AssistantMessageEvent =
  | { readonly type: "start"; readonly partial: AssistantMessage }
  | { readonly type: "text_start" | "thinking_start" | "toolcall_start"; readonly contentIndex: number; readonly partial: AssistantMessage }
  | {
      readonly type: "text_delta" | "thinking_delta" | "toolcall_delta";
      readonly contentIndex: number;
      readonly delta: string;
      readonly partial: AssistantMessage;
    }
  | { readonly type: "text_end" | "thinking_end"; readonly contentIndex: number; readonly content: string; readonly partial: AssistantMessage }
  | { readonly type: "toolcall_end"; readonly contentIndex: number; readonly toolCall: ToolCall; readonly partial: AssistantMessage }
  | { readonly type: "done"; readonly reason: "stop" | "length" | "toolUse"; readonly message: AssistantMessage }
  | { readonly type: "error"; readonly reason: "error" | "aborted"; readonly error: AssistantMessage };

type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; thinking: string; signature: string }
  | { kind: "tool"; id: string; name: string; partial: string; arguments: Readonly<Record<string, unknown>>; argumentsError?: string; index?: number };

/** One response's chunks folded into its message; timestamp is when the request started. */
export class Fold {
  private readonly blocks: Block[] = [];
  private text: Extract<Block, { kind: "text" }> | undefined;
  private thinking: Extract<Block, { kind: "thinking" }> | undefined;
  private readonly toolsByIndex = new Map<number, Extract<Block, { kind: "tool" }>>();
  private readonly toolsById = new Map<string, Extract<Block, { kind: "tool" }>>();
  private usage: Usage = zeroUsage();
  private stopReason: StopReason = "stop";
  private finished = false;
  private responseId: string | undefined;
  private responseModel: string | undefined;
  private rawStopReason: string | undefined;
  private errorMessage: string | undefined;

  private readonly model: Model;
  private readonly timestamp: number;
  constructor(model: Model, timestamp: number) {
    this.model = model;
    this.timestamp = timestamp;
  }

  start(): AssistantMessageEvent {
    return { type: "start", partial: this.message() };
  }

  chunk(chunk: DeepSeekChunk): AssistantMessageEvent[] {
    if (chunk.id !== undefined && !this.responseId) this.responseId = chunk.id;
    if (chunk.model !== undefined && chunk.model !== this.model.id) this.responseModel ??= chunk.model;
    if (chunk.usage) this.usage = { ...chunk.usage, cost: costOf(this.model, chunk.usage) };
    if (chunk.finish) {
      this.rawStopReason = chunk.finish.raw;
      this.stopReason = chunk.finish.reason === "tool" ? "toolUse" : chunk.finish.reason;
      if (chunk.finish.error) this.errorMessage = chunk.finish.error;
      this.finished = true;
    }
    const events: AssistantMessageEvent[] = [];
    // A delta can contain both: the agent's thinking block must precede its text.
    if (chunk.thinking) {
      if (!this.thinking) {
        this.thinking = { kind: "thinking", thinking: "", signature: chunk.thinking.signature };
        events.push(this.opened("thinking_start", this.thinking));
      }
      this.thinking.thinking += chunk.thinking.text;
      events.push({ type: "thinking_delta", contentIndex: this.blocks.indexOf(this.thinking), delta: chunk.thinking.text, partial: this.message() });
    }
    if (chunk.text) {
      if (!this.text) {
        this.text = { kind: "text", text: "" };
        events.push(this.opened("text_start", this.text));
      }
      this.text.text += chunk.text;
      events.push({ type: "text_delta", contentIndex: this.blocks.indexOf(this.text), delta: chunk.text, partial: this.message() });
    }
    for (const call of chunk.calls) {
      const { id, name, arguments: args } = call;
      const block = this.toolBlock(call.index, id, name, events);
      if (!block.id && id) {
        block.id = id;
        this.toolsById.set(id, block);
      }
      if (!block.name && name) block.name = name;
      if (args) {
        block.partial += args;
        block.arguments = streamingArguments(block.partial, block.arguments);
      }
      events.push({ type: "toolcall_delta", contentIndex: this.blocks.indexOf(block), delta: args, partial: this.message() });
    }
    return events;
  }

  /** The stream ended: each block closes, then done, or error when the model's answer was not a complete one. */
  end(): AssistantMessageEvent[] {
    const events = this.blocks.map((b) => this.closed(b));
    if (!this.finished) return [...events, this.failed("Stream ended without finish_reason", false)];
    const reason = this.stopReason;
    if (reason === "error" || reason === "aborted")
      return [...events, this.failed(this.errorMessage || "Provider returned an error stop reason", reason === "aborted")];
    return [...events, { type: "done", reason, message: this.message() }];
  }

  /** The request failed, or was stopped, partway: the blocks stay as they are. */
  failed(message: string, aborted: boolean): AssistantMessageEvent {
    this.stopReason = aborted ? "aborted" : "error";
    this.errorMessage = message;
    return { type: "error", reason: this.stopReason, error: this.message() };
  }

  message(): AssistantMessage {
    return {
      role: "assistant",
      content: this.blocks.map(contentOf),
      api: this.model.api,
      provider: this.model.provider,
      model: this.model.id,
      usage: this.usage,
      stopReason: this.stopReason,
      timestamp: this.timestamp,
      ...(this.responseId !== undefined ? { responseId: this.responseId } : {}),
      ...(this.responseModel !== undefined ? { responseModel: this.responseModel } : {}),
      ...(this.rawStopReason !== undefined ? { rawStopReason: this.rawStopReason } : {}),
      ...(this.errorMessage !== undefined ? { errorMessage: this.errorMessage } : {}),
    };
  }

  private opened(type: "text_start" | "thinking_start" | "toolcall_start", block: Block): AssistantMessageEvent {
    this.blocks.push(block);
    return { type, contentIndex: this.blocks.length - 1, partial: this.message() };
  }

  private toolBlock(
    index: number | undefined,
    id: string | undefined,
    name: string | undefined,
    events: AssistantMessageEvent[],
  ): Extract<Block, { kind: "tool" }> {
    let block = index !== undefined ? this.toolsByIndex.get(index) : undefined;
    if (!block && id) block = this.toolsById.get(id);
    if (!block) {
      block = { kind: "tool", id: id || "", name: name ?? "", partial: "", arguments: {}, ...(index !== undefined ? { index } : {}) };
      if (index !== undefined) this.toolsByIndex.set(index, block);
      if (id) this.toolsById.set(id, block);
      events.push(this.opened("toolcall_start", block));
    }
    if (index !== undefined && block.index === undefined) {
      block.index = index;
      this.toolsByIndex.set(index, block);
    }
    if (id) this.toolsById.set(id, block);
    return block;
  }

  private closed(block: Block): AssistantMessageEvent {
    const contentIndex = this.blocks.indexOf(block);
    switch (block.kind) {
      case "text":
        return { type: "text_end", contentIndex, content: block.text, partial: this.message() };
      case "thinking":
        return { type: "thinking_end", contentIndex, content: block.thinking, partial: this.message() };
      case "tool": {
        const parsed = toolCallArguments(block.partial);
        block.arguments = parsed.arguments;
        if (parsed.argumentsError !== undefined) block.argumentsError = parsed.argumentsError;
        return { type: "toolcall_end", contentIndex, toolCall: toolCallOf(block), partial: this.message() };
      }
    }
  }
}

function contentOf(b: Block): TextContent | ThinkingContent | ToolCall {
  switch (b.kind) {
    case "text":
      return { type: "text", text: b.text };
    case "thinking":
      return { type: "thinking", thinking: b.thinking, thinkingSignature: b.signature };
    case "tool":
      return toolCallOf(b);
  }
}

function toolCallOf(b: Extract<Block, { kind: "tool" }>): ToolCall {
  return {
    type: "toolCall",
    id: b.id,
    name: b.name,
    arguments: b.arguments,
    ...(b.argumentsError !== undefined ? { argumentsError: b.argumentsError } : {}),
  };
}

/** As pi-ai's calculateCost, the same operations in the same order, so the floating point agrees. */
function costOf(model: Model, u: Omit<Usage, "cost">): Usage["cost"] {
  const r = model.cost;
  const input = (r.input / 1000000) * u.input;
  const output = (r.output / 1000000) * u.output;
  const cacheRead = (r.cacheRead / 1000000) * u.cacheRead;
  const cacheWrite = (r.cacheWrite * u.cacheWrite) / 1000000;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

const jsonEscapes = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);
const controlEscapes: Record<string, string> = { "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t" };

/** As pi-ai's repairJson: inside strings, raw control characters are escaped and a stray backslash is doubled. */
function repairJson(json: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (ch === undefined) break;
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }
    if (ch === '"') {
      out += ch;
      inString = false;
      continue;
    }
    if (ch === "\\") {
      const next = json[i + 1];
      if (next === undefined) {
        out += "\\\\";
        continue;
      }
      if (next === "u" && /^[0-9a-fA-F]{4}$/u.test(json.slice(i + 2, i + 6))) {
        out += `\\u${json.slice(i + 2, i + 6)}`;
        i += 5;
        continue;
      }
      if (jsonEscapes.has(next)) {
        out += `\\${next}`;
        i += 1;
        continue;
      }
      out += "\\\\";
      continue;
    }
    const code = ch.charCodeAt(0);
    out += code <= 0x1f ? (controlEscapes[ch] ?? `\\u${code.toString(16).padStart(4, "0")}`) : ch;
  }
  return out;
}

function parseWithRepair(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch (e) {
    const repaired = repairJson(json);
    if (repaired !== json) return JSON.parse(repaired);
    throw e;
  }
}

/** A tool call's whole arguments: an object, or {} and why not with the text that came. */
function toolCallArguments(json: string): { arguments: Readonly<Record<string, unknown>>; argumentsError?: string } {
  if (!json.trim()) return { arguments: {} };
  const refused = (why: string) => ({ arguments: {}, argumentsError: `${why}\n\nReceived arguments:\n${json}` });
  let parsed: unknown;
  try {
    parsed = parseWithRepair(json);
  } catch (e) {
    return refused(e instanceof Error ? e.message : String(e));
  }
  // Each tool reads its own fields by its Schema; here the arguments only have to be an object.
  return Predicate.isObject(parsed) ? { arguments: parsed } : refused("Tool arguments must be a JSON object");
}

/** While the arguments stream in: what parses so far, else what last did (pi-ai guesses at the unfinished JSON; nothing
 * here reads arguments before the call ends). */
function streamingArguments(partial: string, last: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  try {
    const parsed = parseWithRepair(partial);
    return Predicate.isObject(parsed) ? parsed : last;
  } catch {
    return last;
  }
}

/** A whole stream's text read at once: the message the events end with. */
export function responseOf(model: Model, sse: string, timestamp = 0): AssistantMessage {
  const fold = new Fold(model, timestamp);
  const data = new SseData();
  for (const line of sse.split("\n")) {
    const d = data.line(line);
    if (d === undefined) continue;
    const parsed = parsedJson(d);
    if (Option.isNone(parsed)) throw new Error(`Not JSON in the stream: ${d.slice(0, 200)}`);
    fold.chunk(decodeDeepSeekChunk(parsed.value));
  }
  const last = fold.end().at(-1);
  if (!last) return fold.message();
  return last.type === "done" ? last.message : last.type === "error" ? last.error : fold.message();
}
