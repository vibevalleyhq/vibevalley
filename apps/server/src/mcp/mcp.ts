// A session's tools over MCP at /mcp. The tools are tool's; this serves them and says which session
// is calling: the bearer token each session is handed names it, and its profile and project are where it works in the
// core state, never the caller's to choose. Every answer is words a model acts on, a refusal too ("没成：……").
// Stateless: each request is served by a server of its own, so nothing is kept between calls.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Context, Effect, FiberSet, Layer } from "effect";

import type { Tool as LoopTool } from "@vibevalley/agent/core/loop";
import { coerceArguments } from "@vibevalley/ai/tools";

import { session } from "@/base/actor.ts";
import { messageOf } from "@/errors.ts";
import { ServerConfig } from "@/infra/config.ts";
import { Session } from "@/session/session.ts";
import { type Caller, Tool } from "@/tool/tool.ts";

import { failedCall, noTool, unknownCaller } from "./prompts.ts";

export class Mcp extends Context.Service<
  Mcp,
  {
    readonly handle: (request: Request) => Effect.Effect<Response>;
  }
>()("vibevalley/Mcp") {
  static readonly layer = (options?: McpOptions) => Layer.effect(Mcp, make(options));
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export interface McpOptions {
  /** Who a token names; the farm's sessions' when absent. */
  readonly who?: (token: string) => string;
}

const make = (options: McpOptions = {}) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const sessions = yield* Session;
    const tools = yield* Tool;
    const who = options.who ?? sessions.who;
    // A call runs on this service's fibers: it ends with the service.
    const runHere = yield* FiberSet.makeRuntimePromise();

    // A session no longer in the fields still talks; its profile and project are empty.
    const callerOf = (id: string): Caller => {
      const h = sessions.sessionOf(id);
      return { agent: h?.agent ?? "", session: id, project: h?.project ?? "", here: "", picked: "", actor: session(id) };
    };

    const call = async (tool: LoopTool, args: unknown): Promise<string> => {
      try {
        // Coerced as the brain's calls are; each tool's Schema then reads or refuses them.
        const r = await runHere(tool.execute(coerceArguments(args ?? {}, tool.parameters), { id: "" }));
        return r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      } catch (e) {
        return failedCall(messageOf(e));
      }
    };

    const handle = Effect.fn("Mcp.handle")(function* (request: Request) {
      const header = request.headers.get("authorization") ?? "";
      const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
      const id = token ? who(token) : "";
      const list = tools.session(() => {
        if (!id) throw new Error(unknownCaller);
        return callerOf(id);
      });
      // The tools come with JSON Schema and McpServer.registerTool takes zod only: the low-level Server is the SDK's
      // own exception for this.
      const made = () => {
        // oxlint-disable-next-line typescript/no-deprecated
        const server = new Server({ name: "vibevalley", version: config.version }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: list.map((t) => ({ name: t.name, description: t.description, inputSchema: { ...t.parameters, type: "object" as const } })),
        }));
        server.setRequestHandler(CallToolRequestSchema, async (req) => {
          const tool = list.find((t) => t.name === req.params.name);
          if (!tool) return text(noTool(req.params.name));
          // Tools are never called for a caller nobody knows.
          if (!id) return text(failedCall(unknownCaller));
          return text(await call(tool, req.params.arguments));
        });
        return server;
      };
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
          yield* Effect.acquireRelease(
            Effect.promise(async () => {
              const server = made();
              await server.connect(transport);
              return server;
            }),
            (server) => Effect.ignore(Effect.tryPromise({ try: () => server.close(), catch: messageOf })),
          );
          return yield* Effect.promise(() => transport.handleRequest(request));
        }),
      );
    });

    return Mcp.of({ handle });
  });
