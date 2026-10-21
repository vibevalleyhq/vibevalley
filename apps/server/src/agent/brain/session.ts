// The agent's conversation on disk, a message a line. A compaction is a line too: reading the file back, a
// `compactionSummary` stands in for everything before it except its `kept` most recent messages.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CompactionSummaryMessage } from "./messages.ts";

export function applySummary(messages: readonly AgentMessage[], summary: CompactionSummaryMessage): AgentMessage[] {
  return [summary, ...(summary.kept > 0 ? messages.slice(Math.max(0, messages.length - summary.kept)) : [])];
}

export function replay(lines: readonly AgentMessage[]): AgentMessage[] {
  let out: AgentMessage[] = [];
  for (const m of lines) {
    if (m.role === "compactionSummary") out = applySummary(out, m as CompactionSummaryMessage);
    else out.push(m);
  }
  return out;
}

function parseLines(text: string): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const m = JSON.parse(line) as AgentMessage;
      // A line cut off by a crash: the rest still reads.
      if (m && typeof m === "object" && typeof m.role === "string" && m.role !== "system") out.push(m);
    } catch {
      continue;
    }
  }
  return out;
}

/** Every line of a session file as written, the compactions among them and what they fold; empty when there is no file. */
export function readLines(file: string): AgentMessage[] {
  try {
    return parseLines(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

export class SessionFile {
  constructor(readonly file: string) {}

  load(): AgentMessage[] {
    return replay(readLines(this.file));
  }

  append(message: AgentMessage) {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, JSON.stringify(message) + "\n");
  }

  clear() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, "");
  }
}
