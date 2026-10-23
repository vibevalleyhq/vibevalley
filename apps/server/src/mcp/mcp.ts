// A session's tools over MCP at /mcp. The tools are tool's; this serves them and says which session
// is calling: the bearer token each session is handed names it, and its profile and project are where it works in the
// core state, never the caller's to choose. Every answer is words a model acts on, a refusal too ("没成：……").
// Stateless: each request is served by a server of its own, so nothing is kept between calls.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Context, Effect, Layer } from "effect";
import { Settings } from "../base/config.ts";
import { Sessions } from "../session/session.ts";
import { type Caller, Tools } from "../tool/tool.ts";

export interface McpShape {
  readonly handle: (request: Request) => Promise<Response>;
}

export class Mcp extends Context.Service<Mcp, McpShape>()("vibevalley/Mcp") {}

export const unknownCaller = "没认出你是谁：这些工具只给帮工用";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export interface McpOptions {
  /** Who a token names; the farm's sessions' when absent. */
  readonly who?: (token: string) => string;
}

export const make = (options: McpOptions = {}) =>
  Effect.gen(function* () {
    const config = yield* Settings;
    const sessions = yield* Sessions;
    const tools = yield* Tools;
    const who = options.who ?? sessions.who;

    // A session no longer in the fields still talks; its profile and project are empty.
    const callerOf = (id: string): Caller => {
      const h = sessions.sessionOf(id);
      return { agent: h?.agent ?? "", session: id, project: h?.project ?? "", here: "", picked: "", owner: false };
    };

    const call = async (tool: AgentTool, args: unknown): Promise<string> => {
      try {
        const checked = validateToolArguments(tool, { type: "toolCall", id: "", name: tool.name, arguments: (args ?? {}) as never });
        const r = await tool.execute("", checked);
        return r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      } catch (e) {
        return "没成：" + (e instanceof Error ? e.message : String(e));
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
      const server = new Server({ name: "vibevalley", version: config.version }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: list.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters as { type: "object" } })),
      }));
      server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const tool = list.find((t) => t.name === req.params.name);
        if (!tool) return text("没成：没有 " + req.params.name + " 这个工具");
        // Tools are never called for a caller nobody knows.
        if (!id) return text("没成：" + unknownCaller);
        return text(await call(tool, req.params.arguments));
      });
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      try {
        return await transport.handleRequest(request);
      } finally {
        void server.close();
      }
    };

    return Mcp.of({ handle });
  });

export const layer = (options?: McpOptions) => Layer.effect(Mcp, make(options));
