import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

import type { JsonSchema } from "@vibevalley/ai/tools";

import { isRecord } from "../base/json.ts";
import { mcpConfig, mcp as mcpWords } from "../base/prompts.ts";
import { AgentFailed, messageOf, ToolFailed } from "../core/errors.ts";
import type { Tool } from "../core/loop.ts";
import { effectTool } from "../core/tool.ts";
import { type AgentFs, agentFsOf } from "./fs.ts";
import { type AgentLog, consoleLog } from "./log.ts";
import { asTransport } from "./mcpTransport.ts";
import { failAfterRealTime } from "./realTime.ts";

/** Also for connecting. */
const callTimeoutMs = 120_000;

// A tool's result as its server sends it: only the fields read here, the rest let through.
interface Block {
  readonly type: string;
  readonly text?: string;
  readonly resource?: { readonly text?: string; readonly uri?: string };
}
const Block = z.object({
  type: z.string(),
  text: z.exactOptional(z.string()),
  resource: z.exactOptional(z.object({ text: z.exactOptional(z.string()), uri: z.exactOptional(z.string()) })),
}) satisfies z.ZodType<Block>;
const Content = z.array(Block);

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

interface McpConnection {
  readonly tools: Tool[];
  readonly close: () => Promise<void>;
}

/** A server that could not be reached in time: its message is what mcpStatus says of it. */
class McpUnreachable extends Error {
  override readonly name = "McpUnreachable";
}

/** What start gives, or a failure after callTimeoutMs of real time; the request it started is not cancelled. */
async function withinCallTimeout<A>(start: () => Promise<A>): Promise<A> {
  const gaveUp = new AbortController();
  try {
    return await Promise.race([
      start().catch((cause: unknown) => {
        throw new McpUnreachable(messageOf(cause), { cause });
      }),
      failAfterRealTime(callTimeoutMs, () => new McpUnreachable("timed out"), gaveUp.signal),
    ]);
  } finally {
    gaveUp.abort();
  }
}

interface Opened {
  readonly transport: Transport;
  /** The last line the server wrote to stderr, to say why it went. */
  readonly lastStderr: () => string;
}

function openTransport(server: McpServer): Opened {
  if (server.url) {
    const transport = asTransport(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: server.headers ?? {} },
      }),
    );
    return { transport, lastStderr: () => "" };
  }
  let stderr = "";
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
  stdio.stderr?.on("data", (b: Buffer) => {
    stderr = (stderr + b.toString("utf8")).slice(-2000);
  });
  return { transport: stdio, lastStderr: () => stderr.trim().split("\n").at(-1) ?? "" };
}

/** Failed, what it opened is closed first. */
async function connectMcp(server: McpServer, log: AgentLog): Promise<McpConnection> {
  const { transport, lastStderr } = openTransport(server);
  const client = new Client({ name: "vibevalley-agent", version: "0.1.0" });
  const close = async () => {
    // Closing goes on whatever either half says: the server is going either way.
    await client.close().catch((e: unknown) => log.debug(`agent: closing MCP client ${server.name}:`, messageOf(e)));
    await transport.close().catch((e: unknown) => log.debug(`agent: closing MCP transport ${server.name}:`, messageOf(e)));
  };
  try {
    await withinCallTimeout(() => client.connect(transport));
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const asked = cursor ? { cursor } : {};
      const page = await withinCallTimeout(() => client.listTools(asked));
      for (const t of page.tools) tools.push(mcpTool(client, server.name, t));
      cursor = page.nextCursor;
    } while (cursor);
    return { tools, close };
  } catch (e) {
    await close();
    throw new McpUnreachable(mcpWords.connectFailed(server.name, messageOf(e), lastStderr()), { cause: e });
  }
}

function mcpTool(client: Client, server: string, t: { name: string; description?: string | undefined; inputSchema?: object | undefined }): Tool {
  const parameters: JsonSchema = t.inputSchema ? Object.fromEntries(Object.entries(t.inputSchema)) : { type: "object", properties: {} };
  return effectTool({
    name: mcpToolName(server, t.name),
    description: mcpWords.toolDescription(server, t.description || t.name),
    parameters,
    run: async (params, signal) => {
      let r: Awaited<ReturnType<Client["callTool"]>>;
      try {
        r = await client.callTool({ name: t.name, arguments: isRecord(params) ? params : {} }, undefined, {
          timeout: callTimeoutMs,
          ...(signal !== undefined ? { signal } : {}),
        });
      } catch (cause) {
        throw new ToolFailed(mcpWords.callFailed(server, t.name, messageOf(cause)), cause);
      }
      let text = mcpContentText(Content.safeParse(r.content).data ?? []);
      // structuredContent came over JSON-RPC, so it always encodes back.
      if (text === "") text = r.structuredContent !== undefined ? (JSON.stringify(r.structuredContent) ?? mcpWords.noContent) : mcpWords.noContent;
      if (r.isError === true) throw new ToolFailed(text);
      return text;
    },
  });
}

export interface McpConnections {
  readonly tools: Tool[];
  readonly failed: string[];
  readonly close: () => Promise<void>;
}

/** Each server at once; one that cannot be reached is in failed, in the order given. */
export async function connectAll(servers: readonly McpServer[], log: AgentLog = consoleLog): Promise<McpConnections> {
  const settled = await Promise.allSettled(servers.map((s) => connectMcp(s, log)));
  const connections = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const failed = settled.flatMap((r) => (r.status === "rejected" ? [messageOf(r.reason)] : []));
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

const McpEntrySchema = z.object({
  command: z.exactOptional(z.string()),
  args: z.exactOptional(z.array(z.string())),
  env: z.exactOptional(z.record(z.string(), z.string())),
  cwd: z.exactOptional(z.string()),
  url: z.exactOptional(z.string()),
  headers: z.exactOptional(z.record(z.string(), z.string())),
  disabled: z.exactOptional(z.boolean()),
});
const McpConfigSchema = z.object({ mcpServers: z.exactOptional(z.record(z.string(), McpEntrySchema)) });

/** A missing file has none; unreadable JSON or a wrong shape is an AgentFailed. */
export async function readMcpConfig(path: string, fs?: AgentFs): Promise<McpServer[]> {
  const raw = await agentFsOf(fs).readTextIfExists(path);
  const data = raw ?? "{}";
  if (data.trim() === "") throw new AgentFailed(mcpConfig.notJson(path));
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch (cause) {
    throw new AgentFailed(mcpConfig.badShape(path, messageOf(cause)), cause);
  }
  const config = McpConfigSchema.safeParse(json);
  if (!config.success) throw new AgentFailed(mcpConfig.badShape(path, config.error.message), config.error);
  const entries = config.data.mcpServers ?? {};
  const out: McpServer[] = [];
  for (const name of Object.keys(entries).toSorted()) {
    const e = entries[name];
    if (!e || e.disabled === true) continue;
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
