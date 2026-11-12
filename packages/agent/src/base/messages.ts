import { z } from "zod";

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

import type { AgentMessage } from "../core/loop.ts";
import { imagePlaceholder, summary as summaryWords, transcript as transcriptWords } from "./prompts.ts";

type UserContent = string | readonly (TextContent | ImageContent)[];

export interface CustomMessage {
  readonly role: "custom";
  readonly customType: string;
  readonly content: UserContent;
  /** false: hidden. */
  readonly display: boolean;
  readonly details?: unknown;
  readonly timestamp: number;
}

const CustomMessageSchema = z.object({
  role: z.literal("custom"),
  customType: z.string(),
  content: UserContentSchema,
  display: z.boolean(),
  details: z.exactOptional(z.unknown()),
  timestamp: z.number(),
}) satisfies z.ZodType<CustomMessage>;

export interface CompactionSummaryMessage {
  readonly role: "compactionSummary";
  readonly summary: string;
  readonly tokensBefore: number;
  readonly timestamp: number;
  /** Absent when not archived. */
  readonly archive?: string;
  /** How many messages before it in the session file stay after it, as they were. */
  readonly kept: number;
}

const CompactionSummaryMessageSchema = z.object({
  role: z.literal("compactionSummary"),
  summary: z.string(),
  tokensBefore: z.number(),
  timestamp: z.number(),
  archive: z.exactOptional(z.string()),
  kept: z.number(),
}) satisfies z.ZodType<CompactionSummaryMessage>;

export const BrainMessageSchema = z.discriminatedUnion("role", [
  UserMessageSchema,
  AssistantMessageSchema,
  ToolResultMessageSchema,
  CustomMessageSchema,
  CompactionSummaryMessageSchema,
]) satisfies z.ZodType<BrainMessage>;
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
  const where = m.archive !== undefined && m.archive !== "" ? summaryWords.archivedNote(m.archive) : "";
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
          if (c.type === "toolCall") out.push(transcriptWords.toolCallHeading(c.name, JSON.stringify(c.arguments)));
        }
        break;
      case "toolResult":
        out.push(transcriptWords.toolResultHeading(m.toolName, m.isError, messageText(m)));
        break;
    }
  }
  return out.join("\n\n");
}
