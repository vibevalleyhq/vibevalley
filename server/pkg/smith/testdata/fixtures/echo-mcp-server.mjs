/* oxlint-disable eslint/max-statements, eslint/max-lines-per-function, import/no-nodejs-modules, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument, typescript/no-unsafe-return -- Standalone untyped child-process fixture: a tiny MCP server. */
import { createHash } from "node:crypto";
import http from "node:http";
import { createInterface } from "node:readline";

/*
 * A tiny MCP server with one tool, `echo`, for proving that a runtime really
 * attached a session's `mcpServers` entry and that its agent called it.
 *
 *   node echo-mcp-server.mjs          stdio transport (newline-delimited JSON-RPC)
 *   node echo-mcp-server.mjs --http   streamable HTTP on 127.0.0.1, an ephemeral
 *                                     port; prints `listening <url>` on stdout
 *   --once                            one tools/call per connection: over stdio
 *                                     the process exits after answering it, over
 *                                     HTTP that session then answers 404 (MCP:
 *                                     the client must initialize a new one)
 *
 * `echo {text}` answers `echo:<text> via=<transport> token=<fingerprint>`.
 * Nothing but this process writes that string, so a provider request carrying
 * it means the runtime ran the server and returned its result to the model.
 * The fingerprint is the first 12 hex digits of sha256 over the credential the
 * entry gave the server (stdio: env OAR_ECHO_TOKEN; http: the Authorization
 * header), or `none`: a test proves the credential arrived without the value
 * itself ever appearing in a tool result.
 */

const overHttp = process.argv.includes("--http") === true;
const once = process.argv.includes("--once") === true;

function fingerprint(secret) {
  return typeof secret === "string" && secret.length > 0 ? createHash("sha256").update(secret).digest("hex").slice(0, 12) : "none";
}

function answer(message, credential, via) {
  const { id, method, params } = message;
  if (id === undefined || id === null) {
    return null; // a notification (notifications/initialized): nothing to answer
  }
  switch (method) {
    case "initialize":
      return { jsonrpc: "2.0", id, result: {
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "oar-echo", version: "1.0.0" },
      } };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: [{
        name: "echo",
        description: "Echo the given text back, prefixed with echo:",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      }] } };
    case "tools/call": {
      const text = typeof params?.arguments?.text === "string" ? params.arguments.text : "";
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `echo:${text} via=${via} token=${fingerprint(credential)}` }] } };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    default:
      return { jsonrpc: "2.0", id, error: { code: -32_601, message: `method not found: ${String(method)}` } };
  }
}

if (overHttp) {
  let sessions = 0;
  const ended = new Set();
  const server = http.createServer((request, response) => {
    const sessionId = request.headers["mcp-session-id"];
    if (once && ended.has(sessionId)) {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      let message = null;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        response.writeHead(400).end();
        return;
      }
      const reply = answer(message, request.headers.authorization, "http");
      if (reply === null) {
        response.writeHead(202).end();
        return;
      }
      // --once: a session per initialize, ended by its tools/call.
      let session = once ? sessionId : "oar-echo-session";
      if (once && message.method === "initialize") {
        sessions += 1;
        session = `oar-echo-session-${String(sessions)}`;
      }
      if (once && message.method === "tools/call") {
        ended.add(session);
      }
      response.writeHead(200, { "content-type": "application/json", ...(typeof session === "string" ? { "mcp-session-id": session } : {}) });
      response.end(JSON.stringify(reply));
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    process.stdout.write(`listening http://127.0.0.1:${String(address.port)}/mcp\n`);
  });
} else {
  const lines = createInterface({ input: process.stdin });
  // --once: nothing after the call is answered, so a later echo proves a new process.
  let called = false;
  lines.on("line", (line) => {
    if (line.trim() === "" || called) {
      return;
    }
    let message = null;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const reply = answer(message, process.env.OAR_ECHO_TOKEN, "stdio");
    called = once && message.method === "tools/call";
    if (reply !== null) {
      process.stdout.write(`${JSON.stringify(reply)}\n`, () => {
        if (called) {
          process.exit(0);
        }
      });
    }
  });
  lines.on("close", () => process.exit(0));
}
