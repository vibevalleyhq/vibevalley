// A chat/completions request for DeepSeek, as pi-ai 1.3.0's openai-completions builds one for it
// (testdata/deepseek.jsonl.gz holds what pi-ai sent; a change here is a change in what the model reads and caches).

import type { AssistantMessage, Context, ImageContent, Message, TextContent, ToolCall, ToolResultMessage, Usage } from "./messages.ts";
import { clampThinkingLevel, type Model, type ThinkingLevel } from "./models.ts";

export interface RequestOptions {
  /** Off or none: thinking is turned off, where the model lets it be. */
  readonly reasoning?: ThinkingLevel;
  readonly maxTokens?: number;
  readonly toolChoice?: "auto" | "none";
}

const userImageOmitted = "(image omitted: model does not support images)";
const toolImageOmitted = "(tool image omitted: model does not support images)";
const reasoningFields = new Set(["reasoning", "reasoning_content", "reasoning_text"]);

/** Unpaired surrogates fail the provider's JSON; paired ones (emoji) stay. */
export const sanitizeSurrogates = (text: string) => text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");

export function requestBody(model: Model, context: Context, options: RequestOptions = {}): Record<string, unknown> {
  const clamped = options.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
  const effort = clamped === "off" ? undefined : clamped;
  const body: Record<string, unknown> = {
    model: model.id,
    messages: chatMessages(model, context),
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: clampMaxTokens(model, context, options.maxTokens ?? model.maxTokens),
  };
  if (context.tools.length > 0)
    body.tools = context.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  else if (hasToolHistory(context.messages)) body.tools = [];
  if (options.toolChoice) body.tool_choice = options.toolChoice;
  if (model.reasoning) {
    if (effort) body.thinking = { type: "enabled" };
    else if (model.thinkingLevelMap?.off !== null) body.thinking = { type: "disabled" };
    if (effort) body.reasoning_effort = model.thinkingLevelMap?.[effort] ?? effort;
  }
  return body;
}

const hasToolHistory = (messages: readonly Message[]) =>
  messages.some((m) => m.role === "toolResult" || (m.role === "assistant" && m.content.some((c) => c.type === "toolCall")));

function chatMessages(model: Model, context: Context): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (context.system.length > 0) out.push({ role: "system", content: sanitizeSurrogates(context.system) });
  const messages = replayable(model, context.messages);
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    switch (m.role) {
      case "user": {
        if (typeof m.content === "string") {
          out.push({ role: "user", content: sanitizeSurrogates(m.content) });
          break;
        }
        const parts = m.content
          .filter((c) => c.type !== "text" || c.text.length > 0)
          .map((c) => (c.type === "text" ? { type: "text", text: sanitizeSurrogates(c.text) } : { type: "image_url", image_url: { url: dataUrl(c) } }));
        if (parts.length > 0) out.push({ role: "user", content: parts });
        break;
      }
      case "assistant": {
        const said = assistantMessage(model, m);
        if (said) out.push(said);
        break;
      }
      case "toolResult": {
        // A turn's results go together; images, for a model that reads them, follow as one user message.
        const images: Record<string, unknown>[] = [];
        let j = i;
        for (; j < messages.length && messages[j]!.role === "toolResult"; j++) {
          const r = messages[j] as ToolResultMessage;
          const text = r.content
            .filter((c): c is TextContent => c.type === "text")
            .map((c) => c.text)
            .join("\n");
          const hasImages = r.content.some((c) => c.type === "image");
          out.push({
            role: "tool",
            content: sanitizeSurrogates(text || (hasImages ? "(see attached image)" : "(no tool output)")),
            tool_call_id: r.toolCallId,
          });
          if (hasImages && model.input.includes("image"))
            for (const c of r.content) if (c.type === "image") images.push({ type: "image_url", image_url: { url: dataUrl(c) } });
        }
        i = j - 1;
        if (images.length > 0) out.push({ role: "user", content: [{ type: "text", text: "Attached image(s) from tool result:" }, ...images] });
        break;
      }
    }
  }
  return out;
}

function assistantMessage(model: Model, m: AssistantMessage): Record<string, unknown> | undefined {
  const said: Record<string, unknown> = { role: "assistant", content: null };
  const text = m.content
    .filter((c): c is TextContent => c.type === "text" && c.text.trim().length > 0)
    .map((c) => sanitizeSurrogates(c.text))
    .join("");
  const thinking = m.content.filter((c) => c.type === "thinking" && c.thinking.trim().length > 0);
  const calls = m.content.filter((c): c is ToolCall => c.type === "toolCall");
  if (text.length > 0) said.content = text;
  const signature = thinking[0]?.type === "thinking" ? thinking[0].thinkingSignature : undefined;
  if (signature && reasoningFields.has(signature)) said[signature] = thinking.map((c) => (c.type === "thinking" ? c.thinking : "")).join("\n");
  if (calls.length > 0)
    said.tool_calls = calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } }));
  // DeepSeek wants it on every assistant message once thinking is in play.
  if (model.reasoning && said.reasoning_content === undefined) said.reasoning_content = "";
  if ((said.content === null || said.content === "") && !said.tool_calls) return undefined;
  return said;
}

const dataUrl = (c: ImageContent) => `data:${c.mimeType};base64,${c.data}`;

/** What is sent, as pi-ai's transformMessages leaves it: images a model cannot read become a note, thinking from another
 * model goes, a turn that failed or was stopped is not replayed, and a call that got no result gets one. */
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

const usageTokens = (u: Usage) => u.totalTokens || u.input + u.output + u.cacheRead + u.cacheWrite;

function estimateTokens(context: Context): number {
  // The system prompt leads at timestamp 0, as pi-ai's leading system message does.
  const head = textTokens(context.system) + (context.tools.length > 0 ? textTokens(JSON.stringify(context.tools)) : 0);
  let latest = 0;
  let last = -1;
  context.messages.forEach((m, i) => {
    if (m.role === "assistant" && m.timestamp >= latest && m.stopReason !== "aborted" && m.stopReason !== "error" && usageTokens(m.usage) > 0) last = i;
    latest = Math.max(latest, m.timestamp);
  });
  if (last < 0) return context.messages.reduce((n, m) => n + messageTokens(m), head);
  return context.messages.slice(last + 1).reduce((n, m) => n + messageTokens(m), usageTokens((context.messages[last] as AssistantMessage).usage));
}
