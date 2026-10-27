// The model the agent talks to, and MCP servers in the shape Claude Code and Cursor use:
// { "mcpServers": { name: { command, args, env } | { url } } }.

import { agentWording } from "../words.ts";
import { existsSync, readFileSync } from "node:fs";
import { type Effect, Schema } from "effect";
import type { LlmShape } from "../../ai/llm.ts";
import type { AssistantMessage, Context } from "../../ai/messages.ts";
import { getModel, type Model, models } from "../../ai/models.ts";
import type { RequestOptions } from "../../ai/request.ts";

export const defaultModel = "deepseek-flash";

/** Said for the command line; the farm says where to put one in the app. */
export const noDeepSeekKey = () => agentWording().noDeepSeekKey;

/** On fibers someone owns, so what it runs ends with them. */
export type RunWithSignal = <A, E>(effect: Effect.Effect<A, E>, options?: { readonly signal?: AbortSignal }) => Promise<A>;

/** The farm's Llm, and the fibers of whoever owns the agent: its runs and requests end with them. */
export interface LlmOn {
  readonly service: LlmShape;
  readonly run: RunWithSignal;
}

export interface LLM extends LlmOn {
  readonly model: Model;
  /** Asked before each request (and each summary), so a key changed meanwhile is used at once. */
  readonly apiKey?: () => string | undefined;
}

/** id empty is defaultModel; the key is the caller's to find. */
export function deepseek(id: string, key: string | (() => string | undefined), on: LlmOn): LLM {
  const apiKey = typeof key === "string" ? () => key : key;
  if (!apiKey()) throw new Error(noDeepSeekKey());
  const name = id || defaultModel;
  const known = getModel("deepseek", name);
  const model = known ?? { ...models.find((m) => m.id === defaultModel)!, id: name, name };
  return { model, apiKey, ...on };
}

/** One answer, whole; a failure is its error message. */
export const complete = (llm: LLM, context: Context, options: RequestOptions = {}): Effect.Effect<AssistantMessage> =>
  llm.service.complete(llm.model, context, { ...options, apiKey: llm.apiKey?.() ?? "" });

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
