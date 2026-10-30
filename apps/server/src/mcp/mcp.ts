// A session's tools over MCP at /mcp. The tools are tool's; this serves them and says which session
// is calling: the bearer token each session is handed names it, and its profile and project are where it works in the
// core state, never the caller's to choose. Every answer is words a model acts on, a refusal too ("没成：……").
// Stateless: each request is served by a server of its own, so nothing is kept between calls.

import { messageOf } from "@/errors.ts";
import { coerceArguments } from "@vibevalley/ai/tools";
import { failedCall, noTool, unknownCaller } from "./prompts.ts";
import { session } from "@/base/actor.ts";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Context, Effect, FiberSet, Layer } from "effect";
import { ServerConfig } from "@/base/config.ts";
import { Sessions } from "@/session/session.ts";
import type { Tool } from "@vibevalley/agent/core/loop";
import { type Caller, Tools } from "@/tool/tool.ts";

export class Mcp extends Context.Service<
  Mcp,
  {
    readonly handle: (request: Request) => Promise<Response>;
  }
>()("vibevalley/Mcp") {
  static readonly layer = (options?: McpOptions) => Layer.effect(Mcp, make(options));
}

export { unknownCaller };

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export interface McpOptions {
  /** Who a token names; the farm's sessions' when absent. */
  readonly who?: (token: string) => string;
}

export const make = (options: McpOptions = {}) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const sessions = yield* Sessions;
    const tools = yield* Tools;
    const who = options.who ?? sessions.who;
    // A call runs on this service's fibers: it ends with the service.
    const runHere = yield* FiberSet.makeRuntimePromise();

    // A session no longer in the fields still talks; its profile and project are empty.
    const callerOf = (id: string): Caller => {
      const h = sessions.sessionOf(id);
      return { agent: h?.agent ?? "", session: id, project: h?.project ?? "", here: "", picked: "", actor: session(id) };
    };

    const call = async (tool: Tool, args: unknown): Promise<string> => {
      try {
        // Coerced as the brain's calls are; each tool's Schema then reads or refuses them.
        const r = await runHere(tool.execute(coerceArguments(args ?? {}, tool.parameters), { id: "" }));
        return r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      } catch (e) {
        return failedCall(messageOf(e));
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
        tools: list.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters as { type: "object" } })),
      }));
      server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const tool = list.find((t) => t.name === req.params.name);
        if (!tool) return text(noTool(req.params.name));
        // Tools are never called for a caller nobody knows.
        if (!id) return text(failedCall(unknownCaller));
        return text(await call(tool, req.params.arguments));
      });
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.connect(transport);
      try {
        return await transport.handleRequest(request);
      } finally {
        void server.close();
      }
    };

    return Mcp.of({ handle });
  });
