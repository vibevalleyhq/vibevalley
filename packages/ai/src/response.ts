// A chat/completions stream read into an assistant message, as pi-ai 1.3.0's openai-completions reads DeepSeek's
// (testdata/deepseek.jsonl.gz holds what pi-ai made of each stream), with pi-ai's events on the way.

import { Predicate } from "effect";
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

/** Server-sent events' data, one string an event; [DONE] ends them. Feed it lines; a blank line closes an event. */
export class SseData {
  private data: string[] = [];
  done = false;

  line(line: string): string | undefined {
    if (this.done) return undefined;
    const l = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (l === "") {
      if (this.data.length === 0) return undefined;
      const data = this.data.join("\n");
      this.data = [];
      if (data.startsWith("[DONE]")) {
        this.done = true;
        return undefined;
      }
      return data;
    }
    if (l.startsWith(":")) return undefined;
    const colon = l.indexOf(":");
    const field = colon < 0 ? l : l.slice(0, colon);
    if (field === "data") this.data.push(colon < 0 ? "" : l.slice(colon + 1).replace(/^ /, ""));
    return undefined;
  }
}

type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; thinking: string; signature: string }
  | { kind: "tool"; id: string; name: string; partial: string; arguments: Readonly<Record<string, unknown>>; argumentsError?: string; index?: number };

interface ToolCallDelta {
  readonly index?: number;
  readonly id?: string;
  readonly function?: { readonly name?: string; readonly arguments?: string };
}

const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"] as const;

/** One response's chunks folded into its message; timestamp is when the request started. */
export class Fold {
  private readonly blocks: Block[] = [];
  private text: Extract<Block, { kind: "text" }> | undefined;
  private thinking: Extract<Block, { kind: "thinking" }> | undefined;
  private readonly toolsByIndex = new Map<number, Extract<Block, { kind: "tool" }>>();
  private readonly toolsById = new Map<string, Extract<Block, { kind: "tool" }>>();
  private usage: Usage = zeroUsage();
  private stopReason: StopReason | "pending" = "pending";
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

  /** A data event's JSON. */
  chunk(chunk: unknown): AssistantMessageEvent[] {
    if (typeof chunk !== "object" || chunk === null) return [];
    const c = chunk as { id?: unknown; model?: unknown; usage?: RawUsage; choices?: unknown };
    if (typeof c.id === "string" && !this.responseId) this.responseId = c.id;
    if (typeof c.model === "string" && c.model.length > 0 && c.model !== this.model.id) this.responseModel ??= c.model;
    if (c.usage) this.usage = usageOf(c.usage, this.model);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- OpenAI's chunk as the provider sends it, not decoded on the hot path
    const choice = Array.isArray(c.choices) ? (c.choices[0] as Choice | undefined) : undefined;
    if (!choice) return [];
    if (!c.usage && choice.usage) this.usage = usageOf(choice.usage, this.model);
    if (choice.finish_reason) {
      this.rawStopReason = choice.finish_reason;
      const [reason, error] = stopReasonOf(choice.finish_reason);
      this.stopReason = reason;
      if (error) this.errorMessage = error;
      this.finished = true;
    }
    const events: AssistantMessageEvent[] = [];
    const delta = choice.delta;
    if (!delta) return events;
    // Thinking before the text: a proxy may put both in one delta, and the thinking block comes first.
    const field = reasoningFields.find((f) => typeof delta[f] === "string" && delta[f].length > 0);
    const piece = field === undefined ? undefined : delta[field];
    if (field !== undefined && typeof piece === "string") {
      if (!this.thinking) {
        this.thinking = { kind: "thinking", thinking: "", signature: field };
        events.push(this.opened("thinking_start", this.thinking));
      }
      this.thinking.thinking += piece;
      events.push({ type: "thinking_delta", contentIndex: this.blocks.indexOf(this.thinking), delta: piece, partial: this.message() });
    }
    if (typeof delta.content === "string" && delta.content.length > 0) {
      if (!this.text) {
        this.text = { kind: "text", text: "" };
        events.push(this.opened("text_start", this.text));
      }
      this.text.text += delta.content;
      events.push({ type: "text_delta", contentIndex: this.blocks.indexOf(this.text), delta: delta.content, partial: this.message() });
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- OpenAI's chunk as the provider sends it, not decoded on the hot path
    for (const call of Array.isArray(delta.tool_calls) ? (delta.tool_calls as ToolCallDelta[]) : []) {
      const block = this.toolBlock(call, events);
      if (!block.id && call.id) {
        block.id = call.id;
        this.toolsById.set(call.id, block);
      }
      if (!block.name && call.function?.name) block.name = call.function.name;
      const piece = call.function?.arguments ?? "";
      if (piece) {
        block.partial += piece;
        block.arguments = streamingArguments(block.partial, block.arguments);
      }
      events.push({ type: "toolcall_delta", contentIndex: this.blocks.indexOf(block), delta: piece, partial: this.message() });
    }
    return events;
  }

  /** The stream ended: each block closes, then done, or error when the model's answer was not a complete one. */
  end(): AssistantMessageEvent[] {
    const events = this.blocks.map((b) => this.closed(b));
    const reason = this.stopReason;
    if (reason === "error" || reason === "aborted")
      return [...events, this.failed(this.errorMessage || "Provider returned an error stop reason", reason === "aborted")];
    if (!this.finished || reason === "pending") return [...events, this.failed("Stream ended without finish_reason", false)];
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
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- pending only while streaming; a partial message is not read for it
      stopReason: this.stopReason as StopReason,
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

  private toolBlock(call: ToolCallDelta, events: AssistantMessageEvent[]): Extract<Block, { kind: "tool" }> {
    const index = typeof call.index === "number" ? call.index : undefined;
    let block = index !== undefined ? this.toolsByIndex.get(index) : undefined;
    if (!block && call.id) block = this.toolsById.get(call.id);
    if (!block) {
      block = { kind: "tool", id: call.id || "", name: call.function?.name ?? "", partial: "", arguments: {}, ...(index !== undefined ? { index } : {}) };
      if (index !== undefined) this.toolsByIndex.set(index, block);
      if (call.id) this.toolsById.set(call.id, block);
      events.push(this.opened("toolcall_start", block));
    }
    if (index !== undefined && block.index === undefined) {
      block.index = index;
      this.toolsByIndex.set(index, block);
    }
    if (call.id) this.toolsById.set(call.id, block);
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

interface Choice {
  readonly finish_reason?: string | null;
  readonly usage?: RawUsage;
  readonly delta?: Record<string, unknown> & { readonly content?: string | null; readonly tool_calls?: unknown };
}

interface RawUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly cached_tokens?: number;
  /** DeepSeek's cache hits. */
  readonly prompt_cache_hit_tokens?: number;
  readonly prompt_tokens_details?: { readonly cached_tokens?: number; readonly cache_write_tokens?: number };
  readonly completion_tokens_details?: { readonly reasoning_tokens?: number };
}

/** input is the prompt not read from the cache; output already counts reasoning. */
function usageOf(raw: RawUsage, model: Model): Usage {
  const prompt = raw.prompt_tokens ?? 0;
  const cacheRead = raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens ?? raw.cached_tokens ?? 0;
  const cacheWrite = raw.prompt_tokens_details?.cache_write_tokens ?? 0;
  const input = Math.max(0, prompt - cacheRead - cacheWrite);
  const output = raw.completion_tokens ?? 0;
  const usage = {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning: raw.completion_tokens_details?.reasoning_tokens ?? 0,
    totalTokens: input + output + cacheRead + cacheWrite,
  };
  return { ...usage, cost: costOf(model, usage) };
}

/** As pi-ai's calculateCost, the same operations in the same order, so the floating point agrees. */
export function costOf(model: Model, u: Omit<Usage, "cost">): Usage["cost"] {
  const r = model.cost;
  const input = (r.input / 1000000) * u.input;
  const output = (r.output / 1000000) * u.output;
  const cacheRead = (r.cacheRead / 1000000) * u.cacheRead;
  const cacheWrite = (r.cacheWrite * u.cacheWrite) / 1000000;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

function stopReasonOf(reason: string): [StopReason, string?] {
  switch (reason) {
    case "stop":
    case "end":
      return ["stop"];
    case "length":
      return ["length"];
    case "function_call":
    case "tool_calls":
      return ["toolUse"];
    default:
      return ["error", `Provider finish_reason: ${reason}`];
  }
}

const jsonEscapes = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);
const controlEscapes: Record<string, string> = { "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t" };

/** As pi-ai's repairJson: inside strings, raw control characters are escaped and a stray backslash is doubled. */
export function repairJson(json: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i]!;
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
      if (next === "u" && /^[0-9a-fA-F]{4}$/.test(json.slice(i + 2, i + 6))) {
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
    const code = ch.codePointAt(0)!;
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
export function toolCallArguments(json: string): { arguments: Readonly<Record<string, unknown>>; argumentsError?: string } {
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
    if (d !== undefined) fold.chunk(JSON.parse(d));
  }
  const last = fold.end().at(-1);
  if (!last) return fold.message();
  return last.type === "done" ? last.message : last.type === "error" ? last.error : fold.message();
}
