// The agent's own messages, named as pi-coding-agent names them: `custom` and `compactionSummary`. Both are kept in the
// transcript; the model reads them as a user's words (convertToLlm). The transcript's system messages (pi-agent-core's
// tool declarations) are never kept: the request's start is made fresh each time from the prompt and the tools.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, SystemMessage, TextContent, Tool, UserMessage } from "@earendil-works/pi-ai";

export type UserContent = string | (TextContent | ImageContent)[];

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

// pi-coding-agent (through oar) already adds `custom` and `compactionSummary` to pi-agent-core's AgentMessage, in
// shapes these extend: a compactionSummary read from the transcript is this file's once it is known to be the agent's.

export const customMessage = (customType: string, content: UserContent, options: { hidden?: boolean; details?: unknown } = {}): CustomMessage => ({
  role: "custom",
  customType,
  content,
  display: !options.hidden,
  ...(options.details === undefined ? {} : { details: options.details }),
  timestamp: Date.now(),
});

export const userMessage = (text: string): UserMessage => ({
  role: "user",
  content: text,
  timestamp: Date.now(),
});

export function summaryText(m: { readonly summary: string; readonly archive?: string }): string {
  const where = m.archive ? "，原文在 " + m.archive : "";
  return "【之前的对话压成了下面的摘要" + where + "】\n<summary>\n" + m.summary + "\n</summary>";
}

/** The conversation as the model reads it, without the system messages in it. */
export function llmMessages(messages: readonly AgentMessage[]): Message[] {
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

/** One system message leads: the prompt and every tool, the same start for every request until either changes. */
export function withPrefix(prefix: string, tools: readonly Tool[], messages: readonly AgentMessage[]): Message[] {
  const head: SystemMessage = {
    role: "system",
    content: prefix,
    ...(tools.length > 0 ? { toolsAdded: [...tools] } : {}),
    timestamp: 0,
  };
  return [head, ...llmMessages(messages)];
}

function blocksText(blocks: readonly { type: string; text?: string }[]): string {
  let out = "";
  for (const c of blocks) {
    if (c.type === "text") out += c.text ?? "";
    else if (c.type === "image") out += "[图片]";
  }
  return out;
}

const contentWords = (c: UserContent | readonly { type: string; text?: string }[]) => (typeof c === "string" ? c : blocksText(c));

export function messageText(m: AgentMessage): string {
  switch (m.role) {
    case "compactionSummary":
      return m.summary;
    case "custom":
    case "system":
    case "user":
      return contentWords(m.content);
    case "assistant":
    case "toolResult":
      return blocksText(m.content);
  }
  return "";
}

export function transcript(messages: readonly AgentMessage[]): string {
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

/** What the agent keeps and shows: the transcript without pi-agent-core's system messages. */
export const kept = (messages: readonly AgentMessage[]) => messages.filter((m) => m.role !== "system");
