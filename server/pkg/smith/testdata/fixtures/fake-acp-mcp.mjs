/* oxlint-disable import/no-nodejs-modules, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument -- Standalone untyped child-process fixture: fake-acp-agent.mjs's MCP knobs. */
import { appendFileSync } from "node:fs";

/*
 * What the fake ACP agent does with `mcpServers`, set through its env:
 *   FAKE_ACP_MCP_HTTP=1      initialize declares mcpCapabilities.http
 *   FAKE_ACP_MCP_LOG=<file>  each open's method and `mcpServers` param, one JSON line per open
 *   FAKE_ACP_MCP_FAIL=1      an open fails, its error quoting the `mcpServers` param
 *   FAKE_ACP_MCP_FAIL_CODE=n that error's JSON-RPC code (default -32603)
 */

export function mcpCapabilities() {
  return process.env.FAKE_ACP_MCP_HTTP === "1" ? { mcpCapabilities: { http: true } } : {};
}

const OPENS = new Set(["session/new", "session/load", "session/resume"]);

/** Log an open's `mcpServers`, and fail it when asked: true when this answered the request. */
// oxlint-disable-next-line eslint/max-statements -- Independent optional wire logs and one scripted failure.
export function answeredMcpOpen(message, error) {
  if (!OPENS.has(message.method)) {
    return false;
  }
  const servers = message.params?.mcpServers;
  if (process.env.FAKE_ACP_DIRECTORIES_LOG !== undefined) {
    appendFileSync(process.env.FAKE_ACP_DIRECTORIES_LOG, `${JSON.stringify({ method: message.method, additionalDirectories: message.params?.additionalDirectories })}\n`);
  }
  if (process.env.FAKE_ACP_MCP_LOG !== undefined) {
    appendFileSync(process.env.FAKE_ACP_MCP_LOG, `${JSON.stringify({ method: message.method, mcpServers: servers })}\n`);
  }
  if (process.env.FAKE_ACP_MCP_FAIL === "1") {
    error(message.id, Number(process.env.FAKE_ACP_MCP_FAIL_CODE ?? -32_603), `cannot start ${JSON.stringify(servers)}`);
    return true;
  }
  return false;
}
