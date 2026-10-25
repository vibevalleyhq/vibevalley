// The model the agent talks to, and MCP servers in the shape Claude Code and Cursor use:
// { "mcpServers": { name: { command, args, env } | { url } } }.

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Message, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { readFileSync } from "node:fs";
import { getModel, models } from "../../ai/models.ts";

export const defaultModel = "deepseek-flash";

/** Said for the command line; the farm says where to put one in the app. */
export const noDeepSeekKey = "没有 DeepSeek 的密钥：设 DEEPSEEK_API_KEY，或者写进 vibevalley.yaml 的 deepseek.api_key。";

export interface LLM {
  readonly model: Model<Api>;
  readonly stream: StreamFn;
  /** Asked before each request (and each summary), so a key changed meanwhile is used at once. */
  readonly apiKey?: () => string | undefined;
}

/** id empty is defaultModel; the key is the caller's to find. */
export function deepseek(id: string, key: string | (() => string | undefined)): LLM {
  const apiKey = typeof key === "string" ? () => key : key;
  if (!apiKey()) throw new Error(noDeepSeekKey);
  const name = id || defaultModel;
  const known = getModel("deepseek", name);
  const model = known ?? { ...models.find((m) => m.id === defaultModel)!, id: name, name };
  return { model: model as Model<Api>, stream: streamSimple as unknown as StreamFn, apiKey };
}

/** One answer, whole. */
export async function complete(llm: LLM, messages: Message[], options: SimpleStreamOptions = {}): Promise<AssistantMessage> {
  const stream = await llm.stream(llm.model, { messages } as Parameters<StreamFn>[1], {
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

/** A missing file has none; one that is not JSON is an error. */
export function readMcpConfig(path: string): McpServer[] {
  let data = "{}";
  try {
    data = readFileSync(path, "utf8");
  } catch {
    data = "{}";
  }
  let config: { mcpServers?: Record<string, McpEntry> };
  try {
    if (data.trim() === "") throw new Error("empty");
    config = JSON.parse(data) as typeof config;
  } catch {
    throw new Error(`${path} 不是 JSON`);
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
