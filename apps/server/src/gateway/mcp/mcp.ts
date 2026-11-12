import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { coerceArguments } from "@vibevalley/agent/core/schema";
import type { Tool as LoopTool } from "@vibevalley/agent/core/tool";

import { worker, type Caller } from "#/base/actor.ts";
import { messageOf } from "#/base/errors.ts";
import { redact, redactedHead } from "#/base/redact.ts";
import type { Tool } from "#/gateway/tool/tool.ts";
import type { ServerConfig } from "#/infra/config.ts";
import type { Logger } from "#/infra/log.ts";
import type { Session } from "#/modules/session/session.ts";

import { failedCall, noTool, unknownCaller } from "./prompts.ts";

export interface Mcp {
  readonly handle: (request: Request) => Promise<Response>;
  /** Every call still running is aborted. */
  readonly close: () => Promise<void>;
}

export interface McpDeps {
  readonly config: ServerConfig;
  readonly session: Session;
  readonly tool: Tool;
  readonly log: Logger;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export interface McpOptions {
  /** Who a token names; the farm's sessions' when absent. */
  readonly who?: (token: string) => string;
}

export async function makeMcp(deps: McpDeps, options: McpOptions = {}): Promise<Mcp> {
  const { config, session: sessions, tool: tools } = deps;
  const log = deps.log.child("mcp");
  const who = options.who ?? sessions.who;
  // A call runs under this: it ends with the service.
  const stop = new AbortController();

  const callerOf = (id: string): Caller => {
    const h = sessions.live(id).session;
    return { agent: h?.agent ?? "", session: id, repo: h?.repo ?? "", here: "", picked: "", envelope: "", actor: worker(id) };
  };

  const call = async (tool: LoopTool, args: unknown, token: string): Promise<ReturnType<typeof text> & { isError?: boolean }> => {
    try {
      // Coerced as the brain's calls are; each tool's Schema then reads or refuses them.
      const r = await tool.execute(coerceArguments(args ?? {}, tool.parameters), { id: "" }, stop.signal);
      const content = r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      return {
        ...text(r.isError === true ? redactedHead(redact(content.replaceAll(token, "[redacted]")), 8000) : content),
        ...(r.isError !== undefined ? { isError: r.isError } : {}),
      };
    } catch (e) {
      return { ...text(redactedHead(redact(failedCall(messageOf(e)).replaceAll(token, "[redacted]")), 8000)), isError: true };
    }
  };

  const handle = async (request: Request): Promise<Response> => {
    const header = request.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const id = token ? who(token) : "";
    const list = tools.session(() => {
      if (!id) throw new Error(unknownCaller);
      return callerOf(id);
    });
    // The tools come with JSON Schema and McpServer.registerTool takes zod only: the low-level Server is the SDK's
    // own exception for this.
    // oxlint-disable-next-line typescript/no-deprecated
    const server = new Server({ name: "vibevalley", version: config.version }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: list.map((t) => ({ name: t.name, description: t.description, inputSchema: { ...t.parameters, type: "object" as const } })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const tool = list.find((t) => t.name === req.params.name);
      if (!tool) return { ...text(noTool(req.params.name)), isError: true };
      // Tools are never called for a caller nobody knows.
      if (!id || who(token) !== id || (!sessions.live(id).session && tool.name !== "session_list"))
        return { ...text(failedCall(unknownCaller)), isError: true };
      return call(tool, req.params.arguments, token);
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      // The answer is whole (enableJsonResponse): the server is one request's.
      await server.close().catch((e: unknown) => log.debug("mcp: closing the server failed", e));
    }
  };

  return {
    handle,
    close: async () => {
      stop.abort();
    },
  };
}
