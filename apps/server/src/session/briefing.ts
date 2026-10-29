// What a session is told: its profile's instructions and skills, its MCP servers in oar's shape, and what it recalls
// ahead of its job.

import { recallHead, recallIntro } from "./prompts.ts";
import type { McpServer } from "@botiverse/oar";

import type { Agent, MCPServer, Skill } from "@vibevalley/protocol";

/** What the detail panel shows starts after it. */
export const jobBreak = "\n\n---\n\n";

export const toOarMcp = (server: MCPServer): McpServer =>
  server.type === "http"
    ? { name: server.name, type: "http", url: server.url, headers: server.headers }
    : { name: server.name, command: server.command, args: server.args, env: server.env };

export function instructions(agent: Agent, library: readonly Skill[]): string {
  const parts = [agent.persona.trim()];
  for (const id of agent.skills) {
    const skill = library.find((s) => s.id === id);
    if (skill) parts.push("## " + skill.name + "\n" + skill.body.trim());
  }
  return parts.filter((p) => p !== "").join("\n\n");
}

/** recalledIn finds the block by these words. */
export const recallBlock = (recalled: readonly string[]) => (recalled.length === 0 ? "" : [recallHead + recallIntro, ...recalled].join("\n"));

/** Set apart, so the detail panel shows the two apart. */
export const withRecall = (block: string, input: string) => (block ? block + jobBreak + input : input);

export function recalledIn(input: string): string {
  const parts = input.split(jobBreak);
  if (parts.length < 2) return "";
  const block = parts[parts.length - 2]!;
  return block.startsWith(recallHead) ? block.split("\n").slice(1).join("\n") : "";
}
