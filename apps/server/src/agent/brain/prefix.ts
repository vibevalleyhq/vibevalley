// DeepSeek caches by prefix: a request is cheap up to the first character that differs from the request before. The
// prompt's start (tools, then the system prompt) is hashed part by part on every request, so a change between two
// compactions, which costs the whole conversation at full price, is told and can be traced to its part.

import type { Tool } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";

export interface PromptPart {
  readonly name: string;
  readonly text: string;
}

export const joinParts = (parts: readonly PromptPart[]) => parts.map((p) => p.text).join("\n\n");

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** In the order told. Tools last: they are sent before the system prompt, but are told after its own parts. */
export const prefixParts = ["instructions", "env", "skills", "memory", "tools"] as const;

export function prefixHashes(parts: readonly PromptPart[], tools: readonly Tool[]): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const p of parts) hashes[p.name] = digest(p.text);
  hashes.tools = digest(tools.map((t) => t.name + "\0" + t.description + "\0" + JSON.stringify(t.parameters) + "\0").join(""));
  return hashes;
}

/** The parts that differ, in prefixParts' order; none when there is nothing to compare with. */
export const changedParts = (before: Record<string, string> | undefined, now: Record<string, string>) =>
  before ? prefixParts.filter((name) => before[name] !== now[name]) : [];
