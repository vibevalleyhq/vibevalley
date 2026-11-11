import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Effect, Exit, type FileSystem, Option, Predicate, Result, Schema } from "effect";

import type { JsonSchema } from "@vibevalley/ai/tools";

import { mcpConfig, mcp as mcpWords } from "../base/prompts.ts";
import { AgentFailed, messageOf, ToolFailed } from "../core/errors.ts";
import type { Tool } from "../core/loop.ts";
import { effectTool } from "../core/tool.ts";
import { agentFsOf } from "./fs.ts";
import { asTransport } from "./mcpTransport.ts";
import { failAfterRealTime } from "./realTime.ts";

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

interface McpConnection {
  readonly tools: Tool[];
  readonly close: Effect.Effect<void>;
}

/** A server that could not be reached in time: its message is what mcpStatus says of it. */
class McpUnreachable extends Schema.TaggedError<McpUnreachable, { readonly brand: unique symbol }>()("McpUnreachable", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** What start gives, or a failure after callTimeoutMs of real time; the request it started is not cancelled. */
const withinCallTimeout = <A>(start: () => Promise<A>) =>
  Effect.raceFirst(
    Effect.tryPromise({ try: start, catch: (cause) => McpUnreachable.make({ message: messageOf(cause), cause }) }),
    failAfterRealTime(callTimeoutMs, () => McpUnreachable.make({ message: "timed out" })),
  );

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

/** Interrupted or failed, what it opened is closed first. */
const connectMcp = Effect.fnUntraced(function* (server: McpServer) {
  const { transport, lastStderr } = openTransport(server);
  const client = new Client({ name: "vibevalley-agent", version: "0.1.0" });
  const close = Effect.andThen(
    Effect.ignore(Effect.tryPromise({ try: () => client.close(), catch: messageOf }), { log: "Debug" }),
    Effect.ignore(Effect.tryPromise({ try: () => transport.close(), catch: messageOf }), { log: "Debug" }),
  );
  return yield* Effect.gen(function* () {
    yield* withinCallTimeout(() => client.connect(transport));
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const asked = cursor ? { cursor } : {};
      const page = yield* withinCallTimeout(() => client.listTools(asked));
      for (const t of page.tools) tools.push(mcpTool(client, server.name, t));
      cursor = page.nextCursor;
    } while (cursor);
    const connection: McpConnection = { tools, close };
    return connection;
  }).pipe(
    Effect.onExit((exit) => (Exit.isFailure(exit) ? close : Effect.void)),
    Effect.mapError((e) => McpUnreachable.make({ message: mcpWords.connectFailed(server.name, e.message, lastStderr()), cause: e })),
  );
});

const encodeJson = Schema.encodeOption(Schema.fromJsonString(Schema.Unknown));

function mcpTool(client: Client, server: string, t: { name: string; description?: string | undefined; inputSchema?: object | undefined }): Tool {
  const parameters: JsonSchema = t.inputSchema ? Object.fromEntries(Object.entries(t.inputSchema)) : { type: "object", properties: {} };
  return effectTool({
    name: mcpToolName(server, t.name),
    description: mcpWords.toolDescription(server, t.description || t.name),
    parameters,
    run: (params) =>
      Effect.gen(function* () {
        const r = yield* Effect.tryPromise({
          try: (signal) =>
            client.callTool({ name: t.name, arguments: Predicate.isObject(params) ? params : {} }, undefined, {
              timeout: callTimeoutMs,
              signal,
            }),
          catch: (cause) => ToolFailed.make({ message: mcpWords.callFailed(server, t.name, messageOf(cause)), cause }),
        });
        let text = mcpContentText(Option.getOrElse(contentOf(r.content), () => []));
        // structuredContent came over JSON-RPC, so it always encodes back.
        if (text === "")
          text = r.structuredContent !== undefined ? Option.getOrElse(encodeJson(r.structuredContent), () => mcpWords.noContent) : mcpWords.noContent;
        if (r.isError === true) return yield* ToolFailed.make({ message: text });
        return text;
      }),
  });
}

export interface McpConnections {
  readonly tools: Tool[];
  readonly failed: string[];
  readonly close: Effect.Effect<void>;
}

/** Each server at once; one that cannot be reached is in failed, in the order given. */
export const connectAll = Effect.fnUntraced(function* (servers: readonly McpServer[]) {
  const [connections, unreachable] = yield* Effect.partition(servers, (s) => connectMcp(s), { concurrency: "unbounded" });
  const all: McpConnections = {
    tools: connections.flatMap((c) => c.tools),
    failed: unreachable.map((e) => e.message),
    close: Effect.forEach(connections, (c) => c.close, { concurrency: "unbounded", discard: true }),
  };
  return all;
});

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

const McpEntrySchema = Schema.Struct({
  command: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  cwd: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  disabled: Schema.optionalKey(Schema.Boolean),
});
type McpEntry = typeof McpEntrySchema.Type;
const McpConfigSchema = Schema.fromJsonString(Schema.Struct({ mcpServers: Schema.optionalKey(Schema.Record(Schema.String, McpEntrySchema)) }));

/** A missing file has none; unreadable JSON or a wrong shape is an error. */
export const readMcpConfig = (path: string, fs?: FileSystem.FileSystem): Effect.Effect<McpServer[], AgentFailed> =>
  Effect.gen(function* () {
    const raw = yield* agentFsOf(fs).readTextIfExists(path);
    const data = raw ?? "{}";
    if (data.trim() === "") return yield* AgentFailed.make({ message: mcpConfig.notJson(path) });
    const config: Result.Result<{ mcpServers?: Record<string, McpEntry> }, Schema.SchemaError> = Schema.decodeResult(McpConfigSchema)(data);
    if (Result.isFailure(config)) return yield* AgentFailed.make({ message: mcpConfig.badShape(path, String(config.failure)), cause: config.failure });
    const entries = config.success.mcpServers ?? {};
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
  });
