import { type DeepSeekContent, type DeepSeekInput, type DeepSeekMessage, encodeDeepSeekRequest } from "@vibevalley/provider/deepseek/request";

import type { AssistantMessage, Context, ImageContent, Message, TextContent, ThinkingContent, ToolCall, Usage } from "./messages.ts";
import { clampThinkingLevel, type Model, type ThinkingLevel } from "./models.ts";

export interface RequestOptions {
  /** Off or none: thinking is turned off, where the model lets it be. */
  readonly reasoning?: ThinkingLevel;
  readonly maxTokens?: number;
  readonly toolChoice?: "auto" | "none";
}

const userImageOmitted = "(image omitted: model does not support images)";
const toolImageOmitted = "(tool image omitted: model does not support images)";

/** Unpaired surrogates fail the provider's JSON; paired ones (emoji) stay: with u, a pair is one code point the class does not take. */
const sanitizeSurrogates = (text: string) => text.replace(/[\uD800-\uDFFF]/gu, "");

export function requestBody(model: Model, context: Context, options: RequestOptions = {}): Record<string, unknown> {
  return encodeDeepSeekRequest(model.id, requestInput(model, context, options));
}

export function requestInput(model: Model, context: Context, options: RequestOptions = {}): DeepSeekInput {
  const clamped = options.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
  const effort = clamped === "off" ? undefined : clamped;
  return {
    messages: chatMessages(model, context),
    maxTokens: clampMaxTokens(model, context, options.maxTokens ?? model.maxTokens),
    ...(context.tools.length > 0
      ? { tools: context.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }
      : hasToolHistory(context.messages)
        ? { tools: [] }
        : {}),
    ...(options.toolChoice ? { toolChoice: options.toolChoice } : {}),
    reasoning: model.reasoning,
    ...(model.reasoning && (effort || model.thinkingLevelMap?.off !== null) ? { thinking: !!effort } : {}),
    ...(model.reasoning && effort ? { effort: model.thinkingLevelMap?.[effort] ?? effort } : {}),
  };
}

const hasToolHistory = (messages: readonly Message[]) =>
  messages.some((m) => m.role === "toolResult" || (m.role === "assistant" && m.content.some((c) => c.type === "toolCall")));

function chatMessages(model: Model, context: Context): DeepSeekMessage[] {
  const out: DeepSeekMessage[] = [];
  if (context.system.length > 0) out.push({ role: "system", content: sanitizeSurrogates(context.system) });
  const messages = replayable(model, context.messages);
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    switch (m.role) {
      case "user": {
        if (typeof m.content === "string") {
          out.push({ role: "user", content: sanitizeSurrogates(m.content) });
          break;
        }
        const parts = m.content
          .filter((c) => c.type !== "text" || c.text.length > 0)
          .map((c): DeepSeekContent => (c.type === "text" ? { type: "text", text: sanitizeSurrogates(c.text) } : { type: "image", url: dataUrl(c) }));
        if (parts.length > 0) out.push({ role: "user", content: parts });
        break;
      }
      case "assistant": {
        const said = assistantMessage(m);
        if (said) out.push(said);
        break;
      }
      case "toolResult": {
        // A turn's results go together; images, for a model that reads them, follow as one user message.
        const images: DeepSeekContent[] = [];
        let j = i;
        for (let r = messages[j]; r?.role === "toolResult"; r = messages[++j]) {
          const text = r.content
            .filter((c): c is TextContent => c.type === "text")
            .map((c) => c.text)
            .join("\n");
          const hasImages = r.content.some((c) => c.type === "image");
          out.push({
            role: "tool",
            content: sanitizeSurrogates(text || (hasImages ? "(see attached image)" : "(no tool output)")),
            toolCallId: r.toolCallId,
          });
          if (hasImages && model.input.includes("image")) for (const c of r.content) if (c.type === "image") images.push({ type: "image", url: dataUrl(c) });
        }
        i = j - 1;
        if (images.length > 0) out.push({ role: "user", content: [{ type: "text", text: "Attached image(s) from tool result:" }, ...images] });
        break;
      }
    }
  }
  return out;
}

function assistantMessage(m: AssistantMessage): DeepSeekMessage | undefined {
  const text = m.content
    .filter((c): c is TextContent => c.type === "text" && c.text.trim().length > 0)
    .map((c) => sanitizeSurrogates(c.text))
    .join("");
  const thinking = m.content.filter((c): c is ThinkingContent => c.type === "thinking" && c.thinking.trim().length > 0);
  const calls = m.content.filter((c): c is ToolCall => c.type === "toolCall");
  if (text.length === 0 && calls.length === 0) return undefined;
  const signature = thinking[0]?.thinkingSignature;
  return {
    role: "assistant",
    content: text || null,
    ...(signature ? { reasoning: { signature, text: thinking.map((c) => c.thinking).join("\n") } } : {}),
    calls: calls.map((c) => ({ id: c.id, name: c.name, arguments: JSON.stringify(c.arguments) })),
  };
}

const dataUrl = (c: ImageContent) => `data:${c.mimeType};base64,${c.data}`;

/** What is sent, as pi-ai's transformMessages leaves it. */
function replayable(model: Model, messages: readonly Message[]): Message[] {
  const out: Message[] = [];
  let pending: readonly ToolCall[] = [];
  let answered = new Set<string>();
  const close = () => {
    for (const c of pending)
      if (!answered.has(c.id))
        out.push({
          role: "toolResult",
          toolCallId: c.id,
          toolName: c.name,
          content: [{ type: "text", text: "No result provided" }],
          isError: true,
          timestamp: 0,
        });
    pending = [];
    answered = new Set();
  };
  for (const m of messages.map((m) => downgradeImages(model, m))) {
    switch (m.role) {
      case "assistant": {
        close();
        if (m.stopReason === "error" || m.stopReason === "aborted") break;
        const same = m.provider === model.provider && m.api === model.api && m.model === model.id;
        const content = m.content.filter((c) => c.type !== "thinking" || (same && (!!c.thinkingSignature || c.thinking.trim() !== "")));
        const calls = content.filter((c): c is ToolCall => c.type === "toolCall");
        if (calls.length > 0) pending = calls;
        out.push({ ...m, content });
        break;
      }
      case "toolResult":
        answered.add(m.toolCallId);
        out.push(m);
        break;
      case "user":
        close();
        out.push(m);
        break;
    }
  }
  close();
  return out;
}

function downgradeImages(model: Model, m: Message): Message {
  if (model.input.includes("image")) return m;
  if (m.role === "user" && typeof m.content !== "string") return { ...m, content: withoutImages(m.content, userImageOmitted) };
  if (m.role === "toolResult") return { ...m, content: withoutImages(m.content, toolImageOmitted) };
  return m;
}

/** Each run of images is one note. */
function withoutImages(content: readonly (TextContent | ImageContent)[], note: string): TextContent[] {
  const out: TextContent[] = [];
  let noted = false;
  for (const c of content) {
    if (c.type === "image") {
      if (!noted) out.push({ type: "text", text: note });
      noted = true;
      continue;
    }
    out.push(c);
    noted = c.text === note;
  }
  return out;
}

// pi-ai's estimate: 3.5 characters a token, an image as 4800 characters; after the last answer that reported usage, that
// usage plus what came after it.
const charsPerToken = 3.5;
const imageChars = 4800;
const contextSafetyTokens = 4096;

function clampMaxTokens(model: Model, context: Context, maxTokens: number): number {
  if (model.contextWindow <= 0) return Math.max(1, maxTokens);
  const available = model.contextWindow - estimateTokens(context) - contextSafetyTokens;
  return Math.min(maxTokens, Math.max(1, available));
}

const textTokens = (text: string) => Math.ceil(text.length / charsPerToken);

const contentTokens = (content: string | readonly (TextContent | ImageContent)[]) =>
  Math.ceil((typeof content === "string" ? content.length : content.reduce((n, c) => n + (c.type === "text" ? c.text.length : imageChars), 0)) / charsPerToken);

function messageTokens(m: Message): number {
  if (m.role !== "assistant") return contentTokens(m.content);
  let chars = 0;
  for (const c of m.content)
    chars += c.type === "text" ? c.text.length : c.type === "thinking" ? c.thinking.length : c.name.length + JSON.stringify(c.arguments).length;
  return Math.ceil(chars / charsPerToken);
}

const usageTokens = (u: Usage) => (u.totalTokens > 0 ? u.totalTokens : u.input + u.output + u.cacheRead + u.cacheWrite);

function estimateTokens(context: Context): number {
  // The system prompt leads at timestamp 0, as pi-ai's leading system message does.
  const head = textTokens(context.system) + (context.tools.length > 0 ? textTokens(JSON.stringify(context.tools)) : 0);
  let latest = 0;
  let last: { readonly at: number; readonly usage: Usage } | undefined;
  context.messages.forEach((m, i) => {
    if (m.role === "assistant" && m.timestamp >= latest && m.stopReason !== "aborted" && m.stopReason !== "error" && usageTokens(m.usage) > 0)
      last = { at: i, usage: m.usage };
    latest = Math.max(latest, m.timestamp);
  });
  if (!last) return context.messages.reduce((n, m) => n + messageTokens(m), head);
  return context.messages.slice(last.at + 1).reduce((n, m) => n + messageTokens(m), usageTokens(last.usage));
}
