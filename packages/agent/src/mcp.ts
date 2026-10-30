// MCP servers' tools for the agent. Only initialize, tools/list (every page) and tools/call: no resources, prompts or
// sampling. A server that cannot be reached is left out and said why; the others still come.

import { existsSync, readFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Schema, Option } from "effect";

import type { JsonSchema } from "@vibevalley/ai/tools";

import { messageOf } from "./core/errors.ts";
import type { Tool } from "./core/loop.ts";
import { textTool } from "./core/tool.ts";
import { asTransport } from "./mcpTransport.ts";
import { mcpConfig, mcp as mcpWords } from "./prompts.ts";
import { afterRealTime } from "./realTime.ts";

/** Also for connecting. */
const callTimeoutMs = 120_000;

// A tool's result as its server sends it: only the fields read here, the rest let through.
const Block = Schema.Struct({
  type: Schema.String,
  text: Schema.optionalKey(Schema.String),
  resource: Schema.optionalKey(Schema.Struct({ text: Schema.optionalKey(Schema.String), uri: Schema.optionalKey(Schema.String) })),
});
type Block = typeof Block.Type;
const contentOf = Schema.decodeUnknownOption(Schema.Array(Block));

export function mcpContentText(content: readonly Block[]): string {
  const parts: string[] = [];
  for (const block of content) {
    switch (block.type) {
      case "text":
        parts.push(block.text ?? "");
        break;
      case "image":
        parts.push("[image]");
        break;
      case "audio":
        parts.push("[audio]");
        break;
      case "resource_link":
        parts.push("[resource_link]");
        break;
      case "resource":
        if (block.resource?.text) parts.push(block.resource.text);
        else if (block.resource?.uri) parts.push("[" + block.resource.uri + "]");
        else parts.push(mcpWords.resourceBlock);
        break;
    }
  }
  return parts.join("\n").trim();
}

/** The server's name first, only the characters function names allow. */
export const mcpToolName = (server: string, tool: string) => (server + "__" + tool).replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 64);

export interface McpConnection {
  readonly tools: Tool[];
  close(): Promise<void>;
}

const timeout = <A>(p: Promise<A>, ms: number, signal?: AbortSignal) =>
  new Promise<A>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error("canceled"));
      return;
    }
    let settled = false;
    const finish = (f: () => void) => {
      if (settled) return;
      settled = true;
      cancelTimer();
      signal?.removeEventListener("abort", abort);
      f();
    };
    const cancelTimer = afterRealTime(ms, () => finish(() => reject(new Error("timed out"))));
    const abort = () => finish(() => reject(new Error("canceled")));
    signal?.addEventListener("abort", abort, { once: true });
    p.then(
      (value) => finish(() => resolve(value)),
      (e: unknown) => finish(() => reject(e)),
    );
  });

async function connectMcp(server: McpServer, signal?: AbortSignal): Promise<McpConnection> {
  if (signal?.aborted === true) throw new Error("canceled");
  let stderr = "";
  let transport: Transport;
  if (server.url) {
    transport = asTransport(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: server.headers ?? {} },
      }),
    );
  } else {
    const stdio = new StdioClientTransport({
      command: server.command ?? "",
      args: server.args ?? [],
      env: {
        ...getDefaultEnvironment(),
        ...Object.fromEntries(Object.entries(process.env).flatMap(([k, v]) => (v === undefined ? [] : [[k, v]]))),
        ...server.env,
      },
      ...(server.cwd ? { cwd: server.cwd } : {}),
      stderr: "pipe",
    });
    // Keeps the end of a server's stderr, to say why it went.
    stdio.stderr?.on("data", (b: Buffer) => {
      stderr = (stderr + b.toString("utf8")).slice(-2000);
    });
    transport = stdio;
  }
  const fail = (e: unknown) => {
    const last = stderr.trim().split("\n").at(-1) ?? "";
    return new Error(mcpWords.connectFailed(server.name, messageOf(e), last));
  };
  const client = new Client({ name: "vibevalley-agent", version: "0.1.0" });
  const close = async () => {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  };
  try {
    await timeout(client.connect(transport), callTimeoutMs, signal);
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each page's cursor comes with the page before
      const page = await timeout(client.listTools(cursor ? { cursor } : {}), callTimeoutMs, signal);
      for (const t of page.tools) tools.push(mcpTool(client, server.name, t));
      cursor = page.nextCursor;
    } while (cursor);
    return { tools, close };
  } catch (e) {
    await close();
    throw fail(e);
  }
}

function mcpTool(client: Client, server: string, t: { name: string; description?: string | undefined; inputSchema?: object | undefined }): Tool {
  const parameters: JsonSchema = t.inputSchema ? Object.fromEntries(Object.entries(t.inputSchema)) : { type: "object", properties: {} };
  return textTool<Record<string, unknown> | null>({
    name: mcpToolName(server, t.name),
    description: mcpWords.toolDescription(server, t.description || t.name),
    parameters,
    run: async (params, tc) => {
      let r: Awaited<ReturnType<Client["callTool"]>>;
      try {
        r = await client.callTool({ name: t.name, arguments: params ?? {} }, undefined, {
          timeout: callTimeoutMs,
          signal: tc.signal,
        });
      } catch (e) {
        throw new Error(mcpWords.callFailed(server, t.name, messageOf(e)), { cause: e });
      }
      let text = mcpContentText(Option.getOrElse(contentOf(r.content), () => []));
      if (text === "") text = r.structuredContent !== undefined ? JSON.stringify(r.structuredContent) : mcpWords.noContent;
      if (r.isError === true) throw new Error(text);
      return text;
    },
  });
}

export interface McpConnections {
  readonly tools: Tool[];
  readonly failed: string[];
  close(): Promise<void>;
}

export async function connectAll(servers: readonly McpServer[], signal?: AbortSignal): Promise<McpConnections> {
  const outcomes = await Promise.allSettled(servers.map((s) => connectMcp(s, signal)));
  const connections: McpConnection[] = [];
  const failed: string[] = [];
  for (const o of outcomes) {
    if (o.status === "fulfilled") connections.push(o.value);
    else failed.push(o.reason instanceof Error ? o.reason.message : String(o.reason));
  }
  return {
    tools: connections.flatMap((c) => c.tools),
    failed,
    close: async () => void (await Promise.all(connections.map((c) => c.close()))),
  };
}

/** MCP servers in the shape Claude Code and Cursor use: { "mcpServers": { name: { command, args, env } | { url } } }. */
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
  if (data.trim() === "") throw new Error(mcpConfig.notJson(path));
  let config: { mcpServers?: Record<string, McpEntry> };
  try {
    config = Schema.decodeSync(McpConfigSchema)(data);
  } catch (e) {
    throw new Error(mcpConfig.badShape(path, String(e)), { cause: e });
  }
  const entries = config.mcpServers ?? {};
  const out: McpServer[] = [];
  for (const name of Object.keys(entries).toSorted()) {
    const e = entries[name]!;
    if (e.disabled === true) continue;
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
