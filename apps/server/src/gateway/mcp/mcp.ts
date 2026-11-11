import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Context, Effect, FiberSet, Layer } from "effect";

import type { Tool as LoopTool } from "@vibevalley/agent/core/loop";
import { coerceArguments } from "@vibevalley/ai/tools";

import { worker } from "#/base/actor.ts";
import { messageOf } from "#/base/errors.ts";
import { redact, redactedHead } from "#/base/redact.ts";
import { ServerConfig } from "#/infra/config.ts";
import { Session } from "#/modules/session/session.ts";
import type { Caller } from "#/modules/tool/schemas.ts";
import { Tool } from "#/modules/tool/tool.ts";

import { failedCall, noTool, unknownCaller } from "./prompts.ts";

export class Mcp extends Context.Service<
  Mcp,
  {
    readonly handle: (request: Request) => Effect.Effect<Response>;
  }
>()("@vibevalley/server/gateway/mcp/mcp") {
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

    const callerOf = (id: string): Caller => {
      const h = sessions.sessionOf(id);
      return { agent: h?.agent ?? "", session: id, repo: h?.repo ?? "", here: "", picked: "", envelope: "", actor: worker(id) };
    };

    const call = async (tool: LoopTool, args: unknown, token: string): Promise<ReturnType<typeof text> & { isError?: boolean }> => {
      try {
        // Coerced as the brain's calls are; each tool's Schema then reads or refuses them.
        const r = await runHere(tool.execute(coerceArguments(args ?? {}, tool.parameters), { id: "" }));
        const content = r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
        return {
          ...text(r.isError === true ? redactedHead(redact(content.replaceAll(token, "[redacted]")), 8000) : content),
          ...(r.isError !== undefined ? { isError: r.isError } : {}),
        };
      } catch (e) {
        return { ...text(redactedHead(redact(failedCall(messageOf(e)).replaceAll(token, "[redacted]")), 8000)), isError: true };
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
          if (!tool) return { ...text(noTool(req.params.name)), isError: true };
          // Tools are never called for a caller nobody knows.
          if (!id || who(token) !== id || (!sessions.sessionOf(id) && tool.name !== "session_list"))
            return { ...text(failedCall(unknownCaller)), isError: true };
          return call(tool, req.params.arguments, token);
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
            (server) => Effect.ignore(Effect.tryPromise({ try: () => server.close(), catch: messageOf }), { log: "Debug" }),
          );
          return yield* Effect.promise(() => transport.handleRequest(request));
        }),
      );
    });

    return Mcp.of({ handle });
  });
