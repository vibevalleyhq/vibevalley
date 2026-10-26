// The model the agent talks to, and MCP servers in the shape Claude Code and Cursor use:
// { "mcpServers": { name: { command, args, env } | { url } } }.

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { existsSync, readFileSync } from "node:fs";
import { Clock, Effect, Schema, Stream } from "effect";
import { failedMessage, type LlmShape } from "../../ai/llm.ts";
import { type AssistantMessage as Answer, type Context as LlmContext, type Message as LlmMessage, type ToolDeclaration, zeroUsage } from "../../ai/messages.ts";
import { getModel, type Model, models } from "../../ai/models.ts";

export const defaultModel = "deepseek-flash";

/** Said for the command line; the farm says where to put one in the app. */
export const noDeepSeekKey = "没有 DeepSeek 的密钥：设 DEEPSEEK_API_KEY，或者写进 vibevalley.yaml 的 deepseek.api_key。";

export interface LLM {
  readonly model: Model;
  readonly stream: StreamFn;
  /** Asked before each request (and each summary), so a key changed meanwhile is used at once. */
  readonly apiKey?: () => string | undefined;
}

/** id empty is defaultModel; the key is the caller's to find. */
export function deepseek(id: string, key: string | (() => string | undefined), stream: StreamFn): LLM {
  const apiKey = typeof key === "string" ? () => key : key;
  if (!apiKey()) throw new Error(noDeepSeekKey);
  const name = id || defaultModel;
  const known = getModel("deepseek", name);
  const model = known ?? { ...models.find((m) => m.id === defaultModel)!, id: name, name };
  return { model, stream, apiKey };
}

/** Runs an Effect to its answer on fibers someone owns; the signal interrupts it. */
export type RunWithSignal = <A>(effect: Effect.Effect<A>, options?: { readonly signal?: AbortSignal }) => Promise<A>;

/** pi-agent-core's request, made by the farm's Llm, until the loop is the farm's own too
 * (.agents/notes/proposed/architecture/2026-10-27-pi-in-effect.md). pi-agent-core leads with one system message: the
 * prompt and the tools. A stopped request ends as pi-ai's does, aborted with what had come. */
export const llmStreamFn =
  (llm: LlmShape, run: RunWithSignal): StreamFn =>
  (model, context, options) => {
    const out = new AssistantMessageEventStream();
    const ours = model as unknown as Model;
    const [head, ...rest] = context.messages;
    const system = head?.role === "system" ? head : undefined;
    const asked: LlmContext = {
      system: typeof system?.content === "string" ? system.content : (system?.content.map((c) => c.text).join("\n") ?? ""),
      tools: (system?.toolsAdded ?? []) as unknown as ToolDeclaration[],
      messages: (system ? rest : context.messages) as unknown as LlmMessage[],
    };
    let partial: Answer | undefined;
    let started = 0;
    const push = (e: unknown) => out.push(e as Parameters<typeof out.push>[0]);
    const signal = options?.signal;
    run(
      Effect.gen(function* () {
        started = yield* Clock.currentTimeMillis;
        yield* llm
          .stream(ours, asked, {
            apiKey: options?.apiKey ?? "",
            ...(options?.reasoning ? { reasoning: options.reasoning } : {}),
            ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
          })
          .pipe(
            Stream.runForEach((e) =>
              Effect.sync(() => {
                if ("partial" in e) partial = e.partial;
                push(e);
              }),
            ),
            Effect.catchTag("LlmError", (e) => Effect.sync(() => push({ type: "error", reason: "error", error: failedMessage(ours, started, e) }))),
          );
      }),
      signal ? { signal } : undefined,
    ).catch((e: unknown) => {
      const base: Answer = partial ?? {
        role: "assistant",
        content: [],
        api: ours.api,
        provider: ours.provider,
        model: ours.id,
        usage: zeroUsage(),
        stopReason: "error",
        timestamp: started,
      };
      push(
        signal?.aborted
          ? { type: "error", reason: "aborted", error: { ...base, stopReason: "aborted", errorMessage: "Request was aborted" } }
          : { type: "error", reason: "error", error: { ...base, stopReason: "error", errorMessage: e instanceof Error ? e.message : String(e) } },
      );
    });
    return out;
  };

/** One answer, whole. */
export async function complete(llm: LLM, messages: Message[], options: SimpleStreamOptions = {}): Promise<AssistantMessage> {
  const stream = await llm.stream(llm.model as unknown as Parameters<StreamFn>[0], { messages } as Parameters<StreamFn>[1], {
    ...options,
    apiKey: llm.apiKey?.() ?? options.apiKey,
  });
  return stream.result();
}

export interface McpServer {
  readonly name: string;
  readonly url?: string;
  readonly headers?: Record<string, string>;
  readonly command?: string;
  readonly args?: string[];
  readonly env?: Record<string, string>;
  readonly cwd?: string;
}

interface McpEntry {
  readonly command?: string;
  readonly args?: string[];
  readonly env?: Record<string, string>;
  readonly cwd?: string;
  readonly url?: string;
  readonly headers?: Record<string, string>;
  readonly disabled?: boolean;
}

const McpEntrySchema: Schema.Codec<McpEntry> = Schema.Struct({
  command: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  cwd: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  disabled: Schema.optionalKey(Schema.Boolean),
});
const McpConfigSchema = Schema.fromJsonString(Schema.Struct({ mcpServers: Schema.optionalKey(Schema.Record(Schema.String, McpEntrySchema)) }));

/** A missing file has none; unreadable JSON or a wrong shape is an error. */
export function readMcpConfig(path: string): McpServer[] {
  const data = existsSync(path) ? readFileSync(path, "utf8") : "{}";
  if (data.trim() === "") throw new Error(`${path} 不是 JSON`);
  let config: { mcpServers?: Record<string, McpEntry> };
  try {
    config = Schema.decodeUnknownSync(McpConfigSchema)(data);
  } catch (e) {
    throw new Error(`${path} 不是 JSON 或配置形状不对：${String(e)}`, { cause: e });
  }
  const entries = config.mcpServers ?? {};
  const out: McpServer[] = [];
  for (const name of Object.keys(entries).sort()) {
    const e = entries[name]!;
    if (e.disabled) continue;
    if (e.url) out.push({ name, url: e.url, ...(e.headers ? { headers: e.headers } : {}) });
    else if (e.command)
      out.push({
        name,
        command: e.command,
        ...(e.args ? { args: e.args } : {}),
        ...(e.env ? { env: e.env } : {}),
        ...(e.cwd ? { cwd: e.cwd } : {}),
      });
  }
  return out;
}
