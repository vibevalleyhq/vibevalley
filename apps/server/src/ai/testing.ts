// A model for tests: it answers each request from a script, streamed as the real one streams (llm.ts), and keeps every
// request as it was asked. No network.

import { Effect, Layer, Ref, Stream } from "effect";
import { Llm, type LlmShape } from "./llm.ts";
import type { AssistantMessage, Context, StopReason, TextContent, ThinkingContent, ToolCall } from "./messages.ts";
import { zeroUsage } from "./messages.ts";
import type { Model } from "./models.ts";
import { models } from "./models.ts";
import type { RequestOptions } from "./request.ts";
import type { AssistantMessageEvent } from "./response.ts";

export const text = (t: string): TextContent => ({ type: "text", text: t });
export const thinking = (t: string): ThinkingContent => ({ type: "thinking", thinking: t, thinkingSignature: "reasoning_content" });
export const toolCall = (name: string, args: Record<string, unknown>, id?: string): ToolCall => ({
  type: "toolCall",
  id: id ?? `call_${name}`,
  name,
  arguments: args,
});

/** What the script answers one request with: an answer's content (a string is its text), or how the answer stops. */
export interface Answer {
  readonly content: readonly (TextContent | ThinkingContent | ToolCall)[];
  readonly stopReason?: Extract<StopReason, "stop" | "length" | "toolUse" | "error">;
  readonly errorMessage?: string;
  /** The answer streams this many characters of its text, then waits until the request is stopped. */
  readonly hangAfter?: number;
}

export const answer = (content: string | readonly (TextContent | ThinkingContent | ToolCall)[], more: Omit<Answer, "content"> = {}): Answer => ({
  content: typeof content === "string" ? [text(content)] : content,
  ...more,
});

/** A step of the script: an answer, or one made from the request. */
export type Step = Answer | ((request: Request) => Answer);

export interface Request {
  readonly model: Model;
  readonly context: Context;
  readonly options: RequestOptions;
}

export const testModel: Model = models[0]!;

/** The events an answer streams as, a text a character at a time (enough to see a stream move). */
function eventsOf(model: Model, a: Answer, timestamp: number): { events: AssistantMessageEvent[]; hangsAt: number | undefined } {
  const content: (TextContent | ThinkingContent | ToolCall)[] = [];
  const calls = a.content.some((c) => c.type === "toolCall");
  const stopReason: StopReason = a.stopReason ?? (calls ? "toolUse" : "stop");
  const message = (): AssistantMessage => ({
    role: "assistant",
    content: content.map((c) => ({ ...c })),
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason,
    timestamp,
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
      const now = content[i]!;
      content[i] = now.type === "text" ? text(now.text + ch) : { ...(now as ThinkingContent), thinking: (now as ThinkingContent).thinking + ch };
      events.push({ type: `${kind}_delta`, contentIndex: i, delta: ch, partial: message() });
      if (kind === "text" && a.hangAfter !== undefined && ++streamed === a.hangAfter) hangsAt = events.length;
    }
    events.push({ type: `${kind}_end`, contentIndex: i, content: whole, partial: message() });
  }
  events.push(stopReason === "error" ? { type: "error", reason: "error", error: message() } : { type: "done", reason: stopReason, message: message() });
  return { events, hangsAt };
}

/** A scripted model: each request takes the next step; one past the script is a failed answer saying so. */
export const scriptedLlm = Effect.fnUntraced(function* (steps: readonly Step[]) {
  const next = yield* Ref.make(0);
  const requests: Request[] = [];
  const llm: LlmShape = {
    stream: (model, context, options) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const request: Request = { model, context: structuredClone(context), options };
          requests.push(request);
          const i = yield* Ref.getAndUpdate(next, (n) => n + 1);
          const step = steps[i];
          const a =
            step === undefined
              ? answer("", { stopReason: "error", errorMessage: `the script has no answer ${i + 1}` })
              : typeof step === "function"
                ? step(request)
                : step;
          const { events, hangsAt } = eventsOf(model, a, 0);
          return hangsAt === undefined ? Stream.fromIterable(events) : Stream.concat(Stream.fromIterable(events.slice(0, hangsAt)), Stream.never);
        }),
      ),
    // The script never fails on the wire: its failures are error answers, as a model's are.
    complete: (model, context, options) =>
      Stream.runLast(llm.stream(model, context, options)).pipe(
        Effect.orDie,
        Effect.map((last) => {
          const e = last._tag === "Some" ? last.value : undefined;
          if (e?.type === "done") return e.message;
          if (e?.type === "error") return e.error;
          throw new Error("a scripted stream ends with done or error");
        }),
      ),
  };
  return { llm, requests, layer: Layer.succeed(Llm, llm) };
});
