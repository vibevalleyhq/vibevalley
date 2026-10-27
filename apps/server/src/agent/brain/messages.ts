// The roles as pi-coding-agent names them, `custom` and `compactionSummary`, so its transcripts (through oar) read the
// same; the model reads both as a user's words.

import type { Context, ImageContent, Message, TextContent, ToolDeclaration, UserMessage } from "../../ai/messages.ts";
import type { AgentMessage } from "../loop/agent.ts";

export type UserContent = string | readonly (TextContent | ImageContent)[];

export interface CustomMessage {
  readonly role: "custom";
  readonly customType: string;
  readonly content: UserContent;
  /** pi's display: false is hidden. */
  readonly display: boolean;
  readonly details?: unknown;
  readonly timestamp: number;
}

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

export type BrainMessage = AgentMessage<CustomMessage | CompactionSummaryMessage>;

export const customMessage = (customType: string, content: UserContent, now: number, options: { hidden?: boolean; details?: unknown } = {}): CustomMessage => ({
  role: "custom",
  customType,
  content,
  display: !options.hidden,
  ...(options.details === undefined ? {} : { details: options.details }),
  timestamp: now,
});

export const userMessage = (text: string, now: number): UserMessage => ({
  role: "user",
  content: text,
  timestamp: now,
});

export function summaryText(m: { readonly summary: string; readonly archive?: string }): string {
  const where = m.archive ? "，原文在 " + m.archive : "";
  return "【之前的对话压成了下面的摘要" + where + "】\n<summary>\n" + m.summary + "\n</summary>";
}

export function llmMessages(messages: readonly BrainMessage[]): Message[] {
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
    else if (c.type === "image") out += "[图片]";
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
        out.push("## 用户\n" + messageText(m));
        break;
      case "custom":
        out.push("## " + m.customType + "\n" + messageText(m));
        break;
      case "compactionSummary":
        out.push("## 更早的摘要\n" + m.summary);
        break;
      case "assistant":
        for (const c of m.content) {
          if (c.type === "text" && c.text.trim() !== "") out.push("## 助手\n" + c.text);
          if (c.type === "toolCall") out.push("## 调用 " + c.name + "\n" + JSON.stringify(c.arguments));
        }
        break;
      case "toolResult":
        out.push("## " + m.toolName + " 的结果" + (m.isError ? "（失败）" : "") + "\n" + messageText(m));
        break;
    }
  }
  return out.join("\n\n");
}
