// MCP servers' tools for the agent. Only initialize, tools/list (every page) and tools/call: no resources, prompts or
// sampling. A server that cannot be reached is left out and said why; the others still come.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServer } from "./config.ts";
import { type Schema, textTool } from "./tool.ts";

/** Also for connecting. */
export const callTimeoutMs = 120_000;

interface Block {
  readonly type: string;
  readonly text?: string;
  readonly resource?: { readonly text?: string; readonly uri?: string };
}

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
        else parts.push("[资源]");
        break;
    }
  }
  return parts.join("\n").trim();
}

/** The server's name first, only the characters function names allow. */
export const mcpToolName = (server: string, tool: string) => (server + "__" + tool).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);

export interface McpConnection {
  readonly tools: AgentTool[];
  close(): Promise<void>;
}

const timeout = <A>(p: Promise<A>, ms: number, signal?: AbortSignal) =>
  new Promise<A>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    signal?.addEventListener("abort", () => reject(new Error("canceled")), { once: true });
    p.then(resolve, reject).finally(() => clearTimeout(timer));
  });

export async function connectMcp(server: McpServer, signal?: AbortSignal): Promise<McpConnection> {
  let stderr = "";
  let transport: Transport;
  if (server.url) {
    transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: server.headers ?? {} },
    });
  } else {
    const stdio = new StdioClientTransport({
      command: server.command ?? "",
      args: server.args ?? [],
      env: {
        ...getDefaultEnvironment(),
        ...(process.env as Record<string, string>),
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
    return new Error(`连不上 MCP 服务 ${server.name}：${e instanceof Error ? e.message : String(e)}${last ? "：" + last : ""}`);
  };
  const client = new Client({ name: "vibevalley-agent", version: "0.1.0" });
  const close = async () => {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  };
  try {
    await timeout(client.connect(transport), callTimeoutMs, signal);
    const tools: AgentTool[] = [];
    let cursor: string | undefined;
    do {
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

function mcpTool(client: Client, server: string, t: { name: string; description?: string; inputSchema?: object }): AgentTool {
  const parameters = (t.inputSchema as Schema | undefined) ?? { type: "object", properties: {} };
  return textTool<Record<string, unknown> | null>({
    name: mcpToolName(server, t.name),
    label: server + " · " + t.name,
    description: "（" + server + "）" + (t.description || t.name),
    parameters,
    run: async (params, tc) => {
      let r: Awaited<ReturnType<Client["callTool"]>>;
      try {
        r = await client.callTool({ name: t.name, arguments: params ?? {} }, undefined, {
          timeout: callTimeoutMs,
          signal: tc.signal,
        });
      } catch (e) {
        throw new Error(`${server} 的 ${t.name} 出错：${e instanceof Error ? e.message : String(e)}`);
      }
      let text = mcpContentText((r.content as Block[] | undefined) ?? []);
      if (text === "") text = r.structuredContent !== undefined ? JSON.stringify(r.structuredContent) : "（没有内容）";
      if (r.isError) throw new Error(text);
      return text;
    },
  });
}

export interface McpConnections {
  readonly tools: AgentTool[];
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
