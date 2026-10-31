// The agent's conversation on disk, a message a line. A compaction is a line too: reading the file back, a
// `compactionSummary` stands in for everything before it except its `kept` most recent messages.

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Predicate } from "effect";

import type { BrainMessage, CompactionSummaryMessage } from "./messages.ts";

export function applySummary(messages: readonly BrainMessage[], summary: CompactionSummaryMessage): BrainMessage[] {
  return [summary, ...(summary.kept > 0 ? messages.slice(Math.max(0, messages.length - summary.kept)) : [])];
}

export function replay(lines: readonly BrainMessage[]): BrainMessage[] {
  let out: BrainMessage[] = [];
  for (const m of lines) {
    if (m.role === "compactionSummary") out = applySummary(out, m);
    else out.push(m);
  }
  return out;
}

function parseLines(text: string): BrainMessage[] {
  const out: BrainMessage[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const m: unknown = JSON.parse(line);
      // A line cut off by a crash: the rest still reads.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a line this file wrote: a whole one is a BrainMessage
      if (Predicate.hasProperty(m, "role") && typeof m.role === "string") out.push(m as BrainMessage);
    } catch {
      continue;
    }
  }
  return out;
}

/** Every line of a session file as written, the compactions among them and what they fold; empty when there is no file. */
export const readLines = (file: string): Promise<BrainMessage[]> => readFile(file, "utf8").then(parseLines, (): BrainMessage[] => []);

/** The conversation as it stands: the compactions applied. */
export const loadSession = async (file: string): Promise<BrainMessage[]> => replay(await readLines(file));

/** A message added at the end; the caller waits for one before the next, so the lines keep their order. */
export async function appendSession(file: string, message: BrainMessage) {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(message) + "\n");
}

export async function clearSession(file: string) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, "");
}
