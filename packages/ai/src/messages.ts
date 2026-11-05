import { Schema } from "effect";

export interface TextContent {
  readonly type: "text";
  readonly text: string;
}

export interface ThinkingContent {
  readonly type: "thinking";
  readonly thinking: string;
  /** The response field the thinking came in (reasoning_content): it goes back under that name. */
  readonly thinkingSignature?: string;
}

export interface ImageContent {
  readonly type: "image";
  /** Base64. */
  readonly data: string;
  readonly mimeType: string;
}

export interface ToolCall {
  readonly type: "toolCall";
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  /** Set when the model's arguments were not a JSON object; arguments is then {}. */
  readonly argumentsError?: string;
}

export interface Usage {
  /** Prompt tokens not read from the cache. */
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** Of output; set when the provider reports it. */
  readonly reasoning?: number;
  readonly totalTokens: number;
  /** Dollars. */
  readonly cost: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number; readonly total: number };
}

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface UserMessage {
  readonly role: "user";
  readonly content: string | readonly (TextContent | ImageContent)[];
  /** Milliseconds. */
  readonly timestamp: number;
}

export interface AssistantMessage {
  readonly role: "assistant";
  readonly content: readonly (TextContent | ThinkingContent | ToolCall)[];
  readonly api: string;
  readonly provider: string;
  /** The model asked; responseModel is the one that answered when it says another. */
  readonly model: string;
  readonly usage: Usage;
  readonly stopReason: StopReason;
  readonly timestamp: number;
  readonly responseId?: string;
  readonly responseModel?: string;
  /** The provider's own finish_reason. */
  readonly rawStopReason?: string;
  readonly errorMessage?: string;
  /** The level the loop asked for, off when none. */
  readonly thinkingLevel?: string;
  /** From the request to the last of its stream. */
  readonly durationMs?: number;
}

export interface ToolResultMessage {
  readonly role: "toolResult";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: readonly (TextContent | ImageContent)[];
  readonly isError: boolean;
  readonly timestamp: number;
  /** How long the tool ran. */
  readonly durationMs?: number;
}

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

export const TextContentSchema: Schema.Codec<TextContent> = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});

export const ThinkingContentSchema: Schema.Codec<ThinkingContent> = Schema.Struct({
  type: Schema.Literal("thinking"),
  thinking: Schema.String,
  thinkingSignature: Schema.optionalKey(Schema.String),
});

export const ImageContentSchema: Schema.Codec<ImageContent> = Schema.Struct({
  type: Schema.Literal("image"),
  data: Schema.String,
  mimeType: Schema.String,
});

export const ToolCallSchema: Schema.Codec<ToolCall> = Schema.Struct({
  type: Schema.Literal("toolCall"),
  id: Schema.String,
  name: Schema.String,
  arguments: Schema.Record(Schema.String, Schema.Unknown),
  argumentsError: Schema.optionalKey(Schema.String),
});

export const UsageSchema: Schema.Codec<Usage> = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  reasoning: Schema.optionalKey(Schema.Finite),
  totalTokens: Schema.Finite,
  cost: Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    cacheRead: Schema.Finite,
    cacheWrite: Schema.Finite,
    total: Schema.Finite,
  }),
});

export const UserContentSchema = Schema.Union([Schema.String, Schema.Array(Schema.Union([TextContentSchema, ImageContentSchema]))]);

export const UserMessageSchema: Schema.Codec<UserMessage> = Schema.Struct({
  role: Schema.Literal("user"),
  content: UserContentSchema,
  timestamp: Schema.Finite,
});

export const AssistantMessageSchema: Schema.Codec<AssistantMessage> = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Array(Schema.Union([TextContentSchema, ThinkingContentSchema, ToolCallSchema])),
  api: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  usage: UsageSchema,
  stopReason: Schema.Literals(["stop", "length", "toolUse", "error", "aborted"]),
  timestamp: Schema.Finite,
  responseId: Schema.optionalKey(Schema.String),
  responseModel: Schema.optionalKey(Schema.String),
  rawStopReason: Schema.optionalKey(Schema.String),
  errorMessage: Schema.optionalKey(Schema.String),
  thinkingLevel: Schema.optionalKey(Schema.String),
  durationMs: Schema.optionalKey(Schema.Finite),
});

export const ToolResultMessageSchema: Schema.Codec<ToolResultMessage> = Schema.Struct({
  role: Schema.Literal("toolResult"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  content: Schema.Array(Schema.Union([TextContentSchema, ImageContentSchema])),
  isError: Schema.Boolean,
  timestamp: Schema.Finite,
  durationMs: Schema.optionalKey(Schema.Finite),
});
