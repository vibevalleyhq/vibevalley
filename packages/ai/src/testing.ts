import { Effect, Layer, Ref, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { Llm, type LlmShape } from "./llm.ts";
import type { AssistantMessage, Context, StopReason, TextContent, ThinkingContent, ToolCall, Usage } from "./messages.ts";
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

export const assistantMessage = (
  content: string | readonly (TextContent | ThinkingContent | ToolCall)[],
  more: Partial<Omit<AssistantMessage, "role" | "content">> = {},
): AssistantMessage => {
  const blocks = typeof content === "string" ? [text(content)] : content;
  return {
    role: "assistant",
    content: blocks,
    api: testModel.api,
    provider: testModel.provider,
    model: testModel.id,
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

export type Reply = (request: Request) => Answer | Promise<Answer>;

export type Step = Answer | Reply;

export interface Request extends Context {
  readonly model: Model;
  readonly options: RequestOptions;
}

export const testModel: Model = models[0]!;

/** The events an answer streams as, a text a character at a time (enough to see a stream move). */
function eventsOf(model: Model, a: Answer, timestamp: number): { events: AssistantMessageEvent[]; hangsAt: number | undefined } {
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

/** Each request takes the next step, its events a tick apart as a stream's; one past the script is a failed answer
 * saying so. */
export const scriptedLlm = Effect.fnUntraced(function* (steps: readonly Step[]) {
  const script = [...steps];
  const next = yield* Ref.make(0);
  const requests: Request[] = [];
  const llm: LlmShape = {
    stream: (model, context, options) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const request: Request = { ...structuredClone(context), model, options };
          requests.push(request);
          const i = yield* Ref.getAndUpdate(next, (n) => n + 1);
          const step = script[i];
          const made =
            step === undefined
              ? answer("", { stopReason: "error", errorMessage: `the script has no answer ${i + 1}` })
              : typeof step === "function"
                ? step(request)
                : step;
          const a = made instanceof Promise ? yield* Effect.promise(() => made) : made;
          const { events, hangsAt } = eventsOf(model, a, 0);
          const told = Stream.mapEffect(Stream.fromIterable(hangsAt === undefined ? events : events.slice(0, hangsAt)), (e) => Effect.as(Effect.yieldNow, e));
          return hangsAt === undefined ? told : Stream.concat(told, Stream.never);
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
  return {
    llm,
    requests,
    layer: Layer.succeed(Llm, llm),
    append: (...more: readonly Step[]) => void script.push(...more),
    /** Steps no request has taken yet. */
    pending: Effect.map(Ref.get(next), (n) => Math.max(script.length - n, 0)),
  };
});

/** One chat/completions stream chunk, as DeepSeek writes it. */
export const chunk = (delta: Record<string, unknown>, finish: string | null = null, more: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ id: "r", model: "deepseek-flash", choices: [{ index: 0, delta, finish_reason: finish }], ...more })}\n\n`;

export interface Sent {
  url: string;
  authorization: string | undefined;
  body: unknown;
}

export const http = (sent: Sent[], body: string | ReadableStream<Uint8Array>, status = 200) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) => {
      const b = request.body;
      sent.push({
        url: url.toString(),
        authorization: request.headers.authorization,
        body: b._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(b.body)) : undefined,
      });
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status })));
    }),
  );
