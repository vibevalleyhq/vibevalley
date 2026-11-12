import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Message,
  Model,
  StopReason,
  TextContent,
  ThinkingContent,
  ThinkingLevel,
  Tool,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";

import { reasonOf, throwIfAborted } from "@vibevalley/async";

import { messageText, type ModelMessage } from "#/modules/runtime/durable.ts";

export const text = (t: string): TextContent => ({ type: "text", text: t });
export const thinking = (t: string): ThinkingContent => ({ type: "thinking", thinking: t, thinkingSignature: "reasoning_content" });
export const toolCall = (name: string, args: ToolCall["arguments"], id?: string): ToolCall => ({
  type: "toolCall",
  id: id ?? `call_${name}`,
  name,
  arguments: args,
});

const zeroUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/** An answer as DeepSeek's would be kept, for a test that builds a turn by hand. */
export const assistantMessage = (
  content: string | readonly (TextContent | ThinkingContent | ToolCall)[],
  more: Partial<Omit<AssistantMessage, "role" | "content">> = {},
): AssistantMessage => {
  const blocks = typeof content === "string" ? [text(content)] : [...content];
  return {
    role: "assistant",
    content: blocks,
    api: "openai-completions",
    provider: "deepseek",
    model: "deepseek-flash",
    usage: zeroUsage(),
    stopReason: blocks.some((c) => c.type === "toolCall") ? "toolUse" : "stop",
    timestamp: 0,
    ...more,
  };
};

/** What the script answers one request with: an answer's content (a string is its text), or how the answer stops. */
export interface Answer {
  readonly content: readonly (TextContent | ThinkingContent | ToolCall)[];
  readonly stopReason?: Extract<StopReason, "stop" | "length" | "toolUse" | "error">;
  readonly errorMessage?: string;
  /** The answer streams this many characters of its text, then waits until the request is stopped. */
  readonly hangAfter?: number;
  /** On every event from its start, so an answer cut off has it too. */
  readonly usage?: { readonly input: number; readonly output: number; readonly cacheRead?: number };
}

export const answer = (content: string | readonly (TextContent | ThinkingContent | ToolCall)[], more: Omit<Answer, "content"> = {}): Answer => ({
  content: typeof content === "string" ? [text(content)] : content,
  ...more,
});

/** One request as the model is asked it: the prompt and tools the transcript leads with, and the messages. */
export interface Request {
  readonly system: string;
  readonly tools: readonly Tool[];
  readonly messages: readonly ModelMessage[];
  readonly model: Model<Api>;
  readonly options: { readonly reasoning?: ThinkingLevel; readonly maxTokens?: number };
}

export type Reply = (request: Request) => Answer | Promise<Answer>;

export type Step = Answer | Reply;

/** A model a test seats on the farm's DeepSeek: each request streams its answer's events. */
export interface ScriptedModel {
  readonly stream: (request: Request, signal?: AbortSignal) => AsyncIterable<AssistantMessageEvent>;
}

export const systemPrompt = (r: Request) => r.system;
export const toolsOf = (r: Request) => r.tools;
export const lastUser = (r: { readonly messages: readonly Message[] }) => {
  const m = r.messages.findLast((x) => x.role === "user");
  return m?.role === "user" ? messageText(m) : "";
};

/** The events an answer streams as, a text a character at a time (enough to see a stream move). */
function eventsOf(model: Model<Api>, a: Answer): { events: AssistantMessageEvent[]; hangsAt: number | undefined } {
  const content: (TextContent | ThinkingContent | ToolCall)[] = [];
  const calls = a.content.some((c) => c.type === "toolCall");
  const stopReason: StopReason = a.stopReason ?? (calls ? "toolUse" : "stop");
  const cacheRead = a.usage?.cacheRead ?? 0;
  const usage = (): Usage =>
    a.usage
      ? { ...zeroUsage(), input: a.usage.input, output: a.usage.output, cacheRead, totalTokens: a.usage.input + a.usage.output + cacheRead }
      : zeroUsage();
  const message = (): AssistantMessage => ({
    role: "assistant",
    content: content.map((c) => ({ ...c })),
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: usage(),
    stopReason,
    timestamp: 0,
    ...(a.errorMessage !== undefined ? { errorMessage: a.errorMessage } : {}),
  });
  const events: AssistantMessageEvent[] = [{ type: "start", partial: message() }];
  let hangsAt: number | undefined;
  let streamed = 0;
  for (const block of a.content) {
    const i = content.length;
    if (block.type === "toolCall") {
      content.push(block);
      events.push({ type: "toolcall_start", contentIndex: i, partial: message() });
      events.push({ type: "toolcall_delta", contentIndex: i, delta: JSON.stringify(block.arguments), partial: message() });
      events.push({ type: "toolcall_end", contentIndex: i, toolCall: block, partial: message() });
      continue;
    }
    const kind = block.type;
    const whole = kind === "text" ? block.text : block.thinking;
    content.push(kind === "text" ? text("") : { ...block, thinking: "" });
    events.push({ type: `${kind}_start`, contentIndex: i, partial: message() });
    for (const ch of whole) {
      const now = content[i];
      if (now?.type === "text") content[i] = text(now.text + ch);
      else if (now?.type === "thinking") content[i] = { ...now, thinking: now.thinking + ch };
      events.push({ type: `${kind}_delta`, contentIndex: i, delta: ch, partial: message() });
      if (kind === "text" && a.hangAfter !== undefined && ++streamed === a.hangAfter) hangsAt = events.length;
    }
    events.push({ type: `${kind}_end`, contentIndex: i, content: whole, partial: message() });
  }
  events.push(stopReason === "error" ? { type: "error", reason: "error", error: message() } : { type: "done", reason: stopReason, message: message() });
  return { events, hangsAt };
}

/** A turn of the event loop: a scripted stream's events come a tick apart, as a stream's do. */
const aTick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Never resolves; rejects with the signal's reason once it aborts. */
const hang = (signal: AbortSignal | undefined) =>
  new Promise<never>((_, reject) => {
    if (signal === undefined) return;
    if (signal.aborted) reject(reasonOf(signal));
    signal.addEventListener("abort", () => reject(reasonOf(signal)), { once: true });
  });

/** Each request takes the next step, its events a tick apart as a stream's; one past the script is a failed answer
 * saying so. */
export function scriptedLLM(steps: readonly Step[] = []) {
  const script = [...steps];
  let next = 0;
  const requests: Request[] = [];
  async function* stream(request: Request, signal?: AbortSignal): AsyncGenerator<AssistantMessageEvent> {
    requests.push(request);
    const i = next++;
    const step = script[i];
    const a =
      step === undefined
        ? answer("", { stopReason: "error", errorMessage: `the script has no answer ${i + 1}` })
        : typeof step === "function"
          ? await step(request)
          : step;
    const { events, hangsAt } = eventsOf(request.model, a);
    for (const e of hangsAt === undefined ? events : events.slice(0, hangsAt)) {
      await aTick();
      throwIfAborted(signal);
      yield e;
    }
    if (hangsAt !== undefined) await hang(signal);
  }
  const llm: ScriptedModel = { stream };
  return {
    llm,
    requests,
    append: (...more: readonly Step[]) => void script.push(...more),
    /** Steps no request has taken yet. */
    pending: () => Math.max(script.length - next, 0),
  };
}
