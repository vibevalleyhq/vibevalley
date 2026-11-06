import { Schema } from "effect";

const TextContentSchema = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});
export type TextContent = typeof TextContentSchema.Type;

const ThinkingContentSchema = Schema.Struct({
  type: Schema.Literal("thinking"),
  thinking: Schema.String,
  /** The response field the thinking came in (reasoning_content): it goes back under that name. */
  thinkingSignature: Schema.optionalKey(Schema.String),
});
export type ThinkingContent = typeof ThinkingContentSchema.Type;

const ImageContentSchema = Schema.Struct({
  type: Schema.Literal("image"),
  /** Base64. */
  data: Schema.String,
  mimeType: Schema.String,
});
export type ImageContent = typeof ImageContentSchema.Type;

const ToolCallSchema = Schema.Struct({
  type: Schema.Literal("toolCall"),
  id: Schema.String,
  name: Schema.String,
  arguments: Schema.Record(Schema.String, Schema.Unknown),
  /** Set when the model's arguments were not a JSON object; arguments is then {}. */
  argumentsError: Schema.optionalKey(Schema.String),
});
export type ToolCall = typeof ToolCallSchema.Type;

const UsageSchema = Schema.Struct({
  /** Prompt tokens not read from the cache. */
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  /** Of output; set when the provider reports it. */
  reasoning: Schema.optionalKey(Schema.Finite),
  totalTokens: Schema.Finite,
  /** Dollars. */
  cost: Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    cacheRead: Schema.Finite,
    cacheWrite: Schema.Finite,
    total: Schema.Finite,
  }),
});
export type Usage = typeof UsageSchema.Type;

const StopReasonValues = ["stop", "length", "toolUse", "error", "aborted"] as const;
const StopReasonSchema = Schema.Literals(StopReasonValues);
export type StopReason = typeof StopReasonSchema.Type;

export const UserContentSchema = Schema.Union([Schema.String, Schema.Array(Schema.Union([TextContentSchema, ImageContentSchema]))]);

export const UserMessageSchema = Schema.Struct({
  role: Schema.Literal("user"),
  content: UserContentSchema,
  /** Milliseconds. */
  timestamp: Schema.Finite,
});
export type UserMessage = typeof UserMessageSchema.Type;

export const AssistantMessageSchema = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Array(Schema.Union([TextContentSchema, ThinkingContentSchema, ToolCallSchema])),
  api: Schema.String,
  provider: Schema.String,
  /** The model asked; responseModel is the one that answered when it says another. */
  model: Schema.String,
  usage: UsageSchema,
  stopReason: StopReasonSchema,
  timestamp: Schema.Finite,
  responseId: Schema.optionalKey(Schema.String),
  responseModel: Schema.optionalKey(Schema.String),
  /** The provider's own finish_reason. */
  rawStopReason: Schema.optionalKey(Schema.String),
  errorMessage: Schema.optionalKey(Schema.String),
  /** The level the loop asked for, off when none. */
  thinkingLevel: Schema.optionalKey(Schema.String),
  /** From the request to the last of its stream. */
  durationMs: Schema.optionalKey(Schema.Finite),
});
export type AssistantMessage = typeof AssistantMessageSchema.Type;

export const ToolResultMessageSchema = Schema.Struct({
  role: Schema.Literal("toolResult"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  content: Schema.Array(Schema.Union([TextContentSchema, ImageContentSchema])),
  isError: Schema.Boolean,
  timestamp: Schema.Finite,
  durationMs: Schema.optionalKey(Schema.Finite),
});
export type ToolResultMessage = typeof ToolResultMessageSchema.Type;

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

/** A tool as the model is told of it: parameters are JSON Schema. */
export interface ToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** One request: the system prompt and tools lead every request alike, so the provider's prefix cache holds them. */
export interface Context {
  readonly system: string;
  readonly tools: readonly ToolDeclaration[];
  readonly messages: readonly Message[];
}

export const zeroUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
