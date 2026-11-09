import { Formatter, Schema } from "effect";

import {
  AssistantMessageSchema,
  type Context,
  type ImageContent,
  type Message,
  type TextContent,
  type ToolDeclaration,
  ToolResultMessageSchema,
  UserContentSchema,
  type UserMessage,
  UserMessageSchema,
} from "@vibevalley/ai/messages";

import type { AgentMessage } from "./core/loop.ts";
import { imagePlaceholder, summary as summaryWords, transcript as transcriptWords } from "./prompts.ts";

type UserContent = string | readonly (TextContent | ImageContent)[];

const CustomMessageSchema = Schema.Struct({
  role: Schema.Literal("custom"),
  customType: Schema.String,
  content: UserContentSchema,
  /** false: hidden. */
  display: Schema.Boolean,
  details: Schema.optionalKey(Schema.Unknown),
  timestamp: Schema.Finite,
});
export type CustomMessage = typeof CustomMessageSchema.Type;

const CompactionSummaryMessageSchema = Schema.Struct({
  role: Schema.Literal("compactionSummary"),
  summary: Schema.String,
  tokensBefore: Schema.Finite,
  timestamp: Schema.Finite,
  /** Absent when not archived. */
  archive: Schema.optionalKey(Schema.String),
  /** How many messages before it in the session file stay after it, as they were. */
  kept: Schema.Finite,
});
export type CompactionSummaryMessage = typeof CompactionSummaryMessageSchema.Type;

export const BrainMessageSchema = Schema.Union([
  UserMessageSchema,
  AssistantMessageSchema,
  ToolResultMessageSchema,
  CustomMessageSchema,
  CompactionSummaryMessageSchema,
]);
export type BrainMessage = AgentMessage<CustomMessage | CompactionSummaryMessage>;

export const customMessage = (customType: string, content: UserContent, now: number, options: { hidden?: boolean; details?: unknown } = {}): CustomMessage => ({
  role: "custom",
  customType,
  content,
  display: options.hidden !== true,
  ...(options.details === undefined ? {} : { details: options.details }),
  timestamp: now,
});

export const userMessage = (text: string, now: number): UserMessage => ({
  role: "user",
  content: text,
  timestamp: now,
});

function summaryText(m: { readonly summary: string; readonly archive?: string }): string {
  const where = m.archive ? summaryWords.archivedNote(m.archive) : "";
  return summaryWords.wrapped(where, m.summary);
}

function llmMessages(messages: readonly BrainMessage[]): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    switch (m.role) {
      case "custom":
        out.push({ role: "user", content: m.content, timestamp: m.timestamp });
        break;
      case "compactionSummary":
        out.push({ role: "user", content: summaryText(m), timestamp: m.timestamp });
        break;
      case "user":
      case "assistant":
      case "toolResult":
        out.push(m);
        break;
    }
  }
  return out;
}

export const requestContext = (prefix: string, tools: readonly ToolDeclaration[], messages: readonly BrainMessage[]): Context => ({
  system: prefix,
  tools,
  messages: llmMessages(messages),
});

function blocksText(blocks: readonly { type: string; text?: string }[]): string {
  let out = "";
  for (const c of blocks) {
    if (c.type === "text") out += c.text ?? "";
    else if (c.type === "image") out += imagePlaceholder;
  }
  return out;
}

const contentWords = (c: UserContent | readonly { type: string; text?: string }[]) => (typeof c === "string" ? c : blocksText(c));

export function messageText(m: BrainMessage): string {
  switch (m.role) {
    case "compactionSummary":
      return m.summary;
    case "custom":
    case "user":
      return contentWords(m.content);
    case "assistant":
    case "toolResult":
      return blocksText(m.content);
  }
}

export function transcript(messages: readonly BrainMessage[]): string {
  const out: string[] = [];
  for (const m of messages) {
    switch (m.role) {
      case "user":
        out.push(transcriptWords.userHeading(messageText(m)));
        break;
      case "custom":
        out.push(transcriptWords.customHeading(m.customType, messageText(m)));
        break;
      case "compactionSummary":
        out.push(transcriptWords.olderSummaryHeading(m.summary));
        break;
      case "assistant":
        for (const c of m.content) {
          if (c.type === "text" && c.text.trim() !== "") out.push(transcriptWords.replyHeading(c.text));
          if (c.type === "toolCall") out.push(transcriptWords.toolCallHeading(c.name, Formatter.formatJson(c.arguments)));
        }
        break;
      case "toolResult":
        out.push(transcriptWords.toolResultHeading(m.toolName, m.isError, messageText(m)));
        break;
    }
  }
  return out.join("\n\n");
}
