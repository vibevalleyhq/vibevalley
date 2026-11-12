import { z } from "zod";

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
  readonly arguments: { readonly [x: string]: unknown };
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
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
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
  readonly durationMs?: number;
}

const TextContentSchema = z.object({ type: z.literal("text"), text: z.string() }) satisfies z.ZodType<TextContent>;

const ThinkingContentSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
  thinkingSignature: z.exactOptional(z.string()),
}) satisfies z.ZodType<ThinkingContent>;

const ImageContentSchema = z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }) satisfies z.ZodType<ImageContent>;

const ToolCallSchema = z.object({
  type: z.literal("toolCall"),
  id: z.string(),
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  argumentsError: z.exactOptional(z.string()),
}) satisfies z.ZodType<ToolCall>;

const UsageSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  reasoning: z.exactOptional(z.number()),
  totalTokens: z.number(),
  cost: z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), total: z.number() }),
}) satisfies z.ZodType<Usage>;

const StopReasonValues = ["stop", "length", "toolUse", "error", "aborted"] as const satisfies readonly StopReason[];

export const UserContentSchema = z.union([z.string(), z.array(z.discriminatedUnion("type", [TextContentSchema, ImageContentSchema]))]) satisfies z.ZodType<
  UserMessage["content"]
>;

export const UserMessageSchema = z.object({
  role: z.literal("user"),
  content: UserContentSchema,
  timestamp: z.number(),
}) satisfies z.ZodType<UserMessage>;

export const AssistantMessageSchema = z.object({
  role: z.literal("assistant"),
  content: z.array(z.discriminatedUnion("type", [TextContentSchema, ThinkingContentSchema, ToolCallSchema])),
  api: z.string(),
  provider: z.string(),
  model: z.string(),
  usage: UsageSchema,
  stopReason: z.enum(StopReasonValues),
  timestamp: z.number(),
  responseId: z.exactOptional(z.string()),
  responseModel: z.exactOptional(z.string()),
  rawStopReason: z.exactOptional(z.string()),
  errorMessage: z.exactOptional(z.string()),
  thinkingLevel: z.exactOptional(z.string()),
  durationMs: z.exactOptional(z.number()),
}) satisfies z.ZodType<AssistantMessage>;

export const ToolResultMessageSchema = z.object({
  role: z.literal("toolResult"),
  toolCallId: z.string(),
  toolName: z.string(),
  content: z.array(z.discriminatedUnion("type", [TextContentSchema, ImageContentSchema])),
  isError: z.boolean(),
  timestamp: z.number(),
  durationMs: z.exactOptional(z.number()),
}) satisfies z.ZodType<ToolResultMessage>;

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
